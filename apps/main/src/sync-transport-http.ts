/**
 * HTTP SyncTransport implementation (P1-16).
 *
 * Thin wire contract the yet-to-be-written `agent-browser-server` will
 * implement. The server never sees plaintext — all bodies are ciphertext
 * envelopes already produced by SyncEngine.
 *
 * Endpoints (proposed, server TBD):
 *   POST   /api/sync/push            body: { items: EncryptedItem[] }     → 204
 *   GET    /api/sync/bookmarks?since={cursor}  → { items, cursor }
 *   GET    /api/sync/history?since={cursor}    → { items, cursor }
 *
 * Auth: reuse the persona JWT (stored via AuthVault). When no token is set
 * the transport surfaces a clear error so the UI can prompt for login.
 */
import type {
	EncryptedItem,
	PullResponse,
	SyncTransport,
} from "./sync-engine.js";

export interface HttpSyncDeps {
	baseUrl: string;
	getAuthToken: () => string | null;
	fetchFn?: typeof fetch;
}

export class HttpSyncTransport implements SyncTransport {
	private readonly fetchFn: typeof fetch;
	constructor(private readonly deps: HttpSyncDeps) {
		this.fetchFn = deps.fetchFn ?? fetch;
	}

	async push(items: EncryptedItem[]): Promise<void> {
		const res = await this.fetchFn(`${this.deps.baseUrl}/api/sync/push`, {
			method: "POST",
			headers: this.headers(),
			body: JSON.stringify({ items }),
		});
		if (!res.ok) {
			throw new Error(`sync push failed: HTTP ${res.status}`);
		}
	}

	async pullBookmarks(since: number): Promise<PullResponse> {
		return this.getJson(
			`${this.deps.baseUrl}/api/sync/bookmarks?since=${since}`,
		);
	}

	async pullHistory(since: number): Promise<PullResponse> {
		return this.getJson(`${this.deps.baseUrl}/api/sync/history?since=${since}`);
	}

	private async getJson(url: string): Promise<PullResponse> {
		const res = await this.fetchFn(url, { headers: this.headers() });
		if (!res.ok) throw new Error(`sync pull failed: HTTP ${res.status}`);
		const json = (await res.json()) as PullResponse;
		return {
			items: Array.isArray(json.items) ? json.items : [],
			cursor: typeof json.cursor === "number" ? json.cursor : 0,
		};
	}

	private headers(): Record<string, string> {
		const token = this.deps.getAuthToken();
		const h: Record<string, string> = { "Content-Type": "application/json" };
		if (token) h.Authorization = `Bearer ${token}`;
		return h;
	}
}

/**
 * No-op transport used when the user has configured sync locally but no server
 * URL is set yet. push/pull succeed with empty sets so UI reflects "nothing to
 * sync" rather than erroring.
 */
export class NoopSyncTransport implements SyncTransport {
	async push(): Promise<void> {}
	async pullBookmarks(): Promise<PullResponse> {
		return { items: [], cursor: 0 };
	}
	async pullHistory(): Promise<PullResponse> {
		return { items: [], cursor: 0 };
	}
}
