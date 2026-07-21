-- 036 — Data coverage: email attachment text extraction + missing indexes.

CREATE TABLE IF NOT EXISTS ms_email_attachments (
  id SERIAL PRIMARY KEY,
  ms_message_id TEXT NOT NULL REFERENCES ms_emails(ms_message_id) ON DELETE CASCADE,
  ms_attachment_id TEXT NOT NULL,
  filename TEXT,
  content_type TEXT,
  size_bytes INTEGER,
  text_content TEXT,             -- extracted text (pdf/docx/xlsx/csv/txt); NULL if unsupported
  extract_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (ms_message_id, ms_attachment_id)
);
CREATE INDEX IF NOT EXISTS idx_attachments_message ON ms_email_attachments(ms_message_id);
CREATE INDEX IF NOT EXISTS idx_attachments_fts ON ms_email_attachments
  USING GIN (to_tsvector('english', COALESCE(filename, '') || ' ' || COALESCE(text_content, '')));

-- Missing indexes flagged in the audit
CREATE INDEX IF NOT EXISTS idx_website_content_url ON website_content(url);
CREATE INDEX IF NOT EXISTS idx_meeting_transcripts_source ON meeting_transcripts(source);
CREATE INDEX IF NOT EXISTS idx_meeting_transcripts_owner ON meeting_transcripts(owner_email);
CREATE INDEX IF NOT EXISTS idx_ms_emails_mailbox_received ON ms_emails(mailbox_email, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_ms_emails_received ON ms_emails(received_at DESC);
CREATE INDEX IF NOT EXISTS idx_feedback_status ON agent_feedback(approval_status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_artifacts_session ON agent_artifacts(session_id);
