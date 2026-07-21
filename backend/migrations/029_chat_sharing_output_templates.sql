-- 029 — chat sharing + global/per-user output (formatting) templates.

CREATE TABLE IF NOT EXISTS agent_chat_shares (
  id SERIAL PRIMARY KEY,
  session_id INTEGER REFERENCES agent_chat_sessions(id) ON DELETE CASCADE,
  shared_by INTEGER REFERENCES users(id) ON DELETE CASCADE,
  share_token TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS agent_output_templates (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,  -- NULL = global
  name TEXT NOT NULL,
  instructions TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
