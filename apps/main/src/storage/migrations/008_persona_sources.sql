-- 008_persona_sources — multi-source persona registry (P2-19).
--
-- Before: one hard-coded PERSONA_SERVER_URL; personas_cache keyed by slug.
-- After:  `persona_sources` holds zero-or-more named sources (team server,
--         public marketplace). `personas_cache` keys on (source_id, slug)
--         so the SAME slug can legitimately co-exist across a team feed
--         and a public marketplace without overwriting each other.
--         Per-source `since` cursors (MAX(last_updated) WHERE source_id=?)
--         advance independently once rows stay in their own namespace.
--
-- Rebuild strategy: SQLite cannot alter a PRIMARY KEY in place, so we
-- create personas_cache_new with the composite PK, copy existing rows in
-- (stamped source_id='default' for the legacy single-source era), drop the
-- old table, and rename.
CREATE TABLE IF NOT EXISTS persona_sources (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  token TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('team', 'public')),
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS personas_cache_new (
  source_id TEXT NOT NULL DEFAULT 'default',
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  domains_json TEXT NOT NULL DEFAULT '[]',
  allowed_tools_json TEXT,
  content_md TEXT NOT NULL DEFAULT '',
  last_updated INTEGER NOT NULL,
  PRIMARY KEY (source_id, slug)
);

INSERT OR IGNORE INTO personas_cache_new
  (source_id, slug, name, description, domains_json, allowed_tools_json, content_md, last_updated)
SELECT 'default', slug, name, description, domains_json, allowed_tools_json, content_md, last_updated
FROM personas_cache;

DROP TABLE personas_cache;
ALTER TABLE personas_cache_new RENAME TO personas_cache;

CREATE INDEX IF NOT EXISTS personas_cache_updated ON personas_cache(last_updated DESC);
CREATE INDEX IF NOT EXISTS personas_cache_source ON personas_cache(source_id);
