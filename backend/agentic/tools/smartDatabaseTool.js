/**
 * SmartDatabaseTool — the NL-to-SQL tool Claude calls for any data question
 * (class-based; instantiated by the orchestrator, not auto-loaded).
 *
 * Default instance = query_operational_database (primary DB).
 * A second instance pointed at the billing pool = query_billing_database.
 */
const MultiSourceQueryService = require('../services/multiSourceQueryService');

class SmartDatabaseTool {
  constructor(dataPool, opts = {}) {
    this.name = opts.name || 'query_operational_database';
    this.sourceTag = opts.sourceTag || 'primary';
    this.description =
      opts.description ||
      `Query IPS's operational PostgreSQL database using natural language. Table discovery and SQL generation are automatic — just describe what you want.

WHEN TO USE: ANY question about structured operational data — jobs, projects, work orders, bids/estimates, crews, labor hours, equipment, fleet, safety incidents, permits, costs, counts, statistics, trends.
Examples: "how many active jobs are there?", "total labor hours by crew last month", "list safety incidents this quarter".

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
            description: 'Optional: a specific table name to prioritize, if known.',
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
        return { success: false, error: result.error, confidence: 0 };
      }
      const formatted = this.formatRecords(result.rows);
      return {
        success: true,
        data: { rowCount: result.rowCount, rows: result.rows, sql: result.sql, tables: result.tables },
        formatted,
        summary: `${result.rowCount} row(s) from ${result.tables?.join(', ') || 'database'}`,
        confidence: result.rowCount > 0 ? 0.95 : 0.4,
        source_type: this.sourceTag === 'billing' ? 'billing_database' : 'database',
        source_summary: `SQL over ${result.tables?.join(', ')}`,
      };
    } catch (error) {
      return { success: false, error: error.message, confidence: 0 };
    }
  }

  /** Render rows as compact text for the model. */
  formatRecords(rows) {
    if (!rows || rows.length === 0) return 'Query executed successfully but returned no rows.';
    const lines = [`${rows.length} record(s):`];
    for (const row of rows.slice(0, 100)) {
      lines.push(
        Object.entries(row)
          .map(([k, v]) => `${k}: ${v === null ? 'NULL' : String(v).slice(0, 200)}`)
          .join(' | ')
      );
    }
    return lines.join('\n');
  }
}

module.exports = SmartDatabaseTool;
