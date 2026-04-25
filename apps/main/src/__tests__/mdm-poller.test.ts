/**
 * MdmPoller unit tests — Stage 20 (Enterprise MDM).
 *
 * All tests inject a `fetchFn` mock so no real network calls are made.
 * The clock is not faked — interval behaviour is tested via `pollNow()`.
 */
import { describe, expect, it, vi } from "vitest";
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
		expect(warns.every((w) => w.startsWith("[mdm]"))).toBe(true);
	});

	it.each([401, 403, 500, 502])(
		"HTTP %i: logs warning, does NOT call onFetched",
		async (status) => {
			const onFetched = vi.fn();
			const warns: string[] = [];
			const poller = new MdmPoller({
				url: MDM_URL,
				pollIntervalMs: 3_600_000,
				fetchFn: mockFetch({}, status),
				onFetched,
				logger: { warn: (m) => warns.push(m) },
			});
			await poller.pollNow();
			expect(onFetched).not.toHaveBeenCalled();
			expect(warns.some((w) => w.includes(String(status)))).toBe(true);
		},
	);
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
	it("concurrent poll() calls: only one fetch runs, second logs skip", async () => {
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
		const warns: string[] = [];
		const poller = new MdmPoller({
			url: MDM_URL,
			pollIntervalMs: 3_600_000,
			fetchFn: slow,
			onFetched,
			logger: { warn: (m) => warns.push(m) },
		});

		const p1 = poller.pollNow();
		const p2 = poller.pollNow();
		resolveFirst();
		await Promise.all([p1, p2]);

		expect(slow).toHaveBeenCalledOnce();
		expect(onFetched).toHaveBeenCalledOnce();
		// The skipped second poll surfaces an operational signal so admins can
		// notice when the configured interval is shorter than fetch latency.
		expect(warns.some((w) => w.includes("previous poll still running"))).toBe(
			true,
		);
	});
});

describe("MdmPoller — stop()", () => {
	it("stop() before start: a subsequent pollNow is a no-op", async () => {
		const fetchFn = mockFetch(remotePolicy());
		const onFetched = vi.fn();
		const poller = new MdmPoller({
			url: MDM_URL,
			pollIntervalMs: 1_000,
			fetchFn,
			onFetched,
		});
		poller.stop();
		await poller.pollNow();
		expect(fetchFn).not.toHaveBeenCalled();
		expect(onFetched).not.toHaveBeenCalled();
	});

	it("stop() during in-flight fetch drops the result (race protection)", async () => {
		let resolveFetch!: () => void;
		const slow = vi.fn().mockImplementation(
			() =>
				new Promise<Response>((resolve) => {
					resolveFetch = () =>
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

		const inFlight = poller.pollNow();
		// stop() while the fetch is still pending — onFetched must NOT fire
		// once the fetch eventually resolves (renderer may already be torn down).
		poller.stop();
		resolveFetch();
		await inFlight;

		expect(slow).toHaveBeenCalledOnce();
		expect(onFetched).not.toHaveBeenCalled();
	});
});

describe("MdmPoller — onFetched error boundary", () => {
	it("onFetched throwing does not propagate; warns instead", async () => {
		const warns: string[] = [];
		const poller = new MdmPoller({
			url: MDM_URL,
			pollIntervalMs: 3_600_000,
			fetchFn: mockFetch(remotePolicy()),
			onFetched: () => {
				throw new Error("downstream apply failed");
			},
			logger: { warn: (m) => warns.push(m) },
		});
		// Must not throw — the poller's contract is that onFetched failures
		// are isolated so the next poll still runs.
		await expect(poller.pollNow()).resolves.toBeUndefined();
		expect(warns.some((w) => w.includes("onFetched threw"))).toBe(true);
	});
});
