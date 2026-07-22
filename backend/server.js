/**
 * IPS AI Platform — backend entry point.
 * Express app: middleware, agentic brain init, routes, sockets, startup.
 */

// MUST run before any network I/O — Node 18+ prefers IPv6 and flaky IPv6
// egress manifests as ERR_STREAM_PREMATURE_CLOSE on LLM API calls.
require('dns').setDefaultResultOrder('ipv4first');
require('dotenv').config();

const express = require('express');
const http = require('http');
const helmet = require('helmet');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const { Pool } = require('pg');

const clientConfig = require('./agentic/config/client-config');
const ToolRegistry = require('./agentic/services/toolRegistry');
const AgenticOrchestrator = require('./agentic/services/orchestrator');
const websocketService = require('./agentic/services/websocket');
const TableMetadataVectorization = require('./agentic/services/TableMetadataVectorization');
const { runBootstrap } = require('./bootstrap/autoMigrate');
const { ensureAdmin } = require('./bootstrap/ensureAdmin');

const app = express();
const server = http.createServer(app);

// URL normalization shim: some proxies emit /socket.io?... which breaks the
// WS handshake — rewrite to /socket.io/?...
app.use((req, res, next) => {
  if (req.url.startsWith('/socket.io?')) {
    req.url = req.url.replace('/socket.io?', '/socket.io/?');
  }
  next();
});

// ---------------------------------------------------------------------------
// Database pools
// ---------------------------------------------------------------------------
const dbPool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

// Secondary read-only pool: existing IPS Billing platform (Part 11.1, Option B)
// default_transaction_read_only=on makes read-only DB-enforced for every
// connection in this pool, independent of the connection string's role.
let billingDbPool = null;
if (process.env.IPS_BILLING_DATABASE_URL) {
  billingDbPool = new Pool({
    connectionString: process.env.IPS_BILLING_DATABASE_URL,
    max: 10,
    ssl: process.env.IPS_BILLING_DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false,
    options: '-c default_transaction_read_only=on',
  });
  console.log('💰 Billing DB pool configured (read-only enforced)');
}

app.locals.dbPool = dbPool;
app.locals.billingDbPool = billingDbPool;

// ---------------------------------------------------------------------------
// Global middleware
// ---------------------------------------------------------------------------
app.set('trust proxy', 1);
// API-only backend: a strict CSP is safe (no HTML pages served from here) and
// protects any response a browser might render directly (errors, JSON views).
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'none'"],
        connectSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        frameAncestors: ["'none'"],
        baseUri: ["'none'"],
        formAction: ["'none'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  })
);

const allowedOrigins = [
  process.env.FRONTEND_URL,
  'http://localhost:3000',
  'http://127.0.0.1:3000',
].filter(Boolean);
app.use(
  cors({
    origin(origin, cb) {
      // Allow same-origin/no-origin (proxied) requests and known frontends
      if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
      return cb(null, false);
    },
    credentials: true,
  })
);
app.use(cookieParser());
app.use(
  express.json({
    limit: '50mb',
    verify: (req, _res, buf) => {
      req.rawBody = buf; // kept for webhook signature verification (Slack etc.)
    },
  })
);
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

app.use((req, _res, next) => {
  if (!req.url.startsWith('/health')) {
    console.log(`${req.method} ${req.url}`);
  }
  next();
});

// Global API rate limit (per IP). Generous ceiling — per-user chat limits are
// stricter and live in the chat routes; this stops brute force / scraping.
const rateLimit = require('express-rate-limit');
app.use(
  '/api/',
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: parseInt(process.env.GLOBAL_RATE_LIMIT_MAX || '600', 10),
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => req.path.startsWith('/webhooks'),
  })
);

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------
let orchestrator = null;
let toolRegistry = null;

