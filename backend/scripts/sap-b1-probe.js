/**
 * sap-b1-probe — true size and date span of IPS's SAP Business One data,
 * straight from the Service Layer. Read-only.
 *
 * Usage (Render shell on ips-agent-api):  node scripts/sap-b1-probe.js
 */
require('dotenv').config();
const { ServiceLayer, isConfigured } = require('../agentic/services/sapB1History');

const ENTITIES = [
  { label: 'Field tickets', path: 'CRCS_oFieldTicket', dateField: 'U_date', select: 'DocEntry,DocNum,U_date,U_cardName' },
  { label: 'A/R invoices', path: 'Invoices', dateField: 'DocDate', select: 'DocEntry,DocNum,DocDate,CardName' },
  { label: 'A/R credit memos', path: 'CreditNotes', dateField: 'DocDate', select: 'DocEntry,DocNum,DocDate,CardName' },
  { label: 'Delivery notes', path: 'DeliveryNotes', dateField: 'DocDate', select: 'DocEntry,DocNum,DocDate,CardName' },
];

async function first(sl, e, dir) {
  const q = [
    `$filter=${encodeURIComponent(`${e.dateField} ge '1901-01-01'`)}`,
    `$orderby=${encodeURIComponent(`${e.dateField} ${dir}`)}`,
    '$top=1',
    `$select=${e.select}`,
  ].join('&');
  const json = await sl.get(`${e.path}?${q}`);
  return (json?.value || [])[0] || null;
}

(async () => {
  if (!isConfigured()) {
    console.error('Set SAP_BASE_URL, SAP_USERNAME, SAP_PASSWORD and SAP_COMPANY_DB first.');
    process.exit(1);
  }
  const sl = new ServiceLayer();
  await sl.login();
  console.log(`\nSAP B1 company DB: ${sl.companyDb}\n`);
  for (const e of ENTITIES) {
    try {
      const count = await sl.get(`${e.path}/$count`).catch(() => null);
      const earliest = await first(sl, e, 'asc');
      const latest = await first(sl, e, 'desc');
      const fmt = (r) => (r ? `${String(r[e.dateField]).slice(0, 10)} (DocNum ${r.DocNum}, ${r.U_cardName || r.CardName || ''})` : 'none');
      console.log(`${e.label.padEnd(18)} count=${count ?? 'n/a'}`);
      console.log(`${''.padEnd(18)} earliest ${fmt(earliest)}`);
      console.log(`${''.padEnd(18)} latest   ${fmt(latest)}\n`);
    } catch (err) {
      console.log(`${e.label.padEnd(18)} ERROR ${err.message}\n`);
    }
  }
  await sl.logout();
})().catch((err) => {
  console.error('Probe failed:', err.message);
  process.exit(1);
});
