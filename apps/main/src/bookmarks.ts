/**
 * Bookmarks store. SQLite-backed CRUD + reorder (Stage 1.5).
 */
import type { AppDatabase } from "./storage/sqlite.js";

export interface Bookmark {
	id: number;
	url: string;
	title: string;
	folder: string;
	position: number;
	created_at: number;
	updated_at: number;
}

export interface AddBookmarkInput {
	url: string;
	title?: string;
	folder?: string;
	/** Mostly for tests — lets callers pin the timestamp used for both created_at (new rows) and updated_at. Defaults to Date.now(). */
	createdAt?: number;
}

/**
 * Record of a deleted bookmark surviving long enough to propagate through
 * sync to every peer. `(folder, url)` is the natural key that ties it
 * back to a live bookmark on another device.
 */
export interface BookmarkTombstone {
	id: number;
	folder: string;
	url: string;
	deleted_at: number;
}

export interface RemoveBookmarkOpts {
	/** Pin timestamp for tests / deterministic sync replays. */
	deletedAt?: number;
	/**
	 * Set true when applying a tombstone received from a peer — we still want
	 * to delete the local row but should NOT re-write a tombstone (otherwise
	 * the deletion bounces back out). Default false.
	 */
	skipTombstone?: boolean;
}

export class BookmarksStore {
	constructor(private readonly appDb: AppDatabase) {}

	add(input: AddBookmarkInput): Bookmark {
		if (!input.url) throw new Error("bookmark url required");
		const folder = input.folder ?? "";
		const title = input.title ?? input.url;
		const now = input.createdAt ?? Date.now();
		const db = this.appDb.db;
		// A re-add after a delete must supersede the tombstone. Otherwise the
		// next sync push could send BOTH a bookmark (updatedAt=now) and a
		// tombstone (deletedAt=old) — a peer might apply the delete after the
		// add and end up inconsistent. Dropping the tombstone here keeps the
		// sync contract last-writer-wins per (folder, url).
		db.prepare(
			"DELETE FROM bookmark_tombstones WHERE folder = ? AND url = ?",
		).run(folder, input.url);
		// Atomic: a scalar subquery computes the next position in the same
		// statement as the INSERT, so concurrent add() calls cannot observe
		// a stale MAX(position) and collide on the same slot.
		//
		// On insert: created_at = updated_at = now.
		// On conflict(url, folder): keep created_at + position, refresh
		// title + updated_at so sync push can pick up the edit via
		// `updated_at > watermark`.
		const info = db
			.prepare(
				`INSERT INTO bookmarks (url, title, folder, position, created_at, updated_at)
				 VALUES (
				   ?, ?, ?,
				   (SELECT COALESCE(MAX(position), -1) + 1 FROM bookmarks WHERE folder = ?),
				   ?, ?
				 )
				 ON CONFLICT(url, folder) DO UPDATE
				   SET title = excluded.title,
				       updated_at = excluded.updated_at`,
			)
			.run(input.url, title, folder, folder, now, now);
		const id = Number(info.lastInsertRowid);
		const row = db
			.prepare(
				"SELECT * FROM bookmarks WHERE id = ? OR (url = ? AND folder = ?)",
			)
			.get(id, input.url, folder) as Bookmark;
		return row;
	}

	/**
	 * Delete a bookmark by id and (unless `skipTombstone`) record the
	 * deletion so SyncEngine can propagate it. The read of (folder, url)
	 * and the subsequent delete + tombstone insert run in one transaction:
	 * either all three happen or none do, so a crash can't leave a live
	 * row that the peer never hears about OR a tombstone for a row that's
	 * still present.
	 */
	remove(id: number, opts: RemoveBookmarkOpts = {}): boolean {
		const db = this.appDb.db;
		const deletedAt = opts.deletedAt ?? Date.now();
		const tx = db.transaction((rowId: number): boolean => {
			const row = db
				.prepare("SELECT folder, url FROM bookmarks WHERE id = ?")
				.get(rowId) as { folder: string; url: string } | undefined;
			if (!row) return false;
			const info = db.prepare("DELETE FROM bookmarks WHERE id = ?").run(rowId);
			if (Number(info.changes ?? 0) === 0) return false;
			if (!opts.skipTombstone) {
				db.prepare(
					`INSERT INTO bookmark_tombstones (folder, url, deleted_at)
					 VALUES (?, ?, ?)
					 ON CONFLICT(folder, url) DO UPDATE SET deleted_at = excluded.deleted_at`,
				).run(row.folder, row.url, deletedAt);
			}
			return true;
		});
		return tx(id) as boolean;
	}

