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

const LOG_PREFIX = "[mdm]";

export interface MdmPollerOpts {
	/** MDM endpoint URL. */
	url: string;
	/**
	 * How often to re-fetch (ms). The first fetch is scheduled immediately on
	 * `start()` (fire-and-forget — `start()` returns synchronously, the first
	 * task may run before the fetch resolves). This interval governs subsequent
	 * polls.
	 */
	pollIntervalMs: number;
	/** Called with each successfully parsed remote policy. */
	onFetched: (remote: AdminPolicy) => void;
	/** Injectable for tests; defaults to globalThis.fetch. */
	fetchFn?: typeof globalThis.fetch;
	/**
	 * Injectable logger; defaults to a console.warn that prepends `[mdm]`.
	 * Messages passed to `logger.warn` already include the prefix so injected
	 * loggers (tests, audit collectors) see the same string the console does.
	 */
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
	private readonly warn: (msg: string) => void;
	private readonly fetchTimeoutMs: number;

	private timer: ReturnType<typeof setInterval> | undefined;
	private polling = false;
	/**
	 * Once stopped, an in-flight fetch must NOT call `onFetched` even if its
	 * promise resolves later — the app is shutting down and downstream
	 * consumers may be torn down. Also gates `setInterval` callbacks that fire
	 * after `clearInterval` on platforms with sloppy timer semantics.
	 */
	private stopped = false;

	constructor(opts: MdmPollerOpts) {
		this.url = opts.url;
		this.pollIntervalMs = opts.pollIntervalMs;
		this.onFetched = opts.onFetched;
		this.fetchFn = opts.fetchFn ?? globalThis.fetch.bind(globalThis);
		const userWarn = opts.logger?.warn ?? ((m: string) => console.warn(m));
		this.warn = (msg) => userWarn(`${LOG_PREFIX} ${msg}`);
		this.fetchTimeoutMs = opts.fetchTimeoutMs ?? 30_000;
	}

	/** Schedules an immediate fetch (non-blocking) plus a periodic interval. */
	start(): void {
		void this.poll();
		this.timer = setInterval(() => {
			void this.poll();
		}, this.pollIntervalMs);
	}

	/** Stop periodic polling. Any in-flight fetch's result is discarded. */
	stop(): void {
		this.stopped = true;
		if (this.timer !== undefined) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
	}

	/** @internal Test-only entry point — production code should call `start()`. */
	async pollNow(): Promise<void> {
		await this.poll();
	}

	private async poll(): Promise<void> {
		if (this.stopped) return;
		if (this.polling) {
			this.warn("previous poll still running, skipping");
			return;
		}
		this.polling = true;
		try {
			await this.fetchAndApply();
		} finally {
			this.polling = false;
		}
	}

	private async fetchAndApply(): Promise<void> {
		const remote = await this.fetchRemote();
		if (remote === null) return;
		// Stopped between fetch resolution and apply — drop the result.
		if (this.stopped) return;
		try {
			this.onFetched(remote);
		} catch (err) {
			this.warn(`onFetched threw: ${errMsg(err)}`);
		}
	}

	/**
	 * Fetch + parse + validate. Returns the parsed policy or `null` on any
	 * failure (logged). Centralising the failure paths keeps `fetchAndApply`
	 * focused on the success-side decisions.
	 */
	private async fetchRemote(): Promise<AdminPolicy | null> {
		let res: Response;
		try {
			res = await this.fetchFn(this.url, {
				signal: AbortSignal.timeout(this.fetchTimeoutMs),
				headers: { Accept: "application/json" },
			});
		} catch (err) {
			this.warn(`fetch failed for ${this.url}: ${errMsg(err)}`);
			return null;
		}
		if (!res.ok) {
			this.warn(`endpoint returned HTTP ${res.status} — skipping`);
			return null;
		}
		let json: unknown;
		try {
			json = await res.json();
		} catch (err) {
			this.warn(`response is not valid JSON: ${errMsg(err)}`);
			return null;
		}
		const result = AdminPolicySchema.safeParse(json);
		if (!result.success) {
			this.warn(
				`policy failed schema validation: ${JSON.stringify(result.error.issues)}`,
			);
			return null;
		}
		return result.data;
	}
}

function errMsg(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
