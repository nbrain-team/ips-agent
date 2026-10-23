-- Rachel and Brittney's Oct 23, 2026 session: GL account totals must sweep
-- every posting source, and a reconciliation needs the split by source in one
-- query. sap.gl_lines gains posting_source (appended, so CREATE OR REPLACE
-- keeps every existing column and dependent query intact).

CREATE OR REPLACE VIEW sap.gl_lines AS
SELECT
  'SAP B1'::text                                   AS source_system,
  je.reference_date                                AS posting_date,
  EXTRACT(YEAR FROM je.reference_date)::int        AS fiscal_year,
  EXTRACT(MONTH FROM je.reference_date)::int       AS fiscal_period,
  je.jdt_num::text                                 AS document,
  jel.line_id::text                                AS document_line,
  je.origin_type                                   AS document_type,
  CASE WHEN f.fc ~ '^\d{9}$'
       THEN left(f.fc, 6) || CASE WHEN right(f.fc, 3) = '000' THEN '' ELSE '-' || right(f.fc, 3) END
       ELSE f.fc END                               AS gl_account,
  coa.name                                         AS gl_account_name,
  CASE coa.account_type WHEN 'at_Revenues' THEN 'revenue' WHEN 'at_Expenses' THEN 'expense' ELSE 'balance_sheet' END AS account_class,
  (COALESCE(jel.debit, 0) - COALESCE(jel.credit, 0))::numeric(24,3) AS amount,
  jel.costing_code                                 AS division,
  jel.costing_code2                                AS location,
  NULLIF(COALESCE(jel.costing_code, '') || COALESCE(jel.costing_code2, ''), '') AS profit_center,
  NULL::text                                       AS cost_center,
  CASE WHEN jel.short_name IS DISTINCT FROM jel.account_code THEN jel.short_name END AS business_partner,
  COALESCE(jel.project_code, je.project_code)      AS project,
  COALESCE(jel.line_memo, je.memo)                 AS line_text,
  je.origin_type IN ('ttClosingBalance', 'ttOpeningBalance') AS is_period_close,
  CASE
    WHEN je.origin_type IN ('ttAPInvoice', 'ttAPCreditNote', 'ttAPCorrectionInvoice', 'ttAPDownPayment') THEN 'AP invoice'
    WHEN je.origin_type IN ('ttARInvoice', 'ttARCredItnote', 'ttARCorrectionInvoice', 'ttARDownPayment', 'ttDeliveryNotes', 'ttReturn') THEN 'AR invoice'
    WHEN je.origin_type IN ('ttReceipt', 'ttVendorPayment', 'ttDeposit', 'ttChecksforPayment') THEN 'Payment'
    WHEN je.origin_type IN ('ttClosingBalance', 'ttOpeningBalance') THEN 'Period close'
    WHEN je.origin_type = 'ttJournalEntry' AND je.memo ~* 'payroll|\mPR\M' THEN 'Payroll journal'
    WHEN je.origin_type = 'ttJournalEntry' AND je.memo ~* 'cc spread|ramp|credit card|\mcc\M' THEN 'Credit card / Ramp journal'
    WHEN je.origin_type = 'ttJournalEntry' THEN 'Other journal entry'
    ELSE COALESCE(je.origin_type, 'Unknown')
  END                                              AS posting_source
FROM sap_b1.journal_entry_lines jel
JOIN sap_b1.journal_entries je ON je.jdt_num = jel.jdt_num
LEFT JOIN sap_b1.chart_of_accounts coa ON coa.code = jel.account_code
CROSS JOIN LATERAL (SELECT COALESCE(coa.raw_data->>'FormatCode', jel.account_code) AS fc) f
WHERE je.reference_date < DATE '2026-08-01'

UNION ALL

