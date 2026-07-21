/**
 * /api/admin/ops — admin operations dashboard.
 *
 * - GET  /health          sync health for every ingest pipeline
 * - GET  /usage           token / message / latency analytics (30 days)
 * - GET  /failures        open ingest failures (the "failure inbox")
 * - POST /failures/:id/resolve
 * - POST /crawl           trigger a website re-crawl now
 * - POST /vectorize       trigger table re-profiling now
 */
const express = require('express');
const path = require('path');
const { spawn } = require('child_process');
const TableMetadataVectorization = require('../agentic/services/TableMetadataVectorization');
const msGraph = require('../agentic/services/msGraph');

// Rough blended $/1M tokens per model family — for directional cost tracking,
// not billing. Unknown models fall back to DEFAULT_RATE.
const MODEL_RATES = [
  { match: /opus/i, rate: 30 },
  { match: /sonnet/i, rate: 9 },
  { match: /haiku/i, rate: 2.4 },
  { match: /gpt-5/i, rate: 7.5 },
  { match: /gpt-4/i, rate: 6 },
  { match: /gemini/i, rate: 4 },
];
const DEFAULT_RATE = 8;

function estimateCost(model, tokens) {
  const hit = MODEL_RATES.find((r) => r.match.test(model || ''));
  return ((hit ? hit.rate : DEFAULT_RATE) * (tokens || 0)) / 1_000_000;
}

// In-process job state so the UI can show "running..." and we never spawn
// two crawls at once.
const jobState = {
  crawl: { running: false, started_at: null, last_finished_at: null, last_exit: null },
  vectorize: { running: false, started_at: null, last_finished_at: null, last_result: null, last_error: null },
};

