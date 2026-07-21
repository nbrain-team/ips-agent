-- 033 — meeting_transcripts.source: which system the meeting came from
-- (read.ai webhook, otter.ai backfill, etc.)

ALTER TABLE meeting_transcripts ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'read.ai';
