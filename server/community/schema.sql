CREATE TABLE IF NOT EXISTS hc_users (
  id uuid PRIMARY KEY, email text UNIQUE NOT NULL CHECK (email=lower(email)),
  password_hash text NOT NULL, email_verified boolean NOT NULL DEFAULT false,
  profile jsonb NOT NULL DEFAULT '{}', mfa_secret text, mfa_pending text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS hc_sessions (
  token_hash text PRIMARY KEY, user_id uuid NOT NULL REFERENCES hc_users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL, last_strong_auth timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS hc_sessions_owner ON hc_sessions(user_id);
CREATE TABLE IF NOT EXISTS hc_tokens (
  token_hash text PRIMARY KEY, user_id uuid NOT NULL REFERENCES hc_users(id) ON DELETE CASCADE,
  purpose text NOT NULL CHECK(purpose IN ('verify','reset')), expires_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS hc_archives (
  id text NOT NULL, owner_id uuid NOT NULL REFERENCES hc_users(id) ON DELETE CASCADE,
  body jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(owner_id,id)
);
CREATE TABLE IF NOT EXISTS hc_friendships (
  sender uuid NOT NULL REFERENCES hc_users(id) ON DELETE CASCADE,
  recipient uuid NOT NULL REFERENCES hc_users(id) ON DELETE CASCADE,
  accepted boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(sender,recipient), CHECK(sender<>recipient)
);
CREATE TABLE IF NOT EXISTS hc_blocks (
  owner_id uuid NOT NULL REFERENCES hc_users(id) ON DELETE CASCADE,
  target_id uuid NOT NULL REFERENCES hc_users(id) ON DELETE CASCADE,
  PRIMARY KEY(owner_id,target_id), CHECK(owner_id<>target_id)
);
CREATE TABLE IF NOT EXISTS hc_conversations (
  id uuid PRIMARY KEY, owner_id uuid NOT NULL REFERENCES hc_users(id), title text NOT NULL,
  is_group boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS hc_members (
  conversation_id uuid NOT NULL REFERENCES hc_conversations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES hc_users(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'member' CHECK(role IN ('owner','admin','member')),
  joined_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(conversation_id,user_id)
);
CREATE TABLE IF NOT EXISTS hc_packs (
  hash text PRIMARY KEY, data jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS hc_charts (
  id uuid PRIMARY KEY, owner_id uuid NOT NULL REFERENCES hc_users(id),
  pack_hash text NOT NULL REFERENCES hc_packs(hash),
  parent_id uuid REFERENCES hc_charts(id), annotations jsonb NOT NULL, preview jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS hc_items (
  id uuid PRIMARY KEY, owner_id uuid NOT NULL REFERENCES hc_users(id),
  kind text NOT NULL CHECK(kind IN ('post','comment','message','strategy','plan','lesson','test')),
  audience text NOT NULL DEFAULT 'private' CHECK(audience IN ('public','friends','private')),
  parent_id uuid REFERENCES hc_items(id), conversation_id uuid REFERENCES hc_conversations(id),
  chart_id uuid REFERENCES hc_charts(id), body jsonb NOT NULL,
  revision integer NOT NULL DEFAULT 1, deleted boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS hc_feed ON hc_items(kind,created_at DESC,id DESC) WHERE NOT deleted;
CREATE INDEX IF NOT EXISTS hc_threads ON hc_items(parent_id,created_at,id);
CREATE INDEX IF NOT EXISTS hc_messages ON hc_items(conversation_id,created_at,id);
CREATE TABLE IF NOT EXISTS hc_item_versions (
  item_id uuid NOT NULL REFERENCES hc_items(id), revision integer NOT NULL,
  body jsonb NOT NULL, audience text NOT NULL, saved_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(item_id,revision)
);
CREATE TABLE IF NOT EXISTS hc_reactions (
  item_id uuid NOT NULL REFERENCES hc_items(id), user_id uuid NOT NULL REFERENCES hc_users(id),
  emoji text NOT NULL, PRIMARY KEY(item_id,user_id)
);
CREATE TABLE IF NOT EXISTS hc_media (
  id uuid PRIMARY KEY, owner_id uuid NOT NULL REFERENCES hc_users(id), bytes integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS hc_notifications (
  id uuid PRIMARY KEY, owner_id uuid NOT NULL REFERENCES hc_users(id), type text NOT NULL,
  body jsonb NOT NULL, dedup_key text UNIQUE NOT NULL, read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS hc_reports (
  id uuid PRIMARY KEY, reporter_id uuid NOT NULL REFERENCES hc_users(id),
  item_id uuid REFERENCES hc_items(id), target_id uuid REFERENCES hc_users(id),
  reason text NOT NULL, status text NOT NULL DEFAULT 'pending', resolution text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS hc_reputation (
  owner_id uuid NOT NULL REFERENCES hc_users(id), event_key text NOT NULL,
  points integer NOT NULL, reason text NOT NULL, PRIMARY KEY(owner_id,event_key)
);
CREATE TABLE IF NOT EXISTS hc_connections (
  id uuid PRIMARY KEY, owner_id uuid NOT NULL REFERENCES hc_users(id),
  exchange text NOT NULL CHECK(exchange='bybit'), account_hash text UNIQUE NOT NULL,
  credential text NOT NULL, status text NOT NULL DEFAULT 'connected',
  synced_at timestamptz, covered_from timestamptz, error_code text, lease_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS hc_trades (
  connection_id uuid NOT NULL REFERENCES hc_connections(id), source_id text NOT NULL,
  owner_id uuid NOT NULL REFERENCES hc_users(id), symbol text NOT NULL,
  currency text NOT NULL, pnl numeric(38,18) NOT NULL, closed_at timestamptz NOT NULL,
  source jsonb NOT NULL, PRIMARY KEY(connection_id,source_id)
);
CREATE INDEX IF NOT EXISTS hc_trades_owner_time ON hc_trades(owner_id,closed_at DESC);
CREATE TABLE IF NOT EXISTS hc_trade_notes (
  connection_id uuid NOT NULL, source_id text NOT NULL, owner_id uuid NOT NULL REFERENCES hc_users(id),
  body jsonb NOT NULL, written_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(connection_id,source_id), FOREIGN KEY(connection_id,source_id) REFERENCES hc_trades(connection_id,source_id)
);
CREATE TABLE IF NOT EXISTS hc_risk_policies (
  owner_id uuid PRIMARY KEY REFERENCES hc_users(id), version integer NOT NULL DEFAULT 1,
  timezone text NOT NULL DEFAULT 'UTC', currency text NOT NULL DEFAULT 'USDT',
  hourly numeric(38,18), daily numeric(38,18), monthly numeric(38,18),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS hc_risk_state (
  owner_id uuid NOT NULL REFERENCES hc_users(id), policy_version integer NOT NULL,
  window_key text NOT NULL, breached boolean NOT NULL DEFAULT false,
  PRIMARY KEY(owner_id,policy_version,window_key)
);
CREATE TABLE IF NOT EXISTS hc_history (
  key text PRIMARY KEY, rows jsonb NOT NULL, fresh_until timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS hc_exchange_budget (scope text PRIMARY KEY, next_at timestamptz NOT NULL);
CREATE TABLE IF NOT EXISTS hc_audit (
  id uuid PRIMARY KEY, actor_id uuid REFERENCES hc_users(id), action text NOT NULL,
  target text NOT NULL, details jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE hc_users ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE hc_users ADD COLUMN IF NOT EXISTS mfa_last_counter bigint NOT NULL DEFAULT -1;
ALTER TABLE hc_sessions ADD COLUMN IF NOT EXISTS id uuid NOT NULL DEFAULT gen_random_uuid();
CREATE UNIQUE INDEX IF NOT EXISTS hc_sessions_public_id ON hc_sessions(id);
ALTER TABLE hc_charts ADD COLUMN IF NOT EXISTS deleted boolean NOT NULL DEFAULT false;
CREATE TABLE IF NOT EXISTS hc_recovery_codes (
  user_id uuid NOT NULL REFERENCES hc_users(id) ON DELETE CASCADE,
  code_hash text NOT NULL, used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(user_id,code_hash)
);
CREATE TABLE IF NOT EXISTS hc_export_tickets (
  token_hash text PRIMARY KEY, owner_id uuid NOT NULL REFERENCES hc_users(id),
  session_hash text NOT NULL REFERENCES hc_sessions(token_hash) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  scope text NOT NULL DEFAULT 'community' CHECK(scope IN ('community','market'))
);
CREATE TABLE IF NOT EXISTS hc_account_cleanup (
  owner_id uuid PRIMARY KEY REFERENCES hc_users(id),
  market_pending boolean NOT NULL DEFAULT true,
  lease_until timestamptz, attempts integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz
);
CREATE TABLE IF NOT EXISTS hc_media_cleanup (
  id uuid PRIMARY KEY, owner_id uuid NOT NULL REFERENCES hc_users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS hc_items_owner ON hc_items(owner_id,id);
CREATE INDEX IF NOT EXISTS hc_charts_owner ON hc_charts(owner_id,id);
CREATE INDEX IF NOT EXISTS hc_media_owner ON hc_media(owner_id,id);
CREATE INDEX IF NOT EXISTS hc_notifications_owner ON hc_notifications(owner_id,created_at DESC);
CREATE INDEX IF NOT EXISTS hc_members_user ON hc_members(user_id,conversation_id);
CREATE TABLE IF NOT EXISTS hc_profile_names (
  name_hash text PRIMARY KEY CHECK(length(name_hash)=64),
  username text UNIQUE CHECK(username ~ '^[a-z][a-z0-9-]{1,28}[a-z0-9]$'),
  owner_id uuid UNIQUE REFERENCES hc_users(id), claimed_at timestamptz NOT NULL DEFAULT now(),
  retired_at timestamptz,
  CHECK ((username IS NOT NULL AND owner_id IS NOT NULL AND retired_at IS NULL)
    OR (username IS NULL AND owner_id IS NULL AND retired_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS hc_public_wall ON hc_items(owner_id,created_at DESC,id DESC)
  WHERE kind='post' AND audience='public' AND conversation_id IS NULL AND NOT deleted;
