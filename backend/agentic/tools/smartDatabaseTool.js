/**
 * SmartDatabaseTool — the NL-to-SQL tool Claude calls for any data question
 * (class-based; instantiated by the orchestrator, not auto-loaded).
 *
 * Default instance = query_operational_database (primary DB).
 * A second instance pointed at the billing pool = query_billing_database.
 */
const MultiSourceQueryService = require('../services/multiSourceQueryService');
const { toCsv } = require('../utils/tabular');

const MAX_CELL_CHARS = 300;

class SmartDatabaseTool {
  constructor(dataPool, opts = {}) {
    this.name = opts.name || 'query_operational_database';
    this.sourceTag = opts.sourceTag || 'primary';
    this.description =
      opts.description ||
      `Query IPS's operational PostgreSQL database using natural language. Table discovery and SQL generation are automatic — just describe what you want.

WHEN TO USE: ANY question about structured operational data — jobs, projects, work orders, bids/estimates, crews, labor hours, equipment, fleet, safety incidents, permits, costs, counts, statistics, trends.
Examples: "how many active jobs are there?", "total labor hours by crew last month", "list safety incidents this quarter".
Returns up to ${MultiSourceQueryService.MAX_ROWS} rows for lists and ${MultiSourceQueryService.MAX_ROWS_AGGREGATE} for aggregated results (totals, rankings). For "all"/"full list"/"export"/"spreadsheet" requests, or results beyond a few hundred rows, use export_query_result instead.

Do NOT announce that you are querying — use this tool silently and present the results naturally.`;
    this.queryService = new MultiSourceQueryService(dataPool, {
      sourceTag: this.sourceTag,
      metadataPool: opts.metadataPool || dataPool,
    });
  }

  /** Adapter so the class instance registers like an object-style tool. */
  asTool() {
    return {
      name: this.name,
      description: this.description,
      category: 'data',
      requiresApproval: false,
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Natural-language description of the data you need (NOT SQL).',
          },
          hint: {
            type: 'string',
            description: 'Optional: the table name(s) to use, comma-separated when the question joins several (e.g. "sap_b1.ar_invoices, sap_b1.incoming_payments, sap_b1.incoming_payment_invoices").',
          },
        },
        required: ['query'],
      },
      execute: (params, context) => this.execute(params, context),
    };
  }

  async execute(params) {
    try {
      const result = await this.queryService.query(params.query, { hint: params.hint || null });
      if (!result.success) {
        // "This database has no such table" is a real answer, not a
        // malfunction. Carry the explanation and the tables that were searched
        // so the calling agent can tell the operator what is actually missing
        // rather than relaying an internal error string.
        return {
          success: false,
          error: result.error,
          unanswerable: result.unanswerable || false,
          formatted: result.error,
          summary: result.unanswerable ? 'No matching data in this database' : 'Query failed',
          data: result.tables ? { tables: result.tables } : undefined,
          confidence: 0,
        };
      }
      const formatted = SmartDatabaseTool.formatRecords(result);
      return {
        success: true,
        data: {
          rowCount: result.rowCount,
          capped: Boolean(result.capped),
          rows: result.rows,
          sql: result.sql,
          tables: result.tables,
        },
        formatted,
        // `formatted` carries every returned row plus the SQL, so a caller
        // that shows the model text (the federation master) can send it alone
        // instead of the rows twice.
        formattedComplete: true,
        summary: `${result.rowCount}${result.capped ? '+' : ''} row(s) from ${result.tables?.join(', ') || 'database'}`,
        confidence: result.rowCount > 0 ? 0.95 : 0.4,
        source_type: this.sourceTag === 'billing' ? 'billing_database' : 'database',
        source_summary: `SQL over ${result.tables?.join(', ')}`,
      };
    } catch (error) {
      return { success: false, error: error.message, confidence: 0 };
    }
  }

  /**
   * Every returned row as CSV under a one-line preface (row count, whether the
   * cap cut it, the SQL). CSV names each column once instead of per row, which
   * is what lets a 1,000-row ranking fit in one tool result.
   */
  static formatRecords({ rows, fields, capped, cap, sql }) {
    const oneLineSql = String(sql || '').replace(/\s+/g, ' ').trim();
    if (!rows || rows.length === 0) {
      return `Query executed successfully but returned no rows. SQL: ${oneLineSql}`;
    }
    const capNote = capped
      ? ` CAPPED at ${cap} rows; more rows exist. Do not present this as the complete set; use export_query_result for all of them.`
      : ' Complete result (not capped).';
    const columns = fields && fields.length ? [...new Set(fields.map((f) => f.name))] : null;
    return `${rows.length} row(s).${capNote} SQL: ${oneLineSql}\n${toCsv(rows, { columns, maxCell: MAX_CELL_CHARS })}`;
  }
}

SmartDatabaseTool.MAX_ROWS = MultiSourceQueryService.MAX_ROWS;
SmartDatabaseTool.MAX_ROWS_AGGREGATE = MultiSourceQueryService.MAX_ROWS_AGGREGATE;

module.exports = SmartDatabaseTool;
