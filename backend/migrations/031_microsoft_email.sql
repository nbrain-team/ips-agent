-- 031 — Microsoft 365 integration: SSO fields on users, tenant mailboxes,
-- synced email store. ms_emails/ms_mailboxes are EXCLUDED from the generic
-- NL-to-SQL layer — email is only reachable through the permission-scoped
-- search_user_emails tool (own mailbox unless admin).

ALTER TABLE users ADD COLUMN IF NOT EXISTS ms_object_id TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_provider TEXT NOT NULL DEFAULT 'password';

CREATE TABLE IF NOT EXISTS ms_mailboxes (
  id SERIAL PRIMARY KEY,
  ms_user_id TEXT NOT NULL UNIQUE,                 -- Entra object id
  email TEXT NOT NULL UNIQUE,
  display_name TEXT,
  account_enabled BOOLEAN NOT NULL DEFAULT true,
  last_synced_at TIMESTAMPTZ,
  sync_status TEXT NOT NULL DEFAULT 'pending',     -- pending | ok | error
  sync_error TEXT,
  message_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ms_emails (
  id SERIAL PRIMARY KEY,
  ms_message_id TEXT NOT NULL UNIQUE,
  mailbox_email TEXT NOT NULL,                     -- owning mailbox (visibility scope key)
  subject TEXT,
  from_name TEXT,
  from_address TEXT,
  to_addresses TEXT[] NOT NULL DEFAULT '{}',
  cc_addresses TEXT[] NOT NULL DEFAULT '{}',
  body_preview TEXT,
  body_text TEXT,
  received_at TIMESTAMPTZ,
  is_read BOOLEAN,
  has_attachments BOOLEAN NOT NULL DEFAULT false,
  web_link TEXT,
  fts tsvector GENERATED ALWAYS AS (
    to_tsvector('english',
      coalesce(subject,'') || ' ' || coalesce(from_name,'') || ' ' ||
      coalesce(from_address,'') || ' ' || coalesce(body_text,''))
  ) STORED,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ms_emails_mailbox ON ms_emails(mailbox_email, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_ms_emails_from ON ms_emails(from_address);
CREATE INDEX IF NOT EXISTS idx_ms_emails_fts ON ms_emails USING GIN (fts);