SELECT
  'SAP S/4HANA',
  j.posting_date,
  j.fiscal_year::int,
  j.fiscal_period::int,
  j.accounting_document,
  j.ledger_gl_line_item,
  j.accounting_document_type,
  j.gl_account,
  ga.gl_account_name,
  CASE WHEN ga.is_balance_sheet_account THEN 'balance_sheet'
       WHEN ga.gl_account_type = 'S' OR j.gl_account IN ('999997', '999998') THEN 'allocation'
       WHEN left(j.gl_account, 1) = '4' THEN 'revenue'
       ELSE 'expense' END,
  j.amount_in_company_code_currency,
  d.division,
  d.location,
  NULLIF(COALESCE(d.division, '') || COALESCE(d.location, ''), ''),
  j.cost_center,
  COALESCE(j.customer, j.supplier),
  NULLIF(j.wbs_element_internal_id, '00000000'),
  j.document_item_text,
  FALSE,
  CASE
    WHEN j.accounting_document_type IN ('KR', 'KG', 'RE', 'RN', 'KA') THEN 'AP invoice'
    WHEN j.accounting_document_type IN ('DR', 'DG', 'RV', 'DA') THEN 'AR invoice'
    WHEN j.accounting_document_type IN ('KZ', 'DZ', 'ZP', 'ZV') THEN 'Payment'
    WHEN j.accounting_document_type = 'PR' OR j.document_item_text ~* 'payroll' THEN 'Payroll journal'
    WHEN j.document_item_text ~* 'ramp|credit card' THEN 'Credit card / Ramp journal'
    ELSE 'Other journal entry'
  END
FROM sap_s4.journal_entry_items j
LEFT JOIN sap_s4.gl_accounts ga ON ga.chart_of_accounts = j.chart_of_accounts AND ga.gl_account = j.gl_account
CROSS JOIN LATERAL (
  SELECT COALESCE(substring(j.cost_center FROM '^(\d{3})'),
                  substring(j.profit_center FROM '^(\d{3})'),
                  CASE WHEN j.organization_division ~ '^\d{2}$' THEN j.organization_division || '0' END) AS division,
         COALESCE(substring(j.profit_center FROM '^\d{3}([A-Z]+)$'), j.profit_center) AS location
) d
WHERE j.ledger = '0L'
  AND j.posting_date >= DATE '2026-08-01'
  AND EXISTS (SELECT 1 FROM sap_s4.tenant t WHERE t.id AND t.environment = 'production');

COMMENT ON COLUMN sap.gl_lines.posting_source IS 'What posted the line: AP invoice | AR invoice | Payment | Payroll journal | Credit card / Ramp journal | Other journal entry | Period close. An account total is every source added together; this column only splits it.';

-- Feedback from the same session, rewritten as rules the agent can apply.
-- Matched on id AND original text, so this is a no-op on any other database.
UPDATE agent_feedback
   SET training_instruction = 'A GL account total = the full account activity for the period: every posting source (AP invoices, payroll journals, CC/Ramp journals, other journals) added together, period-close entries excluded. Never filter a total by source. Only split by source (sap.gl_lines.posting_source) underneath the total, or when reconciling.',
       approval_status = 'approved', approved_by = 1
 WHERE id IN (40, 41) AND approval_status = 'pending'
   AND (feedback_text LIKE 'just look at gl balances%' OR feedback_text LIKE 'you should not be adding alternative sources%');

UPDATE agent_feedback
   SET training_instruction = 'FieldVu jobs "since <date>" filter on the job start date (startDate), not createdOn: the back office back-dates jobs. Say which date you used.',
       approval_status = 'approved', approved_by = 1
 WHERE id = 33 AND approval_status = 'pending' AND feedback_text LIKE 'dont look at created physically%';

UPDATE agent_feedback
   SET training_instruction = 'Jobs are not field tickets. "How many jobs" = query_fieldvu entity jobs with count_only or group_by, which returns the exact total an export would. Never answer a job count from field tickets or from one page of rows.',
       approval_status = 'approved', approved_by = 1
 WHERE id IN (30, 31) AND approval_status = 'pending'
   AND (feedback_text LIKE 'numbers are wrong. you should be finding this under field view%' OR feedback_text LIKE 'need to be able to see more so that it can provide the same count%');

UPDATE agent_feedback
   SET training_instruction = 'FieldVu third-party billing (purchases and supplier invoices charged to a job) is query_fieldvu entity billing_items. Use it for job purchases, third-party expense and open purchase orders.',
       approval_status = 'approved', approved_by = 1
 WHERE id IN (34, 36) AND approval_status = 'pending'
   AND (feedback_text LIKE 'Need to be able to pull all of the above%' OR feedback_text LIKE 'need to be pulling in the 3rd party tab%');

-- The shared admin account's memory kept the Per Diem "payroll only"
-- reconciliation from that session. Its figures were never queried (2026 CC
-- and Ramp postings to Per Diem are $18,676.56, not $50,663.56), so it must not
-- steer later answers.
DELETE FROM agent_memories
 WHERE id = 233 AND user_id = 1 AND content LIKE 'User values detailed reconciliation and verification of financial figures, including identifying discrepancies such as non-payroll postings%';
