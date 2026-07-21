/**
 * autoMigrate — boot-time idempotent migrations. Runs every .sql in
 * /migrations in filename order, tracking applied files in schema_migrations.
 * All migration SQL is written with IF NOT EXISTS so re-runs are safe anyway.
 */
const fs = require('fs');
const path = require('path');

async function runBootstrap(dbPool) {
  await dbPool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);

  const dir = path.join(__dirname, '..', 'migrations');
  if (!fs.existsSync(dir)) return;
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();

  for (const file of files) {
    const applied = await dbPool.query('SELECT 1 FROM schema_migrations WHERE filename = $1', [file]);
    if (applied.rows.length) continue;
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    console.log(`📦 Applying migration: ${file}`);
    const client = await dbPool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw new Error(`Migration ${file} failed: ${err.message}`);
    } finally {
      client.release();
    }
  }
  console.log('✅ Migrations up to date');
}

module.exports = { runBootstrap };
