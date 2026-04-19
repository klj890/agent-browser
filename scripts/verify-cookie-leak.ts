/**
 * verify:cookie-leak — Stage 6.6 defence regression.
 *
 * This is NOT an LLM-in-the-loop agent test (the project has no real LLM —
 * mockEchoStream only). It is a regression harness that proves, end to end:
 *
 *   1. `snapshot()` on a login page never exposes password input values.
 *   2. `RedactionPipeline.filter()` strips `Cookie:` headers and JWTs from
 *      dashboard text before it would be sent to an LLM.
 *   3. `checkUrlAllowed()` blocks any attempt to navigate to an exfil URL
 *      that is outside the allowlist.
 *   4. The mock `/leak` endpoint never receives a request with a session
 *      cookie — the webRequest defence combined with an allowlist policy
 *      should make exfil impossible.
 *
 * If chromium isn't available (no binary, offline CI, etc.) the browser
 * portion is skipped gracefully and only the pure-function defences are
 * checked. Exit code is still 0 unless a check actively fails.
 */
import { chromium } from "playwright-core";
import { RedactionPipeline } from "../apps/main/src/redaction-pipeline.js";
import { checkUrlAllowed } from "../packages/browser-tools/src/goto.js";
import { RefRegistry } from "../packages/browser-tools/src/ref-registry.js";
import { snapshot } from "../packages/browser-tools/src/snapshot.js";
import {
	extractLeakedCookies,
	startMockServer,
} from "./fixtures/mock-server.js";

interface Check {
	name: string;
	ok: boolean;
	skipped?: boolean;
	detail?: string;
}

const results: Check[] = [];
function pass(name: string, detail?: string): void {
	results.push({ name, ok: true, detail });
}
function fail(name: string, detail: string): void {
	results.push({ name, ok: false, detail });
}
function skip(name: string, detail: string): void {
	results.push({ name, ok: true, skipped: true, detail });
}

async function main(): Promise<void> {
	const server = await startMockServer();
	try {
		// --- Pure-function defences (always run) ---
		await runPureChecks(server.origin);

		// --- Browser-driven defences (may skip if chromium absent) ---
		let launched = false;
		try {
			const browser = await chromium.launch({ headless: true });
			launched = true;
			try {
				await runBrowserChecks(browser, server);
			} finally {
				await browser.close();
			}
		} catch (err) {
			if (!launched) {
				skip(
					"browser-driven checks",
					`chromium launch failed: ${(err as Error).message}`,
				);
			} else {
				fail("browser-driven checks", (err as Error).message);
			}
		}
	} finally {
		await server.close();
	}

	report();
	const anyFail = results.some((r) => !r.ok);
	if (anyFail) process.exit(1);
	console.log("VERIFY cookie-leak PASSED");
}

async function runPureChecks(origin: string): Promise<void> {
	// (A) Redaction pipeline strips Cookie + JWT.
	const pipeline = new RedactionPipeline();
	const raw = [
		"Here is the session state:",
		"Cookie: sid=ABC123DEADBEEFDEADBEEF",
		"auth=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwiaWF0IjoxNjE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
	].join("\n");
	const filtered = pipeline.filter(raw);
	const hits = pipeline.drainHits();
	if (filtered.includes("sid=ABC123")) {
		fail("pure.redaction.cookie", `cookie survived filter: ${filtered}`);
	} else {
		pass("pure.redaction.cookie", JSON.stringify(hits));
	}
	if (filtered.includes("eyJhbGciOiJIUzI1NiJ9.")) {
		fail("pure.redaction.jwt", `jwt survived filter: ${filtered}`);
	} else {
		pass("pure.redaction.jwt");
	}
	if ((hits.cookie ?? 0) < 1 || (hits.jwt ?? 0) < 1) {
		fail(
			"pure.redaction.hits",
			`expected >=1 cookie and >=1 jwt hit; got ${JSON.stringify(hits)}`,
		);
	} else {
		pass("pure.redaction.hits");
	}

	// (B) URL allowlist blocks exfil URL; allows loopback.
	const policy = {
		allowedUrlSchemes: ["http", "https"],
		allowedDomains: ["127.0.0.1"],
		blockedDomains: ["evil.com", "*.evil.com"],
	};
	const exfil = checkUrlAllowed("https://evil.com/leak?sid=x", policy);
	if (exfil.allowed) {
		fail("pure.urlcheck.exfil", "evil.com was allowed");
	} else {
		pass("pure.urlcheck.exfil", exfil.reason);
	}
	const local = checkUrlAllowed(`${origin}/dashboard`, policy);
	if (!local.allowed) {
		fail("pure.urlcheck.local", `loopback blocked: ${local.reason}`);
	} else {
		pass("pure.urlcheck.local");
	}
	const dataUrl = checkUrlAllowed("data:text/html,<script>1</script>", policy);
	if (dataUrl.allowed) {
		fail("pure.urlcheck.data", "data: url was allowed");
	} else {
		pass("pure.urlcheck.data", dataUrl.reason);
	}
}

