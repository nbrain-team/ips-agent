-- 002 — pgvector extension + knowledge/document table (website_content).
-- Powers vector_search / hybrid_search over ingested site + document content.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS website_content (
  id SERIAL PRIMARY KEY,
  url TEXT,
  title TEXT,
  content TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'documentation',
  source TEXT NOT NULL DEFAULT 'website',          -- website | document | import
  embedding vector(1536),
  fts tsvector GENERATED ALWAYS AS (to_tsvector('english', coalesce(title,'') || ' ' || content)) STORED,
  content_hash TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_website_content_hash ON website_content(content_hash);
CREATE INDEX IF NOT EXISTS idx_website_content_fts ON website_content USING GIN (fts);
CREATE INDEX IF NOT EXISTS idx_website_content_vec ON website_content
  USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
