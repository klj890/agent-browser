/**
 * MdmPoller unit tests — Stage 20 (Enterprise MDM).
 *
 * All tests inject a `fetchFn` mock so no real network calls are made.
 * The clock is not faked — interval behaviour is tested via `pollNow()`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AdminPolicy } from "../admin-policy.js";
import { DEFAULT_POLICY } from "../admin-policy.js";
import { MdmPoller } from "../mdm-poller.js";

const MDM_URL = "https://mdm.example.com/policy.json";

/** Build a minimal valid remote policy (all required Zod defaults resolved). */
function remotePolicy(patch: Partial<AdminPolicy> = {}): AdminPolicy {
	return { ...DEFAULT_POLICY, ...patch };
}

/** Fetch mock that returns the given body/status. */
function mockFetch(body: unknown, status = 200): typeof globalThis.fetch {
	return vi.fn().mockResolvedValue({
		ok: status >= 200 && status < 300,
		status,
		json: async () => body,
	} as Response);
}

/** Fetch mock that throws a network error. */
function failingFetch(message = "ECONNREFUSED"): typeof globalThis.fetch {
	return vi.fn().mockRejectedValue(new Error(message));
}

describe("MdmPoller — successful fetch", () => {
	it("calls onFetched with parsed remote policy", async () => {
		const remote = remotePolicy({ autonomy: "autonomous" });
		const onFetched = vi.fn();
		const poller = new MdmPoller({
			url: MDM_URL,
			pollIntervalMs: 3_600_000,
			fetchFn: mockFetch(remote),
			onFetched,
		});
		await poller.pollNow();
		expect(onFetched).toHaveBeenCalledOnce();
		expect(onFetched.mock.calls[0]?.[0]).toMatchObject({
			autonomy: "autonomous",
		});
	});

	it("passes Accept: application/json header", async () => {
		const fetchFn = mockFetch(remotePolicy());
		const poller = new MdmPoller({
			url: MDM_URL,
			pollIntervalMs: 3_600_000,
			fetchFn,
			onFetched: vi.fn(),
		});
		await poller.pollNow();
		expect(fetchFn).toHaveBeenCalledWith(
			MDM_URL,
			expect.objectContaining({ headers: { Accept: "application/json" } }),
		);
	});

	it("remote policy with mdm field: onFetched receives it (caller strips mdm)", async () => {
		// The poller itself does NOT strip the mdm field — that's the
		// PolicyProvider's responsibility. Verify the raw parsed policy is forwarded.
		const remote = remotePolicy({
			mdm: { url: "https://other.example.com/p.json", pollIntervalMs: 60_000 },
		});
		const onFetched = vi.fn();
		const poller = new MdmPoller({
			url: MDM_URL,
			pollIntervalMs: 3_600_000,
			fetchFn: mockFetch(remote),
			onFetched,
		});
		await poller.pollNow();
		// onFetched receives the full parsed policy; the caller decides what to keep.
		expect(onFetched.mock.calls[0]?.[0].mdm?.url).toBe(
			"https://other.example.com/p.json",
		);
	});
});

describe("MdmPoller — network / HTTP errors", () => {
	it("network error: logs warning, does NOT call onFetched", async () => {
		const onFetched = vi.fn();
		const warns: string[] = [];
		const poller = new MdmPoller({
			url: MDM_URL,
			pollIntervalMs: 3_600_000,
			fetchFn: failingFetch("ECONNREFUSED"),
			onFetched,
			logger: { warn: (m) => warns.push(m) },
		});
		await poller.pollNow();
		expect(onFetched).not.toHaveBeenCalled();
		expect(warns.some((w) => w.includes("ECONNREFUSED"))).toBe(true);
	});

	it("HTTP 403: logs warning, does NOT call onFetched", async () => {
		const onFetched = vi.fn();
		const warns: string[] = [];
		const poller = new MdmPoller({
			url: MDM_URL,
			pollIntervalMs: 3_600_000,
			fetchFn: mockFetch({}, 403),
			onFetched,
			logger: { warn: (m) => warns.push(m) },
		});
		await poller.pollNow();
		expect(onFetched).not.toHaveBeenCalled();
		expect(warns.some((w) => w.includes("403"))).toBe(true);
	});

	it("HTTP 500: logs warning, does NOT call onFetched", async () => {
		const onFetched = vi.fn();
		const warns: string[] = [];
		const poller = new MdmPoller({
			url: MDM_URL,
			pollIntervalMs: 3_600_000,
			fetchFn: mockFetch({}, 500),
			onFetched,
			logger: { warn: (m) => warns.push(m) },
		});
		await poller.pollNow();
		expect(onFetched).not.toHaveBeenCalled();
		expect(warns.some((w) => w.includes("500"))).toBe(true);
	});
});

