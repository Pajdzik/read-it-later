-- A single owner-controlled capability grants read-only podcast access.
-- The plaintext is shown once and never persisted.
CREATE TABLE podcast_token (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  token_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);
