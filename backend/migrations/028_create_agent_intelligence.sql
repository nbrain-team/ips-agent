-- 028 — agent intelligence layer: cross-session memory + observability traces.

CREATE TABLE IF NOT EXISTS agent_memories (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  memory_type TEXT NOT NULL DEFAULT 'fact',        -- fact | preference | project | style
  embedding vector(1536),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, content_hash)
);
CREATE INDEX IF NOT EXISTS idx_memories_vec ON agent_memories
  USING ivfflat (embedding vector_cosine_ops) WITH (lists = 50);

CREATE TABLE IF NOT EXISTS agent_traces (
  id SERIAL PRIMARY KEY,
  session_id INTEGER,
  user_id INTEGER,
  mode TEXT NOT NULL DEFAULT 'tool_use',           -- tool_use | plan | deep_research
  user_message TEXT,
  sub_questions JSONB NOT NULL DEFAULT '[]',
  tools_used JSONB NOT NULL DEFAULT '[]',
  memory_hits INTEGER NOT NULL DEFAULT 0,
  validator_issues JSONB NOT NULL DEFAULT '[]',
  confidence_score NUMERIC(4,2),
  tokens_used INTEGER NOT NULL DEFAULT 0,
  latency_ms INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_traces_time ON agent_traces(created_at DESC);
