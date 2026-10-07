ALTER TABLE articles ADD COLUMN extraction_requested_at TEXT;
ALTER TABLE articles ADD COLUMN title_origin TEXT NOT NULL DEFAULT 'protected'
  CHECK (title_origin IN ('fallback', 'supplied', 'extracted', 'protected'));

CREATE INDEX articles_extraction_requested
  ON articles(extraction_requested_at, id)
  WHERE extraction_requested_at IS NOT NULL;

CREATE TABLE article_extraction_jobs (
  article_id TEXT PRIMARY KEY NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  generation INTEGER NOT NULL DEFAULT 1 CHECK (generation > 0),
  state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'retry_wait', 'succeeded', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 3),
  next_attempt_at TEXT NOT NULL,
  lease_token TEXT,
  lease_expires_at TEXT,
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT,
  CHECK ((state = 'running' AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
      OR (state != 'running' AND lease_token IS NULL AND lease_expires_at IS NULL))
);

CREATE INDEX article_extraction_jobs_eligible
  ON article_extraction_jobs(state, next_attempt_at, article_id);
CREATE INDEX article_extraction_jobs_leases
  ON article_extraction_jobs(state, lease_expires_at);
