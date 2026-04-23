/**
 * SyncEngine (P1 Stage 16) — end-to-end encrypted bookmarks + history sync.
 *
 * Client-only cryptographic pipeline. The server sees only:
 *   - item kind ("bookmark" | "history")
 *   - opaque deterministic pointerId (HMAC-style of item's stable key)
 *   - updatedAt timestamp
 *   - ciphertext envelope (aes-256-gcm)
 *
 * Conflict resolution: last-writer-wins on pull, keyed by pointerId.
 *
 * Server is injected via SyncTransport — this makes the module fully testable
 * against a stub and lets agent-browser-server implement any wire format it
 * likes. Only the envelope shape is fixed.
 */
import type { BookmarksStore } from "./bookmarks.js";
import type { HistoryStore } from "./history.js";
import type { SyncConfig, SyncConfigStore } from "./sync-config.js";
import {
	decrypt,
	deriveKey,
	type EnvelopeV1,
	encrypt,
	generateSalt,
	itemPointer,
	keysEqual,
} from "./sync-crypto.js";

const VERIFIER_PLAINTEXT = "agent-browser-sync-v1";

export type ItemKind = "bookmark" | "history";

export interface EncryptedItem {
	pointerId: string;
	kind: ItemKind;
	envelope: EnvelopeV1;
	updatedAt: number;
	deletedAt?: number;
}

export interface PullResponse {
	items: EncryptedItem[];
	/** Server-provided cursor to pass back on next pull. Caller decides semantics. */
	cursor: number;
}

export interface SyncTransport {
	push(items: EncryptedItem[]): Promise<void>;
	pullBookmarks(since: number): Promise<PullResponse>;
	pullHistory(since: number): Promise<PullResponse>;
}

export interface SyncStatus {
	configured: boolean;
	unlocked: boolean;
	enabled: boolean;
	lastBookmarksCursor: number;
	lastHistoryCursor: number;
	serverUrl: string | null;
}

export interface SyncEngineDeps {
	configStore: SyncConfigStore;
	bookmarks: BookmarksStore;
	history: HistoryStore;
	transport: SyncTransport;
	/** Test hook to swap in a faster key derivation during tests. */
	deriveKeyFn?: (passphrase: string, salt: Buffer) => Promise<Buffer>;
}

export class SyncEngine {
	private key: Buffer | null = null;
	private cfg: SyncConfig;

	constructor(private readonly deps: SyncEngineDeps) {
		this.cfg = deps.configStore.load();
	}

	status(): SyncStatus {
		return {
			configured: this.cfg.enabled && !!this.cfg.salt,
			unlocked: this.key !== null,
			enabled: this.cfg.enabled,
			lastBookmarksCursor: this.cfg.lastBookmarksCursor,
			lastHistoryCursor: this.cfg.lastHistoryCursor,
			serverUrl: this.cfg.serverUrl,
		};
	}

	/**
	 * First-time configuration: generate a fresh salt, derive the sync key,
	 * encrypt the verifier, persist. Leaves the engine unlocked.
	 */
	async configure(passphrase: string, serverUrl?: string): Promise<void> {
		if (!passphrase) throw new Error("passphrase required");
		const salt = generateSalt();
		const key = await this.derive(passphrase, salt);
		const verifier = encrypt(key, VERIFIER_PLAINTEXT);
		this.cfg = {
			enabled: true,
			salt: toB64Url(salt),
			verifier,
			lastBookmarksCursor: 0,
			lastHistoryCursor: 0,
			lastPushedBookmarkAt: 0,
			lastPushedHistoryAt: 0,
			serverUrl: serverUrl ?? this.cfg.serverUrl ?? null,
		};
		this.deps.configStore.save(this.cfg);
		this.key = key;
	}

	/**
	 * Returns true if the passphrase matched the stored verifier.
	 * Must be called before pushNow / pullNow after a fresh boot.
	 */
	async unlock(passphrase: string): Promise<boolean> {
		if (!this.cfg.enabled || !this.cfg.salt || !this.cfg.verifier) {
			return false;
		}
		const salt = fromB64Url(this.cfg.salt);
		const candidate = await this.derive(passphrase, salt);
		try {
			const plaintext = decrypt(candidate, this.cfg.verifier);
			if (plaintext !== VERIFIER_PLAINTEXT) return false;
			this.key = candidate;
			return true;
		} catch {
			return false;
		}
	}

	/** Drop the in-memory key; salt/verifier on disk are untouched. */
	lock(): void {
		if (this.key) this.key.fill(0);
		this.key = null;
	}

	/** Permanently disable sync locally: wipes salt/verifier + cursors. */
	disable(): void {
		this.lock();
		this.deps.configStore.clear();
		this.cfg = this.deps.configStore.load();
	}

