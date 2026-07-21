/**
 * /api/output-templates — global + per-user output formatting rules that the
 * orchestrator injects into every prompt (getOutputGuidance).
 */
const express = require('express');
const requireAuthFactory = require('../middleware/requireAuth');
const requireAdminFactory = require('../middleware/requireAdmin');

module.exports = function outputTemplatesRoutes(dbPool) {
  const router = express.Router();
  const requireAuth = requireAuthFactory(dbPool);
  const requireAdmin = requireAdminFactory(dbPool);

  router.get('/', requireAuth, async (req, res) => {
    const result = await dbPool.query(
      `SELECT * FROM agent_output_templates
       WHERE user_id IS NULL OR user_id = $1 ORDER BY user_id NULLS FIRST, name`,
      [req.user.id]
    );
    res.json(result.rows);
  });

  router.post('/', requireAuth, async (req, res) => {
    const { name, instructions, global } = req.body || {};
    if (!name || !instructions) return res.status(400).json({ error: 'name and instructions required' });
    if (global && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Only admins can create global templates' });
    }
    const result = await dbPool.query(
      `INSERT INTO agent_output_templates (user_id, name, instructions) VALUES ($1, $2, $3) RETURNING *`,
      [global ? null : req.user.id, name, instructions]
    );
    res.json(result.rows[0]);
  });

  router.put('/:id', requireAuth, async (req, res) => {
    const { name, instructions, is_active } = req.body || {};
    const result = await dbPool.query(
      `UPDATE agent_output_templates
       SET name = COALESCE($1, name), instructions = COALESCE($2, instructions),
           is_active = COALESCE($3, is_active), updated_at = NOW()
       WHERE id = $4 AND (user_id = $5 OR ($6 = 'admin' AND user_id IS NULL))
       RETURNING *`,
      [name, instructions, is_active, req.params.id, req.user.id, req.user.role]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Template not found' });
    res.json(result.rows[0]);
  });

  router.delete('/:id', requireAuth, async (req, res) => {
    await dbPool.query(
      `DELETE FROM agent_output_templates
       WHERE id = $1 AND (user_id = $2 OR ($3 = 'admin' AND user_id IS NULL))`,
      [req.params.id, req.user.id, req.user.role]
    );
    res.json({ success: true });
  });

  return router;
};
