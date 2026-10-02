-- IPS profit centers are division + location. B1 carries the division in
-- CostingCode ('100' Electrical) and the location in CostingCode2 ('HOB'), and
-- the first sync kept only the division, so "100HOB" could not be isolated.

ALTER TABLE sap_b1.journal_entry_lines ADD COLUMN IF NOT EXISTS costing_code2 TEXT;  -- location (HOB, MID, AND, ...)
ALTER TABLE sap_b1.journal_entry_lines ADD COLUMN IF NOT EXISTS costing_code3 TEXT;

CREATE INDEX IF NOT EXISTS idx_b1_jel_profit_center
  ON sap_b1.journal_entry_lines(costing_code, costing_code2);

-- Re-walk journal entries from the start so existing lines pick up the new
-- columns. backfill_complete stays TRUE: each page replaces its lines in one
-- transaction, so the ledger stays queryable while the re-walk runs.
UPDATE sap_b1.sync_state SET backfill_cursor = 0 WHERE entity = 'journal_entries';
