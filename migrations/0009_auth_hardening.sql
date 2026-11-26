ALTER TABLE oauth_states ADD COLUMN pkce_verifier TEXT;
CREATE INDEX oauth_states_expiry ON oauth_states(expires_at);

ALTER TABLE sessions ADD COLUMN owner_generation INTEGER NOT NULL DEFAULT 1;
ALTER TABLE capture_tokens ADD COLUMN owner_generation INTEGER NOT NULL DEFAULT 1;
ALTER TABLE podcast_token ADD COLUMN owner_generation INTEGER NOT NULL DEFAULT 1;

CREATE TABLE auth_owner_generation (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  owner_github_id TEXT,
  generation INTEGER NOT NULL CHECK (generation > 0)
);
INSERT INTO auth_owner_generation(singleton, owner_github_id, generation) VALUES (1, NULL, 1);
