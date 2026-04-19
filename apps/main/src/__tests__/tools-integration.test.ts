/**
 * Lightweight integration test that drives a real chromium (via playwright-core)
 * through a thin adapter mirroring CdpAdapter's shape. This exercises the
 * browser-tools modules end-to-end against a live DOM.
 *
 * If playwright fails to launch (offline / no browser installed), we skip.
 */

import {
	act,
	goto,
	RefRegistry,
	read,
	snapshot,
} from "@agent-browser/browser-tools";
import {
	type Browser,
	type CDPSession,
	chromium,
	type Page,
} from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const TEST_HTML = `<!doctype html><html><head><title>IT Root</title></head>
<body>
  <main>
    <h1>Integration Test Page</h1>
    <p>Hello <b>World</b>.</p>
    <a id="link" href="/target">Go to target</a>
    <input type="text" id="name" placeholder="your name" />
    <input type="password" id="pw" value="super-secret-123" />
  </main>
</body></html>`;

const TARGET_HTML = `<!doctype html><html><head><title>IT Target</title></head>
<body><h1>Target Page Loaded</h1></body></html>`;

let browser: Browser | null = null;
let launchFailed = false;

beforeAll(async () => {
	try {
		browser = await chromium.launch({ headless: true });
	} catch (e) {
		launchFailed = true;
		// eslint-disable-next-line no-console
		console.warn("playwright launch failed — integration tests skipped:", e);
	}
}, 30_000);

afterAll(async () => {
	await browser?.close();
});

function adaptCdp(cdp: CDPSession) {
	return {
		send: <T>(method: string, params?: object) =>
			cdp.send(method as never, params as never) as Promise<T>,
		on: (method: string, cb: (params: unknown) => void) => {
			cdp.on(method as never, cb as never);
			return () => cdp.off(method as never, cb as never);
		},
	};
}

async function setupPage(): Promise<{
	page: Page;
	cdp: ReturnType<typeof adaptCdp>;
	close: () => Promise<void>;
}> {
	if (!browser) throw new Error("browser not ready");
	const page = await browser.newPage();
	await page.route("**/target", (r) =>
		r.fulfill({
			status: 200,
			contentType: "text/html",
			body: TARGET_HTML,
		}),
	);
	await page.route("**/root", (r) =>
		r.fulfill({
			status: 200,
			contentType: "text/html",
			body: TEST_HTML,
		}),
	);
	await page.goto("http://example.test/root", {
		waitUntil: "domcontentloaded",
	});
	const cdp = await page.context().newCDPSession(page);
	await cdp.send("Page.enable");
	await cdp.send("DOM.enable");
	await cdp.send("Accessibility.enable");
	return {
		page,
		cdp: adaptCdp(cdp),
		close: async () => {
			await cdp.detach().catch(() => undefined);
			await page.close();
		},
	};
}

describe("browser-tools integration", () => {
	it.skipIf(launchFailed)(
		"snapshot returns wrapped interactive list",
		async () => {
			if (!browser) return;
			const { cdp, close } = await setupPage();
			try {
				const registry = new RefRegistry();
				const r = await snapshot(
					{
						cdp,
						registry,
						pageUrl: "http://example.test/root",
						pageTitle: "IT Root",
					},
					{ interactive_only: true },
				);
				expect(r.text).toContain("<untrusted_page_content boundary=");
				expect(r.text).toContain("link");
				// password field must show placeholder, not its value
				expect(r.text).not.toContain("super-secret-123");
				expect(r.refsCount).toBeGreaterThan(0);
			} finally {
				await close();
			}
		},
		20_000,
	);

	it.skipIf(launchFailed)(
		"act click on a link navigates the page",
		async () => {
			if (!browser) return;
			const { page, cdp, close } = await setupPage();
			try {
				const registry = new RefRegistry();
				await snapshot(
					{ cdp, registry, pageUrl: "", pageTitle: "" },
					{ interactive_only: true },
				);
				// find the link ref
				const refEntries = Array.from(
					(
						registry as unknown as {
							byRef: Map<string, { role: string; name: string }>;
						}
					).byRef.entries(),
				);
				const linkEntry = refEntries.find(
					([, v]) => v.role === "link" && v.name.includes("target"),
				);
				expect(linkEntry).toBeDefined();
				const [ref] = linkEntry as [string, { role: string; name: string }];
				const r = await act({ cdp, registry }, { action: "click", ref });
				expect(r.ok).toBe(true);
				await page.waitForURL(/\/target$/, { timeout: 5000 });
			} finally {
				await close();
			}
		},
		20_000,
	);

	it.skipIf(launchFailed)(
		"read returns page heading text",
		async () => {
			if (!browser) return;
			const { cdp, close } = await setupPage();
			try {
				const registry = new RefRegistry();
				const r = await read(
					{ cdp, registry, pageUrl: "x", pageTitle: "y" },
					{ selector: "h1" },
				);
				expect(r.ok).toBe(true);
				expect(r.text).toContain("Integration Test Page");
			} finally {
				await close();
			}
		},
		20_000,
	);

	it.skipIf(launchFailed)(
		"goto navigates to an allowed URL",
		async () => {
			if (!browser) return;
			const { page, cdp, close } = await setupPage();
			try {
				const r = await goto({ cdp }, { url: "http://example.test/target" });
				expect(r.ok).toBe(true);
				expect(page.url()).toMatch(/\/target$/);
			} finally {
				await close();
			}
		},
		20_000,
	);
});
