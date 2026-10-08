-- 043 — Zoom cloud recordings. Meetings land in meeting_transcripts
-- (source 'zoom'); source_account says which Zoom account (IPS has several,
-- one Server-to-Server OAuth app each). zoom_sync_state tracks each account's
-- one-time history backfill and its hourly runs.

ALTER TABLE meeting_transcripts ADD COLUMN IF NOT EXISTS source_account TEXT;

CREATE TABLE IF NOT EXISTS zoom_sync_state (
  account_label         TEXT PRIMARY KEY,     -- env label: ZOOM_<LABEL>_ACCOUNT_ID
  zoom_account_id       TEXT,
  backfill_completed_at TIMESTAMPTZ,          -- NULL until the full history walk finishes once
  earliest_recording    TIMESTAMPTZ,
  last_run_at           TIMESTAMPTZ,
  last_success_at       TIMESTAMPTZ,
  last_error            TEXT,
  recordings_seen       INTEGER NOT NULL DEFAULT 0,
  meetings_ingested     INTEGER NOT NULL DEFAULT 0,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
