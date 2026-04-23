-- P1-16 sync exposed a latent schema gap: the `history` table had no
-- uniqueness constraint on (url, visited_at), so pulling remote rows via
-- the sync engine could produce exact duplicates when the same tab's
-- visit made it to the server from multiple devices (or when sync
-- retried a partial batch).
--
-- Strategy: dedupe any pre-existing duplicates (keeping the MIN(id) row)
-- then add a UNIQUE INDEX. Subsequent writes use INSERT OR IGNORE in
-- HistoryStore.record() so the store is safe to call with duplicates.

DELETE FROM history
WHERE id NOT IN (
  SELECT MIN(id) FROM history GROUP BY url, visited_at
);

CREATE UNIQUE INDEX IF NOT EXISTS history_url_visited_uniq
  ON history(url, visited_at);
