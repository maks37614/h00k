-- h00k authentication & profile store. Run in a dedicated h00k database.
-- IDs are TEXT deliberately, so imported Firebase UIDs can be preserved.
CREATE TABLE IF NOT EXISTS auth_users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE CHECK (email = lower(email)),
  password_hash TEXT NOT NULL,
  display_name TEXT NOT NULL,
  email_verified_at TIMESTAMPTZ,
  profile JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS auth_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  user_agent TEXT NOT NULL DEFAULT '',
  ip_address TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS auth_sessions_user_active_idx ON auth_sessions(user_id, expires_at)
  WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS auth_action_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL CHECK (purpose IN ('verify-email', 'reset-password')),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS auth_action_user_idx ON auth_action_tokens(user_id, purpose);

CREATE TABLE IF NOT EXISTS auth_archives (
  user_id TEXT NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  payload JSONB NOT NULL,
  saved_at BIGINT NOT NULL,
  PRIMARY KEY (user_id, id)
);
CREATE INDEX IF NOT EXISTS auth_archives_recent_idx ON auth_archives(user_id, saved_at DESC);

-- History/alerts and exchange streams keep their existing storage during migration.
