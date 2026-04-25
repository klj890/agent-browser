/**
 * MdmPoller (Stage 20 — Enterprise MDM).
 *
 * Fetches AdminPolicy JSON from a remote URL on startup and then on a
 * configurable interval. A successful fetch calls `onFetched` with the parsed
 * policy; on any error (network, non-200, schema validation) it logs a warning
 * and retains the previous effective policy unchanged.
 *
 * The caller decides merge semantics — typically:
 *   effective = { ...remote, mdm: local.mdm }
 * so the remote endpoint can override everything except its own URL/interval.
 */
import { type AdminPolicy, AdminPolicySchema } from "./admin-policy.js";

export interface MdmPollerOpts {
	/** MDM endpoint URL. */
	url: string;
	/**
	 * How often to re-fetch (ms). The first fetch happens synchronously on
	 * `start()` — this interval governs subsequent polls.
	 */
	pollIntervalMs: number;
	/** Called with each successfully parsed remote policy. */
	onFetched: (remote: AdminPolicy) => void;
	/** Injectable for tests; defaults to globalThis.fetch. */
	fetchFn?: typeof globalThis.fetch;
	/** Injectable logger; defaults to console.warn. */
	logger?: { warn: (msg: string) => void };
	/**
	 * Per-request fetch timeout (ms). Prevents a slow MDM endpoint from
	 * blocking the poll indefinitely. Default: 30 s.
	 */
	fetchTimeoutMs?: number;
}

export class MdmPoller {
	private readonly url: string;
	private readonly pollIntervalMs: number;
	private readonly onFetched: (remote: AdminPolicy) => void;
	private readonly fetchFn: typeof globalThis.fetch;
	private readonly logger: { warn: (msg: string) => void };
	private readonly fetchTimeoutMs: number;

	private timer: ReturnType<typeof setInterval> | undefined;
	/** Prevent concurrent polls if a fetch takes longer than the interval. */
	private polling = false;

	constructor(opts: MdmPollerOpts) {
		this.url = opts.url;
		this.pollIntervalMs = opts.pollIntervalMs;
		this.onFetched = opts.onFetched;
		this.fetchFn = opts.fetchFn ?? globalThis.fetch.bind(globalThis);
		this.logger = opts.logger ?? { warn: (m) => console.warn(`[mdm] ${m}`) };
		this.fetchTimeoutMs = opts.fetchTimeoutMs ?? 30_000;
	}

	/** Fetch once immediately, then schedule periodic polls. */
	start(): void {
		void this.poll();
		this.timer = setInterval(() => {
			void this.poll();
		}, this.pollIntervalMs);
	}

	/** Stop periodic polling. Any in-flight fetch completes but its result is discarded. */
	stop(): void {
		if (this.timer !== undefined) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
	}

	/** Exposed for tests — allows triggering a poll without waiting for the interval. */
	async pollNow(): Promise<void> {
		await this.poll();
	}

	private async poll(): Promise<void> {
		if (this.polling) return; // skip if previous poll is still running
		this.polling = true;
		try {
			await this.fetchAndApply();
		} finally {
			this.polling = false;
		}
	}

	private async fetchAndApply(): Promise<void> {
		let res: Response;
		try {
			res = await this.fetchFn(this.url, {
				signal: AbortSignal.timeout(this.fetchTimeoutMs),
				headers: { Accept: "application/json" },
			});
		} catch (err) {
			this.logger.warn(
				`fetch failed for ${this.url}: ${err instanceof Error ? err.message : String(err)}`,
			);
			return;
		}

		if (!res.ok) {
			this.logger.warn(`MDM endpoint returned HTTP ${res.status} — skipping`);
			return;
		}

		let json: unknown;
		try {
			json = await res.json();
		} catch (err) {
			this.logger.warn(
				`MDM response is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
			);
			return;
		}

		const result = AdminPolicySchema.safeParse(json);
		if (!result.success) {
			this.logger.warn(
				`MDM policy failed schema validation: ${JSON.stringify(result.error.issues)}`,
			);
			return;
		}

		this.onFetched(result.data);
	}
}
