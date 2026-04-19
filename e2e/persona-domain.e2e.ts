/**
 * e2e #3 — persona ↔ domain auto-switch (PLAN scenario 3).
 *
 * Verifies that `PersonaManager.matchByDomain` returns the correct persona for
 * glob patterns like `*.github.com`, and that a TabManager did-navigate event
 * could drive the switch. We don't wire a live agent-host here — we just
 * assert the matching primitive behaves correctly end-to-end.
 */
import { describe, expect, it } from "vitest";
import {
	PersonaManager,
	parsePersona,
} from "../apps/main/src/persona-manager.js";

function mkPersona(slug: string, domains: string[]) {
	const md = [
		"---",
		`name: "${slug}"`,
		`description: for ${slug}`,
		`domains: [${domains.join(", ")}]`,
		"---",
		"body",
	].join("\n");
	return parsePersona(slug, md);
}

describe("e2e/persona-domain: matchByDomain drives tab auto-switch", () => {
	const mgr = new PersonaManager();
	mgr.register(mkPersona("github-helper", ["*.github.com"]));
	mgr.register(mkPersona("shopping", ["amazon.com", "*.amazon.com"]));
	mgr.register(mkPersona("default", ["*"]));

	it("matches glob subdomain (*.github.com)", () => {
		expect(mgr.matchByDomain("https://api.github.com/repos")?.slug).toBe(
			"github-helper",
		);
		expect(mgr.matchByDomain("https://github.com/klj890")?.slug).toBe(
			"github-helper",
		);
	});

	it("matches exact host alongside wildcard", () => {
		expect(mgr.matchByDomain("https://amazon.com/dp/X")?.slug).toBe("shopping");
		expect(mgr.matchByDomain("https://www.amazon.com/dp/X")?.slug).toBe(
			"shopping",
		);
	});

	it("falls through to '*' catch-all persona", () => {
		expect(mgr.matchByDomain("https://example.org/")?.slug).toBe("default");
	});

	it("returns undefined for malformed URL", () => {
		expect(mgr.matchByDomain("not a url")).toBeUndefined();
	});
});
