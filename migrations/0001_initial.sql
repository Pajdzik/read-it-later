-- Initial pre-launch schema. Apply only to a fresh database; see docs/prelaunch-reset.md.

CREATE TABLE articles (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  normalized_url TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  read_at TEXT,
  author TEXT,
  description TEXT,
  title_origin TEXT NOT NULL DEFAULT 'protected'
    CHECK (title_origin IN ('fallback', 'supplied', 'extracted', 'protected')),
  pdf_asset_id TEXT REFERENCES pdf_assets(id),
  enrichment_requested_at TEXT,
  enrichment_wait_for_copy INTEGER NOT NULL DEFAULT 0 CHECK (enrichment_wait_for_copy IN (0,1)),
  description_origin TEXT CHECK (description_origin IN ('manual','extracted','generated')),
  tags_manual INTEGER NOT NULL DEFAULT 0 CHECK (tags_manual IN (0,1))
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  csrf_token TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE oauth_states (
  state_hash TEXT PRIMARY KEY,
  browser_binding_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE capture_tokens (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE TABLE capture_rate_buckets (
  token_id TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY(token_id, window_start)
);

CREATE TABLE article_copies (
  article_id TEXT PRIMARY KEY NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  markdown TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('paste', 'upload')),
  revision TEXT NOT NULL
);

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
  kind TEXT NOT NULL DEFAULT 'initial' CHECK (kind IN ('initial', 'recapture')),
  expected_revision TEXT,
  refresh_metadata INTEGER NOT NULL DEFAULT 0 CHECK (refresh_metadata IN (0, 1)),
  baseline_metadata TEXT,
  CHECK ((state = 'running' AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
      OR (state != 'running' AND lease_token IS NULL AND lease_expires_at IS NULL))
);

CREATE TABLE article_integration_deliveries (
  article_id TEXT NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  integration_id TEXT NOT NULL,
  destination_key TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  delivered_at TEXT NOT NULL,
  PRIMARY KEY (article_id, integration_id, destination_key)
);

CREATE TABLE article_capture_recovery (
  article_id TEXT PRIMARY KEY NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  markdown TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('paste', 'upload')),
  previous_metadata TEXT,
  resulting_metadata TEXT,
  resulting_revision TEXT NOT NULL,
  pdf_asset_id TEXT REFERENCES pdf_assets(id)
);

CREATE TABLE pdf_assets (
  id TEXT PRIMARY KEY,
  object_key TEXT NOT NULL UNIQUE,
  checksum TEXT NOT NULL,
  bytes INTEGER NOT NULL CHECK(bytes > 0 AND bytes <= 20971520),
  captured_at TEXT NOT NULL,
  source_url TEXT NOT NULL,
  cleanup_at TEXT NOT NULL,
  deleting INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE archive_sessions (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('export','import')),
  expires_at TEXT NOT NULL,
  completed INTEGER NOT NULL DEFAULT 0,
  commit_token TEXT
);

CREATE TABLE archive_records (
  session_id TEXT NOT NULL REFERENCES archive_sessions(id) ON DELETE CASCADE,
  article_id TEXT NOT NULL,
  record TEXT NOT NULL,
  asset_id TEXT REFERENCES pdf_assets(id),
  pdf_info TEXT,
  normalized_url TEXT,
  committed INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(session_id, article_id)
);

CREATE TABLE archive_files (
  session_id TEXT NOT NULL REFERENCES archive_sessions(id) ON DELETE CASCADE,
  archive_id TEXT NOT NULL,
  asset_id TEXT NOT NULL REFERENCES pdf_assets(id),
  PRIMARY KEY(session_id, archive_id)
);

CREATE INDEX articles_created ON articles(created_at DESC, id DESC);

CREATE INDEX articles_read_created ON articles(read_at, created_at DESC, id DESC);

CREATE INDEX sessions_expires ON sessions(expires_at);

CREATE INDEX oauth_states_expires ON oauth_states(expires_at);

CREATE INDEX capture_rate_window ON capture_rate_buckets(window_start);

CREATE INDEX article_extraction_jobs_eligible
  ON article_extraction_jobs(state, next_attempt_at, article_id);

CREATE INDEX article_extraction_jobs_leases
  ON article_extraction_jobs(state, lease_expires_at);

CREATE INDEX pdf_assets_cleanup ON pdf_assets(cleanup_at);

CREATE INDEX articles_pdf_asset ON articles(pdf_asset_id);

CREATE INDEX recovery_pdf_asset ON article_capture_recovery(pdf_asset_id);

CREATE INDEX archive_records_asset ON archive_records(asset_id);

CREATE INDEX archive_files_asset ON archive_files(asset_id);

CREATE TRIGGER pdf_article_removed AFTER DELETE ON articles WHEN OLD.pdf_asset_id IS NOT NULL BEGIN
  UPDATE pdf_assets SET cleanup_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','+1 day') WHERE id=OLD.pdf_asset_id;
END;

CREATE TRIGGER pdf_article_replaced AFTER UPDATE OF pdf_asset_id ON articles WHEN OLD.pdf_asset_id IS NOT NEW.pdf_asset_id BEGIN
  UPDATE pdf_assets SET cleanup_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','+1 day') WHERE id=OLD.pdf_asset_id;
END;

CREATE TRIGGER pdf_recovery_removed AFTER DELETE ON article_capture_recovery WHEN OLD.pdf_asset_id IS NOT NULL BEGIN
  UPDATE pdf_assets SET cleanup_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','+1 day') WHERE id=OLD.pdf_asset_id;
END;

CREATE TRIGGER articles_ready_asset_0 BEFORE INSERT ON articles
 WHEN NEW.pdf_asset_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM pdf_assets WHERE id=NEW.pdf_asset_id AND deleting=0) BEGIN
 SELECT RAISE(ABORT,'asset_unavailable'); END;

