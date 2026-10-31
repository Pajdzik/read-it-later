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
CREATE INDEX pdf_assets_cleanup ON pdf_assets(cleanup_at);
ALTER TABLE articles ADD COLUMN pdf_asset_id TEXT REFERENCES pdf_assets(id);
ALTER TABLE article_capture_recovery ADD COLUMN pdf_asset_id TEXT REFERENCES pdf_assets(id);
CREATE TABLE archive_sessions (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('export','import')),
  expires_at TEXT NOT NULL,
  completed INTEGER NOT NULL DEFAULT 0
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
CREATE TRIGGER pdf_article_removed AFTER DELETE ON articles WHEN OLD.pdf_asset_id IS NOT NULL BEGIN
  UPDATE pdf_assets SET cleanup_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','+1 day') WHERE id=OLD.pdf_asset_id;
END;
CREATE TRIGGER pdf_article_replaced AFTER UPDATE OF pdf_asset_id ON articles WHEN OLD.pdf_asset_id IS NOT NEW.pdf_asset_id BEGIN
  UPDATE pdf_assets SET cleanup_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','+1 day') WHERE id=OLD.pdf_asset_id;
END;
CREATE TRIGGER pdf_recovery_removed AFTER DELETE ON article_capture_recovery WHEN OLD.pdf_asset_id IS NOT NULL BEGIN
  UPDATE pdf_assets SET cleanup_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','+1 day') WHERE id=OLD.pdf_asset_id;
END;

CREATE INDEX articles_pdf_asset ON articles(pdf_asset_id);
CREATE INDEX recovery_pdf_asset ON article_capture_recovery(pdf_asset_id);
CREATE INDEX archive_records_asset ON archive_records(asset_id);
CREATE INDEX archive_files_asset ON archive_files(asset_id);
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
