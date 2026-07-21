/**
 * list_data_sources — friendly self-inventory so users can ask "what are we
 * connected to?" and get a simple, accurate list of everything the agent can
 * answer questions from, with freshness info.
 */

module.exports = {
  name: 'list_data_sources',
  description: `List every data source this agent is connected to and can answer questions from, with counts and last-updated info.

WHEN TO USE: whenever the user asks anything like "what are we connected to?", "what data do you have?", "what can you answer?", "what do you know?", "what systems are hooked up?", "help me get acquainted", or asks about the agent's capabilities/data access.

Present the result as a SIMPLE, friendly list (source name — one-line description — freshness). Do not dump raw table names unless asked; group them into plain-English categories.`,
  category: 'meta',
  requiresApproval: false,
  parameters: {
    type: 'object',
    properties: {},
    required: [],
  },
  async execute(_params, context) {
    try {
      const db = context.dbPool;

      const tables = await db
        .query(
          `SELECT table_name, source_tag, row_count, date_range_json
           FROM agent_metadata.table_vectors ORDER BY source_tag, row_count DESC`
        )
        .catch(() => ({ rows: [] }));

      const knowledge = await db
        .query(
          `SELECT category, source, COUNT(*)::int AS chunks, MAX(updated_at) AS last_updated
           FROM website_content GROUP BY category, source`
        )
        .catch(() => ({ rows: [] }));

      const emails = await db
        .query(
          `SELECT (SELECT COUNT(*)::int FROM ms_mailboxes WHERE sync_status = 'ok') AS mailboxes,
                  COUNT(*)::int AS messages, MAX(received_at) AS latest
           FROM ms_emails`
        )
        .catch(() => ({ rows: [{ mailboxes: 0, messages: 0, latest: null }] }));

      const memories = await db
        .query(`SELECT COUNT(*)::int AS n FROM agent_memories WHERE user_id = $1`, [context.userId || null])
        .catch(() => ({ rows: [{ n: 0 }] }));

      const summarize = (list) => ({
        tables: list.length,
        total_rows: list.reduce((s, t) => s + Number(t.row_count || 0), 0),
        data_through: list.reduce((m, t) => {
          const d = t.date_range_json?.max;
          return d && (!m || d > m) ? d : m;
        }, null),
        table_names: list.map((t) => t.table_name),
      });

      const sources = [];

      const primary = tables.rows.filter((t) => t.source_tag === 'primary');
      if (primary.length) {
        sources.push({
          source: 'IPS operational database (Postgres)',
          what: 'Structured operational data — queryable in natural language via query_operational_database',
          ...summarize(primary),
        });
      }

      const billing = tables.rows.filter((t) => t.source_tag === 'billing');
      if (billing.length) {
        sources.push({
          source: 'IPS Billing platform database (Postgres, read-only)',
          what: 'The existing IPS billing/back-office system (jobs, tickets, billing, Motive fleet data, etc.) — queryable via query_billing_database',
          ...summarize(billing),
        });
      }

      if (emails.rows[0].messages > 0) {
        sources.push({
          source: 'Microsoft 365 email',
          what: 'Company email, synced every hour (last 30 days). Users see only their own mailbox; admins see all.',
          mailboxes: emails.rows[0].mailboxes,
          messages: emails.rows[0].messages,
          latest_message: emails.rows[0].latest,
        });
      }

      const meetings = await db
        .query(`SELECT COUNT(*)::int AS n, MAX(meeting_start) AS latest FROM meeting_transcripts`)
        .catch(() => ({ rows: [{ n: 0, latest: null }] }));
      if (meetings.rows[0].n > 0) {
        sources.push({
          source: 'Meeting transcripts (Read.ai)',
          what: 'Meeting recordings auto-ingested from Read.ai — summaries, action items, and full transcripts, searchable by meaning',
          meetings: meetings.rows[0].n,
          latest_meeting: meetings.rows[0].latest,
        });
      }

      if (knowledge.rows.length) {
        sources.push({
          source: 'Knowledge base (documents & website)',
          what: 'Ingested documents and ipsaecorp.com content, searchable by meaning and keyword',
          collections: knowledge.rows
            .filter((k) => k.category !== 'meeting_transcript')
            .map((k) => ({
              category: k.category,
              origin: k.source,
              chunks: k.chunks,
              last_updated: k.last_updated,
            })),
        });
      }

      sources.push({
        source: 'In-chat uploads',
        what: 'PDFs, Word, Excel, CSV, PowerPoint and images can be attached to any message for analysis',
      });

      if (memories.rows[0].n > 0) {
        sources.push({
          source: 'Long-term memory',
          what: 'Facts and preferences remembered from your past conversations',
          memories: memories.rows[0].n,
        });
      }

      return {
        success: true,
        data: sources,
        summary: `${sources.length} connected data sources`,
        confidence: 0.95,
        source_type: 'system',
        source_summary: 'Live data-source inventory',
      };
    } catch (error) {
      return { success: false, error: error.message, confidence: 0 };
    }
  },
};
