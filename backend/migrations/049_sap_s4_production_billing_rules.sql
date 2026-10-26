-- 049: billing rules confirmed on the production tenant (Oct 26, 2026): S2
-- cancels a G2 credit memo, TMP numbers are temporary documents never posted,
-- and FieldVu tickets link to S/4 billing by ticket number, not by
-- fieldvu.field_tickets.billing_document_id (which matches no S/4 document).

COMMENT ON COLUMN sap_s4.billing_document_items.billing_document_type IS 'F2 invoice, G2 credit memo, S1 cancellation of an invoice, S2 cancellation of a credit memo. Net billing = F2 - G2, both NOT billing_document_is_cancelled and billing_document NOT LIKE ''TMP%''; leave S1 and S2 out (SAP BillingDocumentType)';
COMMENT ON COLUMN sap_s4.billing_document_items.billing_document_is_cancelled IS 'TRUE when this invoice or credit memo was cancelled by an S1 / S2 document: exclude it from billing totals (SAP BillingDocumentIsCancelled)';
COMMENT ON COLUMN sap_s4.billing_document_items.cancelled_billing_document IS 'On an S1 / S2 cancellation: the invoice or credit memo it cancels (SAP CancelledBillingDocument)';
COMMENT ON COLUMN sap_s4.billing_document_items.billing_document IS 'Billing document number (9000xxxx). TMP… numbers are temporary documents not posted to accounting: leave them out of billing totals (SAP BillingDocument)';
COMMENT ON COLUMN sap_s4.billing_document_items.field_ticket_no IS 'FieldVu field ticket number, zero-padded to 10 digits: = lpad(fieldvu.field_tickets.doc_num::text, 10, ''0'') (SAP YY1_FieldTicketNo_BDI)';
COMMENT ON COLUMN fieldvu.field_tickets.billing_document_id IS 'Set once FieldVu sends the ticket for invoicing. FieldVu''s own reference (9000000000+): it matches no S/4 billing document. Link to S/4 billing by lpad(doc_num::text, 10, ''0'') = sap_s4.billing_document_items.field_ticket_no';