	/**
	 * Delete by (url, folder). Used by SyncEngine.pullNow to apply a peer's
	 * tombstone: we look up the live row — if any — and delete it without
	 * writing a new tombstone (skipTombstone=true).
	 *
	 * Returns true if a live row was actually removed.
	 */
	removeByUrlFolder(url: string, folder: string): boolean {
		const row = this.appDb.db
			.prepare("SELECT id FROM bookmarks WHERE url = ? AND folder = ?")
			.get(url, folder) as { id: number } | undefined;
		if (!row) return false;
		return this.remove(row.id, { skipTombstone: true });
	}

	/**
	 * Paginate tombstones for SyncEngine.pushNow. Same (at, id) compound
	 * cursor pattern as live bookmarks / history so rows sharing a
	 * deleted_at never straddle a page boundary silently.
	 */
	listTombstonesSince(
		afterDeletedAt: number,
		afterId: number,
		limit: number,
	): BookmarkTombstone[] {
		return this.appDb.db
			.prepare(
				`SELECT * FROM bookmark_tombstones
				 WHERE deleted_at > ?
				    OR (deleted_at = ? AND id > ?)
				 ORDER BY deleted_at ASC, id ASC
				 LIMIT ?`,
			)
			.all(
				afterDeletedAt,
				afterDeletedAt,
				afterId,
				limit,
			) as BookmarkTombstone[];
	}

	/**
	 * Drop tombstones older than `keepMs` ms. Expected to run on a low-freq
	 * schedule (daily routine) once every peer has had ample time to pull.
	 */
	gcTombstones(keepMs: number): number {
		const cutoff = Date.now() - keepMs;
		const info = this.appDb.db
			.prepare("DELETE FROM bookmark_tombstones WHERE deleted_at < ?")
			.run(cutoff);
		return Number(info.changes ?? 0);
	}

	list(folder?: string): Bookmark[] {
		const db = this.appDb.db;
		if (folder === undefined) {
			return db
				.prepare("SELECT * FROM bookmarks ORDER BY folder ASC, position ASC")
				.all() as Bookmark[];
		}
		return db
			.prepare("SELECT * FROM bookmarks WHERE folder = ? ORDER BY position ASC")
			.all(folder) as Bookmark[];
	}

	/**
	 * Paginated incremental scan by `updated_at` for SyncEngine.pushNow.
	 * Avoids loading the entire bookmark set into memory per push and lets
	 * pagination keep working even when many bookmarks share a timestamp.
	 * Uses (updated_at, id) as a compound cursor for the same reason the
	 * history store does — SQL-side filtering, no post-fetch JS filter.
	 */
	listSince(
		afterUpdatedAt: number,
		afterId: number,
		limit: number,
	): Bookmark[] {
		return this.appDb.db
			.prepare(
				`SELECT * FROM bookmarks
				 WHERE updated_at > ?
				    OR (updated_at = ? AND id > ?)
				 ORDER BY updated_at ASC, id ASC
				 LIMIT ?`,
			)
			.all(afterUpdatedAt, afterUpdatedAt, afterId, limit) as Bookmark[];
	}

	/** Reorder a folder: `ids` gives the new positional order. */
	reorder(folder: string, ids: number[]): void {
		const db = this.appDb.db;
		const upd = db.prepare(
			"UPDATE bookmarks SET position = ? WHERE id = ? AND folder = ?",
		);
		const tx = db.transaction((items: number[]) => {
			for (let i = 0; i < items.length; i++) {
				upd.run(i, items[i], folder);
			}
		});
		tx(ids);
	}
}
