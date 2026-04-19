/**
 * e2e #6 — admin gate (autonomous + allowedDomains).
 *
 * PLAN scenario 5 — "autonomous + allowedDomains:['github.com'] → navigate to
 * malicious.com → 被拒". We exercise `checkUrlAllowed` from browser-tools/goto
 * directly (the same predicate goto() runs pre-navigation).
 */
import { describe, expect, it } from "vitest";
import { checkUrlAllowed } from "../packages/browser-tools/src/goto.js";

describe("e2e/admin-gate-autonomous-domain: URL allowlist gates navigation", () => {
	const policy = {
		allowedDomains: ["example.com"],
		allowedUrlSchemes: ["https", "http"] as const,
		blockedDomains: [] as string[],
	};

	it("allows a URL on an allowlisted domain", () => {
		const r = checkUrlAllowed("https://example.com/foo", policy);
		expect(r.allowed).toBe(true);
	});

	it("rejects a URL on a non-allowlisted domain", () => {
		const r = checkUrlAllowed("https://evil.com/foo", policy);
		expect(r.allowed).toBe(false);
		expect(r.reason).toBeDefined();
	});

	it("rejects a data: URL even when domain parsing returns none", () => {
		const r = checkUrlAllowed("data:text/html,<b>evil</b>", {
			...policy,
			allowedUrlSchemes: ["http", "https"],
		});
		expect(r.allowed).toBe(false);
	});

	it("allows sub-path of an allowed host", () => {
		const r = checkUrlAllowed("https://example.com/deep/path?q=1", policy);
		expect(r.allowed).toBe(true);
	});
});
