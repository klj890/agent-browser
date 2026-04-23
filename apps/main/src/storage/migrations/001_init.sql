-- 001_init — history, bookmarks, personas_cache tables.
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
