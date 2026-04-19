/**
 * CdpAdapter — thin wrapper over Electron's `webContents.debugger`.
 *
 * Per PLAN Stage 2.1 / 附录 H: we don't pull in a third-party CDP client;
 * Electron already has one. This class gives the rest of Stage 2
 * (snapshot / act / read / goto / screenshot) a tiny, typed surface.
 *
 *   const cdp = new CdpAdapter(webContents);
 *   await cdp.ready();                              // attaches + enables default domains
 *   const tree = await cdp.send('Accessibility.getFullAXTree');
 *   const off = cdp.on('Page.frameNavigated', (p) => ...);
 *   off();
 *   cdp.detach();
 *
 * Reconnect: if `send` rejects with a detach-class error, we re-attach up
 * to 3 times before surfacing `CdpUnavailableError`.
 */
import type { WebContents } from "electron";

export class CdpUnavailableError extends Error {
	constructor(
		message: string,
		override readonly cause?: unknown,
	) {
		super(message);
		this.name = "CdpUnavailableError";
	}
}

export type CdpEventHandler = (params: unknown) => void;

/** Minimal shape we need from Electron's Debugger. Makes tests easier. */
export interface DebuggerLike {
	attach(protocolVersion?: string): void;
	detach(): void;
	isAttached(): boolean;
	sendCommand(method: string, params?: object): Promise<unknown>;
	on(event: string, listener: (...args: unknown[]) => void): unknown;
	off(event: string, listener: (...args: unknown[]) => void): unknown;
}

export interface WebContentsLike {
	debugger: DebuggerLike;
	isDestroyed(): boolean;
}

const DEFAULT_DOMAINS = ["Page.enable", "DOM.enable", "Accessibility.enable"];
const PROTOCOL_VERSION = "1.3";
const MAX_RECONNECTS = 3;

export class CdpAdapter {
	private readonly dbg: DebuggerLike;
	private readonly listeners = new Map<string, Set<CdpEventHandler>>();
	private readyPromise?: Promise<void>;
	private detachedReason?: string;
	private disposed = false;
	private messageHandler: (...args: unknown[]) => void;
	private detachHandler: (...args: unknown[]) => void;

	constructor(webContents: WebContents | WebContentsLike) {
		const wc = webContents as unknown as WebContentsLike;
		this.dbg = wc.debugger;
		this.messageHandler = (...args: unknown[]) => {
			const method = args[1] as string;
			const params = args[2];
			const set = this.listeners.get(method);
			if (!set) return;
			for (const cb of set) {
				try {
					cb(params);
				} catch {
					/* listener errors must not break CDP pipe */
				}
			}
		};
		this.detachHandler = (...args: unknown[]) => {
			this.detachedReason = String(args[1] ?? "detach");
		};
		this.dbg.on("message", this.messageHandler);
		this.dbg.on("detach", this.detachHandler);
		// kick off attach eagerly so callers can race `await cdp.ready()`
		this.readyPromise = this.attachAndEnable();
	}

	/** Await initial attach + default-domain enables. */
	ready(): Promise<void> {
		return this.readyPromise ?? Promise.resolve();
	}

	async send<T = unknown>(method: string, params?: object): Promise<T> {
		if (this.disposed) throw new CdpUnavailableError("CdpAdapter disposed");
		await this.ready();
		let lastErr: unknown;
		for (let attempt = 0; attempt <= MAX_RECONNECTS; attempt++) {
			try {
				return (await this.dbg.sendCommand(method, params)) as T;
			} catch (err) {
				lastErr = err;
				if (!this.isDetachError(err)) throw err;
				if (attempt >= MAX_RECONNECTS) break;
				this.readyPromise = this.attachAndEnable();
				try {
					await this.readyPromise;
				} catch (reErr) {
					lastErr = reErr;
					break;
				}
			}
		}
		throw new CdpUnavailableError(
			`CDP send failed after ${MAX_RECONNECTS} reconnects: ${method}`,
			lastErr,
		);
	}

	/** Subscribe to a CDP event. Returns the unsubscribe function. */
	on(method: string, cb: CdpEventHandler): () => void {
		let set = this.listeners.get(method);
		if (!set) {
			set = new Set();
			this.listeners.set(method, set);
		}
		set.add(cb);
		return () => {
			set?.delete(cb);
		};
	}

	detach(): void {
		if (this.disposed) return;
		this.disposed = true;
		try {
			this.dbg.off("message", this.messageHandler);
		} catch {
			/* ignore */
		}
		try {
			this.dbg.off("detach", this.detachHandler);
		} catch {
			/* ignore */
		}
		try {
			if (this.dbg.isAttached()) this.dbg.detach();
		} catch {
			/* ignore */
		}
		this.listeners.clear();
	}

	isAttached(): boolean {
		try {
			return !this.disposed && this.dbg.isAttached();
		} catch {
			return false;
		}
	}

	// ---- internals ----

	private async attachAndEnable(): Promise<void> {
		try {
			if (!this.dbg.isAttached()) {
				this.dbg.attach(PROTOCOL_VERSION);
			}
			this.detachedReason = undefined;
			for (const method of DEFAULT_DOMAINS) {
				await this.dbg.sendCommand(method);
			}
		} catch (err) {
			throw new CdpUnavailableError(
				`CDP attach/enable failed: ${(err as Error)?.message ?? err}`,
				err,
			);
		}
	}

	private isDetachError(err: unknown): boolean {
		if (this.detachedReason) return true;
		const msg = (err as Error)?.message?.toLowerCase() ?? "";
		return (
			msg.includes("not attached") ||
			msg.includes("detached") ||
			msg.includes("target closed") ||
			msg.includes("session closed")
		);
	}
}
