ALTER TABLE articles ADD COLUMN enrichment_requested_at TEXT;
ALTER TABLE articles ADD COLUMN enrichment_wait_for_copy INTEGER NOT NULL DEFAULT 0 CHECK (enrichment_wait_for_copy IN (0,1));
ALTER TABLE articles ADD COLUMN description_origin TEXT
  CHECK (description_origin IN ('manual','extracted','generated'));
ALTER TABLE articles ADD COLUMN tags_manual INTEGER NOT NULL DEFAULT 0 CHECK (tags_manual IN (0,1));
UPDATE articles SET description_origin='manual' WHERE description IS NOT NULL;
CREATE INDEX articles_enrichment_intent ON articles(enrichment_requested_at,id)
  WHERE enrichment_requested_at IS NOT NULL;

CREATE TABLE article_tags (
  article_id TEXT NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  tag TEXT NOT NULL CHECK (length(tag) BETWEEN 1 AND 40),
  PRIMARY KEY (article_id,tag)
);
CREATE INDEX article_tags_lookup ON article_tags(tag,article_id);

CREATE TABLE article_enrichment_jobs (
  article_id TEXT PRIMARY KEY NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  state TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','running','retry_wait','deferred','succeeded','failed','skipped')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 2),
  next_attempt_at TEXT NOT NULL,
  lease_token TEXT,
  lease_expires_at TEXT,
  input_fingerprint TEXT,
  copy_revision TEXT,
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((state='running' AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR (state!='running' AND lease_token IS NULL AND lease_expires_at IS NULL))
);
CREATE INDEX article_enrichment_due ON article_enrichment_jobs(state,next_attempt_at,article_id);
CREATE INDEX article_enrichment_leases ON article_enrichment_jobs(state,lease_expires_at);
CREATE TABLE enrichment_daily_usage (
  day TEXT PRIMARY KEY NOT NULL,
  attempts INTEGER NOT NULL CHECK (attempts >= 0)
);

-- Preserve in-flight recapture/undo guards across the additive metadata field.
UPDATE article_extraction_jobs SET baseline_metadata=json_insert(baseline_metadata,'$[#]',
  CASE WHEN json_extract(baseline_metadata,'$[3]') IS NULL THEN NULL ELSE 'manual' END)
  WHERE baseline_metadata IS NOT NULL;
UPDATE article_capture_recovery SET
  previous_metadata=CASE WHEN previous_metadata IS NULL THEN NULL ELSE json_insert(previous_metadata,'$[#]',
    CASE WHEN json_extract(previous_metadata,'$[3]') IS NULL THEN NULL ELSE 'manual' END) END,
  resulting_metadata=CASE WHEN resulting_metadata IS NULL THEN NULL ELSE json_insert(resulting_metadata,'$[#]',
    CASE WHEN json_extract(resulting_metadata,'$[3]') IS NULL THEN NULL ELSE 'manual' END) END;
