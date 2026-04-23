-- P1-16 bookmark sync needs a monotonic "last modification" watermark
-- so title / position / folder edits resync to other devices. Without
-- updated_at the push cursor based on created_at would never re-send an
-- edited row.
--
-- Strategy: add updated_at (NOT NULL default 0), then back-fill to
-- created_at for any existing rows so they keep their relative order.
ALTER TABLE bookmarks ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;
UPDATE bookmarks SET updated_at = created_at WHERE updated_at = 0;
