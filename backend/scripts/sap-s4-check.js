#!/usr/bin/env node
/**
 * Read-only readiness check for an S/4HANA tenant, before pointing the sync at it.
 *
 *   node scripts/sap-s4-check.js --host my434651-api.s4hana.cloud.sap --creds ~/Downloads/ips-sap-uat.env
 *
 * --creds is a file with Username= / Password= lines (else SAP_S4_USERNAME /
 * SAP_S4_PASSWORD). Recently invoiced FieldVu tickets (fieldvu.field_tickets via
 * DATABASE_URL, or --fieldvu-tickets <file of ticket numbers>) are looked up by
 * field ticket number to tell IPS's live books from a test system.
 *
 * Makes exactly one request before it knows the login works, and stops on a
 * 401: SAP locks the user after a few failed logons.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const { S4Client, ENTITIES, CUTOVER_DATE, schemaDrift } = require('../agentic/services/sapS4Sync');
const SCHEMA_SPEC = require('../agentic/services/sapS4Schema');

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? null : process.argv[i + 1];
};

function credentials() {
  const file = arg('--creds');
  if (!file) return { username: process.env.SAP_S4_USERNAME, password: process.env.SAP_S4_PASSWORD };
  const lines = Object.fromEntries(
    fs.readFileSync(file.replace(/^~/, process.env.HOME), 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i).trim().toLowerCase(), l.slice(i + 1).replace(/\r$/, '')];
    })
  );
  return {
    username: (lines.username || process.env.SAP_S4_USERNAME || '').trim(),
    password: lines.password || process.env.SAP_S4_PASSWORD,
  };
}

/** First record in `orderby` order, or null. */
async function first(client, view, field, { filter, desc } = {}) {
  const qs = ['$format=json', '$top=1', `$select=${field}`, `$orderby=${encodeURIComponent(`${field}${desc ? ' desc' : ''}`)}`];
  if (filter) qs.push(`$filter=${encodeURIComponent(filter)}`);
  const path = `/sap/opu/odata/sap/YY1_EXT_${view}_READ_CDS/YY1_EXT_${view}_READ?${qs.join('&')}`;
  return JSON.parse(await client.get(path)).d.results[0]?.[field] ?? null;
}

const sapDate = (v) => {
  const m = v && String(v).match(/\/Date\((-?\d+)/);
  return m ? new Date(Number(m[1])).toISOString().slice(0, 10) : v;
};

(async () => {
  const host = (arg('--host') || process.env.SAP_S4_BASE_URL || '').replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  const { username, password } = credentials();
  if (!host || !username || !password) {
    console.error('Need --host and credentials (--creds file or SAP_S4_USERNAME / SAP_S4_PASSWORD).');
    process.exit(1);
  }
  const client = new S4Client({ host, username, password });
  const problems = [];
  console.log(`Tenant ${host}, user ${username}`);

  try {
    await client.count('PROFIT_CENTER');
    console.log('Login: OK');
  } catch (err) {
    console.log(`Login: FAILED (${err.message}). Stopping here; do not retry with the same password.`);
    process.exit(2);
  }

  console.log('\nViews (records, fields SAP added / removed since sapS4Schema.js):');
  for (const entity of ENTITIES) {
    try {
      const [records, xml] = await Promise.all([client.count(entity.view, entity.filter), client.metadata(entity.view)]);
      const drift = schemaDrift(xml, SCHEMA_SPEC[entity.table]);
      const leaked = (entity.exclude || []).filter((f) => xml.includes(`Property Name="${f}"`));
      const notes = [
        drift.added.length ? `added ${drift.added.join(', ')}` : '',
        drift.removed.length ? `removed ${drift.removed.join(', ')}` : '',
        leaked.length ? `still exposes ${leaked.join(', ')} (not copied)` : '',
      ].filter(Boolean);
      console.log(`  ${entity.view.padEnd(14)} ${String(records).padStart(9)}  ${notes.join('; ') || 'matches'}`);
      if (drift.removed.length) problems.push(`${entity.view}: fields we load are missing (${drift.removed.join(', ')})`);
    } catch (err) {
      console.log(`  ${entity.view.padEnd(14)} ERROR ${err.message}`);
      problems.push(`${entity.view}: ${err.message}`);
    }
  }

  console.log('\nJournals (ledger 0L):');
  try {
    const all = await client.count('JOURNALS', "Ledger eq '0L'");
    const postCutover = await client.count('JOURNALS', `Ledger eq '0L' and PostingDate ge datetime'${CUTOVER_DATE}T00:00:00'`);
    const from = sapDate(await first(client, 'JOURNALS', 'PostingDate', { filter: "Ledger eq '0L'" }));
    const to = sapDate(await first(client, 'JOURNALS', 'PostingDate', { filter: "Ledger eq '0L'", desc: true }));
    console.log(`  ${all} lines, posted ${from} to ${to}; ${postCutover} on or after ${CUTOVER_DATE}`);
  } catch (err) {
    console.log(`  ERROR ${err.message}`);
  }

  console.log('\nBilling items:');
  let liveNumbers = false;
  try {
    const en = "BillingDocumentTypeLanguage eq 'EN'";
    const since = new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10);
    const created = await client.count('BILLDOCITEM', `(CreationDate ge datetime'${since}T00:00:00') and ${en}`);
    const lo = await first(client, 'BILLDOCITEM', 'BillingDocument', { filter: en });
    const hi = await first(client, 'BILLDOCITEM', 'BillingDocument', { filter: `${en} and BillingDocument lt 'A'`, desc: true });
    console.log(`  documents ${lo} to ${hi}; ${created} items created since ${since} (CreationDate filter works)`);
  } catch (err) {
    console.log(`  ERROR ${err.message}`);
    problems.push(`billing: ${err.message}`);
  }

  let tickets = null;
  if (arg('--fieldvu-tickets')) {
    tickets = fs.readFileSync(arg('--fieldvu-tickets').replace(/^~/, process.env.HOME), 'utf8').match(/\b\d+\b/g) || [];
  } else if (process.env.DATABASE_URL) {
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL) ? false : { rejectUnauthorized: false } });
    try {
      const { rows } = await pool.query(
        `SELECT doc_num::text AS ticket FROM fieldvu.field_tickets
          WHERE billing_document_id IS NOT NULL ORDER BY ticket_date DESC, doc_num DESC LIMIT 20`
      );
      tickets = rows.map((r) => r.ticket);
    } catch (err) {
      console.log(`  FieldVu comparison skipped: ${err.message}`);
    } finally {
      await pool.end();
    }
  }
  if (tickets) {
    tickets = tickets.slice(0, 20);
    let found = 0;
    for (const t of tickets) {
      if ((await client.count('BILLDOCITEM', `YY1_FieldTicketNo_BDI eq '${t.padStart(10, '0')}'`)) > 0) found++;
    }
    console.log(`  FieldVu: ${found} of ${tickets.length} recently invoiced FieldVu tickets have billing items here`);
    liveNumbers = tickets.length > 0 && found >= tickets.length / 2;
  }

  console.log(`\nVerdict: ${liveNumbers ? "billing matches IPS's live FieldVu tickets: this looks like PRODUCTION" : 'billing does not match FieldVu: a TEST system, not IPS\'s books'}`);
  if (problems.length) console.log(`Problems:\n  - ${problems.join('\n  - ')}`);
  process.exit(problems.length ? 3 : 0);
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
