/**
 * /api/data-inventory — the "what does the agent know?" page. Read-only
 * depth + freshness view over everything the agent can reach: both Postgres
 * databases (via table_vectors), synced M365 email, the knowledge base,
 * and long-term memories. Every source reports a last-updated timestamp.
 */
const express = require('express');
const requireAuthFactory = require('../middleware/requireAuth');

module.exports = function dataInventoryRoutes(dbPool, billingDbPool) {
  const router = express.Router();
  const requireAuth = requireAuthFactory(dbPool);

  router.get('/', requireAuth, async (_req, res) => {
    try {
      const tables = await dbPool
        .query(
          `SELECT table_name, source_tag, row_count, description,
                  jsonb_array_length(columns_json) AS column_count,
                  date_range_json, updated_at
           FROM agent_metadata.table_vectors ORDER BY source_tag, table_name`
        )
        .catch(() => ({ rows: [] }));

      const knowledge = await dbPool
        .query(
          `SELECT category, source, COUNT(*)::int AS chunks, MAX(updated_at) AS last_updated
           FROM website_content GROUP BY category, source ORDER BY chunks DESC`
        )
        .catch(() => ({ rows: [] }));

      const memories = await dbPool
        .query(`SELECT COUNT(*)::int AS n, MAX(created_at) AS last_updated FROM agent_memories`)
        .catch(() => ({ rows: [{ n: 0, last_updated: null }] }));

      const emails = await dbPool
        .query(
          `SELECT (SELECT COUNT(*)::int FROM ms_mailboxes WHERE sync_status = 'ok') AS mailboxes,
                  (SELECT COUNT(*)::int FROM ms_mailboxes) AS mailboxes_total,
                  (SELECT MAX(last_synced_at) FROM ms_mailboxes) AS last_synced,
                  COUNT(*)::int AS messages, MAX(received_at) AS latest_message
           FROM ms_emails`
        )
        .catch(() => ({ rows: [{ mailboxes: 0, mailboxes_total: 0, last_synced: null, messages: 0, latest_message: null }] }));

      const rows = tables.rows.map((t) => ({
        ...t,
        // Freshest data point inside the table (max of its primary date column)
        data_through: t.date_range_json?.max || null,
        data_from: t.date_range_json?.min || null,
        date_column: t.date_range_json?.column || null,
        date_range_json: undefined,
      }));

      const primary = rows.filter((t) => t.source_tag === 'primary');
      const billing = rows.filter((t) => t.source_tag === 'billing');
      const maxDate = (list, key) =>
        list.reduce((m, t) => (t[key] && (!m || t[key] > m) ? t[key] : m), null);

      res.json({
        data_tables: rows,
        knowledge_base: knowledge.rows,
        memories: { count: memories.rows[0].n, last_updated: memories.rows[0].last_updated },
        emails: emails.rows[0],
        billing_database_connected: !!billingDbPool,
        summary: {
          primary_tables: primary.length,
          primary_rows: primary.reduce((s, t) => s + Number(t.row_count || 0), 0),
          primary_data_through: maxDate(primary, 'data_through'),
          primary_profiled_at: maxDate(primary, 'updated_at'),
          billing_tables: billing.length,
          billing_rows: billing.reduce((s, t) => s + Number(t.row_count || 0), 0),
          billing_data_through: maxDate(billing, 'data_through'),
          billing_profiled_at: maxDate(billing, 'updated_at'),
          knowledge_chunks: knowledge.rows.reduce((s, k) => s + k.chunks, 0),
          knowledge_last_updated: maxDate(knowledge.rows, 'last_updated'),
        },
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};
