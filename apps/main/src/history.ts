/**
 * Browsing history store. Backed by the shared SQLite DB (Stage 1.5).
 *
 * Stage 11: optional semantic index. When a HistoryIndex + RedactionPipeline
 * are attached, `recordWithIndex()` writes the row synchronously and fires a
 * background task to embed `title + " " + url` (after redaction) and store
 * the vector in `history_embeddings`. Embedding failures never block the
 * history write — they are logged and swallowed.
 */
import type { HistoryIndex, SemanticHit } from "./history-index.js";
import type { SensitiveWordFilter } from "./redaction-pipeline.js";
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
	private readonly getByIdsStmt: import("better-sqlite3").Statement;
	private index: HistoryIndex | null = null;
	private redactor: SensitiveWordFilter | null = null;

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
		this.getByIdsStmt = db.prepare(
			// Used by semanticSearch() to hydrate HistoryEntry rows from a hit list.
			// Parameters are bound dynamically via rest spread.
			"SELECT id, url, title, visited_at FROM history WHERE id = ?",
		);
	}

	/** Attach semantic index + redactor. Safe to call once at startup. */
	attachIndex(index: HistoryIndex, redactor: SensitiveWordFilter): void {
		this.index = index;
		this.redactor = redactor;
	}

	record(url: string, title: string, visitedAt: number = Date.now()): number {
		if (!url) return 0;
		// Skip internal / non-http schemes
		if (!/^https?:|^file:/.test(url)) return 0;
		const info = this.insertStmt.run(url, title ?? "", visitedAt);
		return Number(info.lastInsertRowid);
	}

	/**
	 * Record a visit and (if an index is attached) asynchronously embed the
	 * redacted `title + " " + url` string. Returns the new row id; returns 0
	 * when the URL was filtered out.
	 */
	recordWithIndex(
		url: string,
		title: string,
		visitedAt: number = Date.now(),
	): number {
		const id = this.record(url, title, visitedAt);
		if (id === 0) return 0;
		const idx = this.index;
		if (!idx) return id;
		const raw = `${title ?? ""} ${url}`.trim();
		const text = this.redactor ? this.redactor.filter(raw) : raw;
		// Fire-and-forget; failures must not crash the main process.
		void idx.upsert(id, text).catch((err) => {
			console.warn("[history-index] upsert failed:", err);
		});
		return id;
	}

	list(limit = 50, offset = 0): HistoryEntry[] {
		return this.listStmt.all(limit, offset) as HistoryEntry[];
	}

	search(q: string, limit = 50): HistoryEntry[] {
		const pat = `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
		return this.searchStmt.all(pat, pat, limit) as HistoryEntry[];
	}

	/**
	 * Semantic search via the attached HistoryIndex. Falls back to empty
	 * array if no index is attached. Returns entries ordered by similarity.
	 */
	async semanticSearch(q: string, limit = 20): Promise<HistoryEntry[]> {
		if (!this.index) return [];
		const hits: SemanticHit[] = await this.index.search(q, limit);
		if (hits.length === 0) return [];
		// Hydrate ordered by score.
		const out: HistoryEntry[] = [];
		for (const h of hits) {
			const row = this.getByIdsStmt.get(h.id) as HistoryEntry | undefined;
			if (row) out.push(row);
		}
		return out;
	}

	clear(): void {
		this.clearStmt.run();
		// CASCADE on history_embeddings handles vectors, but call deleteAll()
		// defensively in case the FK isn't honored (tests in :memory: enable it).
		if (this.index) this.index.deleteAll();
	}
}