CREATE TRIGGER articles_ready_asset_1 BEFORE UPDATE OF pdf_asset_id ON articles
 WHEN NEW.pdf_asset_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM pdf_assets WHERE id=NEW.pdf_asset_id AND deleting=0) BEGIN
 SELECT RAISE(ABORT,'asset_unavailable'); END;

CREATE TRIGGER article_capture_recovery_ready_asset_0 BEFORE INSERT ON article_capture_recovery
 WHEN NEW.pdf_asset_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM pdf_assets WHERE id=NEW.pdf_asset_id AND deleting=0) BEGIN
 SELECT RAISE(ABORT,'asset_unavailable'); END;

CREATE TRIGGER article_capture_recovery_ready_asset_1 BEFORE UPDATE OF pdf_asset_id ON article_capture_recovery
 WHEN NEW.pdf_asset_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM pdf_assets WHERE id=NEW.pdf_asset_id AND deleting=0) BEGIN
 SELECT RAISE(ABORT,'asset_unavailable'); END;

CREATE TRIGGER archive_records_ready_asset_0 BEFORE INSERT ON archive_records
 WHEN NEW.asset_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM pdf_assets WHERE id=NEW.asset_id AND deleting=0) BEGIN
 SELECT RAISE(ABORT,'asset_unavailable'); END;

CREATE TRIGGER archive_records_ready_asset_1 BEFORE UPDATE OF asset_id ON archive_records
 WHEN NEW.asset_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM pdf_assets WHERE id=NEW.asset_id AND deleting=0) BEGIN
 SELECT RAISE(ABORT,'asset_unavailable'); END;

CREATE TRIGGER archive_files_ready_asset_0 BEFORE INSERT ON archive_files
 WHEN NEW.asset_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM pdf_assets WHERE id=NEW.asset_id AND deleting=0) BEGIN
 SELECT RAISE(ABORT,'asset_unavailable'); END;

CREATE TRIGGER archive_files_ready_asset_1 BEFORE UPDATE OF asset_id ON archive_files
 WHEN NEW.asset_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM pdf_assets WHERE id=NEW.asset_id AND deleting=0) BEGIN
 SELECT RAISE(ABORT,'asset_unavailable'); END;

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
