/**
 * Stage 2 pre-flight spike: validate ref-registry stability.
 * Run: pnpm spike:ref
 * Requires: playwright-core + @playwright/browser-chromium (dev only; not runtime deps).
 *
 * We drive the browser via CDP directly (page.context().newCDPSession) to
 * match what Stage 2 will do (webContents.debugger.attach in production).
 * This exercises the same Accessibility.getFullAXTree path.
 */
import { type CDPSession, chromium, type Page } from "playwright-core";
import { RefRegistry } from "../packages/browser-tools/src/ref-registry.js";

const TARGETS = [
	{ name: "github-repo", url: "https://github.com/microsoft/playwright" },
	{ name: "static-blog", url: "https://example.com/" },
	{ name: "mdn-home", url: "https://developer.mozilla.org/" },
	{ name: "hn", url: "https://news.ycombinator.com/" },
	{ name: "wikipedia", url: "https://en.wikipedia.org/wiki/Web_browser" },
];
const RUNS = 10;
const INTERACTIVE_ROLES = new Set([
	"button",
	"link",
	"textbox",
	"combobox",
	"checkbox",
	"radio",
	"menuitem",
	"tab",
	"switch",
	"searchbox",
	"slider",
]);

interface Sample {
	ref: string;
	backendNodeId: number;
	role: string;
	name: string;
}

interface AxNode {
	nodeId: string;
	backendDOMNodeId?: number;
	role?: { type?: string; value?: unknown };
	name?: { type?: string; value?: unknown };
	ignored?: boolean;
	childIds?: string[];
}

async function snapshotViaCdp(
	cdp: CDPSession,
	registry: RefRegistry,
): Promise<Sample[]> {
	const res = (await cdp.send("Accessibility.getFullAXTree")) as {
		nodes: AxNode[];
	};
	const out: Sample[] = [];
	for (const node of res.nodes) {
		if (node.ignored) continue;
		const role = typeof node.role?.value === "string" ? node.role.value : "";
		if (!INTERACTIVE_ROLES.has(role)) continue;
		if (typeof node.backendDOMNodeId !== "number") continue;
		const rawName = node.name?.value;
		const name = typeof rawName === "string" ? rawName.slice(0, 60) : "";
		const ref = registry.allocate({
			backendNodeId: node.backendDOMNodeId,
			role,
			name,
		});
		out.push({ ref, backendNodeId: node.backendDOMNodeId, role, name });
	}
	registry.sweep(10 * 60_000);
	return out;
}

async function runTarget(
	page: Page,
	cdp: CDPSession,
	url: string,
): Promise<{ base_count: number; consistency: number }> {
	await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
	const registry = new RefRegistry();
	const runs: Sample[][] = [];
	for (let i = 0; i < RUNS; i++) {
		runs.push(await snapshotViaCdp(cdp, registry));
		await page.waitForTimeout(200);
	}
	const base = runs[0] ?? [];
	let matched = 0;
	let total = 0;
	for (let i = 1; i < RUNS; i++) {
		for (const s of runs[i] ?? []) {
			const b = base.find((x) => x.backendNodeId === s.backendNodeId);
			if (b) {
				total += 1;
				if (b.ref === s.ref) matched += 1;
			}
		}
	}
	const rate = total === 0 ? 0 : matched / total;
	return { base_count: base.length, consistency: rate };
}

async function main(): Promise<void> {
	const browser = await chromium.launch({ headless: true });
	const results: Array<{
		target: string;
		base_count: number;
		consistency: number;
	}> = [];

	for (const t of TARGETS) {
		const page = await browser.newPage();
		try {
			const cdp = await page.context().newCDPSession(page);
			await cdp.send("Accessibility.enable");
			const r = await runTarget(page, cdp, t.url);
			results.push({ target: t.name, ...r });
		} catch (e) {
			results.push({ target: t.name, base_count: -1, consistency: 0 });
			console.error(`spike error on ${t.name}:`, e);
		} finally {
			await page.close();
		}
	}

	await browser.close();
	console.table(results);

	const failed = results.filter((r) => r.consistency < 0.95);
	if (failed.length) {
		console.error("SPIKE FAILED:", failed);
		process.exit(1);
	} else {
		console.log("SPIKE PASSED: all targets >= 0.95 consistency");
	}
}

main();