module.exports = function adminOpsRoutes(dbPool, billingDbPool) {
  const router = express.Router();
  const requireAdmin = require('../middleware/requireAdmin')(dbPool);
  router.use(requireAdmin);

  // ---- Sync health -------------------------------------------------------
  router.get('/health', async (_req, res) => {
    try {
      const [mailboxes, emails, meetings, vectors, website, kb, failures] = await Promise.all([
        dbPool.query(
          `SELECT COUNT(*)::int AS total,
                  COUNT(*) FILTER (WHERE sync_status = 'ok')::int AS ok,
                  COUNT(*) FILTER (WHERE sync_status = 'error')::int AS error,
                  MAX(last_synced_at) AS last_synced_at
           FROM ms_mailboxes`
        ).catch(() => ({ rows: [{}] })),
        dbPool.query(
          `SELECT COUNT(*)::int AS total, MAX(received_at) AS latest,
                  (SELECT COUNT(*)::int FROM ms_email_attachments WHERE text_content IS NOT NULL) AS attachments
           FROM ms_emails`
        ).catch(() => ({ rows: [{}] })),
        dbPool.query(
          `SELECT COUNT(*)::int AS total, MAX(meeting_start) AS latest_meeting,
                  MAX(created_at) AS last_ingested
           FROM meeting_transcripts`
        ).catch(() => ({ rows: [{}] })),
        dbPool.query(
          `SELECT source_tag, COUNT(*)::int AS tables, MAX(updated_at) AS last_profiled
           FROM agent_metadata.table_vectors GROUP BY source_tag ORDER BY source_tag`
        ).catch(() => ({ rows: [] })),
        dbPool.query(
          `SELECT COUNT(*)::int AS pages, MAX(created_at) AS last_crawled
           FROM website_content WHERE source = 'website'`
        ).catch(() => ({ rows: [{}] })),
        dbPool.query(
          `SELECT COUNT(*)::int AS chunks FROM website_content`
        ).catch(() => ({ rows: [{}] })),
        dbPool.query(
          `SELECT COUNT(*)::int AS open FROM ingest_failures WHERE resolved = FALSE`
        ).catch(() => ({ rows: [{ open: 0 }] })),
      ]);

      res.json({
        email: {
          configured: msGraph.isConfigured(),
          mailboxes: mailboxes.rows[0],
          messages: emails.rows[0],
        },
        meetings: meetings.rows[0],
        table_vectors: vectors.rows,
        website: website.rows[0],
        knowledge_chunks: kb.rows[0]?.chunks ?? 0,
        billing_db: billingDbPool ? 'connected' : 'not configured',
        open_failures: failures.rows[0]?.open ?? 0,
        jobs: jobState,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---- Usage & cost analytics --------------------------------------------
  router.get('/usage', async (req, res) => {
    const days = Math.min(parseInt(req.query.days || '30', 10) || 30, 90);
    try {
      const [daily, byUser, byModel, traces] = await Promise.all([
        dbPool.query(
          `SELECT DATE(created_at) AS day,
                  COUNT(*) FILTER (WHERE role = 'user')::int AS messages,
                  COALESCE(SUM(tokens_used), 0)::bigint AS tokens
           FROM agent_chat_messages
           WHERE created_at > NOW() - ($1 || ' days')::interval
           GROUP BY 1 ORDER BY 1`,
          [days]
        ),
        dbPool.query(
          `SELECT u.email, COUNT(*) FILTER (WHERE m.role = 'user')::int AS messages,
                  COALESCE(SUM(m.tokens_used), 0)::bigint AS tokens
           FROM agent_chat_messages m
           JOIN agent_chat_sessions s ON s.id = m.session_id
           JOIN users u ON u.id = s.user_id
           WHERE m.created_at > NOW() - ($1 || ' days')::interval
           GROUP BY u.email ORDER BY tokens DESC LIMIT 20`,
          [days]
        ),
        dbPool.query(
          `SELECT COALESCE(model_used, 'unknown') AS model, COUNT(*)::int AS responses,
                  COALESCE(SUM(tokens_used), 0)::bigint AS tokens
           FROM agent_chat_messages
           WHERE role = 'assistant' AND created_at > NOW() - ($1 || ' days')::interval
           GROUP BY 1 ORDER BY tokens DESC`,
          [days]
        ),
        dbPool.query(
          `SELECT mode, COUNT(*)::int AS runs,
                  ROUND(AVG(latency_ms))::int AS avg_latency_ms,
                  ROUND(AVG(confidence_score)::numeric, 2) AS avg_confidence
           FROM agent_traces
           WHERE created_at > NOW() - ($1 || ' days')::interval
           GROUP BY mode ORDER BY runs DESC`,
          [days]
        ).catch(() => ({ rows: [] })),
      ]);

      const models = byModel.rows.map((r) => ({
        ...r,
        tokens: Number(r.tokens),
        est_cost_usd: Math.round(estimateCost(r.model, Number(r.tokens)) * 100) / 100,
      }));
      const totalTokens = models.reduce((s, r) => s + r.tokens, 0);
      const totalCost = Math.round(models.reduce((s, r) => s + r.est_cost_usd, 0) * 100) / 100;

      res.json({
        days,
        totals: {
          tokens: totalTokens,
          est_cost_usd: totalCost,
          messages: daily.rows.reduce((s, r) => s + r.messages, 0),
        },
        daily: daily.rows.map((r) => ({ ...r, tokens: Number(r.tokens) })),
        by_user: byUser.rows.map((r) => ({ ...r, tokens: Number(r.tokens) })),
        by_model: models,
        by_mode: traces.rows,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---- Ingest-failure inbox ----------------------------------------------
  router.get('/failures', async (req, res) => {
    try {
      const showResolved = req.query.all === '1';
      const result = await dbPool.query(
        `SELECT id, source, reference, error, resolved, created_at
         FROM ingest_failures
         ${showResolved ? '' : 'WHERE resolved = FALSE'}
         ORDER BY created_at DESC LIMIT 200`
      );
      res.json(result.rows);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/failures/:id/resolve', async (req, res) => {
    try {
      await dbPool.query(
        `UPDATE ingest_failures SET resolved = TRUE, resolved_at = NOW() WHERE id = $1`,
        [req.params.id]
      );
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---- Manual job triggers -----------------------------------------------
  router.post('/crawl', (_req, res) => {
    if (jobState.crawl.running) {
      return res.status(409).json({ error: 'A crawl is already running' });
    }
    jobState.crawl.running = true;
    jobState.crawl.started_at = new Date().toISOString();
    const proc = spawn(process.execPath, [path.join(__dirname, '..', 'scripts', 'crawl-website.js')], {
      env: process.env,
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    proc.on('close', (code) => {
      jobState.crawl.running = false;
      jobState.crawl.last_finished_at = new Date().toISOString();
      jobState.crawl.last_exit = code;
      if (code !== 0) {
        require('../agentic/services/ingestFailures').recordFailure(dbPool, {
          source: 'website_crawl',
          reference: 'manual crawl (admin UI)',
          error: `crawl-website.js exited with code ${code}`,
        });
      }
    });
    proc.on('error', (err) => {
      jobState.crawl.running = false;
      jobState.crawl.last_exit = -1;
      console.warn('Manual crawl failed to start:', err.message);
    });
    res.json({ success: true, started: true });
  });

  router.post('/vectorize', (_req, res) => {
    if (jobState.vectorize.running) {
      return res.status(409).json({ error: 'Vectorization is already running' });
    }
    jobState.vectorize.running = true;
    jobState.vectorize.started_at = new Date().toISOString();
    res.json({ success: true, started: true });

    (async () => {
      try {
        const vec = new TableMetadataVectorization(dbPool);
        const result = await vec.vectorizeAllTables();
        if (billingDbPool) {
          const bvec = new TableMetadataVectorization(billingDbPool, {
            sourceTag: 'billing',
            metadataPool: dbPool,
          });
          result.billing = await bvec.vectorizeAllTables();
        }
        jobState.vectorize.last_result = result;
        jobState.vectorize.last_error = null;
      } catch (err) {
        jobState.vectorize.last_error = err.message;
        require('../agentic/services/ingestFailures').recordFailure(dbPool, {
          source: 'vectorize',
          reference: 'manual vectorize (admin UI)',
          error: err.message,
        });
      } finally {
        jobState.vectorize.running = false;
        jobState.vectorize.last_finished_at = new Date().toISOString();
      }
    })();
  });

  return router;
};
