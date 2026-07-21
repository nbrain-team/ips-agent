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
const { recordFailure } = require('../agentic/services/ingestFailures');

/**
 * Read.ai signs webhooks: HMAC-SHA256 over the RAW request body, delivered in
 * the X-Read-Signature header. Their docs don't pin down whether the signing
 * key is used as-is or base64-decoded, nor hex vs base64 digest encoding — so
 * we accept any (key-interpretation × digest-encoding) combination, compared
 * timing-safely. If READAI_SIGNING_KEY is set, a valid signature is REQUIRED.
 */
function verifyReadaiSignature(req) {
  const key = process.env.READAI_SIGNING_KEY;
  if (!key) return true; // signature enforcement off until the key is configured
  // ?sig= fallback exists for the browser-based backfill, where a custom
  // header would force a CORS preflight.
  const header = String(req.headers['x-read-signature'] || req.query.sig || '').trim();
  if (!header || !req.rawBody) return false;
  const provided = header.replace(/^sha256=/i, '');

  const keyBuffers = [Buffer.from(key, 'utf8')];
  if (/^[A-Za-z0-9+/]+=*$/.test(key)) keyBuffers.push(Buffer.from(key, 'base64'));

  for (const keyBuf of keyBuffers) {
    const digest = crypto.createHmac('sha256', keyBuf).update(req.rawBody).digest();
    for (const encoded of [digest.toString('hex'), digest.toString('base64')]) {
      const a = Buffer.from(provided);
      const b = Buffer.from(encoded);
      if (a.length === b.length && crypto.timingSafeEqual(a, b)) return true;
    }
  }
  return false;
}

module.exports = function webhooksRoutes(dbPool) {
  const router = express.Router();

  // Accept text/plain too (used by the browser-based backfill to avoid CORS
  // preflight) — the body is still JSON, still signature-verified.
  const textParser = express.text({ type: 'text/plain', limit: '50mb' });

  router.post('/readai/:secret', textParser, (req, res) => {
    if (typeof req.body === 'string') {
      req.rawBody = Buffer.from(req.body, 'utf8');
      try {
        req.body = JSON.parse(req.body);
      } catch (_e) {
        return res.status(400).json({ error: 'Invalid JSON' });
      }
    }
    const expected = process.env.READAI_WEBHOOK_SECRET;
    if (!expected) return res.status(503).json({ error: 'Webhook not configured' });
    const given = String(req.params.secret || '');
    const ok =
      given.length === expected.length &&
      crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
    if (!ok) return res.status(401).json({ error: 'Invalid webhook secret' });
    if (!verifyReadaiSignature(req)) {
      console.warn('🎙️ Read.ai webhook rejected: bad or missing X-Read-Signature');
      return res.status(401).json({ error: 'Invalid signature' });
    }

    const payload = req.body || {};
    // ACK fast; embed/ingest in the background
    res.json({ received: true });

    // Read.ai fires several triggers; only meeting_end carries the transcript.
    const trigger = payload.trigger || 'meeting_end';
    if (trigger && trigger !== 'meeting_end') {
      console.log(`🎙️ Read.ai webhook ignored (trigger: ${trigger})`);
      return;
    }

    ingestMeeting(dbPool, payload).catch((err) => {
      console.error('Read.ai ingest failed:', err.message);
      recordFailure(dbPool, {
        source: 'readai',
        reference: payload?.session_title || payload?.title || payload?.session_id || 'unknown meeting',
        error: err.message,
      });
    });
  });

  return router;
};
