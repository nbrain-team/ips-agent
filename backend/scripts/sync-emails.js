/**
 * Manual Microsoft 365 email sync.
 * Usage: node scripts/sync-emails.js
 */
require('dns').setDefaultResultOrder('ipv4first');
require('dotenv').config();
const { Pool } = require('pg');
const msGraph = require('../agentic/services/msGraph');

async function main() {
  if (!msGraph.isConfigured()) {
    console.error('MS_GRAPH_CLIENT_ID / MS_GRAPH_CLIENT_SECRET / MS_GRAPH_TENANT_ID not set.');
    process.exit(1);
  }
  const dbPool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false,
  });
  const summary = await msGraph.syncAllMailboxes(dbPool);
  console.log('Done:', JSON.stringify(summary, null, 2));

  const { rows } = await dbPool.query(
    `SELECT email, sync_status, sync_error, message_count FROM ms_mailboxes ORDER BY email`
  );
  for (const r of rows) {
    console.log(`  ${r.sync_status === 'ok' ? '✅' : '❌'} ${r.email} — ${r.message_count} msgs${r.sync_error ? ` (${r.sync_error})` : ''}`);
  }
  await dbPool.end();
}

main().catch((err) => {
  console.error('Sync failed:', err.message);
  process.exit(1);
});
