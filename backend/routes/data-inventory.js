/**
 * /api/data-inventory — the "what does the agent know?" page. Read-only
 * counts/metadata from table_vectors (both sources) + the knowledge base.
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
          `SELECT table_name, source_tag, row_count, description, updated_at
           FROM agent_metadata.table_vectors ORDER BY source_tag, table_name`
        )
        .catch(() => ({ rows: [] }));

      const knowledge = await dbPool
        .query(
          `SELECT category, source, COUNT(*)::int AS chunks
           FROM website_content GROUP BY category, source ORDER BY chunks DESC`
        )
        .catch(() => ({ rows: [] }));

      const memories = await dbPool
        .query(`SELECT COUNT(*)::int AS n FROM agent_memories`)
        .catch(() => ({ rows: [{ n: 0 }] }));

      res.json({
        data_tables: tables.rows,
        knowledge_base: knowledge.rows,
        memories: memories.rows[0].n,
        billing_database_connected: !!billingDbPool,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};
