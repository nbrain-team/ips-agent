/**
 * FieldVu Cloud field tickets → fieldvu.field_tickets.
 *
 * FieldVu Cloud replaced the B1 FieldView add-on when IPS moved to S/4HANA
 * (first tickets Feb 6, 2026). query_fieldvu reads it live, but a live API
 * can't be joined or aggregated alongside the B1 history, so the headers are
 * also stored. The full set is small (~7k tickets), so every run re-pulls all
 * of it; statuses change after submission, and a full pass catches that.
 */

const fieldvu = require('./fieldvu');

const PAGE = 100;

const str = (v) => (v === null || v === undefined || String(v).trim() === '' ? null : String(v).trim());
const num = (v) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
};

async function syncFieldTickets(pool) {
  const base = `${fieldvu.MOBILE}/GetFieldTicketLimitedHeaders(companyId=${fieldvu.companyId()})`;
  const all = [];
  for (let skip = 0; ; skip += PAGE) {
    const data = await fieldvu.fvGet(`${base}?$top=${PAGE}&$skip=${skip}&$orderby=DocNum`);
    const rows = data.value || [];
    all.push(...rows);
    if (rows.length < PAGE) break;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const r of all) {
      if (r.DocNum === null || r.DocNum === undefined) continue;
      await client.query(
        `INSERT INTO fieldvu.field_tickets
           (doc_num, ticket_date, status, customer_code, customer_name, job_code, job_name, description,
            customer_ref1, customer_ref2, customer_ref3, ship_to_code, ticket_total, billing_document_id,
            created_by, company_branch_id, raw_data)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
         ON CONFLICT (doc_num) DO UPDATE SET
           ticket_date = EXCLUDED.ticket_date, status = EXCLUDED.status,
           customer_code = EXCLUDED.customer_code, customer_name = EXCLUDED.customer_name,
           job_code = EXCLUDED.job_code, job_name = EXCLUDED.job_name, description = EXCLUDED.description,
           customer_ref1 = EXCLUDED.customer_ref1, customer_ref2 = EXCLUDED.customer_ref2,
           customer_ref3 = EXCLUDED.customer_ref3, ship_to_code = EXCLUDED.ship_to_code,
           ticket_total = EXCLUDED.ticket_total, billing_document_id = EXCLUDED.billing_document_id,
           created_by = EXCLUDED.created_by, company_branch_id = EXCLUDED.company_branch_id,
           raw_data = EXCLUDED.raw_data, synced_at = NOW()`,
        [
          r.DocNum,
          r.Date ? String(r.Date).slice(0, 10) : null,
          str(r.Status),
          str(r.CustomerCode),
          str(r.CustomerName),
          str(r.JobCode),
          str(r.JobName),
          str(r.Description),
          str(r.CustomerRefNo1),
          str(r.CustomerRefNo2),
          str(r.CustomerRefNo3),
          str(r.ShipToCode),
          num(r.FieldTicketTotal),
          str(r.BillingDocumentId),
          str(r.CreatedBy),
          str(r.CompanyBranchId),
          JSON.stringify(r),
        ]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  return { tickets: all.length };
}

module.exports = { syncFieldTickets };
