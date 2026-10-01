CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  csrf_token TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX sessions_expires ON sessions(expires_at);

CREATE TABLE oauth_states (
  state_hash TEXT PRIMARY KEY,
  browser_binding_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX oauth_states_expires ON oauth_states(expires_at);

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
CREATE INDEX capture_rate_window ON capture_rate_buckets(window_start);
