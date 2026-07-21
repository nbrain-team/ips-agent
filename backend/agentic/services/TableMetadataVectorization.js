/**
 * TableMetadataVectorization — scans each business-data table, captures
 * columns/types/row counts/date ranges/sample rows, embeds a searchable
 * description, and stores it in agent_metadata.table_vectors (on the PRIMARY
 * db). This powers semantic table discovery + schema-context generation.
 *
 * Can also be pointed at the read-only billing pool with a sourceTag so both
 * schemas are discoverable without colliding (Part 11.1).
 */
const { embedText, toVectorLiteral } = require('../utils/embeddings');

// Infra tables that should never be treated as business data.
// Matched against the BASE table name (schema prefix stripped).
const EXCLUDED_TABLES = [
  'users', 'agent_chat_sessions', 'agent_chat_messages', 'agent_artifacts',
  'agent_templates', 'agent_session_presence', 'agent_feedback',
  'agent_user_preferences', 'agent_background_jobs', 'agent_notification_preferences',
  'agent_notifications', 'agent_weekly_digests', 'agent_pinecone_sync',
  'agent_memories', 'agent_traces', 'agent_chat_shares', 'agent_output_templates',
  'website_content', 'schema_migrations', 'pg_stat_statements',
  // Email tables are permission-scoped — ONLY reachable via search_user_emails
  'ms_emails', 'ms_mailboxes',
  // Billing-platform infra/auth tables
  'activity_log', 'user_audit_log', 'user_customer_access', 'user_roles',
  'gps_backfill_log',
];

/** 'ips_cb.field_tickets' → { schema: 'ips_cb', table: 'field_tickets' } */
function splitQualified(name) {
  const idx = name.indexOf('.');
  return idx === -1
    ? { schema: 'public', table: name }
    : { schema: name.slice(0, idx), table: name.slice(idx + 1) };
}

class TableMetadataVectorization {
  /**
   * @param {Pool} dataPool  pool to SCAN (primary or billing)
   * @param {object} opts    { sourceTag: 'primary'|'billing', metadataPool }
   *   metadataPool defaults to dataPool — where table_vectors rows are WRITTEN.
   */
  constructor(dataPool, opts = {}) {
    this.dataPool = dataPool;
    this.metadataPool = opts.metadataPool || dataPool;
    this.sourceTag = opts.sourceTag || 'primary';
  }

  async needsVectorization() {
    try {
      const res = await this.metadataPool.query(
        `SELECT COUNT(*)::int AS n FROM agent_metadata.table_vectors WHERE source_tag = $1`,
        [this.sourceTag]
      );
      const tables = await this.listDataTables();
      return tables.length > 0 && res.rows[0].n === 0;
    } catch (_e) {
      return false;
    }
  }

  /**
   * All business-data tables across non-system schemas. Tables outside
   * `public` are returned schema-qualified (e.g. 'ips_cb.field_tickets') so
   * SQL generation targets the right schema.
   */
  async listDataTables() {
    const res = await this.dataPool.query(`
      SELECT table_schema, table_name FROM information_schema.tables
      WHERE table_type = 'BASE TABLE'
        AND table_schema NOT IN ('pg_catalog', 'information_schema')
        AND table_schema NOT LIKE 'pg_%'
      ORDER BY table_schema, table_name`);
    return res.rows
      .filter(
        (r) =>
          !EXCLUDED_TABLES.includes(r.table_name) &&
          !/auth/i.test(r.table_schema) &&
          r.table_schema !== 'agent_metadata'
      )
      .map((r) => (r.table_schema === 'public' ? r.table_name : `${r.table_schema}.${r.table_name}`));
  }

  async describeTable(tableName) {
    const { schema, table } = splitQualified(tableName);
    const qualified = `"${schema}"."${table}"`;
    const cols = await this.dataPool.query(
      `SELECT column_name, data_type FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position`,
      [schema, table]
    );
    const columns = cols.rows;

    let rowCount = 0;
    try {
      const rc = await this.dataPool.query(`SELECT COUNT(*)::bigint AS n FROM ${qualified}`);
      rowCount = Number(rc.rows[0].n);
    } catch (_e) { /* permission or timeout — leave 0 */ }

    // Date range from the first timestamp/date column
    let dateRange = null;
    const dateCol = columns.find((c) => /timestamp|date/.test(c.data_type));
    if (dateCol && rowCount > 0) {
      try {
        const dr = await this.dataPool.query(
          `SELECT MIN("${dateCol.column_name}") AS min_d, MAX("${dateCol.column_name}") AS max_d FROM ${qualified}`
        );
        dateRange = { column: dateCol.column_name, min: dr.rows[0].min_d, max: dr.rows[0].max_d };
      } catch (_e) { /* ignore */ }
    }

    let sampleRows = [];
    if (rowCount > 0) {
      try {
        const sr = await this.dataPool.query(`SELECT * FROM ${qualified} LIMIT 3`);
        sampleRows = sr.rows.map((row) => {
          const trimmed = {};
          for (const [k, v] of Object.entries(row)) {
            trimmed[k] = typeof v === 'string' && v.length > 120 ? `${v.slice(0, 120)}…` : v;
          }
          return trimmed;
        });
      } catch (_e) { /* ignore */ }
    }

    return { tableName, columns, rowCount, dateRange, sampleRows };
  }

  buildSearchableDescription(meta) {
    const colList = meta.columns.map((c) => `${c.column_name} (${c.data_type})`).join(', ');
    const parts = [
      `Table "${meta.tableName}" (source: ${this.sourceTag}) with ${meta.rowCount} rows.`,
      `Columns: ${colList}.`,
    ];
    if (meta.dateRange) {
      parts.push(`Date range on ${meta.dateRange.column}: ${meta.dateRange.min} to ${meta.dateRange.max}.`);
    }
    if (meta.sampleRows.length) {
      parts.push(`Sample row: ${JSON.stringify(meta.sampleRows[0]).slice(0, 500)}`);
    }
    return parts.join(' ');
  }

  async vectorizeAllTables() {
    const tables = await this.listDataTables();
    let ok = 0;
    const errors = [];
    for (const table of tables) {
      try {
        const meta = await this.describeTable(table);
        const description = this.buildSearchableDescription(meta);
        const embedding = await embedText(description);
        await this.metadataPool.query(
          `INSERT INTO agent_metadata.table_vectors
             (table_name, source_tag, description, columns_json, row_count, date_range_json, sample_rows_json, embedding, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8::vector, NOW())
           ON CONFLICT (table_name, source_tag) DO UPDATE SET
             description = EXCLUDED.description,
             columns_json = EXCLUDED.columns_json,
             row_count = EXCLUDED.row_count,
             date_range_json = EXCLUDED.date_range_json,
             sample_rows_json = EXCLUDED.sample_rows_json,
             embedding = EXCLUDED.embedding,
             updated_at = NOW()`,
          [
            table,
            this.sourceTag,
            description,
            JSON.stringify(meta.columns),
            meta.rowCount,
            JSON.stringify(meta.dateRange),
            JSON.stringify(meta.sampleRows),
            toVectorLiteral(embedding),
          ]
        );
        ok++;
      } catch (err) {
        errors.push({ table, error: err.message });
      }
    }
    console.log(`🧠 Vectorized ${ok}/${tables.length} tables (source: ${this.sourceTag})`);
    return { source: this.sourceTag, vectorized: ok, total: tables.length, errors };
  }
}

module.exports = TableMetadataVectorization;
module.exports.EXCLUDED_TABLES = EXCLUDED_TABLES;
module.exports.splitQualified = splitQualified;
