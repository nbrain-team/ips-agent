-- 034 — Security: per-user token_version for JWT revocation.
-- Bumping a user's token_version invalidates all their existing JWTs
-- (used on password change, force-logout, and account disable).

ALTER TABLE users ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 0;
