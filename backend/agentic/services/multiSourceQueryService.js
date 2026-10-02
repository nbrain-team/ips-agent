/**
 * multiSourceQueryService — the NL → SQL pipeline (Part 5.6).
 *
 * discover relevant tables → build schema context (columns, counts, date
 * ranges, sample rows) → Claude writes ONE read-only SELECT → execute with a
 * 30s statement timeout → return rows. Every run logged to
 * agent_metadata.query_history.
 *
 * SAFETY: hard keyword denylist (SELECT-only), READ ONLY transaction, 30s
 * timeout, and a row cap applied in SQL — 250 rows for lists, 2,000 for
 * aggregates (both env-tunable). export_query_result runs the same pipeline
 * with its own, larger limits.
 * Works against any pool (primary operational DB or the read-only billing DB).
 */
const Anthropic = require('@anthropic-ai/sdk');
const TableRouter = require('./TableRouter');
const { isExcludedTable, splitQualified } = require('./TableMetadataVectorization');
const { llmHttpsAgent } = require('../utils/httpAgent');
const { withRetry, sanitizeAnthropicParams } = require('../utils/anthropicRetry');

const FORBIDDEN_SQL =
  /\b(DROP|DELETE|UPDATE|INSERT|ALTER|CREATE|TRUNCATE|GRANT|REVOKE|COPY|VACUUM|COMMENT|EXECUTE|DO|CALL|MERGE|LOCK|LISTEN|NOTIFY|REFRESH|REINDEX|CLUSTER|CHECKPOINT|SECURITY|PREPARE|DEALLOCATE|DECLARE|RESET|SHOW)\b/i;
// Dangerous server-side functions that work even inside a SELECT
const FORBIDDEN_FUNCTIONS =
  /\b(pg_read_file|pg_read_binary_file|pg_ls_dir|pg_stat_file|pg_logdir_ls|lo_import|lo_export|dblink|dblink_exec|pg_sleep|pg_terminate_backend|pg_cancel_backend|pg_reload_conf|pg_rotate_logfile|copy_from|current_setting\s*\(\s*'[^']*password)/i;
const { isAggregateSQL } = require('../utils/tabular');

const MAX_ROWS = parseInt(process.env.SMART_DB_MAX_ROWS || '250', 10);
const MAX_ROWS_AGGREGATE = parseInt(process.env.SMART_DB_MAX_ROWS_AGGREGATE || '2000', 10);
const STATEMENT_TIMEOUT_MS = 30000;
const MAX_TABLES = 12;

// Semantic discovery ranks tables one at a time, so a question that needs a
// join (invoice → payment) can come back with only one side of it. Whenever
// one of these tables is chosen, the tables it joins to come with it.
const SAP_B1_PARTNERS = {
  ar_invoices: ['ar_invoice_lines', 'incoming_payment_invoices', 'incoming_payments'],
  ar_invoice_lines: ['ar_invoices', 'field_tickets'],
  incoming_payments: ['incoming_payment_invoices', 'ar_invoices'],
  incoming_payment_invoices: ['incoming_payments', 'ar_invoices'],
  ar_credit_memos: ['ar_credit_memo_lines'],
  ar_credit_memo_lines: ['ar_credit_memos'],
  ap_invoices: ['ap_invoice_lines', 'vendor_payment_invoices', 'vendor_payments'],
  ap_invoice_lines: ['ap_invoices', 'chart_of_accounts'],
  vendor_payments: ['vendor_payment_invoices', 'ap_invoices'],
  vendor_payment_invoices: ['vendor_payments', 'ap_invoices'],
  ap_credit_memos: ['ap_credit_memo_lines'],
  ap_credit_memo_lines: ['ap_credit_memos'],
  delivery_notes: ['delivery_note_lines'],
  delivery_note_lines: ['delivery_notes', 'field_tickets'],
  field_tickets: ['field_ticket_lines'],
  field_ticket_lines: ['field_tickets'],
  journal_entries: ['journal_entry_lines', 'chart_of_accounts'],
  journal_entry_lines: ['journal_entries', 'chart_of_accounts'],
};

