/**
 * /api/exports — artifact downloads (PDF binaries, text artifacts as files).
 */
const express = require('express');
const requireAuthFactory = require('../middleware/requireAuth');

const EXT = { html: 'html', svg: 'svg', mermaid: 'mmd', chart: 'json', markdown: 'md', pdf: 'pdf' };

module.exports = function exportsRoutes(dbPool) {
  const router = express.Router();
  const requireAuth = requireAuthFactory(dbPool);

  router.get('/artifact/:id', requireAuth, async (req, res) => {
    const result = await dbPool.query('SELECT * FROM agent_artifacts WHERE id = $1', [req.params.id]);
    const artifact = result.rows[0];
    if (!artifact) return res.status(404).json({ error: 'Artifact not found' });

    const safeTitle = String(artifact.title).replace(/[^a-zA-Z0-9-_ ]/g, '').slice(0, 60) || 'artifact';
    const ext = EXT[artifact.type] || 'txt';

    if (artifact.content_binary) {
      res.setHeader('Content-Type', artifact.type === 'pdf' ? 'application/pdf' : 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="${safeTitle}.${ext}"`);
      return res.send(artifact.content_binary);
    }
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${safeTitle}.${ext}"`);
    res.send(artifact.content || '');
  });

  return router;
};
