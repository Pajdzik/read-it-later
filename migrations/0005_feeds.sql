CREATE TABLE feeds (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  last_fetched_at TEXT,
  last_attempt_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE feed_items (
  id TEXT PRIMARY KEY,
  feed_id TEXT NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
  entry_key TEXT NOT NULL,
  url TEXT NOT NULL,
  normalized_url TEXT NOT NULL,
  title TEXT NOT NULL,
  preview TEXT NOT NULL,
  published_at TEXT NOT NULL,
  seen INTEGER NOT NULL DEFAULT 0 CHECK (seen IN (0,1)),
  UNIQUE(feed_id, entry_key)
);
CREATE INDEX feed_items_order ON feed_items(published_at DESC, id DESC);
CREATE INDEX feed_items_source_order ON feed_items(feed_id, published_at DESC, id DESC);
CREATE TRIGGER feeds_limit BEFORE INSERT ON feeds
WHEN (SELECT COUNT(*) FROM feeds) >= 40
BEGIN
  SELECT RAISE(ABORT, 'feed_limit');
END;
