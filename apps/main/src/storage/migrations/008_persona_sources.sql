-- 008_persona_sources — multi-source persona registry (P2-19).
--
-- Before: one hard-coded PERSONA_SERVER_URL, all personas lumped into
--         `personas_cache` with no provenance.
-- After:  `persona_sources` holds zero-or-more named sources (team server,
--         public marketplace, future MDM feeds). `personas_cache.source_id`
--         records which source supplied a row so the UI can show badges,
--         the user can unsubscribe a source wholesale, and per-source
--         `since` cursors advance independently.
--
-- Rows inserted before this migration are stamped with source_id='default'
-- so existing deployments keep working without any config change.
CREATE TABLE IF NOT EXISTS persona_sources (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  token TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('team', 'public')),
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

ALTER TABLE personas_cache ADD COLUMN source_id TEXT NOT NULL DEFAULT 'default';
CREATE INDEX IF NOT EXISTS personas_cache_source ON personas_cache(source_id);
