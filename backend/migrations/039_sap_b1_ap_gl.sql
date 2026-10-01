-- 039 — SAP Business One AP, payments, and general ledger history.
--
-- Same backfill as 038 (keyset on the document key, resumable), covering the
-- payables and accounting side of B1 through the August 1, 2026 cutover.

-- A/P documents: purchase invoices (vendor bills) and purchase credit memos.
CREATE TABLE IF NOT EXISTS sap_b1.ap_invoices (
  doc_entry        INTEGER PRIMARY KEY,
  doc_num          INTEGER,
  series           INTEGER,
  doc_date         DATE,
  due_date         DATE,
  vendor_code      TEXT,                   -- sap_b1.business_partners.card_code
  vendor_name      TEXT,
  vendor_ref       TEXT,                   -- NumAtCard (vendor's invoice number)
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
CREATE TABLE IF NOT EXISTS sap_b1.ap_credit_memos (LIKE sap_b1.ap_invoices INCLUDING ALL);

CREATE INDEX IF NOT EXISTS idx_b1_apinv_date   ON sap_b1.ap_invoices(doc_date);
CREATE INDEX IF NOT EXISTS idx_b1_apinv_vendor ON sap_b1.ap_invoices(vendor_code);
CREATE INDEX IF NOT EXISTS idx_b1_apcm_date    ON sap_b1.ap_credit_memos(doc_date);
CREATE INDEX IF NOT EXISTS idx_b1_apcm_vendor  ON sap_b1.ap_credit_memos(vendor_code);

CREATE TABLE IF NOT EXISTS sap_b1.ap_invoice_lines (
  doc_entry     INTEGER NOT NULL,
  line_num      INTEGER NOT NULL,
  item_code     TEXT,
  description   TEXT,
  quantity      NUMERIC(14,4),
  price         NUMERIC(14,4),
  line_total    NUMERIC(14,2),
  project_code  TEXT,
  account_code  TEXT,                      -- GL account (sap_b1.chart_of_accounts.code)
  base_type     INTEGER,                   -- e.g. 22 = purchase order, 20 = goods receipt
  base_entry    INTEGER,
  raw_data      JSONB,
  PRIMARY KEY (doc_entry, line_num)
);
CREATE TABLE IF NOT EXISTS sap_b1.ap_credit_memo_lines (LIKE sap_b1.ap_invoice_lines INCLUDING ALL);

CREATE INDEX IF NOT EXISTS idx_b1_apinvl_account ON sap_b1.ap_invoice_lines(account_code);
CREATE INDEX IF NOT EXISTS idx_b1_apinvl_project ON sap_b1.ap_invoice_lines(project_code);

-- Payments: incoming (customer receipts) and vendor (outgoing) payments.
CREATE TABLE IF NOT EXISTS sap_b1.incoming_payments (
  doc_entry          INTEGER PRIMARY KEY,
  doc_num            INTEGER,
  doc_date           DATE,
  card_code          TEXT,                 -- business partner paid / paying
  card_name          TEXT,
  doc_type           TEXT,                 -- rCustomer | rSupplier | rAccount
  cash_sum           NUMERIC(14,2),
  transfer_sum       NUMERIC(14,2),
  check_sum          NUMERIC(14,2),
  credit_card_sum    NUMERIC(14,2),
  total              NUMERIC(14,2),        -- cash + transfer + checks + credit cards
  transfer_reference TEXT,
  remarks            TEXT,
  journal_remarks    TEXT,
  cancelled          BOOLEAN,
  raw_data           JSONB,
  synced_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS sap_b1.vendor_payments (LIKE sap_b1.incoming_payments INCLUDING ALL);

CREATE INDEX IF NOT EXISTS idx_b1_inpay_date ON sap_b1.incoming_payments(doc_date);
CREATE INDEX IF NOT EXISTS idx_b1_inpay_card ON sap_b1.incoming_payments(card_code);
CREATE INDEX IF NOT EXISTS idx_b1_vpay_date  ON sap_b1.vendor_payments(doc_date);
CREATE INDEX IF NOT EXISTS idx_b1_vpay_card  ON sap_b1.vendor_payments(card_code);

-- Which documents each payment settled.
CREATE TABLE IF NOT EXISTS sap_b1.incoming_payment_invoices (
  doc_entry          INTEGER NOT NULL,     -- incoming_payments.doc_entry
  line_num           INTEGER NOT NULL,
  invoice_doc_entry  INTEGER,              -- ar_invoices.doc_entry (or credit memo, per invoice_type)
  invoice_type       TEXT,                 -- it_Invoice | it_CredItnote | it_PurchaseInvoice | ...
  sum_applied        NUMERIC(14,2),
  PRIMARY KEY (doc_entry, line_num)
);
CREATE TABLE IF NOT EXISTS sap_b1.vendor_payment_invoices (LIKE sap_b1.incoming_payment_invoices INCLUDING ALL);

CREATE INDEX IF NOT EXISTS idx_b1_inpayi_inv ON sap_b1.incoming_payment_invoices(invoice_doc_entry);
CREATE INDEX IF NOT EXISTS idx_b1_vpayi_inv  ON sap_b1.vendor_payment_invoices(invoice_doc_entry);

-- General ledger: every posting (invoices, payments, payroll, manual entries).
CREATE TABLE IF NOT EXISTS sap_b1.journal_entries (
  jdt_num          INTEGER PRIMARY KEY,    -- JdtNum / TransId
  number           INTEGER,
  reference_date   DATE,                   -- posting date
  due_date         DATE,
  tax_date         DATE,
  memo             TEXT,
  reference1       TEXT,
  reference2       TEXT,
  reference3       TEXT,
  transaction_code TEXT,
  project_code     TEXT,
  origin_type      TEXT,                   -- OriginalJournal: source document type (ttARInvoice, ttVendorPayment, ttJournalEntry, ...)
  origin_ref       TEXT,                   -- source document number
  total_debit      NUMERIC(14,2),
  raw_data         JSONB,
  synced_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_b1_je_date   ON sap_b1.journal_entries(reference_date);
CREATE INDEX IF NOT EXISTS idx_b1_je_origin ON sap_b1.journal_entries(origin_type);

CREATE TABLE IF NOT EXISTS sap_b1.journal_entry_lines (
  jdt_num        INTEGER NOT NULL,         -- journal_entries.jdt_num
  line_id        INTEGER NOT NULL,
  account_code   TEXT,                     -- GL account (chart_of_accounts.code)
  short_name     TEXT,                     -- business partner code on BP lines, else the account
  debit          NUMERIC(14,2),
  credit         NUMERIC(14,2),
  line_memo      TEXT,
  project_code   TEXT,
  contra_account TEXT,
  reference1     TEXT,
  reference2     TEXT,
  costing_code   TEXT,                     -- distribution rule / cost center
  PRIMARY KEY (jdt_num, line_id)
);
CREATE INDEX IF NOT EXISTS idx_b1_jel_account ON sap_b1.journal_entry_lines(account_code);
CREATE INDEX IF NOT EXISTS idx_b1_jel_short   ON sap_b1.journal_entry_lines(short_name);
CREATE INDEX IF NOT EXISTS idx_b1_jel_project ON sap_b1.journal_entry_lines(project_code);

CREATE TABLE IF NOT EXISTS sap_b1.chart_of_accounts (
  code            TEXT PRIMARY KEY,
  name            TEXT,
  account_type    TEXT,                    -- at_Revenues | at_Expenses | at_Other
  active          BOOLEAN,
  postable        BOOLEAN,
  father_account  TEXT,
  raw_data        JSONB,
  synced_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
