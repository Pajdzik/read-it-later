CREATE TABLE audio_episodes (
  id TEXT PRIMARY KEY,
  article_id TEXT REFERENCES articles(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  author TEXT,
  url TEXT NOT NULL,
  copy_revision TEXT NOT NULL,
  voice TEXT NOT NULL,
  normalizer_version INTEGER NOT NULL,
  narration_text TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('queued','generating','ready','failed','deleted')),
  created_at TEXT NOT NULL,
  ready_at TEXT,
  bytes INTEGER NOT NULL DEFAULT 0 CHECK(bytes >= 0),
  duration_seconds REAL NOT NULL DEFAULT 0 CHECK(duration_seconds >= 0),
  object_key TEXT,
  checksum TEXT,
  generation INTEGER NOT NULL DEFAULT 1 CHECK(generation > 0),
  assembly_attempts INTEGER NOT NULL DEFAULT 0 CHECK(assembly_attempts BETWEEN 0 AND 3),
  lease_token TEXT,
  lease_expires_at TEXT,
  error_code TEXT,
  cleanup_at TEXT
);
CREATE UNIQUE INDEX audio_episode_active_article ON audio_episodes(article_id) WHERE article_id IS NOT NULL AND state != 'deleted';
CREATE INDEX audio_episode_cleanup ON audio_episodes(state,cleanup_at);
CREATE TRIGGER audio_article_removed AFTER UPDATE OF article_id ON audio_episodes
 WHEN OLD.article_id IS NOT NULL AND NEW.article_id IS NULL BEGIN
  UPDATE audio_episodes SET state='deleted',generation=generation+1,lease_token=NULL,lease_expires_at=NULL,
    cleanup_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=NEW.id;
 END;

CREATE TABLE audio_chunks (
  episode_id TEXT NOT NULL REFERENCES audio_episodes(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL CHECK(chunk_index >= 0),
  text TEXT NOT NULL,
  request_characters INTEGER NOT NULL CHECK(request_characters > 0),
  state TEXT NOT NULL CHECK(state IN ('queued','running','succeeded','failed','ambiguous')),
  generation INTEGER NOT NULL DEFAULT 1 CHECK(generation > 0),
  lease_token TEXT,
  lease_expires_at TEXT,
  object_key TEXT,
  bytes INTEGER NOT NULL DEFAULT 0 CHECK(bytes >= 0),
  reserved_month TEXT,
  error_code TEXT,
  PRIMARY KEY(episode_id,chunk_index)
);
CREATE INDEX audio_chunks_claim ON audio_chunks(state,lease_expires_at);

CREATE TABLE audio_monthly_usage (
  month TEXT PRIMARY KEY,
  used_characters INTEGER NOT NULL DEFAULT 0 CHECK(used_characters >= 0),
  reserved_characters INTEGER NOT NULL DEFAULT 0 CHECK(reserved_characters >= 0),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0)
);

CREATE TABLE audio_object_cleanup (
  object_key TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);
CREATE INDEX audio_object_cleanup_created ON audio_object_cleanup(created_at);
