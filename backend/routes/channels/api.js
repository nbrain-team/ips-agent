/**
 * /api/channels — multi-channel entry points into the same brain.
 * - POST /api/channels/message: server-to-server API channel (API-key auth).
 * - Slack / email / SMS: ⚠️ TODO stubs — wire when IPS chooses channels
 *   (each just needs signature verification + a call into the orchestrator).
 */
const express = require('express');
const clientConfig = require('../../agentic/config/client-config');

module.exports = function channelsRoutes(dbPool, getOrchestrator) {
  const router = express.Router();

  function requireApiKey(req, res, next) {
    const key = req.headers['x-api-key'];
    if (!process.env.CHANNEL_API_KEY || key !== process.env.CHANNEL_API_KEY) {
      return res.status(401).json({ error: 'Invalid API key' });
    }
    next();
  }

  // Generic API channel — non-streaming
  router.post('/message', requireApiKey, async (req, res) => {
    try {
      const { message, external_user_id } = req.body || {};
      if (!message) return res.status(400).json({ error: 'message required' });

      // One rolling session per external user on the API channel
      const sessionResult = await dbPool.query(
        `INSERT INTO agent_chat_sessions (user_id, client_id, title, folder)
         VALUES (NULL, $1, $2, 'API Channel') RETURNING id`,
        [clientConfig.CLIENT_ID, `API: ${external_user_id || 'anonymous'}`]
      );
      const sessionId = sessionResult.rows[0].id;

      const orchestrator = getOrchestrator();
      const result = await orchestrator.processQuery({
        userMessage: message,
        conversationHistory: [],
        sessionId,
        userId: null,
        streamCallback: () => {},
      });
      res.json({ success: result.success, response: result.response, sessionId });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ⚠️ TODO: Slack events endpoint (verify Slack signature via req.rawBody,
  // then funnel event text into orchestrator.processQuery).
  router.post('/slack/events', (_req, res) => {
    res.status(501).json({ error: 'Slack channel not yet configured for IPS' });
  });

  // ⚠️ TODO: inbound email webhook (SendGrid/Mailgun parse → orchestrator).
  router.post('/email/inbound', (_req, res) => {
    res.status(501).json({ error: 'Email channel not yet configured for IPS' });
  });

  // ⚠️ TODO: SMS webhook (Twilio → orchestrator → TwiML reply).
  router.post('/sms/inbound', (_req, res) => {
    res.status(501).json({ error: 'SMS channel not yet configured for IPS' });
  });

  return router;
};