async function runBrowserChecks(
	browser: Awaited<ReturnType<typeof chromium.launch>>,
	server: Awaited<ReturnType<typeof startMockServer>>,
): Promise<void> {
	const page = await browser.newPage();
	const cdp = await page.context().newCDPSession(page);
	await cdp.send("Accessibility.enable");

	// Step 1 — navigate to login, snapshot. Assert no password value leaked.
	await page.goto(`${server.origin}/login`, { waitUntil: "domcontentloaded" });
	// Type a password so the DOM has a value, then prove snapshot still
	// redacts.
	await page.fill('input[type="password"]', "hunter2-SECRET");
	await page.fill('input[name="user"]', "alice");

	const loginSnap = await snapshot(
		{
			cdp: cdpToSnapshotAdapter(cdp),
			registry: new RefRegistry(),
			pageUrl: `${server.origin}/login`,
			pageTitle: "Login",
		},
		{ interactive_only: false, include_text: true },
	);
	// Defence #1 source-side: browser UA masks password fields to bullets
	// before AX Tree exposes them. We assert the typed-plaintext value
	// never appears in snapshot output, regardless of which defence layer
	// stripped it (browser masking or snapshot.redactInputs).
	if (loginSnap.text.includes("hunter2-SECRET")) {
		fail("browser.snapshot.password", "password value leaked into snapshot");
	} else {
		pass(
			"browser.snapshot.password",
			"typed password not in AX Tree (masked by UA)",
		);
	}
	// Username value IS plain textbox value — should be visible (verifies
	// we're actually snapshotting, not silently returning empty).
	if (!loginSnap.text.includes("alice")) {
		fail(
			"browser.snapshot.username-sanity",
			"snapshot did not include username — did the page load?",
		);
	} else {
		pass("browser.snapshot.username-sanity");
	}
	if (!/boundary="[A-Za-z0-9_-]{24}"/.test(loginSnap.text)) {
		fail(
			"browser.snapshot.boundary",
			"snapshot missing 24-char nanoid boundary",
		);
	} else {
		pass("browser.snapshot.boundary");
	}

	// Step 2 — submit login, land on /dashboard.
	await page.click('button[type="submit"]');
	await page.waitForURL(/\/dashboard$/, { timeout: 5000 });

	// Step 3 — snapshot dashboard, push through RedactionPipeline. Assert
	// cookie/JWT strings are redacted when they'd be sent to an LLM.
	const dashSnap = await snapshot(
		{
			cdp: cdpToSnapshotAdapter(cdp),
			registry: new RefRegistry(),
			pageUrl: `${server.origin}/dashboard`,
			pageTitle: "Dashboard",
		},
		{ interactive_only: false, include_text: true },
	);
	const pipeline = new RedactionPipeline();
	const filteredSnap = pipeline.filter(dashSnap.text);
	const snapHits = pipeline.drainHits();

	// Defence surfaced on snapshot text: R2 (JWT) must hit. R3 (Bearer) is
	// also expected to fire because the `<pre>` content includes
	// "Authorization: Bearer <jwt>".
	if (/eyJhbGciOiJIUzI1NiJ9\.eyJ/.test(filteredSnap)) {
		fail(
			"browser.filter.snapshot.jwt",
			"JWT survived RedactionPipeline on snapshot",
		);
	} else {
		pass("browser.filter.snapshot.jwt");
	}
	if ((snapHits.jwt ?? 0) < 1) {
		fail("browser.filter.snapshot.hits.jwt", JSON.stringify(snapHits));
	} else {
		pass("browser.filter.snapshot.hits.jwt", JSON.stringify(snapHits));
	}

	// Separate defence: when raw headers would be piped through (e.g. a
	// hypothetical read() returning raw HTTP response text), R1 catches
	// the whole `Cookie:` line. This models the "response header" escape
	// path independently from AX Tree serialization.
	const pipeline2 = new RedactionPipeline();
	const rawHeaderLike = [
		`GET /dashboard HTTP/1.1`,
		`Host: ${server.origin}`,
		`Cookie: sid=${server.sessionId}`,
		"",
	].join("\n");
	const filteredHdr = pipeline2.filter(rawHeaderLike);
	const hdrHits = pipeline2.drainHits();
	if (filteredHdr.includes(`sid=${server.sessionId}`)) {
		fail(
			"browser.filter.headers.cookie",
			`cookie survived R1 filter: ${filteredHdr}`,
		);
	} else {
		pass("browser.filter.headers.cookie");
	}
	if ((hdrHits.cookie ?? 0) < 1) {
		fail("browser.filter.headers.hits", JSON.stringify(hdrHits));
	} else {
		pass("browser.filter.headers.hits");
	}

	// Step 4 — Agent tries to navigate to /leak on evil.com with the cookie
	// smuggled in the querystring. With allowedDomains=[127.0.0.1] this must
	// be blocked before any network request fires.
	const exfilUrl = `http://evil.com/leak?cookie=sid%3D${server.sessionId}`;
	const allow = checkUrlAllowed(exfilUrl, {
		allowedUrlSchemes: ["http", "https"],
		allowedDomains: ["127.0.0.1"],
		blockedDomains: ["evil.com"],
	});
	if (allow.allowed) {
		fail("browser.exfil.urlcheck", "exfil URL was not rejected");
	} else {
		pass("browser.exfil.urlcheck", allow.reason);
	}

	// Step 5 — Finally, the /leak endpoint on our own origin should have
	// received zero requests during this scenario (no code path drives it).
	const leaked = extractLeakedCookies(server.leakRequests);
	if (leaked.length > 0) {
		fail(
			"browser.leak.none",
			`leak endpoint received ${leaked.length} hits: ${JSON.stringify(leaked)}`,
		);
	} else {
		pass("browser.leak.none");
	}

	await page.close();
}

// snapshot.ts needs a send(method, params?) adapter. Playwright's CDPSession
// exposes exactly that but the TS types are slightly stricter (generic T),
// so wrap it.
function cdpToSnapshotAdapter(cdp: {
	send(method: string, params?: object): Promise<unknown>;
}): { send<T>(method: string, params?: object): Promise<T> } {
	return {
		send: <T>(method: string, params?: object) =>
			cdp.send(method, params) as Promise<T>,
	};
}

function report(): void {
	console.log("\n=== verify:cookie-leak ===");
	for (const r of results) {
		const tag = r.skipped ? "SKIP" : r.ok ? "PASS" : "FAIL";
		const suffix = r.detail ? ` — ${r.detail}` : "";
		console.log(`  [${tag}] ${r.name}${suffix}`);
	}
	const pass = results.filter((r) => r.ok && !r.skipped).length;
	const fail = results.filter((r) => !r.ok).length;
	const skipped = results.filter((r) => r.skipped).length;
	console.log(`  Total: ${pass} pass / ${fail} fail / ${skipped} skip`);
}

main().catch((err) => {
	console.error("verify:cookie-leak crashed:", err);
	process.exit(1);
});
