CREATE TABLE article_copies (
  article_id TEXT PRIMARY KEY NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  markdown TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('paste', 'upload')),
  revision TEXT NOT NULL
);
