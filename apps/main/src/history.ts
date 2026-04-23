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

/**
 * Escape a single token for inclusion in an FTS5 MATCH expression.
 * Any double-quote becomes two double-quotes (FTS5 string-literal quoting);
 * the whole token is then wrapped in double-quotes and given a `*` suffix
 * so partial words still match.
 */
function escapeFtsToken(tok: string): string {
	// Drop characters FTS5 treats as operators (colon → column spec, paren →
	// subexpression). Trimming them is fine for a search UI.
	const cleaned = tok.replace(/[():]/g, "");
	if (!cleaned) return "";
	return `"${cleaned.replace(/"/g, '""')}"*`;
}

export function toFtsMatch(q: string): string {
	const parts = q
		.split(/\s+/)
		.map((s) => s.trim())
		.filter(Boolean)
		.map(escapeFtsToken)
		.filter(Boolean);
	if (parts.length === 0) return "";
	return parts.join(" ");
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
	private readonly ftsStmt: import("better-sqlite3").Statement<
		[string, number]
	>;
	private readonly listSinceStmt: import("better-sqlite3").Statement<
		[number, number]
	>;
	private readonly existingIdStmt: import("better-sqlite3").Statement<
		[string, number]
	>;
	private readonly clearStmt: import("better-sqlite3").Statement;
	private readonly getByIdsStmt: import("better-sqlite3").Statement;
	private index: HistoryIndex | null = null;
	private redactor: SensitiveWordFilter | null = null;

	constructor(private readonly appDb: AppDatabase) {
		const db = appDb.db;
		// INSERT OR IGNORE so repeated records of the same (url, visited_at)
		// — e.g. a sync retry applying the same remote rows twice — are
		// quietly deduped by the UNIQUE INDEX from migration 005.
		this.insertStmt = db.prepare(
			"INSERT OR IGNORE INTO history (url, title, visited_at) VALUES (?, ?, ?)",
		);
		this.listSinceStmt = db.prepare(
			"SELECT id, url, title, visited_at FROM history WHERE visited_at > ? ORDER BY visited_at ASC LIMIT ?",
		);
		this.existingIdStmt = db.prepare(
			"SELECT id FROM history WHERE url = ? AND visited_at = ?",
		);
		this.listStmt = db.prepare(
			"SELECT id, url, title, visited_at FROM history ORDER BY visited_at DESC LIMIT ? OFFSET ?",
		);
		this.searchStmt = db.prepare(
			"SELECT id, url, title, visited_at FROM history WHERE url LIKE ? OR title LIKE ? ORDER BY visited_at DESC LIMIT ?",
		);
		// FTS5 MATCH: ranked by bm25 (lower = more relevant). We join back to
		// history by rowid to hydrate the real row.
		this.ftsStmt = db.prepare(
			`SELECT h.id, h.url, h.title, h.visited_at
			 FROM history_fts f
			 JOIN history h ON h.id = f.rowid
			 WHERE history_fts MATCH ?
			 ORDER BY bm25(history_fts), h.visited_at DESC
			 LIMIT ?`,
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
		if (info.changes === 0) {
			// UNIQUE(url, visited_at) collision — return the existing row id so
			// callers that need a handle (e.g. recordWithIndex → HistoryIndex
			// upsert) still work idempotently.
			const row = this.existingIdStmt.get(url, visitedAt) as
				| { id: number }
				| undefined;
			return row?.id ?? 0;
		}
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

	/**
	 * Ascending pagination by `visited_at`. Used by SyncEngine.pushNow to
	 * iterate every unsynced row regardless of total history size, avoiding
	 * the hard-coded `list(10_000, 0)` data-loss cliff.
	 *
	 * Pass `since=0` to start from the beginning; pass the last returned
	 * row's `visited_at` to fetch the next page. Stop when the result
	 * is empty.
	 */
	listSince(since: number, limit: number): HistoryEntry[] {
		return this.listSinceStmt.all(since, limit) as HistoryEntry[];
	}

	search(q: string, limit = 50): HistoryEntry[] {
		const pat = `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
		return this.searchStmt.all(pat, pat, limit) as HistoryEntry[];
	}

	/**
	 * Full-text search backed by an FTS5 virtual table. The query is rewritten
	 * into a safe MATCH expression: each whitespace-separated token becomes a
	 * prefix match, letting the user type partial words. Special FTS operators
	 * (AND/OR/NOT/NEAR/column specifiers/quotes) are escaped to avoid
	 * accidental syntax errors on user input.
	 */
	fullTextSearch(q: string, limit = 50): HistoryEntry[] {
		const match = toFtsMatch(q);
		if (!match) return [];
		try {
			return this.ftsStmt.all(match, limit) as HistoryEntry[];
		} catch {
			// A malformed MATCH expression (e.g. user typed stray `"`) — treat
			// as no results rather than crashing the IPC channel.
			return [];
		}
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
