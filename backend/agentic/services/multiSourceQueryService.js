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

const FORBIDDEN_SQL =
  /\b(DROP|DELETE|UPDATE|INSERT|ALTER|CREATE|TRUNCATE|GRANT|REVOKE|COPY|VACUUM|COMMENT|EXECUTE|DO|CALL|MERGE|LOCK|LISTEN|NOTIFY|REFRESH|REINDEX|CLUSTER|CHECKPOINT|SECURITY|PREPARE|DEALLOCATE|DECLARE|RESET|SHOW)\b/i;
// Dangerous server-side functions that work even inside a SELECT
const FORBIDDEN_FUNCTIONS =
  /\b(pg_read_file|pg_read_binary_file|pg_ls_dir|pg_stat_file|pg_logdir_ls|lo_import|lo_export|dblink|dblink_exec|pg_sleep|pg_terminate_backend|pg_cancel_backend|pg_reload_conf|pg_rotate_logfile|copy_from|current_setting\s*\(\s*'[^']*password)/i;
const MAX_ROWS = 250;

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
    return res.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  }

  /**
   * Pull the statement out of whatever the model actually returned.
   *
   * "Return ONLY the SQL" is an instruction, not a guarantee. In practice the
   * answer comes back fenced, prefixed with "Here's the query:", or led by a
   * `-- comment` — all of which are still perfectly good SQL that the old
   * startsWith check threw away. Returns null when there is genuinely no
   * statement in there, which is the signal that the model answered in prose
   * instead, and that is worth handling as its own case rather than as a
   * malformed-SQL error.
   */
  static extractSQL(raw) {
    if (!raw) return null;
    let text = String(raw).trim();

    // Prefer a fenced block wherever it sits in the response.
    const fenced = text.match(/```(?:sql)?\s*\n?([\s\S]*?)```/i);
    if (fenced && fenced[1].trim()) text = fenced[1].trim();

    // Drop leading line comments and blank lines.
    const lines = text.split('\n');
    while (lines.length && (!lines[0].trim() || /^\s*--/.test(lines[0]))) lines.shift();
    text = lines.join('\n').trim();

    // Drop a leading block comment.
    text = text.replace(/^\/\*[\s\S]*?\*\/\s*/, '').trim();

    if (/^(SELECT|WITH)\b/i.test(text)) return text;

    // Last resort: the statement may sit under a line of preamble.
    //
    // "Contains SELECT and FROM" is too loose to be the test. A refusal reads
    // "you would need to select from an email table, but no such table
    // exists", which satisfies it, and recovering that as SQL is worse than
    // recovering nothing — the validator passes it, Postgres rejects it, and a
    // clear "this database cannot answer that" becomes a syntax error.
    //
    // The distinction that actually holds is position. A real statement starts
    // a line, or follows a colon. A verb in the middle of a sentence does not.
    const candidates = [
      text.match(/^[ \t]*((?:SELECT|WITH)\b[\s\S]*)$/im),
      text.match(/:[ \t]*((?:SELECT|WITH)\b[\s\S]*)$/i),
    ];

    for (const match of candidates) {
      if (!match) continue;
      const tail = match[1].trim();
      // A query needs a source. Keep this as a floor even once positioned.
      if (/\bFROM\b/i.test(tail) || /^SELECT\b[^;]*$/i.test(tail)) return tail;
    }

    return null;
  }

  validateSQL(sql) {
    const clean = sql.trim();
    if (!/^(SELECT|WITH)\b/i.test(clean)) {
      throw new Error('Generated SQL must be a SELECT statement');
    }
    if (FORBIDDEN_SQL.test(clean)) {
      throw new Error('Generated SQL contains a forbidden keyword — rejected');
    }
    if (FORBIDDEN_FUNCTIONS.test(clean)) {
      throw new Error('Generated SQL calls a forbidden function — rejected');
    }
    if (clean.split(';').filter((s) => s.trim()).length > 1) {
      throw new Error('Multiple statements are not allowed');
    }
    return clean;
  }

  async executeQuery(sql) {
    // Defense in depth: run inside a READ ONLY transaction so even SQL that
    // slips past the denylist cannot write, regardless of the pool's DB role.
    const client = await this.dataPool.connect();
    try {
      await client.query('BEGIN TRANSACTION READ ONLY');
      await client.query('SET LOCAL statement_timeout = 30000');
      const res = await client.query(sql);
      await client.query('COMMIT');
      return res.rows.slice(0, MAX_ROWS);
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch (_e) { /* ignore */ }
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Generate, extract, and validate — retrying once when the model answers
   * with something other than a statement.
   *
   * The retry is worth its cost: the usual cause is a stray sentence of
   * preamble, which a pointed correction fixes on the second pass. When it
   * fails twice the model is telling us something real — almost always that
   * the table the question names is not among the ones the router surfaced —
   * so the prose is returned as the explanation instead of being discarded
   * behind a validator message that means nothing to an operator.
   */
  async writeSQL(question, schemaContext, tableNames) {
    // Attach the model's output to a rejection. Without it the query_history
    // row records that generation failed but not what it produced, which is
    // the only thing that would explain why.
    const validate = (candidate, rawText) => {
      try {
        return this.validateSQL(candidate);
      } catch (err) {
        err.generatedSql = rawText;
        throw err;
      }
    };

    const raw = await this.generateSQL(question, schemaContext, tableNames);
    const first = MultiSourceQueryService.extractSQL(raw);
    if (first) return { sql: validate(first, raw), raw };

    const retryRaw = await this.generateSQL(
      `${question}\n\nIMPORTANT: your previous response was not a SQL statement. Reply with ` +
        'nothing but the SELECT (or WITH) statement — no prose, no explanation, no code fences. ' +
        'If the question cannot be answered from the tables listed above, reply with exactly ' +
        'CANNOT_ANSWER followed by one sentence saying which table or column is missing.',
      schemaContext,
      tableNames
    );
    const second = MultiSourceQueryService.extractSQL(retryRaw);
    if (second) return { sql: validate(second, retryRaw), raw: retryRaw };

    return { sql: null, raw: retryRaw || raw };
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

      const written = await this.writeSQL(question, schemaContext, tableNames);
      if (!written.sql) {
        // Not a fault — the SQL writer is reporting that this database cannot
        // answer the question. Say that plainly, and name the tables it did
        // have, so the calling agent can answer the operator instead of
        // relaying an internal validator message.
        const why = String(written.raw || '')
          .replace(/^CANNOT_ANSWER[:\s-]*/i, '')
          .split('\n')
          .find((l) => l.trim()) || 'the SQL writer could not express it against these tables';
        const explanation =
          `This database cannot answer that. ${why.trim().slice(0, 400)} ` +
          `Tables searched: ${tableNames.join(', ')}.`;
        await this.logQuery({
          question,
          sql: written.raw,
          success: false,
          error: explanation,
          durationMs: Date.now() - started,
        });
        return { success: false, error: explanation, unanswerable: true, rows: [], rowCount: 0, tables: tableNames };
      }
      sql = written.sql;
      let rows = await this.executeQuery(sql);

      // Empty result → one retry with a rephrase + widened table set
      if (rows.length === 0) {
        const wider = await this.tableRouter.discoverRelevantTables(question, { limit: 10, hint });
        if (wider.length > relevant.length) {
          schemaContext = await this.buildDynamicSchemaContext(wider);
          tableNames = wider.map((r) => r.table_name);
        }
        const retry = await this.writeSQL(
          `${question}\n\n(The previous attempt returned zero rows with this SQL: ${sql}. Try different tables, broader filters, or case-insensitive matching.)`,
          schemaContext,
          tableNames
        );
        // A widened second pass that produces no statement is not worth
        // failing over — the first query ran fine and legitimately found
        // nothing, which is an answer.
        if (retry.sql) {
          const retryRows = await this.executeQuery(retry.sql);
          if (retryRows.length > 0) {
            sql = retry.sql;
            rows = retryRows;
          }
        }
      }

      const durationMs = Date.now() - started;
      await this.logQuery({ question, sql, rowCount: rows.length, success: true, durationMs });
      return { success: true, sql, rows, rowCount: rows.length, tables: tableNames };
    } catch (err) {
      await this.logQuery({
        question,
        sql: sql || err.generatedSql || null,
        success: false,
        error: err.message,
        durationMs: Date.now() - started,
      });
      return { success: false, error: err.message, sql, rows: [], rowCount: 0 };
    }
  }
}

module.exports = MultiSourceQueryService;
module.exports.MAX_ROWS = MAX_ROWS;
