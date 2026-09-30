-- 038 — SAP Business One history + FieldVu Cloud field tickets.
--
-- IPS ran SAP B1 (with the CRCS FieldView add-on) from July 2017 until the
-- 2026 cutover to SAP S/4HANA, where field tickets moved to FieldVu Cloud.
-- sap_b1.* holds the complete legacy record (backfilled by DocEntry, then kept
-- current); fieldvu.* holds the FieldVu Cloud tickets from Feb 2026 on. The two
-- use different numbering and customer codes and overlap during the transition,
-- so they are kept side by side rather than merged.

CREATE SCHEMA IF NOT EXISTS sap_b1;
CREATE SCHEMA IF NOT EXISTS fieldvu;

-- Field tickets (UDO CRCS_oFieldTicket)
CREATE TABLE IF NOT EXISTS sap_b1.field_tickets (
  doc_entry            INTEGER PRIMARY KEY,
  doc_num              INTEGER,
  series               INTEGER,
  ticket_date          DATE,
  customer_code        TEXT,
  customer_name        TEXT,
  job_code             TEXT,               -- dominant U_PrjCode across the ticket's lines
  contact              TEXT,
  description          TEXT,
  ref1                 TEXT,               -- U_ref1..U_ref6: customer reference fields (lease/site, AFE, PO, ...)
  ref2                 TEXT,
  ref3                 TEXT,
  ref4                 TEXT,
  ref5                 TEXT,
  ref6                 TEXT,
  ship_to_code         TEXT,
  status               TEXT,               -- document status: O = open, C = closed
  canceled             BOOLEAN,
  approved             BOOLEAN,
  first_level_approved BOOLEAN,
  approved_date        DATE,
  approved_by          TEXT,
  labor_total          NUMERIC(14,2),
  equipment_total      NUMERIC(14,2),
  material_total       NUMERIC(14,2),
  doc_total            NUMERIC(14,2),
  billed_doc_type      TEXT,               -- target document type from the lines (e.g. DL = delivery note)
  billed_doc_nums      TEXT,               -- comma-separated target DocNums from the lines
  created_date         DATE,
  updated_date         DATE,
  raw_data             JSONB,              -- header fields only; lines live in field_ticket_lines
  synced_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_b1_ft_date     ON sap_b1.field_tickets(ticket_date);
CREATE INDEX IF NOT EXISTS idx_b1_ft_customer ON sap_b1.field_tickets(customer_code);
CREATE INDEX IF NOT EXISTS idx_b1_ft_job      ON sap_b1.field_tickets(job_code);
CREATE INDEX IF NOT EXISTS idx_b1_ft_docnum   ON sap_b1.field_tickets(doc_num);

CREATE TABLE IF NOT EXISTS sap_b1.field_ticket_lines (
  doc_entry        INTEGER NOT NULL,       -- sap_b1.field_tickets.doc_entry
  line_type        TEXT    NOT NULL,       -- labor | equipment | material
  line_id          INTEGER NOT NULL,
  work_date        DATE,
  employee_id      TEXT,
  employee_name    TEXT,
  work_type        TEXT,
  item_code        TEXT,
  item_name        TEXT,
  quantity         NUMERIC(14,4),
  st_hours         NUMERIC(10,2),
  ot_hours         NUMERIC(10,2),
  pd_hours         NUMERIC(10,2),
  st_rate          NUMERIC(14,4),
  ot_rate          NUMERIC(14,4),
  pd_rate          NUMERIC(14,4),
  price            NUMERIC(14,4),
  amount           NUMERIC(14,2),
  project_code     TEXT,
  billable         TEXT,
  target_doc_type  TEXT,                   -- U_CRCSTDT
  target_doc_num   TEXT,                   -- U_CRCSTDN
  comments         TEXT,
  raw_data         JSONB,
  PRIMARY KEY (doc_entry, line_type, line_id)
);
CREATE INDEX IF NOT EXISTS idx_b1_ftl_employee ON sap_b1.field_ticket_lines(employee_id);
CREATE INDEX IF NOT EXISTS idx_b1_ftl_project  ON sap_b1.field_ticket_lines(project_code);
CREATE INDEX IF NOT EXISTS idx_b1_ftl_target   ON sap_b1.field_ticket_lines(target_doc_num);

-- A/R documents: invoices, credit memos, and delivery notes (2017-era tickets
-- were delivered before invoicing). Same shape for all three.
CREATE TABLE IF NOT EXISTS sap_b1.ar_invoices (
  doc_entry        INTEGER PRIMARY KEY,
  doc_num          INTEGER,
  series           INTEGER,
  doc_date         DATE,
  due_date         DATE,
  customer_code    TEXT,
  customer_name    TEXT,
  customer_ref     TEXT,                   -- NumAtCard (customer PO / reference)
  project          TEXT,
  doc_total        NUMERIC(14,2),
  tax_total        NUMERIC(14,2),
  paid_to_date     NUMERIC(14,2),
  document_status  TEXT,                   -- bost_Open | bost_Close
  cancelled        BOOLEAN,
  comments         TEXT,
  journal_memo     TEXT,
  created_date     DATE,
  updated_date     DATE,
  raw_data         JSONB,
  synced_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS sap_b1.ar_credit_memos (LIKE sap_b1.ar_invoices INCLUDING ALL);
CREATE TABLE IF NOT EXISTS sap_b1.delivery_notes  (LIKE sap_b1.ar_invoices INCLUDING ALL);

CREATE INDEX IF NOT EXISTS idx_b1_inv_date     ON sap_b1.ar_invoices(doc_date);
CREATE INDEX IF NOT EXISTS idx_b1_inv_customer ON sap_b1.ar_invoices(customer_code);
CREATE INDEX IF NOT EXISTS idx_b1_inv_docnum   ON sap_b1.ar_invoices(doc_num);
CREATE INDEX IF NOT EXISTS idx_b1_cm_date      ON sap_b1.ar_credit_memos(doc_date);
CREATE INDEX IF NOT EXISTS idx_b1_dn_date      ON sap_b1.delivery_notes(doc_date);
CREATE INDEX IF NOT EXISTS idx_b1_dn_docnum    ON sap_b1.delivery_notes(doc_num);

CREATE TABLE IF NOT EXISTS sap_b1.ar_invoice_lines (
  doc_entry            INTEGER NOT NULL,
  line_num             INTEGER NOT NULL,
  item_code            TEXT,
  description          TEXT,
  quantity             NUMERIC(14,4),
  price                NUMERIC(14,4),
  line_total           NUMERIC(14,2),
  project_code         TEXT,
  account_code         TEXT,
  base_type            INTEGER,            -- standard B1 base document link
  base_entry           INTEGER,
  field_ticket_doc_type TEXT,              -- U_CRCSBDT ('FT' when the line came from a field ticket)
  field_ticket_doc_num  TEXT,              -- U_CRCSBDN = sap_b1.field_tickets.doc_num (invoice and delivery lines)
  work_details         TEXT,
  raw_data             JSONB,
  PRIMARY KEY (doc_entry, line_num)
);
CREATE TABLE IF NOT EXISTS sap_b1.ar_credit_memo_lines (LIKE sap_b1.ar_invoice_lines INCLUDING ALL);
CREATE TABLE IF NOT EXISTS sap_b1.delivery_note_lines  (LIKE sap_b1.ar_invoice_lines INCLUDING ALL);

CREATE INDEX IF NOT EXISTS idx_b1_invl_ft  ON sap_b1.ar_invoice_lines(field_ticket_doc_num);
CREATE INDEX IF NOT EXISTS idx_b1_dnl_ft   ON sap_b1.delivery_note_lines(field_ticket_doc_num);

CREATE TABLE IF NOT EXISTS sap_b1.business_partners (
  card_code   TEXT PRIMARY KEY,
  card_name   TEXT,
  card_type   TEXT,                        -- cCustomer | cSupplier | cLid
  active      BOOLEAN,
  phone       TEXT,
  email       TEXT,
  raw_data    JSONB,
  synced_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sap_b1.projects (
  code        TEXT PRIMARY KEY,
  name        TEXT,
  active      BOOLEAN,
  valid_from  DATE,
  valid_to    DATE,
  synced_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Resumable sync progress, one row per entity.
CREATE TABLE IF NOT EXISTS sap_b1.sync_state (
  entity                TEXT PRIMARY KEY,
  backfill_cursor       INTEGER NOT NULL DEFAULT 0,   -- highest DocEntry stored
  backfill_complete     BOOLEAN NOT NULL DEFAULT FALSE,
  backfill_started_at   TIMESTAMPTZ,
  backfill_completed_at TIMESTAMPTZ,
  changes_since         DATE,                         -- UpdateDate watermark for incremental passes
  rows_synced           BIGINT NOT NULL DEFAULT 0,
  last_run_at           TIMESTAMPTZ,
  last_status           TEXT,
  last_error            TEXT
);

-- FieldVu Cloud field ticket headers (IPS on S/4HANA, Feb 2026 onward).
CREATE TABLE IF NOT EXISTS fieldvu.field_tickets (
  doc_num             INTEGER PRIMARY KEY,
  ticket_date         DATE,
  status              TEXT,                -- Approved | Submitted | Unsubmitted | Reversed | Reversal | Deleted
  customer_code       TEXT,
  customer_name       TEXT,
  job_code            TEXT,
  job_name            TEXT,
  description         TEXT,
  customer_ref1       TEXT,
  customer_ref2       TEXT,
  customer_ref3       TEXT,
  ship_to_code        TEXT,
  ticket_total        NUMERIC(14,2),
  billing_document_id TEXT,                -- S/4HANA billing document once invoiced
  created_by          TEXT,
  company_branch_id   TEXT,
  raw_data            JSONB,
  first_seen_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  synced_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_fv_ft_date     ON fieldvu.field_tickets(ticket_date);
CREATE INDEX IF NOT EXISTS idx_fv_ft_customer ON fieldvu.field_tickets(customer_name);
