-- 037 — Ops visibility: persistent ingest-failure inbox.
-- Failures from Read.ai webhooks, email sync, website crawls, and table
-- vectorization were console-only; now they land here for the admin UI.

CREATE TABLE IF NOT EXISTS ingest_failures (
  id SERIAL PRIMARY KEY,
  source TEXT NOT NULL,              -- readai | email_sync | website_crawl | vectorize | other
  reference TEXT,                    -- meeting title / mailbox / URL / table name
  error TEXT NOT NULL,
  detail JSONB,
  resolved BOOLEAN NOT NULL DEFAULT FALSE,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ingest_failures_open
  ON ingest_failures(resolved, created_at DESC);
