-- Stage 12: multi-profile support.
-- A profile is a named Electron session partition. The default profile
-- always exists with partition 'persist:default' and cannot be removed.
-- Incognito tabs use an ephemeral partition 'incognito:{nanoid}' and do NOT
-- get a row here (they are not persisted across restarts).
CREATE TABLE IF NOT EXISTS profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  partition TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);

INSERT OR IGNORE INTO profiles (id, name, partition, created_at)
VALUES ('default', 'Default', 'persist:default', 0);
