-- Each commit acquires this nonce inside the same transaction as publication.
-- Stale batches must still match both their session and uncommitted records.
ALTER TABLE archive_sessions ADD COLUMN commit_token TEXT;