	/**
	 * Push newly-added local bookmarks + newly-recorded history since the
	 * last pushed cursor. Both streams are append-only from the push side:
	 * once a row's timestamp ≤ its cursor, we skip it.
	 *
	 * Known limitation: bookmark title/position *edits* after initial push
	 * won't resync because BookmarksStore has no updated_at column. When
	 * that becomes a real issue, add `updated_at` to the schema and switch
	 * this filter to `b.updated_at > cursor`.
	 */
	async pushNow(): Promise<{ pushed: number }> {
		const key = this.requireUnlocked();
		const items: EncryptedItem[] = [];
		for (const b of this.deps.bookmarks.list()) {
			if (b.created_at <= this.cfg.lastPushedBookmarkAt) continue;
			items.push({
				pointerId: itemPointer(key, `bookmark:${b.folder}:${b.url}`),
				kind: "bookmark",
				envelope: encrypt(
					key,
					JSON.stringify({
						url: b.url,
						title: b.title,
						folder: b.folder,
						position: b.position,
						created_at: b.created_at,
					}),
				),
				updatedAt: b.created_at,
			});
		}
		for (const h of this.deps.history.list(10_000, 0)) {
			if (h.visited_at <= this.cfg.lastPushedHistoryAt) continue;
			items.push({
				pointerId: itemPointer(key, `history:${h.visited_at}:${h.url}`),
				kind: "history",
				envelope: encrypt(
					key,
					JSON.stringify({
						url: h.url,
						title: h.title,
						visited_at: h.visited_at,
					}),
				),
				updatedAt: h.visited_at,
			});
		}
		if (items.length === 0) return { pushed: 0 };
		await this.deps.transport.push(items);
		// Advance the per-kind push watermark. NB: these are independent of the
		// pull cursors — advancing them here must not shrink the pull horizon.
		let maxHistory = this.cfg.lastPushedHistoryAt;
		let maxBookmark = this.cfg.lastPushedBookmarkAt;
		for (const it of items) {
			if (it.kind === "history" && it.updatedAt > maxHistory)
				maxHistory = it.updatedAt;
			if (it.kind === "bookmark" && it.updatedAt > maxBookmark)
				maxBookmark = it.updatedAt;
		}
		let changed = false;
		if (maxHistory > this.cfg.lastPushedHistoryAt) {
			this.cfg.lastPushedHistoryAt = maxHistory;
			changed = true;
		}
		if (maxBookmark > this.cfg.lastPushedBookmarkAt) {
			this.cfg.lastPushedBookmarkAt = maxBookmark;
			changed = true;
		}
		if (changed) this.deps.configStore.save(this.cfg);
		return { pushed: items.length };
	}

	/**
	 * Pull remote changes and apply to local stores. Items whose decrypt
	 * fails are silently skipped (corrupt / tampered / wrong-key).
	 */
	async pullNow(): Promise<{ applied: number; skipped: number }> {
		const key = this.requireUnlocked();
		let applied = 0;
		let skipped = 0;

		const bm = await this.deps.transport.pullBookmarks(
			this.cfg.lastBookmarksCursor,
		);
		for (const it of bm.items) {
			if (it.kind !== "bookmark") {
				skipped++;
				continue;
			}
			try {
				const row = JSON.parse(decrypt(key, it.envelope)) as {
					url: string;
					title?: string;
					folder?: string;
				};
				// BookmarksStore.add upserts on (url, folder) conflict → last-writer-wins.
				this.deps.bookmarks.add({
					url: row.url,
					title: row.title,
					folder: row.folder,
				});
				applied++;
			} catch {
				skipped++;
			}
		}
		if (bm.cursor > this.cfg.lastBookmarksCursor) {
			this.cfg.lastBookmarksCursor = bm.cursor;
		}

		const hist = await this.deps.transport.pullHistory(
			this.cfg.lastHistoryCursor,
		);
		for (const it of hist.items) {
			if (it.kind !== "history") {
				skipped++;
				continue;
			}
			try {
				const row = JSON.parse(decrypt(key, it.envelope)) as {
					url: string;
					title?: string;
					visited_at: number;
				};
				this.deps.history.record(row.url, row.title ?? "", row.visited_at);
				applied++;
			} catch {
				skipped++;
			}
		}
		if (hist.cursor > this.cfg.lastHistoryCursor) {
			this.cfg.lastHistoryCursor = hist.cursor;
		}
		this.deps.configStore.save(this.cfg);
		return { applied, skipped };
	}

	// ---- internals ----

	private requireUnlocked(): Buffer {
		if (!this.key) throw new Error("sync engine locked — call unlock() first");
		return this.key;
	}

	private async derive(passphrase: string, salt: Buffer): Promise<Buffer> {
		const fn = this.deps.deriveKeyFn ?? deriveKey;
		return fn(passphrase, salt);
	}

	/**
	 * Test helper — confirm a derived key matches the current unlocked key.
	 */
	_currentKeyMatches(candidate: Buffer): boolean {
		return this.key !== null && keysEqual(this.key, candidate);
	}
}

function toB64Url(buf: Buffer): string {
	return buf
		.toString("base64")
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
}

function fromB64Url(s: string): Buffer {
	const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
	return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}
