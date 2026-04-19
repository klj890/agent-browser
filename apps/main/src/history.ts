/**
 * Browsing history store. Backed by the shared SQLite DB (Stage 1.5).
 */
import type { AppDatabase } from "./storage/sqlite.js";

export interface HistoryEntry {
	id: number;
	url: string;
	title: string;
	visited_at: number;
}

export class HistoryStore {
	private readonly insertStmt: import("better-sqlite3").Statement<
		[string, string, number]
	>;
	private readonly listStmt: import("better-sqlite3").Statement<
		[number, number]
	>;
	private readonly searchStmt: import("better-sqlite3").Statement<
		[string, string, number]
	>;
	private readonly clearStmt: import("better-sqlite3").Statement;

	constructor(private readonly appDb: AppDatabase) {
		const db = appDb.db;
		this.insertStmt = db.prepare(
			"INSERT INTO history (url, title, visited_at) VALUES (?, ?, ?)",
		);
		this.listStmt = db.prepare(
			"SELECT id, url, title, visited_at FROM history ORDER BY visited_at DESC LIMIT ? OFFSET ?",
		);
		this.searchStmt = db.prepare(
			"SELECT id, url, title, visited_at FROM history WHERE url LIKE ? OR title LIKE ? ORDER BY visited_at DESC LIMIT ?",
		);
		this.clearStmt = db.prepare("DELETE FROM history");
	}

	record(url: string, title: string, visitedAt: number = Date.now()): void {
		if (!url) return;
		// Skip internal / non-http schemes
		if (!/^https?:|^file:/.test(url)) return;
		this.insertStmt.run(url, title ?? "", visitedAt);
	}

	list(limit = 50, offset = 0): HistoryEntry[] {
		return this.listStmt.all(limit, offset) as HistoryEntry[];
	}

	search(q: string, limit = 50): HistoryEntry[] {
		const pat = `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
		return this.searchStmt.all(pat, pat, limit) as HistoryEntry[];
	}

	clear(): void {
		this.clearStmt.run();
	}
}