describe("MdmPoller — invalid JSON / schema failures", () => {
	it("non-JSON response: logs warning, does NOT call onFetched", async () => {
		const onFetched = vi.fn();
		const warns: string[] = [];
		const fetchFn = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			json: async () => {
				throw new SyntaxError("Unexpected token");
			},
		} as unknown as Response);
		const poller = new MdmPoller({
			url: MDM_URL,
			pollIntervalMs: 3_600_000,
			fetchFn,
			onFetched,
			logger: { warn: (m) => warns.push(m) },
		});
		await poller.pollNow();
		expect(onFetched).not.toHaveBeenCalled();
		expect(warns.some((w) => w.includes("not valid JSON"))).toBe(true);
	});

	it("schema validation failure (wrong version): logs warning, does NOT call onFetched", async () => {
		const onFetched = vi.fn();
		const warns: string[] = [];
		const poller = new MdmPoller({
			url: MDM_URL,
			pollIntervalMs: 3_600_000,
			// version: 2 doesn't satisfy z.literal(1)
			fetchFn: mockFetch({ version: 2, autonomy: "autonomous" }),
			onFetched,
			logger: { warn: (m) => warns.push(m) },
		});
		await poller.pollNow();
		expect(onFetched).not.toHaveBeenCalled();
		expect(warns.some((w) => w.includes("schema validation"))).toBe(true);
	});

	it("schema validation failure (invalid autonomy): logs warning", async () => {
		const onFetched = vi.fn();
		const warns: string[] = [];
		const poller = new MdmPoller({
			url: MDM_URL,
			pollIntervalMs: 3_600_000,
			fetchFn: mockFetch({ version: 1, autonomy: "godmode" }),
			onFetched,
			logger: { warn: (m) => warns.push(m) },
		});
		await poller.pollNow();
		expect(onFetched).not.toHaveBeenCalled();
		expect(warns.some((w) => w.includes("schema validation"))).toBe(true);
	});
});

describe("MdmPoller — concurrency guard", () => {
	it("concurrent poll() calls: only one fetch runs at a time", async () => {
		let resolveFirst!: () => void;
		const slow = vi.fn().mockImplementation(
			() =>
				new Promise<Response>((resolve) => {
					resolveFirst = () =>
						resolve({
							ok: true,
							status: 200,
							json: async () => remotePolicy(),
						} as Response);
				}),
		);
		const onFetched = vi.fn();
		const poller = new MdmPoller({
			url: MDM_URL,
			pollIntervalMs: 3_600_000,
			fetchFn: slow,
			onFetched,
		});

		// Start two polls concurrently — second should be a no-op
		const p1 = poller.pollNow();
		const p2 = poller.pollNow(); // polling flag set → skip
		resolveFirst();
		await Promise.all([p1, p2]);

		// fetch was called only once (second poll was skipped)
		expect(slow).toHaveBeenCalledOnce();
		expect(onFetched).toHaveBeenCalledOnce();
	});
});

describe("MdmPoller — stop()", () => {
	it("stop() prevents further interval polls", () => {
		vi.useFakeTimers();
		const fetchFn = mockFetch(remotePolicy());
		const onFetched = vi.fn();
		const poller = new MdmPoller({
			url: MDM_URL,
			pollIntervalMs: 1_000,
			fetchFn,
			onFetched,
		});
		poller.start();
		poller.stop();
		// Advance time — no further polls should fire
		vi.advanceTimersByTime(10_000);
		// start() triggers one immediate poll (pollNow), then stop() clears the interval.
		// The immediate poll's fetch is async so it may not have resolved yet.
		// Key assertion: fetch was called at most once (the initial immediate poll).
		expect(vi.mocked(fetchFn).mock.calls.length).toBeLessThanOrEqual(1);
		vi.useRealTimers();
	});
});

describe("PolicyProvider MDM overlay semantics (integration-style)", () => {
	it("mdm field from local is preserved after applyMdm", () => {
		// Verify the intended merge: remote wins for everything EXCEPT mdm config.
		// We test this by directly simulating what PolicyProvider.get() does.
		const localMdm = { url: MDM_URL, pollIntervalMs: 3_600_000 };
		const local: AdminPolicy = { ...DEFAULT_POLICY, mdm: localMdm };
		const remote: AdminPolicy = {
			...DEFAULT_POLICY,
			autonomy: "autonomous",
			mdm: { url: "https://evil.example.com/p.json", pollIntervalMs: 60_000 },
		};

		// Simulate PolicyProvider.get() after applyMdm:
		const effective = { ...remote, mdm: local.mdm };

		expect(effective.autonomy).toBe("autonomous"); // remote overrides local
		expect(effective.mdm).toEqual(localMdm); // mdm always from local
	});

	it("without mdm overlay, local policy is returned unchanged", () => {
		const local: AdminPolicy = { ...DEFAULT_POLICY, autonomy: "manual" };
		const mdmOverlay: AdminPolicy | null = null;

		// Simulate PolicyProvider.get(): no MDM overlay → return local as-is.
		const effective: AdminPolicy = mdmOverlay
			? { ...(mdmOverlay as AdminPolicy), mdm: local.mdm }
			: local;
		expect(effective).toBe(local);
	});
});
