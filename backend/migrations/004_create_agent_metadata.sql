-- 004 — agent_metadata schema: the NL→SQL data layer's brain.
-- table_vectors (semantic table discovery), query_history (learning),
-- query_patterns (reusable templates). source_tag distinguishes the primary
-- operational DB from the read-only billing DB (Part 11.1).

CREATE SCHEMA IF NOT EXISTS agent_metadata;

CREATE TABLE IF NOT EXISTS agent_metadata.table_vectors (
  id SERIAL PRIMARY KEY,
  table_name TEXT NOT NULL,
  source_tag TEXT NOT NULL DEFAULT 'primary',      -- primary | billing
  description TEXT NOT NULL,
  columns_json JSONB NOT NULL DEFAULT '[]',
  row_count BIGINT NOT NULL DEFAULT 0,
  date_range_json JSONB,
  sample_rows_json JSONB NOT NULL DEFAULT '[]',
  embedding vector(1536),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (table_name, source_tag)
);
CREATE INDEX IF NOT EXISTS idx_table_vectors_vec ON agent_metadata.table_vectors
  USING ivfflat (embedding vector_cosine_ops) WITH (lists = 50);

CREATE TABLE IF NOT EXISTS agent_metadata.query_history (
  id SERIAL PRIMARY KEY,
  question TEXT NOT NULL,
  generated_sql TEXT,
  source_tag TEXT NOT NULL DEFAULT 'primary',
  row_count INTEGER NOT NULL DEFAULT 0,
  success BOOLEAN NOT NULL DEFAULT false,
  error TEXT,
  duration_ms INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS agent_metadata.query_patterns (
  id SERIAL PRIMARY KEY,
  pattern_name TEXT NOT NULL UNIQUE,
  question_template TEXT NOT NULL,
  sql_template TEXT NOT NULL,
  usage_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
