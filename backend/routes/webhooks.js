/**
 * /api/webhooks — inbound webhooks from external systems.
 *
 * Read.ai: POST /api/webhooks/readai/:secret
 * Read.ai doesn't sign payloads, so auth is a secret path segment
 * (READAI_WEBHOOK_SECRET). We ACK immediately and ingest asynchronously so
 * Read.ai never times out on long transcripts.
 */
const express = require('express');
const crypto = require('crypto');
const { ingestMeeting } = require('../agentic/services/readaiIngest');

module.exports = function webhooksRoutes(dbPool) {
  const router = express.Router();

  router.post('/readai/:secret', (req, res) => {
    const expected = process.env.READAI_WEBHOOK_SECRET;
    if (!expected) return res.status(503).json({ error: 'Webhook not configured' });
    const given = String(req.params.secret || '');
    const ok =
      given.length === expected.length &&
      crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
    if (!ok) return res.status(401).json({ error: 'Invalid webhook secret' });

    const payload = req.body || {};
    // ACK fast; embed/ingest in the background
    res.json({ received: true });

    // Read.ai fires several triggers; only meeting_end carries the transcript.
    const trigger = payload.trigger || 'meeting_end';
    if (trigger && trigger !== 'meeting_end') {
      console.log(`🎙️ Read.ai webhook ignored (trigger: ${trigger})`);
      return;
    }

    ingestMeeting(dbPool, payload).catch((err) =>
      console.error('Read.ai ingest failed:', err.message)
    );
  });

  return router;
};
