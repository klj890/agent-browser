-- P2 follow-up: bookmark deletion sync (tombstones).
-- When the user deletes a bookmark we must still tell the sync server so
-- every other device drops its copy too. Live rows are gone from
-- `bookmarks`, so we keep a tiny tombstone record of (folder, url, deleted_at)
-- long enough for every peer to pull it.
CREATE TABLE IF NOT EXISTS bookmark_tombstones (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  folder TEXT NOT NULL,
  url TEXT NOT NULL,
  deleted_at INTEGER NOT NULL,
  UNIQUE(folder, url)
);
CREATE INDEX IF NOT EXISTS bookmark_tombstones_deleted
  ON bookmark_tombstones(deleted_at ASC, id ASC);
