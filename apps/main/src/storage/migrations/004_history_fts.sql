-- Stage P1-13: full-text search on history (title + url).
-- FTS5 virtual table mirrors history rows via triggers so search stays in sync.
CREATE VIRTUAL TABLE IF NOT EXISTS history_fts USING fts5(
  title,
  url,
  content='history',
  content_rowid='id',
  tokenize='unicode61'
);

-- Back-fill existing rows (cheap even on large tables — FTS5 internal rowid = history.id).
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
