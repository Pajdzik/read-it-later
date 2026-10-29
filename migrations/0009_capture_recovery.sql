ALTER TABLE article_extraction_jobs ADD COLUMN kind TEXT NOT NULL DEFAULT 'initial'
  CHECK (kind IN ('initial', 'recapture'));
ALTER TABLE article_extraction_jobs ADD COLUMN expected_revision TEXT;
ALTER TABLE article_extraction_jobs ADD COLUMN refresh_metadata INTEGER NOT NULL DEFAULT 0
  CHECK (refresh_metadata IN (0, 1));
ALTER TABLE article_extraction_jobs ADD COLUMN baseline_metadata TEXT;

-- One preceding copy, independent of job retries and portable exports.
CREATE TABLE article_capture_recovery (
  article_id TEXT PRIMARY KEY NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  markdown TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('paste', 'upload')),
  previous_metadata TEXT,
  resulting_metadata TEXT,
  resulting_revision TEXT NOT NULL
);