const SAP_B1_JOIN_NOTES = `SAP B1 JOIN KEYS (tables in schema sap_b1):
- Header to lines: <document>_lines.doc_entry = <document>.doc_entry; journal_entry_lines.jdt_num = journal_entries.jdt_num.
- Customer payment to invoice: incoming_payment_invoices.doc_entry = incoming_payments.doc_entry AND incoming_payment_invoices.invoice_doc_entry = ar_invoices.doc_entry AND incoming_payment_invoices.invoice_type = 'it_Invoice' ('it_CredItnote' links to ar_credit_memos). Days to pay = incoming_payments.doc_date - ar_invoices.doc_date.
- Vendor payment to bill: vendor_payment_invoices.doc_entry = vendor_payments.doc_entry AND vendor_payment_invoices.invoice_doc_entry = ap_invoices.doc_entry AND vendor_payment_invoices.invoice_type = 'it_PurchaseInvoice' ('it_PurchaseCreditNote' links to ap_credit_memos).
- Field ticket to invoice: ar_invoice_lines.field_ticket_doc_num = field_tickets.doc_num (same on delivery_note_lines).
- Business partner code: ar_*.customer_code, ap_*.vendor_code, *_payments.card_code, business_partners.card_code.
- cancelled / canceled are booleans: add "NOT cancelled" (field_tickets: "NOT canceled") unless cancelled documents are asked for.

SAP B1 GENERAL LEDGER MATH (checked against IPS accounting's own B1 figures):
- Account numbers: users write the FormatCode with a dash ("541200-000"). Match chart_of_accounts.raw_data->>'FormatCode' = '541200000'; journal_entry_lines.account_code is the internal _SYS code.
- Dates: journal_entries.reference_date IS B1's posting date. due_date normally equals it. Filter periods on reference_date.
- Year-end close: every 12/31 an entry with journal_entries.origin_type = 'ttClosingBalance' zeroes each revenue and expense account into retained earnings. Exclude 'ttClosingBalance' and 'ttOpeningBalance' from any period activity, total or P&L.
- An account's activity for a period = SUM(debit - credit) for expenses, SUM(credit - debit) for revenue, closing entries excluded. Never sum debits alone or credits alone: credit memos, receipts and reversals post to the other side. (GL 541200-000 in 2025 = $2,836,051.30 net; debits alone overstate it by about $100K.)
- "Balance as of 12/31/YYYY" on a revenue or expense account means that fiscal year's activity before the close, not the all-history running balance (which is $0 after every close). Balance-sheet accounts (FormatCode 1xxxxx-3xxxxx, account_type at_Other) are cumulative through the date.
- Profit: revenue = accounts with account_type 'at_Revenues' (FormatCode 4xxxxx); expenses = 'at_Expenses' (5xxxxx job cost / COGS, 6xxxxx overhead, 8xxxxx other). Leave at_Other (balance sheet) out of any P&L. Gross profit = revenue - 5xxxxx; net = revenue - all expenses. Never compute revenue as "all credits".
- Repair & maintenance is split: 541200-000 Job Cost Equipment R&M (job cost) and overhead accounts (620300-000 Auto R&M, 654300-000 Office/Building R&M). Show them separately; say which is included.
- Profit center = division + location. journal_entry_lines.costing_code is the division ('100' = Electrical across all locations); journal_entry_lines.costing_code2 is the location ('HOB', 'MID', 'AND', 'LBK', 'ELP', 'DAL'). "100HOB" / "100 HOB" / "Hobbs electrical" = costing_code '100' AND costing_code2 'HOB'. If costing_code2 is NULL for the period, the location split has not loaded yet: say so and offer the division-wide figure, labeled as all locations. On document lines (ar_invoice_lines, ar_credit_memo_lines, ap_invoice_lines, ap_credit_memo_lines, delivery_note_lines) the same values are raw_data->>'CostingCode' and raw_data->>'CostingCode2'.`;

const RAMP_PARTNERS = {
  transactions: ['users', 'cards', 'trips'],
  cards: ['users', 'transactions'],
  users: ['transactions', 'cards'],
  trips: ['transactions', 'users'],
  limits: ['transactions', 'users'],
  vendors: ['transactions'],
  accounting_gl_accounts: ['transactions'],
};

const PARTNERS = { sap_b1: SAP_B1_PARTNERS, ramp: RAMP_PARTNERS };

