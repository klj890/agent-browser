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
import type { AppDatabase } from "./storage/sqlite.js";
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
	/**
	 * Shared AppDatabase used by both stores — SyncEngine uses it to wrap
	 * pull-apply loops in a single transaction, which cuts per-row fsync
	 * overhead and makes an interrupted pull atomic (all or nothing).
	 */
	appDb: AppDatabase;
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
			lastPushedHistoryId: 0,
			lastPushedBookmarkId: 0,
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
	 * Push bookmarks + history rows that have changed since the last
	 * watermark. Both streams paginate by a compound (timestamp, id) cursor
	 * so rows sharing a timestamp never straddle a page boundary silently.
	 *
	 * Deletion is not yet synced — doing it correctly requires tombstones.
	 * Documented in PLAN as follow-up work.
	 */
	async pushNow(): Promise<{ pushed: number }> {
		const key = this.requireUnlocked();
		const items: EncryptedItem[] = [];

		const BOOKMARK_PAGE = 1_000;
		let bmAt = this.cfg.lastPushedBookmarkAt;
		let bmId = this.cfg.lastPushedBookmarkId ?? 0;
		while (true) {
			const page = this.deps.bookmarks.listSince(bmAt, bmId, BOOKMARK_PAGE);
			if (page.length === 0) break;
			for (const b of page) {
				items.push({
					// JSON.stringify([folder, url]) gives a collision-free encoding:
					// structural delimiters can't appear inside a JSON-escaped string,
					// so "a:b"/"c" and "a"/"b:c" produce distinct pointerIds.
					pointerId: itemPointer(
						key,
						`bookmark:${JSON.stringify([b.folder, b.url])}`,
					),
					kind: "bookmark",
					envelope: encrypt(
						key,
						JSON.stringify({
							url: b.url,
							title: b.title,
							folder: b.folder,
							position: b.position,
							created_at: b.created_at,
							updated_at: b.updated_at,
						}),
					),
					updatedAt: b.updated_at,
				});
				if (b.updated_at > bmAt || (b.updated_at === bmAt && b.id > bmId)) {
					bmAt = b.updated_at;
					bmId = b.id;
				}
			}
			if (page.length < BOOKMARK_PAGE) break;
		}

		const HISTORY_PAGE = 1_000;
		let hAt = this.cfg.lastPushedHistoryAt;
		let hId = this.cfg.lastPushedHistoryId ?? 0;
		while (true) {
			const batch = this.deps.history.listSince(hAt, hId, HISTORY_PAGE);
			if (batch.length === 0) break;
			for (const h of batch) {
				items.push({
					// Same JSON encoding rationale as bookmarks — url or title could
					// legitimately contain ':', so string concat would collide.
					pointerId: itemPointer(
						key,
						`history:${JSON.stringify([h.visited_at, h.url])}`,
					),
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
				if (h.visited_at > hAt || (h.visited_at === hAt && h.id > hId)) {
					hAt = h.visited_at;
					hId = h.id;
				}
			}
			if (batch.length < HISTORY_PAGE) break;
		}

		if (items.length === 0) return { pushed: 0 };
		await this.deps.transport.push(items);

		let changed = false;
		if (hAt > this.cfg.lastPushedHistoryAt) {
			this.cfg.lastPushedHistoryAt = hAt;
			changed = true;
		}
		if ((this.cfg.lastPushedHistoryId ?? 0) !== hId) {
			this.cfg.lastPushedHistoryId = hId;
			changed = true;
		}
		if (bmAt > this.cfg.lastPushedBookmarkAt) {
			this.cfg.lastPushedBookmarkAt = bmAt;
			changed = true;
		}
		if ((this.cfg.lastPushedBookmarkId ?? 0) !== bmId) {
			this.cfg.lastPushedBookmarkId = bmId;
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
		const hist = await this.deps.transport.pullHistory(
			this.cfg.lastHistoryCursor,
		);

		// Apply all decrypted rows in a single transaction: ~O(N) fsyncs
		// collapse into one, and a crash mid-apply leaves the DB clean
		// instead of half-populated.
		const applyAll = this.deps.appDb.db.transaction(() => {
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
						updated_at?: number;
					};
					// Preserve the remote updated_at on local insert/upsert.
					// Without this, add() would stamp Date.now() which is always
					// greater than our push watermark, and the next pushNow() would
					// ping-pong the same row back to the server (infinite loop
					// between two devices synchronizing a common bookmark set).
					this.deps.bookmarks.add({
						url: row.url,
						title: row.title,
						folder: row.folder,
						createdAt: row.updated_at ?? it.updatedAt,
					});
					applied++;
				} catch {
					skipped++;
				}
			}
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
					// Route through recordWithIndex so pulled rows enter the local
					// semantic embedding index too — otherwise they're invisible to
					// Stage 11 / history:semanticSearch on this device.
					this.deps.history.recordWithIndex(
						row.url,
						row.title ?? "",
						row.visited_at,
					);
					applied++;
				} catch {
					skipped++;
				}
			}
		});
		applyAll();

		if (bm.cursor > this.cfg.lastBookmarksCursor) {
			this.cfg.lastBookmarksCursor = bm.cursor;
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
