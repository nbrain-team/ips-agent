-- 032 — Read.ai meeting transcripts. Full meeting record lives here; the
-- transcript is also chunked + embedded into website_content
-- (category 'meeting_transcript') so vector/hybrid search finds it.

CREATE TABLE IF NOT EXISTS meeting_transcripts (
  id SERIAL PRIMARY KEY,
  session_id TEXT NOT NULL UNIQUE,          -- Read.ai session id (dedupe key)
  title TEXT,
  meeting_start TIMESTAMPTZ,
  meeting_end TIMESTAMPTZ,
  owner_email TEXT,
  participants JSONB NOT NULL DEFAULT '[]',
  summary TEXT,
  action_items JSONB NOT NULL DEFAULT '[]',
  key_questions JSONB NOT NULL DEFAULT '[]',
  topics JSONB NOT NULL DEFAULT '[]',
  report_url TEXT,
  transcript_text TEXT,
  chunk_count INTEGER NOT NULL DEFAULT 0,
  raw_payload JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_meeting_transcripts_start ON meeting_transcripts(meeting_start DESC);
