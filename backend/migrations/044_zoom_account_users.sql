-- 044 — Zoom account licensing. Free (Basic) Zoom users have no cloud
-- recording, so an account with no licensed users can never supply meetings;
-- the data page says so instead of showing a bare zero.

ALTER TABLE zoom_sync_state ADD COLUMN IF NOT EXISTS total_users INTEGER;
ALTER TABLE zoom_sync_state ADD COLUMN IF NOT EXISTS licensed_users INTEGER;
