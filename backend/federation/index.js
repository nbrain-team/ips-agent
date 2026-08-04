/**
 * Agent Federation — nbrain-federation/1
 *
 * Lets the Ingram Businesses master agent discover and execute this agent's
 * tools remotely, so a tool added here shows up there without a code change on
 * either side.
 *
 * Three routes, mounted at /api/federation:
 *   GET  /manifest  — tool schemas + prompt fragment + data-source inventory
 *   POST /tool      — execute one tool, return its raw structured result
 *   GET  /health    — cheap liveness probe
 *
 * This module deliberately does NOT invoke the LLM. The master owns the
 * reasoning loop; we are a tool host. See docs/federation-protocol.md in the
 * ingram-main repo for the full contract.
 */

const crypto = require('crypto');
const express = require('express');

const PROTOCOL = 'nbrain-federation/1';
const BOOTED_AT = Date.now();

// ---------------------------------------------------------------------------
// kind / modality inference
//
// Most tools here predate the protocol and declare neither field. The master's
// work rail colours every row by `kind` and badges it by `modality`, so an
// absent value produces a row that tells the operator nothing. Infer rather
// than omit; an explicit declaration on the tool always wins.
// ---------------------------------------------------------------------------
const WRITE_RE = /(^|_)(create|send|draft|update|delete|post|generate|save|upsert)(_|$)/i;
const REASON_RE = /(^|_)(analyze|analyse|research|python|execute|deep)(_|$)/i;

const MODALITY_RULES = [
  [/email|mail|gmail|inbox/i, 'email'],
  [/pdf/i, 'pdf'],
  [/image|vision|ocr|photo/i, 'image'],
  [/audio|voice|transcri(be|ption)/i, 'audio'],
  [/database|query|sql|metrics|sales|financ|quickbooks|invoice|billing|calendar|table/i, 'table'],
];

function inferKind(tool) {
  if (tool.kind) return tool.kind;
  if (WRITE_RE.test(tool.name)) return 'write';
  if (REASON_RE.test(tool.name)) return 'reason';
  return 'read';
}

function inferModality(tool) {
  if (tool.modality) return tool.modality;
  for (const [re, modality] of MODALITY_RULES) {
    if (re.test(tool.name)) return modality;
  }
  return 'text';
}

/**
 * Constant-time key comparison.
 *
 * `===` on a secret leaks it a byte at a time to anyone patient enough to
 * measure response times. timingSafeEqual needs equal-length buffers, so hash
 * both sides first — that also stops the length itself from leaking.
 */
function keyMatches(provided, expected) {
  if (!provided || !expected) return false;
  const a = crypto.createHash('sha256').update(String(provided)).digest();
  const b = crypto.createHash('sha256').update(String(expected)).digest();
  return crypto.timingSafeEqual(a, b);
}

/**
 * @param {object}   options
 * @param {string}   options.agentId      Stable slug. Must match the master's company id.
 * @param {string}   options.label        Human name shown in the master's sidebar.
 * @param {string}   options.description  One line of what this business does.
 * @param {function} options.listTools    () => Array<tool>. Called per request so
 *                                        tools registered after boot are included.
 * @param {function} options.executeTool  (name, input, ctx) => Promise<result>
 * @param {function} options.promptFragment () => string
 * @param {function} options.dataSources  () => Promise<Array<source>>
 */
function createFederationRouter(options) {
  const {
    agentId,
    label,
    description = '',
    listTools,
    executeTool,
    promptFragment = () => '',
    dataSources = async () => [],
  } = options;

  const router = express.Router();

  // Gate every route. An unset FEDERATION_KEY disables federation entirely
  // rather than defaulting to open, so this code can deploy ahead of the
  // config without exposing anything.
  router.use((req, res, next) => {
    const expected = process.env.FEDERATION_KEY;
    if (!expected) {
      return res.status(503).json({
        error: 'Federation is not enabled on this service (FEDERATION_KEY unset).',
      });
    }
    if (!keyMatches(req.get('X-Federation-Key'), expected)) {
      return res.status(401).json({ error: 'Invalid federation key.' });
    }
    next();
  });

  router.get('/health', (_req, res) => {
    let toolCount = 0;
    try {
      toolCount = listTools().length;
    } catch (_e) {
      /* report zero rather than 500 — this route must stay cheap and reliable */
    }
    res.json({
      ok: true,
      agent: agentId,
      protocol: PROTOCOL,
      tools: toolCount,
      uptimeSec: Math.round((Date.now() - BOOTED_AT) / 1000),
    });
  });

  router.get('/manifest', async (_req, res) => {
    try {
      const tools = listTools()
        // Approval-gated tools are not proxied. Approving a write in the master
        // that fires in a sub-agent needs a two-phase commit the protocol does
        // not attempt in v1, so they are withheld rather than exposed.
        .filter((t) => !t.requiresApproval)
        .map((t) => ({
          name: t.name,
          description: t.description || t.name,
          input_schema: t.parameters || t.input_schema || { type: 'object', properties: {} },
          kind: inferKind(t),
          modality: inferModality(t),
          category: t.category || 'general',
          requiresApproval: false,
        }));

      res.json({
        protocol: PROTOCOL,
        agent: { id: agentId, label, description, generatedAt: new Date().toISOString() },
        promptFragment: promptFragment(),
        tools,
        dataSources: await dataSources(),
      });
    } catch (err) {
      console.error('[federation] manifest failed:', err);
      res.status(500).json({ error: `Manifest generation failed: ${err.message}` });
    }
  });

  router.post('/tool', async (req, res) => {
    const { name, input = {}, context = {} } = req.body || {};
    if (!name) return res.status(400).json({ error: 'Missing tool name.' });

    const tool = listTools().find((t) => t.name === name);
    if (!tool) return res.status(404).json({ error: `Unknown tool: ${name}` });
    if (tool.requiresApproval) {
      return res.status(403).json({ error: `Tool ${name} requires approval and is not federated.` });
    }

    const startedAt = Date.now();
    try {
      const result = await executeTool(name, input, context);
      const durationMs = Date.now() - startedAt;

      // Tools in this codebase return { success, data, summary, error }. A tool
      // that ran and failed is a 200 with ok:false — the master feeds that back
      // to the model as something to reason about, whereas a non-2xx is a
      // protocol fault it should retry.
      const ok = result?.success !== false;
      res.json({
        ok,
        durationMs,
        summary: result?.summary || (ok ? `${name} completed` : result?.error) || '',
        error: ok ? undefined : result?.error || 'Tool reported failure',
        result,
      });
    } catch (err) {
      console.error(`[federation] tool ${name} threw:`, err);
      res.json({
        ok: false,
        durationMs: Date.now() - startedAt,
        summary: `${name} failed`,
        error: err.message,
        result: null,
      });
    }
  });

  return router;
}

module.exports = { createFederationRouter, PROTOCOL, inferKind, inferModality };
