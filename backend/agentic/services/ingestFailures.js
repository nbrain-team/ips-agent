/**
 * Persistent ingest-failure inbox. Anything that ingests data in the
 * background (Read.ai webhooks, email sync, crawls, vectorization) records
 * failures here instead of only logging to the console, so admins can see and
 * clear them from /admin/ops.
 */
async function recordFailure(dbPool, { source, reference = null, error, detail = null }) {
  try {
    await dbPool.query(
      `INSERT INTO ingest_failures (source, reference, error, detail)
       VALUES ($1, $2, $3, $4)`,
      [source, reference, String(error).slice(0, 2000), detail ? JSON.stringify(detail) : null]
    );
  } catch (e) {
    // Never let failure-recording break the caller
    console.warn('ingest_failures insert failed:', e.message);
  }
}

module.exports = { recordFailure };