async function start() {
  // 1. Boot-time idempotent migrations + admin bootstrap
  try {
    await runBootstrap(dbPool);
    await ensureAdmin(dbPool);
  } catch (err) {
    console.error('❌ Bootstrap failed (continuing — health check will show DB state):', err.message);
  }

  // 2. Agentic brain
  clientConfig.validate();
  toolRegistry = new ToolRegistry();
  toolRegistry.loadToolsFromDirectory(require('path').join(__dirname, 'agentic', 'tools'));
  orchestrator = new AgenticOrchestrator(dbPool, toolRegistry, { billingDbPool });
  app.locals.orchestrator = orchestrator;
  app.locals.toolRegistry = toolRegistry;

  // 3. Realtime
  const { Server } = require('socket.io');
  const io = new Server(server, {
    path: '/socket.io/',
    cors: { origin: allowedOrigins, credentials: true },
  });
  websocketService.initialize(io, dbPool);
  app.locals.io = io;

  // 4. Routes
  app.use('/api/auth', require('./routes/auth')(dbPool));
  app.use('/api/auth', require('./routes/auth-microsoft')(dbPool));
  app.use('/api/admin/users', require('./routes/admin-users')(dbPool));
  app.use('/api/agent-chat', require('./agentic/routes/index')(dbPool, () => orchestrator));
  app.use('/api/data-inventory', require('./routes/data-inventory')(dbPool, billingDbPool));
  app.use('/api/exports', require('./routes/exports')(dbPool));
  app.use('/api/output-templates', require('./routes/output-templates')(dbPool));
  app.use('/api/channels', require('./routes/channels/api')(dbPool, () => orchestrator));
  app.use('/api/webhooks', require('./routes/webhooks')(dbPool));
  app.use('/api/admin/ops', require('./routes/admin-ops')(dbPool, billingDbPool));

  // Health check — run a real SELECT 1 so DB status is accurate
  app.get('/health', async (_req, res) => {
    let db = 'down';
    try {
      await dbPool.query('SELECT 1');
      db = 'up';
    } catch (_e) {
      /* db stays down */
    }
    const ok = db === 'up';
    res.status(ok ? 200 : 503).json({
      status: ok ? 'healthy' : 'degraded',
      client: clientConfig.CLIENT_NAME,
      database: db,
      billing_database: billingDbPool ? 'configured' : 'not configured',
      uptime_s: Math.round(process.uptime()),
    });
  });

  // Admin DB endpoints
  const requireAdmin = require('./middleware/requireAdmin')(dbPool);
  app.post('/api/admin/vectorize', requireAdmin, async (_req, res) => {
    try {
      const vec = new TableMetadataVectorization(dbPool);
      const result = await vec.vectorizeAllTables();
      if (billingDbPool) {
        const bvec = new TableMetadataVectorization(billingDbPool, { sourceTag: 'billing', metadataPool: dbPool });
        result.billing = await bvec.vectorizeAllTables();
      }
      res.json({ success: true, result });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });
  // Manual email sync trigger + status
  const msGraph = require('./agentic/services/msGraph');
  app.post('/api/admin/sync-emails', requireAdmin, async (_req, res) => {
    try {
      const summary = await msGraph.syncAllMailboxes(dbPool);
      res.json({ success: true, summary });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });
  app.get('/api/admin/email-sync-status', requireAdmin, async (_req, res) => {
    try {
      const mailboxes = await dbPool.query(
        `SELECT email, display_name, sync_status, sync_error, last_synced_at, message_count
         FROM ms_mailboxes ORDER BY email`
      );
      const totals = await dbPool.query(
        `SELECT COUNT(*)::int AS messages, MAX(received_at) AS latest FROM ms_emails`
      );
      res.json({ configured: msGraph.isConfigured(), mailboxes: mailboxes.rows, ...totals.rows[0] });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/admin/database-info', requireAdmin, async (_req, res) => {
    try {
      const tables = await dbPool.query(`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`);
      const vectors = await dbPool
        .query(`SELECT source_tag, COUNT(*)::int AS n FROM agent_metadata.table_vectors GROUP BY source_tag`)
        .catch(() => ({ rows: [] }));
      res.json({ tables: tables.rows.map((r) => r.table_name), table_vectors: vectors.rows });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // 5. Listen
  const port = process.env.PORT || 8080;
  server.listen(port, () => {
    console.log(`🚀 ${clientConfig.CLIENT_NAME} AI Platform backend on :${port}`);
  });

  // 6. Scheduled Microsoft 365 email sync (all tenant users, last 30 days)
  const msGraphSvc = require('./agentic/services/msGraph');
  if (msGraphSvc.isConfigured()) {
    const intervalMin = parseInt(process.env.EMAIL_SYNC_INTERVAL_MIN || '60', 10);
    const { recordFailure } = require('./agentic/services/ingestFailures');
    const runSync = () =>
      msGraphSvc.syncAllMailboxes(dbPool).catch((err) => {
        console.warn('Email sync failed:', err.message);
        recordFailure(dbPool, { source: 'email_sync', reference: 'tenant sync run', error: err.message });
      });
    setTimeout(runSync, 15000); // first sync shortly after boot
    setInterval(runSync, intervalMin * 60000);
    console.log(`📧 M365 email sync scheduled every ${intervalMin} min`);
  } else {
    console.log('📧 M365 email sync disabled (MS_GRAPH_* env vars not set)');
  }

  // 7. Background table-metadata vectorization (best-effort, non-blocking)
  setTimeout(async () => {
    try {
      const vec = new TableMetadataVectorization(dbPool);
      const stale = await vec.needsVectorization();
      if (stale) {
        console.log('🧠 Vectorizing table metadata in background...');
        await vec.vectorizeAllTables();
      }
    } catch (err) {
      console.warn('Table vectorization skipped:', err.message);
    }
  }, 5000);

  // 8. Scheduled data-freshness jobs
  //    - table re-profiling (schema drift, row counts, date ranges): daily
  //    - website re-crawl (site content changes): weekly
  const reprofileHours = parseInt(process.env.TABLE_REPROFILE_INTERVAL_H || '24', 10);
  if (reprofileHours > 0) {
    setInterval(async () => {
      try {
        console.log('🧠 Scheduled table re-profiling...');
        const vec = new TableMetadataVectorization(dbPool);
        await vec.vectorizeAllTables();
        if (billingDbPool) {
          const bvec = new TableMetadataVectorization(billingDbPool, { sourceTag: 'billing', metadataPool: dbPool });
          await bvec.vectorizeAllTables();
        }
        console.log('🧠 Scheduled table re-profiling done');
      } catch (err) {
        console.warn('Scheduled re-profiling failed:', err.message);
        require('./agentic/services/ingestFailures').recordFailure(dbPool, {
          source: 'vectorize',
          reference: 'scheduled re-profiling',
          error: err.message,
        });
      }
    }, reprofileHours * 3600000);
    console.log(`🧠 Table re-profiling scheduled every ${reprofileHours}h`);
  }

  const crawlDays = parseInt(process.env.WEBSITE_RECRAWL_INTERVAL_DAYS || '7', 10);
  if (crawlDays > 0) {
    const { spawn } = require('child_process');
    const runCrawl = () => {
      console.log('🌐 Scheduled website re-crawl starting...');
      const proc = spawn(process.execPath, [require('path').join(__dirname, 'scripts', 'crawl-website.js')], {
        env: process.env,
        stdio: ['ignore', 'inherit', 'inherit'],
      });
      proc.on('close', (code) => {
        console.log(`🌐 Website re-crawl finished (exit ${code})`);
        if (code !== 0) {
          require('./agentic/services/ingestFailures').recordFailure(dbPool, {
            source: 'website_crawl',
            reference: 'scheduled re-crawl',
            error: `crawl-website.js exited with code ${code}`,
          });
        }
      });
      proc.on('error', (err) => console.warn('Website re-crawl failed to start:', err.message));
    };
    setInterval(runCrawl, crawlDays * 86400000);
    console.log(`🌐 Website re-crawl scheduled every ${crawlDays}d`);
  }
}

// Safety net: background jobs (email sync, attachment extraction, crawls)
// must never take the API down. Log loudly, record to the failure inbox,
// keep serving. (Fatal startup errors still exit via start().catch below.)
process.on('unhandledRejection', (err) => {
  console.error('⚠️ Unhandled rejection (service kept alive):', err?.stack || err);
  require('./agentic/services/ingestFailures')
    .recordFailure(dbPool, { source: 'other', reference: 'unhandledRejection', error: String(err?.message || err) })
    .catch(() => {});
});
process.on('uncaughtException', (err) => {
  console.error('⚠️ Uncaught exception (service kept alive):', err?.stack || err);
  require('./agentic/services/ingestFailures')
    .recordFailure(dbPool, { source: 'other', reference: 'uncaughtException', error: String(err?.message || err) })
    .catch(() => {});
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received — shutting down');
  server.close(() => process.exit(0));
  try {
    await dbPool.end();
    if (billingDbPool) await billingDbPool.end();
  } catch (_e) { /* ignore */ }
  setTimeout(() => process.exit(0), 5000);
});

start().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
