/**
 * Run migrations manually: `node scripts/run-migration.js all`
 * or a single file: `node scripts/run-migration.js 004_create_agent_metadata.sql`
 */
require('dns').setDefaultResultOrder('ipv4first');
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { runBootstrap } = require('../bootstrap/autoMigrate');

async function main() {
  const target = process.argv[2] || 'all';
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false,
  });
  try {
    if (target === 'all') {
      await runBootstrap(pool);
    } else {
      const file = path.join(__dirname, '..', 'migrations', target);
      const sql = fs.readFileSync(file, 'utf8');
      console.log(`Applying ${target}...`);
      await pool.query(sql);
      console.log('Done.');
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
