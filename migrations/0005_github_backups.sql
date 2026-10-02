-- Last confirmed explicit GitHub backup. D1 content and read state stay authoritative.
CREATE TABLE article_github_backups (
  article_id TEXT PRIMARY KEY REFERENCES articles(id) ON DELETE CASCADE,
  repository TEXT NOT NULL,
  branch TEXT NOT NULL,
  path TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  backed_up_at TEXT NOT NULL
);
