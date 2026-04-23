/**
 * Persistent sync configuration (P1-16).
 *
 * Stored as plain JSON under userData/agent-browser/sync-config.json.
 * Contents are NOT secret — the salt and verifier envelope leak nothing
 * useful without the user's passphrase.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { EnvelopeV1 } from "./sync-crypto.js";

export interface SyncConfig {
	enabled: boolean;
	/** base64url-encoded salt used with scrypt to derive the sync key. */
	salt: string;
	/**
	 * Ciphertext of a fixed plaintext string. On unlock, we decrypt with the
	 * re-derived key; a successful decrypt proves the passphrase is correct.
	 */
	verifier: EnvelopeV1 | null;
	/**
	 * Server-returned cursors for the pull side. Opaque to us — we pass them
	 * back verbatim on next pull.
	 */
	lastBookmarksCursor: number;
	lastHistoryCursor: number;
	/**
	 * Local-only watermarks for the push side: max `created_at` of bookmarks
	 * and max `visited_at` of history rows already uploaded. Split from the
	 * pull cursors so pushing never truncates our pull horizon.
	 */
	lastPushedBookmarkAt: number;
	lastPushedHistoryAt: number;
	/**
	 * Tiebreakers paired with the *At cursors — when multiple rows share a
	 * timestamp we also persist the last id pushed so the next page can
	 * continue strictly after (at, id).
	 */
	lastPushedHistoryId?: number;
	lastPushedBookmarkId?: number;
	serverUrl: string | null;
}

export const EMPTY_SYNC_CONFIG: SyncConfig = {
	enabled: false,
	salt: "",
	verifier: null,
	lastBookmarksCursor: 0,
	lastHistoryCursor: 0,
	lastPushedBookmarkAt: 0,
	lastPushedHistoryAt: 0,
	lastPushedHistoryId: 0,
	lastPushedBookmarkId: 0,
	serverUrl: null,
};

export class SyncConfigStore {
	constructor(private readonly filePath: string) {}

	load(): SyncConfig {
		if (!existsSync(this.filePath)) return { ...EMPTY_SYNC_CONFIG };
		try {
			const raw = readFileSync(this.filePath, "utf-8");
			const parsed = JSON.parse(raw) as Partial<SyncConfig>;
			return {
				...EMPTY_SYNC_CONFIG,
				...parsed,
			};
		} catch {
			return { ...EMPTY_SYNC_CONFIG };
		}
	}

	save(cfg: SyncConfig): void {
		const dir = path.dirname(this.filePath);
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		writeFileSync(this.filePath, JSON.stringify(cfg, null, 2));
	}

	clear(): void {
		if (!existsSync(this.filePath)) return;
		writeFileSync(this.filePath, JSON.stringify(EMPTY_SYNC_CONFIG, null, 2));
	}
}
