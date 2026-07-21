-- 001 — Core platform system tables (users, sessions, messages, artifacts,
-- feedback, presence, preferences, jobs, notifications). Idempotent.

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',              -- user | user_manager | admin
  is_active BOOLEAN NOT NULL DEFAULT true,
  must_change_password BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS agent_chat_sessions (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL DEFAULT 'ips',
  project_id TEXT,
  title TEXT NOT NULL DEFAULT 'New chat',
  folder TEXT,
  subfolder TEXT,
  tags TEXT[] NOT NULL DEFAULT '{}',
  is_archived BOOLEAN NOT NULL DEFAULT false,
  visibility TEXT NOT NULL DEFAULT 'private',     -- private | shared
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON agent_chat_sessions(user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS agent_chat_messages (
  id SERIAL PRIMARY KEY,
  session_id INTEGER REFERENCES agent_chat_sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL,                              -- user | assistant | system
  content TEXT NOT NULL DEFAULT '',
  model_used TEXT,
  tokens_used INTEGER,
  plan_json JSONB,
  tool_calls JSONB,
  sources JSONB,
  search_method TEXT,
  complexity_level TEXT,
  confidence_score NUMERIC(4,2),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON agent_chat_messages(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_fts ON agent_chat_messages USING GIN (to_tsvector('english', content));

CREATE TABLE IF NOT EXISTS agent_artifacts (
  id SERIAL PRIMARY KEY,
  session_id INTEGER REFERENCES agent_chat_sessions(id) ON DELETE SET NULL,
  message_id INTEGER REFERENCES agent_chat_messages(id) ON DELETE SET NULL,
  type TEXT NOT NULL,                              -- html | svg | mermaid | chart | markdown | pdf
  title TEXT NOT NULL,
  content TEXT,
  content_binary BYTEA,
  version INTEGER NOT NULL DEFAULT 1,
  parent_artifact_id INTEGER REFERENCES agent_artifacts(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS agent_templates (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  template_type TEXT NOT NULL DEFAULT 'document',
  content TEXT NOT NULL,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS agent_session_presence (
  socket_id TEXT PRIMARY KEY,
  session_id INTEGER,
  user_id INTEGER,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS agent_feedback (
  id SERIAL PRIMARY KEY,
  message_id INTEGER REFERENCES agent_chat_messages(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  rating TEXT NOT NULL,                            -- up | down
  categories TEXT[] NOT NULL DEFAULT '{}',
  feedback_text TEXT,
  training_instruction TEXT,
  approval_status TEXT NOT NULL DEFAULT 'pending', -- pending | approved | rejected
  approved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS agent_user_preferences (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  pref_key TEXT NOT NULL,
  pref_value TEXT,
  confidence NUMERIC(4,2) NOT NULL DEFAULT 0.5,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, pref_key)
);

CREATE TABLE IF NOT EXISTS agent_background_jobs (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  job_type TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending',
  run_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS agent_notification_preferences (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  email_enabled BOOLEAN NOT NULL DEFAULT true,
  digest_enabled BOOLEAN NOT NULL DEFAULT false,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS agent_notifications (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  body TEXT,
  is_read BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS agent_weekly_digests (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  week_start DATE NOT NULL,
  content TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS agent_pinecone_sync (
  id SERIAL PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  synced_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'pending'
);

-- updated_at trigger
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_users_updated') THEN
    CREATE TRIGGER trg_users_updated BEFORE UPDATE ON users
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_sessions_updated') THEN
    CREATE TRIGGER trg_sessions_updated BEFORE UPDATE ON agent_chat_sessions
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;
