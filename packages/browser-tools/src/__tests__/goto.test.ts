import { describe, expect, it } from "vitest";
import { checkUrlAllowed, goto } from "../goto.js";

function makeCdp(
	opts: {
		onNavigate?: (params: unknown) => unknown;
		fireEvent?: "Page.loadEventFired" | "Page.domContentEventFired";
		fireDelayMs?: number;
	} = {},
) {
	type Listener = (p: unknown) => void;
	const listeners = new Map<string, Set<Listener>>();
	const calls: Array<{ method: string; params?: object }> = [];
	const cdp = {
		send: async <T>(method: string, params?: object): Promise<T> => {
			calls.push({ method, params });
			if (method === "Page.navigate") {
				if (opts.onNavigate) return opts.onNavigate(params) as T;
				// schedule event
				if (opts.fireEvent !== null) {
					const event = opts.fireEvent ?? "Page.domContentEventFired";
					setTimeout(() => {
						for (const l of listeners.get(event) ?? []) l({});
					}, opts.fireDelayMs ?? 5);
				}
				return { frameId: "frame-1" } as unknown as T;
			}
			return {} as T;
		},
		on: (method: string, cb: Listener) => {
			const set = listeners.get(method) ?? new Set();
			set.add(cb);
			listeners.set(method, set);
			return () => {
				set.delete(cb);
			};
		},
	};
	return { cdp, calls };
}

describe("checkUrlAllowed", () => {
	it("allows default http/https", () => {
		expect(checkUrlAllowed("https://example.com/").allowed).toBe(true);
		expect(checkUrlAllowed("http://example.com/").allowed).toBe(true);
	});
	it("blocks file: and javascript: schemes by default", () => {
		const r = checkUrlAllowed("javascript:alert(1)") as {
			allowed: false;
			reason: string;
		};
		expect(r.allowed).toBe(false);
		expect(r.reason).toBe("scheme_blocked");
	});
	it("invalid URL string returns invalid_url", () => {
		const r = checkUrlAllowed("::::") as { allowed: false; reason: string };
		expect(r.allowed).toBe(false);
		expect(r.reason).toBe("invalid_url");
	});
	it("domain whitelist with glob matches", () => {
		expect(
			checkUrlAllowed("https://sub.example.com/", {
				allowedDomains: ["*.example.com"],
			}).allowed,
		).toBe(true);
		const r = checkUrlAllowed("https://evil.com/", {
			allowedDomains: ["*.example.com"],
		}) as { allowed: false; reason: string };
		expect(r.allowed).toBe(false);
		expect(r.reason).toBe("domain_not_allowed");
	});
	it("blocked domain wins over allowed", () => {
		const r = checkUrlAllowed("https://evil.example.com/", {
			allowedDomains: ["*.example.com"],
			blockedDomains: ["evil.example.com"],
		}) as { allowed: false; reason: string };
		expect(r.allowed).toBe(false);
		expect(r.reason).toBe("domain_blocked");
	});
});

describe("goto", () => {
	it("success path fires domContentEventFired and resolves ok", async () => {
		const { cdp, calls } = makeCdp({});
		const r = await goto({ cdp }, { url: "https://example.com/" });
		expect(r.ok).toBe(true);
		expect(calls[0]?.method).toBe("Page.navigate");
	});

	it("rejects non-allowed scheme before touching CDP", async () => {
		const { cdp, calls } = makeCdp({});
		const r = await goto({ cdp }, { url: "javascript:alert(1)" });
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.reason).toBe("scheme_blocked");
		expect(calls).toHaveLength(0);
	});

	it("rejects domain_not_allowed when policy whitelist misses", async () => {
		const { cdp } = makeCdp({});
		const r = await goto(
			{
				cdp,
				policy: { allowedDomains: ["example.com"] },
			},
			{ url: "https://other.com/" },
		);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.reason).toBe("domain_not_allowed");
	});

	it("times out when event never fires", async () => {
		const { cdp } = makeCdp({
			onNavigate: () => ({ frameId: "f" }),
		});
		const r = await goto(
			{ cdp },
			{ url: "https://example.com/", timeoutMs: 50 },
		);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.reason).toBe("timeout");
	});

	it("surfaces errorText from Page.navigate as navigate_failed", async () => {
		const { cdp } = makeCdp({
			onNavigate: () => ({ errorText: "net::ERR_NAME_NOT_RESOLVED" }),
		});
		const r = await goto({ cdp }, { url: "https://nope.invalid/" });
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.reason).toBe("navigate_failed");
	});

	it("waitUntil=load subscribes to loadEventFired", async () => {
		const { cdp } = makeCdp({ fireEvent: "Page.loadEventFired" });
		const r = await goto(
			{ cdp },
			{ url: "https://example.com/", waitUntil: "load" },
		);
		expect(r.ok).toBe(true);
	});
});
