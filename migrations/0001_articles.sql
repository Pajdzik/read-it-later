CREATE TABLE articles (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  normalized_url TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  read_at TEXT
);

CREATE INDEX articles_created ON articles(created_at DESC, id DESC);
CREATE INDEX articles_read_created ON articles(read_at, created_at DESC, id DESC);
