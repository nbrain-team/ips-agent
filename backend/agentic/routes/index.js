/**
 * /api/agent-chat — sessions, streaming messages (SSE, Part 5.10 protocol),
 * uploads, chat migration/import, feedback, traces, tools, models.
 */
const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const requireAuthFactory = require('../../middleware/requireAuth');
const requireAdminFactory = require('../../middleware/requireAdmin');
const { extractTextIsolated, isImage } = require('../services/documentProcessor');
const { getRecentTraces } = require('../services/agentTrace');
const { getDashboard } = require('../services/confidenceScoring');
const clientConfig = require('../config/client-config');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: 8 },
});

// In-memory chat rate limit: 10 messages/min/user
const chatRateBuckets = new Map();
function chatRateLimited(userId) {
  const now = Date.now();
  const bucket = (chatRateBuckets.get(userId) || []).filter((t) => now - t < 60000);
  if (bucket.length >= 10) return true;
  bucket.push(now);
  chatRateBuckets.set(userId, bucket);
  return false;
}

module.exports = function agentChatRoutes(dbPool, getOrchestrator) {
  const router = express.Router();
  const requireAuth = requireAuthFactory(dbPool);
  const requireAdmin = requireAdminFactory(dbPool);

  /**
   * Server-side auto-title: if the session is still called "New chat" after a
   * successful exchange, summarize the first exchange into a unique title.
   * Runs inside the SSE request so the client gets a `session_title` event.
   */
  async function maybeAutoTitle(sessionId, userId) {
    const s = await dbPool.query(
      `SELECT title FROM agent_chat_sessions WHERE id = $1 AND user_id = $2`,
      [sessionId, userId]
    );
    if (!s.rows.length || !/^new chat$/i.test(String(s.rows[0].title || '').trim())) return null;

    const messages = await dbPool.query(
      `SELECT role, content FROM agent_chat_messages WHERE session_id = $1 ORDER BY created_at ASC, id ASC LIMIT 2`,
      [sessionId]
    );
    if (!messages.rows.length) return null;

    let title = '';
    try {
      const orchestrator = getOrchestrator();
      // 'classification' routes to the OpenAI fast model — cheap, and avoids
      // Anthropic 529 retry backoff blocking the stream. Hard 10s cap either way.
      const { text } = await Promise.race([
        orchestrator.modelRouter.generateText({
          taskType: 'classification',
          maxTokens: 30,
          temperature: 0.3,
          prompt: `Write a specific 3-6 word title for this chat. No quotes, no trailing punctuation, no generic words like "chat" or "conversation":\n\n${messages.rows
            .map((m) => `${m.role}: ${String(m.content).slice(0, 500)}`)
            .join('\n')}`,
        }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('title timeout')), 10000)),
      ]);
      title = text.trim().replace(/^["']|["']$/g, '').replace(/[.!?]+$/, '').slice(0, 80);
    } catch (_e) { /* fall through to heuristic */ }
    if (!title) title = String(messages.rows[0].content).replace(/\s+/g, ' ').trim().slice(0, 50);
    if (!title) return null;

    await dbPool.query(
      `UPDATE agent_chat_sessions SET title = $1, updated_at = NOW() WHERE id = $2`,
      [title, sessionId]
    );
    return title;
  }

  /**
   * Rolling conversation summary: when a session outgrows the 20-message
   * window, summarize everything older than the last 16 messages into
   * agent_chat_sessions.summary. Incremental (folds the previous summary in),
   * async/best-effort — never blocks a chat turn.
   */
  async function maybeUpdateSummary(sessionId) {
    const counts = await dbPool.query(
      `SELECT COUNT(*)::int AS n FROM agent_chat_messages WHERE session_id = $1`,
      [sessionId]
    );
    if (counts.rows[0].n <= 20) return;

    const session = await dbPool.query(
      `SELECT summary, summary_thru_message_id FROM agent_chat_sessions WHERE id = $1`,
      [sessionId]
    );
    const { summary: prevSummary, summary_thru_message_id: thruId } = session.rows[0] || {};

    // Messages that should be part of the summary: everything except the most
    // recent 16 (those stay in the live window).
    const older = await dbPool.query(
      `SELECT id, role, content FROM agent_chat_messages
       WHERE session_id = $1 AND id NOT IN (
         SELECT id FROM agent_chat_messages WHERE session_id = $1 ORDER BY created_at DESC, id DESC LIMIT 16
       )
       AND ($2::int IS NULL OR id > $2)
       ORDER BY created_at ASC, id ASC LIMIT 40`,
      [sessionId, thruId || null]
    );
    if (!older.rows.length) return;

    const block = older.rows
      .map((m) => `${m.role}: ${String(m.content).slice(0, 1200)}`)
      .join('\n');
    const orchestrator = getOrchestrator();
    const { text } = await orchestrator.modelRouter.generateText({
      taskType: 'summarization',
      maxTokens: 900,
      temperature: 0.2,
      system:
        'You maintain a rolling summary of a work conversation. Merge the previous summary (if any) with the new messages into ONE updated summary. Preserve: decisions made, data findings and key numbers, open questions, user preferences/instructions, and topics discussed. Be dense and factual. Max ~350 words.',
      prompt: `${prevSummary ? `PREVIOUS SUMMARY:\n${prevSummary}\n\n` : ''}NEW MESSAGES:\n${block}`,
    });
    if (!text?.trim()) return;
    const lastId = older.rows[older.rows.length - 1].id;
    await dbPool.query(
      `UPDATE agent_chat_sessions SET summary = $1, summary_thru_message_id = $2 WHERE id = $3`,
      [text.trim().slice(0, 8000), lastId, sessionId]
    );
  }

  // ==========================================================================
  // Sessions
  // ==========================================================================
  router.post('/sessions', requireAuth, async (req, res) => {
    const { title, folder, project_id } = req.body || {};
    const result = await dbPool.query(
      `INSERT INTO agent_chat_sessions (user_id, client_id, project_id, title, folder)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [req.user.id, clientConfig.CLIENT_ID, project_id || null, title || 'New chat', folder || null]
    );
    res.json(result.rows[0]);
  });

  router.get('/sessions', requireAuth, async (req, res) => {
    const { search, folder, archived } = req.query;
    const params = [req.user.id];
    let where = `user_id = $1`;
    if (archived === 'true') where += ` AND is_archived = true`;
    else where += ` AND is_archived = false`;
    if (folder) {
      params.push(folder);
      where += ` AND folder = $${params.length}`;
    }
    if (search) {
      params.push(`%${search}%`);
      where += ` AND (title ILIKE $${params.length} OR id IN (
        SELECT session_id FROM agent_chat_messages WHERE content ILIKE $${params.length}))`;
    }
    const result = await dbPool.query(
      `SELECT * FROM agent_chat_sessions WHERE ${where} ORDER BY updated_at DESC LIMIT 200`,
      params
    );
    res.json(result.rows);
  });

  router.get('/sessions/:id', requireAuth, async (req, res) => {
    const session = await dbPool.query(
      `SELECT * FROM agent_chat_sessions WHERE id = $1 AND (user_id = $2 OR visibility = 'shared')`,
      [req.params.id, req.user.id]
    );
    if (!session.rows.length) return res.status(404).json({ error: 'Session not found' });
    const messages = await dbPool.query(
      `SELECT id, role, content, model_used, tokens_used, plan_json, tool_calls, sources,
              complexity_level, confidence_score, created_at
       FROM agent_chat_messages WHERE session_id = $1 ORDER BY created_at ASC, id ASC`,
      [req.params.id]
    );
    res.json({ ...session.rows[0], messages: messages.rows });
  });

  router.put('/sessions/:id', requireAuth, async (req, res) => {
    const allowed = ['title', 'folder', 'subfolder', 'tags', 'is_archived', 'visibility'];
    const sets = [];
    const params = [];
    for (const key of allowed) {
      if (req.body[key] !== undefined) {
        params.push(req.body[key]);
        sets.push(`${key} = $${params.length}`);
      }
    }
    if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
    params.push(req.params.id, req.user.id);
    const result = await dbPool.query(
      `UPDATE agent_chat_sessions SET ${sets.join(', ')}, updated_at = NOW()
       WHERE id = $${params.length - 1} AND user_id = $${params.length} RETURNING *`,
      params
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Session not found' });
    res.json(result.rows[0]);
  });

  router.delete('/sessions/:id', requireAuth, async (req, res) => {
    await dbPool.query(`DELETE FROM agent_chat_sessions WHERE id = $1 AND user_id = $2`, [
      req.params.id,
      req.user.id,
    ]);
    res.json({ success: true });
  });

  // Auto-title from the first exchange (manual trigger; same logic runs
  // automatically inside the message stream)
  router.post('/sessions/:id/generate-title', requireAuth, async (req, res) => {
    try {
      const title = await maybeAutoTitle(parseInt(req.params.id, 10), req.user.id);
      res.json({ title: title || 'New chat' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ==========================================================================
  // Messaging — SSE streaming (protocol table in Part 5.10)
  // ==========================================================================
  router.post('/sessions/:id/message', requireAuth, async (req, res) => {
    const { imageAttachments, documentAttachments, regenerate } = req.body || {};
    let { message } = req.body || {};
    if (!message && !regenerate && !imageAttachments?.length && !documentAttachments?.length) {
      return res.status(400).json({ error: 'Message or attachments required' });
    }
    if (chatRateLimited(req.user.id)) {
      return res.status(429).json({ error: 'Rate limit: max 10 messages per minute', retryAfterSec: 30 });
    }

    const sessionCheck = await dbPool.query(
      `SELECT id, summary FROM agent_chat_sessions WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.user.id]
    );
    if (!sessionCheck.rows.length) return res.status(404).json({ error: 'Session not found' });

    // Regenerate / edit-and-resend: drop the last user message and everything
    // after it, then re-process (the turn re-inserts a fresh user message).
    if (regenerate) {
      const lastUser = await dbPool.query(
        `SELECT id, content FROM agent_chat_messages
         WHERE session_id = $1 AND role = 'user'
         ORDER BY created_at DESC, id DESC LIMIT 1`,
        [req.params.id]
      );
      if (!lastUser.rows.length) return res.status(400).json({ error: 'Nothing to regenerate' });
      if (!message) message = lastUser.rows[0].content;
      await dbPool.query(
        `DELETE FROM agent_chat_messages WHERE session_id = $1 AND id >= $2`,
        [req.params.id, lastUser.rows[0].id]
      );
    }

    // SSE headers
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders?.();

    const streamCallback = (event) => {
      try {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      } catch (_e) { /* client gone */ }
    };

    // Server-side stop: when the client disconnects (stop button / closed
    // tab), the orchestrator halts between turns instead of burning tokens.
    let clientGone = false;
    res.on('close', () => { clientGone = true; });

    // 15s heartbeat so proxies don't drop long runs (Part 14)
    const heartbeat = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch (_e) { /* ignore */ }
    }, 15000);

    try {
      // Conversation history for context (with retained structured results)
      const history = await dbPool.query(
        `SELECT role, content, structured_results FROM agent_chat_messages WHERE session_id = $1 ORDER BY created_at DESC, id DESC LIMIT 20`,
        [req.params.id]
      );

      const orchestrator = getOrchestrator();
      const result = await orchestrator.processQuery({
        userMessage: message || '',
        conversationHistory: history.rows.reverse(),
        conversationSummary: sessionCheck.rows[0].summary || null,
        sessionId: parseInt(req.params.id, 10),
        userId: req.user.id,
        user: req.user,
        streamCallback,
        isCancelled: () => clientGone,
        imageAttachments: imageAttachments || [],
        documentAttachments: documentAttachments || [],
      });

      if (result.success) {
        try {
          const title = await maybeAutoTitle(parseInt(req.params.id, 10), req.user.id);
          if (title) streamCallback({ type: 'session_title', data: { title } });
        } catch (_e) { /* titling is best-effort */ }
        streamCallback({ type: 'complete', data: result });
        // Refresh the rolling summary in the background (never blocks)
        maybeUpdateSummary(parseInt(req.params.id, 10)).catch(() => {});
      }
      // (error events are emitted inside processQuery)
    } catch (err) {
      streamCallback({
        type: 'error',
        data: { error: err.message, errorType: 'server', retryable: false },
      });
    } finally {
      clearInterval(heartbeat);
      res.end();
    }
  });

  // ==========================================================================
  // Uploads — images → base64 vision blocks; documents → extracted text
  // ==========================================================================
  router.post('/upload', requireAuth, upload.array('files', 8), async (req, res) => {
    try {
      const descriptors = [];
      for (const file of req.files || []) {
        if (isImage(file.mimetype)) {
          descriptors.push({
            kind: 'image',
            filename: file.originalname,
            media_type: file.mimetype,
            data: file.buffer.toString('base64'),
          });
        } else {
          // Isolated worker: a corrupt PDF can't block/OOM the API process
          const result = await extractTextIsolated(file.buffer, file.originalname, file.mimetype);
          if (result.error) {
            return res.status(422).json({
              success: false,
              error: `Could not read "${file.originalname}": ${result.error}`,
            });
          }
          descriptors.push({
            kind: 'document',
            filename: file.originalname,
            text: String(result.text || '').slice(0, 100000),
          });
        }
      }
      res.json({ success: true, files: descriptors });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ==========================================================================
  // Chat migration/import (Appendix B onboarding trick)
  // ==========================================================================
  router.get('/migration-prompt', requireAuth, (_req, res) => {
    res.json({
      prompt: `Please export everything important from our conversations as a well-organized Markdown document. Include:
1. Facts you've learned about me, my role, and my company (${clientConfig.CLIENT_NAME}, Inc.)
2. My preferences for how you respond (format, tone, level of detail)
3. Ongoing projects or topics we discuss and their current status
4. Standing instructions I've given you
5. Any domain knowledge, terminology, or context specific to my work

Organize with clear headings. Be thorough — this will onboard my new AI assistant.`,
      instructions:
        'Paste this prompt into your existing ChatGPT or Claude, copy the Markdown it returns, and import it below. Your new IPS assistant will start with everything your old one knew.',
    });
  });

  router.post('/import', requireAuth, async (req, res) => {
    try {
      const { content, title } = req.body || {};
      if (!content) return res.status(400).json({ error: 'content required' });
      const session = await dbPool.query(
        `INSERT INTO agent_chat_sessions (user_id, client_id, title, folder)
         VALUES ($1, $2, $3, 'Imported') RETURNING id`,
        [req.user.id, clientConfig.CLIENT_ID, title || 'Imported knowledge from previous AI']
      );
      const sessionId = session.rows[0].id;
      await dbPool.query(
        `INSERT INTO agent_chat_messages (session_id, role, content) VALUES ($1, 'user', $2)`,
        [sessionId, `[IMPORTED KNOWLEDGE — treat as standing context about this user]\n\n${String(content).slice(0, 200000)}`]
      );
      await dbPool.query(
        `INSERT INTO agent_chat_messages (session_id, role, content) VALUES ($1, 'assistant', $2)`,
        [sessionId, 'Got it — I\'ve absorbed this imported context and will remember it in future conversations.']
      );
      // Seed long-term memory from the import (async, best-effort)
      const orchestrator = getOrchestrator();
      orchestrator.memory
        .extract(req.user.id, String(content).slice(0, 12000), 'Imported prior-assistant knowledge')
        .catch(() => {});
      res.json({ success: true, sessionId });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ==========================================================================
  // Feedback (thumbs + training instruction)
  // ==========================================================================
  router.post('/messages/:id/feedback', requireAuth, async (req, res) => {
    const { rating, categories, feedback_text, training_instruction } = req.body || {};
    if (!['up', 'down'].includes(rating)) return res.status(400).json({ error: 'rating must be up|down' });
    const result = await dbPool.query(
      `INSERT INTO agent_feedback (message_id, user_id, rating, categories, feedback_text, training_instruction)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [req.params.id, req.user.id, rating, categories || [], feedback_text || null, training_instruction || null]
    );
    // A training instruction is an explicit preference — remember it for THIS
    // user immediately (personal memory; global guidance still needs approval).
    const instruction = training_instruction || (rating === 'down' ? feedback_text : null);
    if (instruction) {
      const orchestrator = getOrchestrator();
      orchestrator.memory
        .extract(req.user.id, `Feedback on your answer (${rating}): ${instruction}`, '(user feedback — treat as a standing preference)')
        .catch(() => {});
    }
    res.json({ success: true, feedbackId: result.rows[0].id });
  });

  router.post('/feedback/:id/approve', requireAdmin, async (req, res) => {
    await dbPool.query(
      `UPDATE agent_feedback SET approval_status = 'approved', approved_by = $1 WHERE id = $2`,
      [req.user.id, req.params.id]
    );
    // Bust the orchestrator's feedback-guidance cache so it applies now
    try { getOrchestrator()._feedbackCache = { at: 0, text: '' }; } catch (_e) { /* ignore */ }
    res.json({ success: true });
  });

  // Pending feedback queue (admin) — powers the approval workflow
  router.get('/feedback/pending', requireAdmin, async (_req, res) => {
    const result = await dbPool.query(
      `SELECT f.id, f.rating, f.categories, f.feedback_text, f.training_instruction,
              f.approval_status, f.created_at, u.email AS user_email,
              m.content AS message_content
       FROM agent_feedback f
       LEFT JOIN users u ON u.id = f.user_id
       LEFT JOIN agent_chat_messages m ON m.id = f.message_id
       WHERE f.approval_status = 'pending'
         AND COALESCE(NULLIF(f.training_instruction, ''), f.feedback_text) IS NOT NULL
       ORDER BY f.created_at DESC LIMIT 100`
    );
    res.json(result.rows.map((r) => ({ ...r, message_content: String(r.message_content || '').slice(0, 500) })));
  });

  // ==========================================================================
  // Observability + meta
  // ==========================================================================
  router.get('/admin/traces', requireAdmin, async (req, res) => {
    res.json(await getRecentTraces(dbPool, { limit: parseInt(req.query.limit || '50', 10) }));
  });

  router.get('/confidence', requireAuth, async (_req, res) => {
    res.json(await getDashboard(dbPool));
  });

  router.get('/tools', requireAuth, (_req, res) => {
    const orchestrator = getOrchestrator();
    res.json(
      orchestrator.toolRegistry.getAll().map((t) => ({
        name: t.name,
        category: t.category,
        description: String(t.description || '').split('\n')[0],
      }))
    );
  });

  router.get('/models', requireAuth, (_req, res) => {
    const orchestrator = getOrchestrator();
    res.json(orchestrator.modelRouter.getStatus());
  });

  return router;
};
