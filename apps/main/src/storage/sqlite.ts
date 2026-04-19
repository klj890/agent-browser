/**
 * SQLite wrapper for main-process persistent state (history, bookmarks,
 * personas cache). Single DB, single connection per path. Tests can request
 * a fresh in-memory instance by passing `:memory:`.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database, { type Database as BetterSqliteDb } from "better-sqlite3";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const instances = new Map<string, AppDatabase>();

export class AppDatabase {
	readonly db: BetterSqliteDb;
	constructor(public readonly dbPath: string) {
		if (dbPath !== ":memory:") {
			const dir = path.dirname(dbPath);
			if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		}
		this.db = new Database(dbPath);
		this.db.pragma("journal_mode = WAL");
		this.db.pragma("foreign_keys = ON");
		this.runMigrations();
	}

	private runMigrations(): void {
		this.db.exec(
			`CREATE TABLE IF NOT EXISTS schema_migrations (
				name TEXT PRIMARY KEY,
				applied_at INTEGER NOT NULL
			)`,
		);
		const files = loadMigrationFiles();
		const applied = new Set(
			(
				this.db.prepare("SELECT name FROM schema_migrations").all() as Array<{
					name: string;
				}>
			).map((r) => r.name),
		);
		const insertApplied = this.db.prepare(
			"INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)",
		);
		for (const { name, sql } of files) {
			if (applied.has(name)) continue;
			this.db.exec("BEGIN");
			try {
				this.db.exec(sql);
				insertApplied.run(name, Date.now());
				this.db.exec("COMMIT");
			} catch (err) {
				this.db.exec("ROLLBACK");
				throw err;
			}
		}
	}

	close(): void {
		instances.delete(this.dbPath);
		this.db.close();
	}
}

export function getAppDatabase(dbPath: string): AppDatabase {
	const existing = instances.get(dbPath);
	if (existing) return existing;
	const inst = new AppDatabase(dbPath);
	instances.set(dbPath, inst);
	return inst;
}

/** Test helper: drop any cached singleton for a path without closing it. */
export function _resetForTests(): void {
	instances.clear();
}

/**
 * Locate migration SQL files. Prefers the on-disk `migrations/` dir (tsx, dev)
 * and falls back to a bundled inline copy when running from built `dist/`.
 */
function loadMigrationFiles(): Array<{ name: string; sql: string }> {
	const candidates = [
		path.join(__dirname, "migrations"),
		// When running from dist/storage/, the source migrations sit at ../../../src/storage/migrations
		path.resolve(__dirname, "..", "..", "..", "src", "storage", "migrations"),
	];
	for (const dir of candidates) {
		if (existsSync(dir)) {
			return readdirSync(dir)
				.filter((f) => f.endsWith(".sql"))
				.sort()
				.map((name) => ({
					name,
					sql: readFileSync(path.join(dir, name), "utf8"),
				}));
		}
	}
	return INLINE_MIGRATIONS;
}

const INLINE_MIGRATIONS: Array<{ name: string; sql: string }> = [
	{
		name: "001_init.sql",
		sql: `
CREATE TABLE IF NOT EXISTS history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  visited_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS history_visited_at ON history(visited_at DESC);
CREATE INDEX IF NOT EXISTS history_url ON history(url);

CREATE TABLE IF NOT EXISTS bookmarks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  folder TEXT NOT NULL DEFAULT '',
  position INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  UNIQUE(url, folder)
);
CREATE INDEX IF NOT EXISTS bookmarks_folder_position ON bookmarks(folder, position);

CREATE TABLE IF NOT EXISTS personas_cache (
  slug TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  domains_json TEXT NOT NULL DEFAULT '[]',
  allowed_tools_json TEXT,
  content_md TEXT NOT NULL DEFAULT '',
  last_updated INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS personas_cache_updated ON personas_cache(last_updated DESC);
`,
	},
];
