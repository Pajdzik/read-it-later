ALTER TABLE feeds ADD COLUMN retention_days INTEGER CHECK (
  retention_days IS NULL OR (typeof(retention_days) = 'integer' AND retention_days BETWEEN 1 AND 36500)
);
ALTER TABLE feeds ADD COLUMN retention_count INTEGER CHECK (
  retention_count IS NULL OR (typeof(retention_count) = 'integer' AND retention_count BETWEEN 1 AND 500)
);
ALTER TABLE feeds ADD COLUMN refresh_sequence INTEGER NOT NULL DEFAULT 0;

CREATE TABLE feed_item_history (
  feed_id TEXT NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
  entry_key TEXT NOT NULL,
  id TEXT NOT NULL,
  published_at TEXT NOT NULL,
  seen INTEGER NOT NULL,
  refresh_sequence INTEGER NOT NULL,
  PRIMARY KEY (feed_id, entry_key)
) WITHOUT ROWID;
CREATE INDEX feed_item_history_recent ON feed_item_history(feed_id, refresh_sequence DESC, entry_key DESC);

-- Keep the previous date and ordering ID when the same entry is still in the source.
-- During an unsubscribe, the parent has already been deleted and history cascades with it.
CREATE TRIGGER feed_items_remember_pruned AFTER DELETE ON feed_items
WHEN EXISTS (SELECT 1 FROM feeds WHERE id = OLD.feed_id)
BEGIN
  INSERT INTO feed_item_history(feed_id, entry_key, id, published_at, seen, refresh_sequence)
  VALUES (OLD.feed_id, OLD.entry_key, OLD.id, OLD.published_at, OLD.seen,
    (SELECT refresh_sequence FROM feeds WHERE id = OLD.feed_id))
  ON CONFLICT(feed_id, entry_key) DO UPDATE SET id = excluded.id,
    published_at = excluded.published_at, seen = excluded.seen,
    refresh_sequence = excluded.refresh_sequence;
END;
