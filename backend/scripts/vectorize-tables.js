/**
 * npm run vectorize — vectorize table metadata for the primary DB and (if
 * configured) the read-only billing DB so table discovery works (Part 5.6).
 */
require('dns').setDefaultResultOrder('ipv4first');
require('dotenv').config();
const { Pool } = require('pg');
const TableMetadataVectorization = require('../agentic/services/TableMetadataVectorization');

async function main() {
  const primary = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false,
  });
  try {
    const vec = new TableMetadataVectorization(primary);
    console.log(JSON.stringify(await vec.vectorizeAllTables(), null, 2));

    if (process.env.IPS_BILLING_DATABASE_URL) {
      const billing = new Pool({
        connectionString: process.env.IPS_BILLING_DATABASE_URL,
        max: 5,
        ssl: process.env.IPS_BILLING_DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false,
      });
      try {
        const bvec = new TableMetadataVectorization(billing, { sourceTag: 'billing', metadataPool: primary });
        console.log(JSON.stringify(await bvec.vectorizeAllTables(), null, 2));
      } finally {
        await billing.end();
      }
    }
  } finally {
    await primary.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
