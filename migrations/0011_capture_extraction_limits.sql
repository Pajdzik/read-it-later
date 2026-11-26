ALTER TABLE article_extraction_jobs ADD COLUMN capture_token_id TEXT REFERENCES capture_tokens(id);
ALTER TABLE article_extraction_jobs ADD COLUMN recovery_published_at TEXT;

CREATE INDEX capture_extraction_outstanding ON article_extraction_jobs(capture_token_id)
  WHERE capture_token_id IS NOT NULL AND state IN ('queued','running','retry_wait');
CREATE INDEX article_extraction_pending_recovery
  ON article_extraction_jobs((capture_token_id IS NOT NULL),recovery_published_at,article_id)
  WHERE state IN ('queued','retry_wait');

CREATE TRIGGER cancel_revoked_capture_extractions AFTER UPDATE OF revoked_at ON capture_tokens
  WHEN OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL
BEGIN
  UPDATE article_extraction_jobs SET state='failed',generation=generation+1,
    lease_token=NULL,lease_expires_at=NULL,error_code='capture_token_revoked',
    finished_at=NEW.revoked_at,updated_at=NEW.revoked_at
    WHERE capture_token_id=NEW.id AND state IN ('queued','running','retry_wait');
END;
