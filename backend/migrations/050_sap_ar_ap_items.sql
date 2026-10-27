-- 050: open receivables and payables from S/4HANA. S/4 has no AR/AP document
-- views yet, but every customer and supplier item posts to 120100 (AR Trade) or
-- 220100 (Accounts Payable - Trade) with a clearing date once paid. B1's open
-- items were migrated into S/4 on 2026-07-31 (document types DR/DG/KR/KG), so
-- from the cutover on, open AR/AP comes from here, never from B1.

CREATE OR REPLACE VIEW sap.ar_ap_items AS
SELECT
  CASE WHEN j.gl_account = '120100' THEN 'AR' ELSE 'AP' END                        AS side,
  CASE WHEN j.gl_account = '120100' THEN j.customer ELSE j.supplier END            AS business_partner,
  bp.business_partner_name                                                         AS partner_name,
  CASE WHEN j.gl_account = '120100' THEN j.amount_in_company_code_currency
       ELSE -j.amount_in_company_code_currency END                                 AS amount,
  j.posting_date,
  j.document_date,
  j.clearing_date,
  j.clearing_date IS NULL                                                          AS is_open,
  (j.posting_date = DATE '2026-07-31' AND j.accounting_document_type IN ('DR', 'DG', 'KR', 'KG')) AS migrated_from_b1,
  j.accounting_document_type,
  j.accounting_document,
  j.fiscal_year,
  j.reference_document,
  j.assignment_reference,
  j.document_item_text,
  j.profit_center,
  j.gl_account
FROM sap_s4.journal_entry_items j
LEFT JOIN sap_s4.business_partners bp
  ON bp.business_partner = CASE WHEN j.gl_account = '120100' THEN j.customer ELSE j.supplier END
WHERE j.ledger = '0L'
  AND j.company_code = '1710'
  AND j.gl_account IN ('120100', '220100')
  AND EXISTS (SELECT 1 FROM sap_s4.tenant t WHERE t.id AND t.environment = 'production');

COMMENT ON VIEW sap.ar_ap_items IS 'Open and paid customer (AR) and vendor (AP) items in SAP S/4HANA, including the B1 open items migrated on 2026-07-31. Open now: WHERE is_open. Open as of a date D: posting_date <= D AND (clearing_date IS NULL OR clearing_date > D). Aging by document_date. Use for every AR/AP balance, aging or "who owes us" question from 2026-07-31 on; never B1.';
COMMENT ON COLUMN sap.ar_ap_items.side IS 'AR = customer receivable (GL 120100), AP = vendor payable (GL 220100)';
COMMENT ON COLUMN sap.ar_ap_items.business_partner IS 'S/4 customer number (AR) or supplier number (AP) = sap_s4.customers.customer / sap_s4.suppliers.supplier';
COMMENT ON COLUMN sap.ar_ap_items.partner_name IS 'Customer or vendor name from sap_s4.business_partners';
COMMENT ON COLUMN sap.ar_ap_items.amount IS 'USD, positive = owed (to IPS for AR, by IPS for AP). Invoices are positive, payments and credit memos negative; an open balance is SUM(amount)';
COMMENT ON COLUMN sap.ar_ap_items.clearing_date IS 'Date the item was paid or offset; NULL = still open';
COMMENT ON COLUMN sap.ar_ap_items.is_open IS 'TRUE when clearing_date is NULL (open today)';
COMMENT ON COLUMN sap.ar_ap_items.migrated_from_b1 IS 'Open item carried over from SAP B1 at the cutover (posted 2026-07-31); its document_date is the original B1 invoice date';
COMMENT ON COLUMN sap.ar_ap_items.accounting_document_type IS 'AR: RV invoice from billing, DR/DG customer invoice/credit memo, DZ customer payment. AP: RE vendor invoice, KR/KG vendor invoice/credit, ZP payment run, KZ manual payment, SA journal. DR/DG/KR/KG posted 2026-07-31 are the B1 migration';
