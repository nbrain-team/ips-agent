/**
 * /api/exports — artifact downloads (PDF and spreadsheet binaries, text artifacts as files).
 *
 *   GET /artifact/:id  — signed-in IPS users (owner, admin, or shared session)
 *   GET /download/:id  — anyone holding a signed, unexpired link (see exportLinks.js)
 */
const express = require('express');
const requireAuthFactory = require('../middleware/requireAuth');
const exportLinks = require('../agentic/services/exportLinks');

const EXT = { html: 'html', svg: 'svg', mermaid: 'mmd', chart: 'json', markdown: 'md', pdf: 'pdf', xlsx: 'xlsx' };
const BINARY_TYPES = {
  pdf: 'application/pdf',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

function sendArtifact(res, artifact) {
  const safeTitle = String(artifact.title).replace(/[^a-zA-Z0-9-_ ]/g, '').slice(0, 60) || 'artifact';
  const ext = EXT[artifact.type] || 'txt';
  res.setHeader('Content-Disposition', `attachment; filename="${safeTitle}.${ext}"`);
  if (artifact.content_binary) {
    res.setHeader('Content-Type', BINARY_TYPES[artifact.type] || 'application/octet-stream');
    return res.send(artifact.content_binary);
  }
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  return res.send(artifact.content || '');
}

module.exports = function exportsRoutes(dbPool) {
  const router = express.Router();
  const requireAuth = requireAuthFactory(dbPool);

  router.get('/artifact/:id', requireAuth, async (req, res) => {
    // Scope to the requester: an artifact is downloadable only by the owner of
    // its chat session, an admin, or anyone if the session is explicitly shared.
    // Artifacts with no session (session_id NULL) are admin-only.
    const result = await dbPool.query(
      `SELECT a.*, s.user_id AS session_user_id, s.visibility AS session_visibility
       FROM agent_artifacts a
       LEFT JOIN agent_chat_sessions s ON s.id = a.session_id
       WHERE a.id = $1`,
      [req.params.id]
    );
    const artifact = result.rows[0];
    if (!artifact) return res.status(404).json({ error: 'Artifact not found' });

    const isOwner = artifact.session_user_id != null && artifact.session_user_id === req.user.id;
    const isAdmin = req.user.role === 'admin';
    const isShared = artifact.session_visibility === 'shared';
    if (!isOwner && !isAdmin && !isShared) {
      return res.status(404).json({ error: 'Artifact not found' });
    }

    return sendArtifact(res, artifact);
  });

  // No session: the signature is the authority. Limited to exports so a
  // signed link can never be minted into a route to chat artifacts.
  router.get('/download/:id', async (req, res) => {
    let check;
    try {
      check = exportLinks.verify(req.params.id, req.query.exp, req.query.sig);
    } catch (err) {
      console.error('[exports] signed download unavailable:', err.message);
      return res.status(503).json({ error: 'Downloads are not configured on this service.' });
    }
    if (check === 'expired') return res.status(410).json({ error: 'This download link has expired. Ask for the export again.' });
    if (check !== 'ok') return res.status(404).json({ error: 'Artifact not found' });

    const result = await dbPool.query(
      `SELECT id, type, title, content, content_binary FROM agent_artifacts WHERE id = $1 AND type = 'xlsx'`,
      [req.params.id]
    );
    const artifact = result.rows[0];
    if (!artifact) return res.status(404).json({ error: 'Artifact not found' });
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    return sendArtifact(res, artifact);
  });

  return router;
};
