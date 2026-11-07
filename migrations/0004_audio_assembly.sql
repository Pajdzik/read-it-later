CREATE TABLE audio_assembly_grants (
  token_hash TEXT PRIMARY KEY,
  episode_id TEXT NOT NULL REFERENCES audio_episodes(id) ON DELETE CASCADE,
  generation INTEGER NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX audio_assembly_grants_expiry ON audio_assembly_grants(expires_at);
