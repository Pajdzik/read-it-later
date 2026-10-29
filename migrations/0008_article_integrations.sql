-- Confirmed hook deliveries are independent of article/copy storage and GitHub backups.
CREATE TABLE article_integration_deliveries (
  article_id TEXT NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  integration_id TEXT NOT NULL,
  destination_key TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  delivered_at TEXT NOT NULL,
  PRIMARY KEY (article_id, integration_id, destination_key)
);
