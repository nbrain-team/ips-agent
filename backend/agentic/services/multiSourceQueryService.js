/**
 * multiSourceQueryService — the NL → SQL pipeline (Part 5.6).
 *
 * discover relevant tables → build schema context (columns, counts, date
 * ranges, sample rows) → Claude writes ONE read-only SELECT → execute with a
 * 30s statement timeout → return rows. Every run logged to
 * agent_metadata.query_history.
 *
 * SAFETY: hard keyword denylist (SELECT-only), 30s timeout, 100-row cap.
 * Works against any pool (primary operational DB or the read-only billing DB).
 */
const Anthropic = require('@anthropic-ai/sdk');
const TableRouter = require('./TableRouter');
const { EXCLUDED_TABLES, splitQualified } = require('./TableMetadataVectorization');
const { llmHttpsAgent } = require('../utils/httpAgent');
const { withRetry, sanitizeAnthropicParams } = require('../utils/anthropicRetry');

const FORBIDDEN_SQL = /\b(DROP|DELETE|UPDATE|INSERT|ALTER|CREATE|TRUNCATE|GRANT|REVOKE|COPY|VACUUM|COMMENT|EXECUTE|DO)\b/i;
const MAX_ROWS = 100;

class MultiSourceQueryService {
  /**
   * @param {Pool} dataPool      pool the SQL runs against
   * @param {object} opts        { sourceTag, metadataPool, sqlModel }
   */
  constructor(dataPool, opts = {}) {
    this.dataPool = dataPool;
    this.metadataPool = opts.metadataPool || dataPool;
    this.sourceTag = opts.sourceTag || 'primary';
    this.tableRouter = new TableRouter(this.metadataPool, this.sourceTag);
    this.sqlModel = opts.sqlModel || process.env.ANTHROPIC_PRIMARY_MODEL || 'claude-opus-4-8';
    this.anthropic = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
      httpAgent: llmHttpsAgent,
      maxRetries: 0,
    });
  }

  async getAllTables() {
    const res = await this.dataPool.query(`
      SELECT table_schema, table_name FROM information_schema.tables
      WHERE table_type = 'BASE TABLE'
        AND table_schema NOT IN ('pg_catalog', 'information_schema')
        AND table_schema NOT LIKE 'pg_%'
      ORDER BY table_schema, table_name`);
    return res.rows
      .filter((r) => !EXCLUDED_TABLES.includes(r.table_name) && !/auth/i.test(r.table_schema))
      .map((r) => (r.table_schema === 'public' ? r.table_name : `${r.table_schema}.${r.table_name}`));
  }

  /** Build the schema context block the SQL-writer model sees. */
  async buildDynamicSchemaContext(relevantTables) {
    const blocks = [];
    for (const t of relevantTables) {
      const cols = typeof t.columns_json === 'string' ? JSON.parse(t.columns_json) : t.columns_json || [];
      const samples = typeof t.sample_rows_json === 'string' ? JSON.parse(t.sample_rows_json) : t.sample_rows_json || [];
      const dateRange = typeof t.date_range_json === 'string' ? JSON.parse(t.date_range_json) : t.date_range_json;

      let block = `TABLE "${t.table_name}" (${t.row_count} rows)`;
      if (cols.length) {
        block += `\n  COLUMNS: ${cols.map((c) => `"${c.column_name}" ${c.data_type}`).join(', ')}`;
      } else {
        // information_schema fallback if vector metadata is missing columns
        try {
          const { schema, table } = splitQualified(t.table_name);
          const live = await this.dataPool.query(
            `SELECT column_name, data_type FROM information_schema.columns
             WHERE table_schema=$1 AND table_name=$2 ORDER BY ordinal_position`,
            [schema, table]
          );
          block += `\n  COLUMNS: ${live.rows.map((c) => `"${c.column_name}" ${c.data_type}`).join(', ')}`;
        } catch (_e) { /* ignore */ }
      }
      if (dateRange && dateRange.column) {
        block += `\n  DATE RANGE (${dateRange.column}): ${dateRange.min} → ${dateRange.max}`;
      }
      if (samples && samples.length) {
        block += `\n  SAMPLE ROW: ${JSON.stringify(samples[0]).slice(0, 600)}`;
      }
      blocks.push(block);
    }
    return blocks.join('\n\n');
  }

  async generateSQL(question, schemaContext, tableNames) {
    const today = new Date().toISOString().slice(0, 10);
    const prompt = `You are an expert PostgreSQL query writer. Write ONE read-only SELECT statement to answer the question.

CURRENT DATE: ${today} (use it for relative-date math like "last month", "this year")

AVAILABLE TABLES (use ONLY these):
${schemaContext}

STRICT RULES:
- ONE SELECT statement only. No DDL/DML of any kind. No semicolons except optionally at the end.
- Only use the tables listed above: ${tableNames.join(', ')}.
- Some table names are schema-qualified (e.g. ips_cb.field_tickets) — keep the schema prefix in the SQL exactly as listed.
- Double-quote any column/table names with capitals, spaces, or odd characters (quote schema and table separately: "ips_cb"."field_tickets").
- Add LIMIT ${MAX_ROWS} to list-style results; use aggregates (COUNT/SUM/AVG/GROUP BY) for big tables.
- Cast where needed; be defensive about NULLs.
- Return ONLY the SQL, no explanation, no code fences.

QUESTION: ${question}`;

    const params = sanitizeAnthropicParams({
      model: this.sqlModel,
      max_tokens: 1500,
      temperature: 0.1,
      messages: [{ role: 'user', content: prompt }],
    });
    const res = await withRetry(() => this.anthropic.messages.create(params), { label: 'sql-gen' });
    let sql = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
    sql = sql.replace(/^```(sql)?/i, '').replace(/```$/, '').trim();
    return sql;
  }

  validateSQL(sql) {
    const clean = sql.trim();
    if (!/^(SELECT|WITH)\b/i.test(clean)) {
      throw new Error('Generated SQL must be a SELECT statement');
    }
    if (FORBIDDEN_SQL.test(clean)) {
      throw new Error('Generated SQL contains a forbidden keyword — rejected');
    }
    if (clean.split(';').filter((s) => s.trim()).length > 1) {
      throw new Error('Multiple statements are not allowed');
    }
    return clean;
  }

  async executeQuery(sql) {
    const client = await this.dataPool.connect();
    try {
      await client.query('SET statement_timeout = 30000');
      const res = await client.query(sql);
      return res.rows.slice(0, MAX_ROWS);
    } finally {
      client.release();
    }
  }

  async logQuery({ question, sql, rowCount, success, error, durationMs }) {
    try {
      await this.metadataPool.query(
        `INSERT INTO agent_metadata.query_history
           (question, generated_sql, source_tag, row_count, success, error, duration_ms)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [question, sql || null, this.sourceTag, rowCount || 0, success, error || null, durationMs || null]
      );
    } catch (_e) { /* logging must never break the query */ }
  }

  /**
   * The full pipeline. Retries with alternative tables when results are empty.
   * Returns { success, sql, rows, rowCount, tables }.
   */
  async query(question, { hint = null } = {}) {
    const started = Date.now();
    let sql = null;
    try {
      let relevant = await this.tableRouter.discoverRelevantTables(question, { limit: 6, hint });
      if (!relevant.length) {
        // Vectors not built yet — fall back to live table list with schema
        const tables = await this.getAllTables();
        relevant = tables.slice(0, 8).map((t) => ({ table_name: t, row_count: '?', columns_json: [], sample_rows_json: [] }));
      }
      if (!relevant.length) {
        return { success: false, error: 'No business-data tables exist yet in this database.', rows: [], rowCount: 0 };
      }

      let schemaContext = await this.buildDynamicSchemaContext(relevant);
      let tableNames = relevant.map((r) => r.table_name);

      sql = this.validateSQL(await this.generateSQL(question, schemaContext, tableNames));
      let rows = await this.executeQuery(sql);

      // Empty result → one retry with a rephrase + widened table set
      if (rows.length === 0) {
        const wider = await this.tableRouter.discoverRelevantTables(question, { limit: 10, hint });
        if (wider.length > relevant.length) {
          schemaContext = await this.buildDynamicSchemaContext(wider);
          tableNames = wider.map((r) => r.table_name);
        }
        const retrySql = this.validateSQL(
          await this.generateSQL(
            `${question}\n\n(The previous attempt returned zero rows with this SQL: ${sql}. Try different tables, broader filters, or case-insensitive matching.)`,
            schemaContext,
            tableNames
          )
        );
        const retryRows = await this.executeQuery(retrySql);
        if (retryRows.length > 0) {
          sql = retrySql;
          rows = retryRows;
        }
      }

      const durationMs = Date.now() - started;
      await this.logQuery({ question, sql, rowCount: rows.length, success: true, durationMs });
      return { success: true, sql, rows, rowCount: rows.length, tables: tableNames };
    } catch (err) {
      await this.logQuery({ question, sql, success: false, error: err.message, durationMs: Date.now() - started });
      return { success: false, error: err.message, sql, rows: [], rowCount: 0 };
    }
  }
}

module.exports = MultiSourceQueryService;
module.exports.MAX_ROWS = MAX_ROWS;