const RAMP_NOTES = `RAMP (IPS corporate cards, schema ramp):
- KEYS: ramp_id (text) is Ramp's own id. The integer "id" column is a local row number: never join or filter on it.
  transactions.card_holder_user_id = users.ramp_id; transactions.card_id = cards.ramp_id; transactions.limit_id = limits.ramp_id; transactions.trip_id = trips.ramp_id; transactions.merchant_id = vendors.merchant_id; cards.cardholder_id = users.ramp_id; trips.user_id = users.ramp_id; a refund's original_transaction_id = the original purchase's transactions.ramp_id.
  Removed users and terminated cards are not in users/cards, so use LEFT JOIN. For spend by person, group on transactions.card_holder_first_name || ' ' || card_holder_last_name (always filled) rather than joining users.
- UNITS: transactions.amount and trips.total_spend are DOLLARS. These are CENTS (divide by 100): transactions.merchant_amount_value, entity_amount_value, original_transaction_amount_amount and line_items amounts; vendors.total_spend_last_30_days_amount / _ytd_amount / _last_365_days_amount / _all_time_amount; transfers.amount_amount; trips.total_spend_amount_value; limits.restrictions_limit_amount and balance_*_amount; cards.spending_restrictions_total_amount_value. cards.spending_restrictions_amount is dollars. Sum transactions.amount for spend.
- DATES: user_transaction_time is the purchase date (use it for "spend in <period>"); settlement_date is when it cleared; accounting_date is the posting date.
- STATE: CLEARED is final, PENDING can still change or drop. Negative amounts are refunds and credits; net them in unless gross spend is asked for.
- CATEGORIES: sk_category_name is Ramp's merchant category (Restaurants, SaaS / Software, ...). IPS's accounting coding is the jsonb array accounting_categories, one element per dimension, keyed by tracking_category_remote_name:
  'Category' = SAP GL account (category_id like '617300-000', category_name like 'MEALS/ENTERTAINMENT'; matches accounting_gl_accounts.code / name), 'Division' (Powerline, Electrical, Automation & Fiber, ... overhead), 'Location' (Hobbs, Midland, Andrews, ...).
  Example: (SELECT c->>'category_name' FROM jsonb_array_elements(t.accounting_categories) c WHERE c->>'tracking_category_remote_name' = 'Category'). An empty array means the transaction is not coded yet.
  card_holder_department_name / card_holder_location_name are the cardholder's HR department and location, not the transaction's coding.
- receipts and policy_violations are jsonb arrays: jsonb_array_length(receipts) = 0 means no receipt attached. sync_status 'SYNCED' means exported to the accounting system.
- vendors.total_spend_* are Ramp's rolling totals as of the last sync; for any specific date range, sum transactions instead.
- *_info tables (transactions_info, users_info, trips_info, limits_info, transfers_info) are detail copies of the same records, and transactions_info holds only the newest 1,000. Never add them to the base tables; use the base tables for totals.
- business, business_balance and accounting_all_connections are single rows with everything in raw_data (jsonb). This Ramp account has no bills or vendor credits; IPS's AP bills are in SAP.`;

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
      .filter((r) => !isExcludedTable(r.table_schema, r.table_name))
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
    if (relevantTables.some((t) => String(t.table_name).startsWith('sap_b1.'))) blocks.push(SAP_B1_JOIN_NOTES);
    if (relevantTables.some((t) => String(t.table_name).startsWith('ramp.'))) blocks.push(RAMP_NOTES);
    return blocks.join('\n\n');
  }

  /**
   * Final table set for the SQL writer: tables named in the hint or the
   * question first (whether or not they are profiled yet), then the router's
   * picks, then the SAP B1 / Ramp tables those join to.
   */
  widenTables(routed, question, hint, live) {
    const clean = (name) => name.replace(/["`]/g, '').replace(/^public\./, '');
    const named = [
      ...String(hint || '').split(/[\s,;]+/),
      ...(String(question).match(/\b[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*\b/gi) || []),
    ]
      .map(clean)
      .filter((t) => live.has(t));
    const order = [...new Set([...named, ...routed.map((r) => r.table_name)])];
    const partners = order.flatMap((t) => {
      const { schema, table } = splitQualified(t);
      return ((PARTNERS[schema] || {})[table] || []).map((p) => `${schema}.${p}`);
    });
    const byName = new Map(routed.map((r) => [r.table_name, r]));
    return [...new Set([...order, ...partners])]
      .filter((t) => live.has(t))
      .slice(0, Math.max(MAX_TABLES, named.length))
      .map((t) => byName.get(t) || { table_name: t, row_count: '?', columns_json: [], sample_rows_json: [] });
  }

  async generateSQL(question, schemaContext, tableNames, purpose = 'answer') {
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
${MultiSourceQueryService.limitRules(purpose)}
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

  /** The row-limit part of the SQL-writer prompt. Exports want every row; answers want a bounded result. */
  static limitRules(purpose) {
    if (purpose === 'export') {
      return `- This result is written to a spreadsheet for download. Return EVERY matching row: no LIMIT unless the question asks for a top N.
- Compute rankings, totals and counts in SQL (GROUP BY with SUM/COUNT, ORDER BY the measure) when the question asks for them, and add an ORDER BY that makes the sheet easy to read.`;
    }
    return `- Compute totals, rankings and counts IN SQL (GROUP BY with SUM/COUNT/AVG, ORDER BY the measure DESC) — never return raw rows for the reader to add up.
- Aggregated results (GROUP BY or DISTINCT summaries): LIMIT ${MAX_ROWS_AGGREGATE} at most. When the question asks for all of them (e.g. every vendor ranked by spend), return every group up to that limit.
- Raw row lists (one row per record): LIMIT ${MAX_ROWS}.`;
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

  /** Row cap for a statement: aggregates summarise, so they may return more rows than lists. */
  static rowCapFor(sql) {
    return isAggregateSQL(sql) ? MAX_ROWS_AGGREGATE : MAX_ROWS;
  }

  /**
   * Run one validated SELECT and return { rows, fields, capped, cap }.
   *
   * The cap is applied in SQL by wrapping the statement, so a query that
   * forgot its LIMIT on a 275k-row table never pulls every row into memory.
   * One extra row is fetched to tell "exactly the cap" from "more exist".
   *
   * @param {object} opts
   * @param {number} [opts.rowCap]      overrides the list/aggregate cap
   * @param {number} [opts.cellBudget]  further limits rows to cellBudget / column count
   * @param {number} [opts.timeoutMs]   statement timeout (default 30s)
   */
  async executeQuery(sql, { rowCap = null, cellBudget = null, timeoutMs = STATEMENT_TIMEOUT_MS } = {}) {
    let cap = rowCap || MultiSourceQueryService.rowCapFor(sql);
    const body = sql.trim().replace(/;\s*$/, '');
    // Defense in depth: run inside a READ ONLY transaction so even SQL that
    // slips past the denylist cannot write, regardless of the pool's DB role.
    const client = await this.dataPool.connect();
    try {
      await client.query('BEGIN TRANSACTION READ ONLY');
      await client.query(`SET LOCAL statement_timeout = ${Math.max(1000, parseInt(timeoutMs, 10) || STATEMENT_TIMEOUT_MS)}`);
      if (cellBudget) {
        const shape = await client.query(`SELECT * FROM (\n${body}\n) AS _shape LIMIT 0`);
        cap = Math.max(1, Math.min(cap, Math.floor(cellBudget / Math.max(1, shape.fields.length))));
      }
      const res = await client.query(`SELECT * FROM (\n${body}\n) AS _capped LIMIT ${cap + 1}`);
      await client.query('COMMIT');
      return { rows: res.rows.slice(0, cap), fields: res.fields, capped: res.rows.length > cap, cap };
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
  async writeSQL(question, schemaContext, tableNames, purpose = 'answer') {
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

    const raw = await this.generateSQL(question, schemaContext, tableNames, purpose);
    const first = MultiSourceQueryService.extractSQL(raw);
    if (first) return { sql: validate(first, raw), raw };

    const retryRaw = await this.generateSQL(
      `${question}\n\nIMPORTANT: your previous response was not a SQL statement. Reply with ` +
        'nothing but the SELECT (or WITH) statement — no prose, no explanation, no code fences. ' +
        'If the question cannot be answered from the tables listed above, reply with exactly ' +
        'CANNOT_ANSWER followed by one sentence saying which table or column is missing.',
      schemaContext,
      tableNames,
      purpose
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
   * Returns { success, sql, rows, fields, rowCount, capped, cap, tables }.
   *
   * @param {object} opts
   * @param {string} [opts.hint]     table name to prioritise
   * @param {string} [opts.purpose]  'answer' (bounded, default) or 'export' (every row)
   * @param {object} [opts.limits]   executeQuery options: rowCap, cellBudget, timeoutMs
   */
  async query(question, { hint = null, purpose = 'answer', limits = {} } = {}) {
    const started = Date.now();
    let sql = null;
    try {
      const live = new Set(await this.getAllTables());
      let relevant = this.widenTables(
        await this.tableRouter.discoverRelevantTables(question, { limit: 6, hint }),
        question,
        hint,
        live
      );
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

      const written = await this.writeSQL(question, schemaContext, tableNames, purpose);
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
      let run = await this.executeQuery(sql, limits);

      // Empty result → one retry with a rephrase + widened table set
      if (run.rows.length === 0) {
        const wider = this.widenTables(
          await this.tableRouter.discoverRelevantTables(question, { limit: 10, hint }),
          question,
          hint,
          live
        );
        if (wider.length > relevant.length) {
          schemaContext = await this.buildDynamicSchemaContext(wider);
          tableNames = wider.map((r) => r.table_name);
        }
        const retry = await this.writeSQL(
          `${question}\n\n(The previous attempt returned zero rows with this SQL: ${sql}. Try different tables, broader filters, or case-insensitive matching.)`,
          schemaContext,
          tableNames,
          purpose
        );
        // A widened second pass that produces no statement is not worth
        // failing over — the first query ran fine and legitimately found
        // nothing, which is an answer.
        if (retry.sql) {
          const retryRun = await this.executeQuery(retry.sql, limits);
          if (retryRun.rows.length > 0) {
            sql = retry.sql;
            run = retryRun;
          }
        }
      }

      const durationMs = Date.now() - started;
      const { rows, fields, capped, cap } = run;
      await this.logQuery({ question, sql, rowCount: rows.length, success: true, durationMs });
      return { success: true, sql, rows, fields, rowCount: rows.length, capped, cap, tables: tableNames };
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
module.exports.MAX_ROWS_AGGREGATE = MAX_ROWS_AGGREGATE;
