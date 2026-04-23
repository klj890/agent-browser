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
	{
		name: "002_history_embeddings.sql",
		sql: `
CREATE TABLE IF NOT EXISTS history_embeddings (
  history_id INTEGER PRIMARY KEY REFERENCES history(id) ON DELETE CASCADE,
  dim INTEGER NOT NULL,
  vec BLOB NOT NULL
);
`,
	},
	{
		name: "003_profiles.sql",
		sql: `
CREATE TABLE IF NOT EXISTS profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  partition TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);
INSERT OR IGNORE INTO profiles (id, name, partition, created_at)
VALUES ('default', 'Default', 'persist:default', 0);
`,
	},
	{
		name: "004_history_fts.sql",
		sql: `
CREATE VIRTUAL TABLE IF NOT EXISTS history_fts USING fts5(
  title,
  url,
  content='history',
  content_rowid='id',
  tokenize='unicode61'
);
INSERT INTO history_fts (rowid, title, url)
  SELECT id, title, url FROM history
  WHERE id NOT IN (SELECT rowid FROM history_fts);
CREATE TRIGGER IF NOT EXISTS history_ai AFTER INSERT ON history BEGIN
  INSERT INTO history_fts (rowid, title, url) VALUES (new.id, new.title, new.url);
END;
CREATE TRIGGER IF NOT EXISTS history_ad AFTER DELETE ON history BEGIN
  INSERT INTO history_fts (history_fts, rowid, title, url)
    VALUES ('delete', old.id, old.title, old.url);
END;
CREATE TRIGGER IF NOT EXISTS history_au AFTER UPDATE ON history BEGIN
  INSERT INTO history_fts (history_fts, rowid, title, url)
    VALUES ('delete', old.id, old.title, old.url);
  INSERT INTO history_fts (rowid, title, url) VALUES (new.id, new.title, new.url);
END;
`,
	},
	{
		name: "005_history_unique.sql",
		sql: `
DELETE FROM history
WHERE id NOT IN (
  SELECT MIN(id) FROM history GROUP BY url, visited_at
);
CREATE UNIQUE INDEX IF NOT EXISTS history_url_visited_uniq
  ON history(url, visited_at);
`,
	},
	{
		name: "006_bookmarks_updated_at.sql",
		sql: `
ALTER TABLE bookmarks ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;
UPDATE bookmarks SET updated_at = created_at WHERE updated_at = 0;
`,
	},
	{
		name: "007_bookmark_tombstones.sql",
		sql: `
CREATE TABLE IF NOT EXISTS bookmark_tombstones (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  folder TEXT NOT NULL,
  url TEXT NOT NULL,
  deleted_at INTEGER NOT NULL,
  UNIQUE(folder, url)
);
CREATE INDEX IF NOT EXISTS bookmark_tombstones_deleted
  ON bookmark_tombstones(deleted_at ASC, id ASC);
`,
	},
];
