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
}

export interface AddBookmarkInput {
	url: string;
	title?: string;
	folder?: string;
}

export class BookmarksStore {
	constructor(private readonly appDb: AppDatabase) {}

	add(input: AddBookmarkInput): Bookmark {
		if (!input.url) throw new Error("bookmark url required");
		const folder = input.folder ?? "";
		const title = input.title ?? input.url;
		const createdAt = Date.now();
		const db = this.appDb.db;
		const maxRow = db
			.prepare(
				"SELECT COALESCE(MAX(position), -1) AS maxpos FROM bookmarks WHERE folder = ?",
			)
			.get(folder) as { maxpos: number };
		const position = (maxRow?.maxpos ?? -1) + 1;
		const info = db
			.prepare(
				`INSERT INTO bookmarks (url, title, folder, position, created_at)
				 VALUES (?, ?, ?, ?, ?)
				 ON CONFLICT(url, folder) DO UPDATE SET title = excluded.title`,
			)
			.run(input.url, title, folder, position, createdAt);
		const id = Number(info.lastInsertRowid);
		const row = db
			.prepare(
				"SELECT * FROM bookmarks WHERE id = ? OR (url = ? AND folder = ?)",
			)
			.get(id, input.url, folder) as Bookmark;
		return row;
	}

	remove(id: number): boolean {
		const info = this.appDb.db
			.prepare("DELETE FROM bookmarks WHERE id = ?")
			.run(id);
		return Number(info.changes ?? 0) > 0;
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
