/**
 * apiMonitor — hourly health check of the AI provider accounts the agent
 * depends on, with email alerts to the people who can fix them.
 *
 * Checks:
 *  - anthropic_key     the chat key answers a 1-token call on the fast model,
 *                      which catches revoked keys, an empty credit balance and
 *                      a reached spend limit (the call costs a fraction of a cent)
 *  - openai_key        the embeddings / transcription key answers a one-word embedding
 *  - anthropic_admin   (ANTHROPIC_ADMIN_API_KEY) the chat key's status in the
 *                      organization's key list, so a revoke shows by name
 *  - anthropic_budget  (ANTHROPIC_ADMIN_API_KEY) month-to-date spend from the
 *                      cost report vs ANTHROPIC_MONTHLY_BUDGET_USD
 *
 * Alerts go out when a check turns bad, again every API_MONITOR_REMINDER_H
 * (default 24) while it stays bad, and once when it recovers. Budget alerts
 * fire once per threshold per month. Transient states (rate limited, provider
 * outage) are recorded but never alerted.
 *
 * Delivery: Microsoft Graph sendMail from API_MONITOR_FROM_MAILBOX (needs the
 * Mail.Send application permission) to API_MONITOR_ALERT_EMAILS, falling back
 * to users with role 'admin'. Every problem is also written to the
 * ingest-failure inbox so it shows on /admin/ops even if email is not set up.
 *
 * Anthropic does not expose the prepaid credit balance of a Console
 * organization through any API; the anthropic_key check is what catches a
 * balance that has run out.
 */

const { MODEL_REGISTRY } = require('./modelRouter');
const msGraph = require('./msGraph');
const { recordFailure } = require('./ingestFailures');

const ANTHROPIC = 'https://api.anthropic.com';
const ANTHROPIC_VERSION = '2023-06-01';
const TIMEOUT_MS = 20000;
const REMINDER_MS = parseFloat(process.env.API_MONITOR_REMINDER_H || '24') * 3600000;
const CHAT_TRIGGER_DEBOUNCE_MS = 10 * 60000;

const BAD = new Set(['invalid', 'no_credit', 'forbidden', 'missing', 'key_not_found', 'key_inactive', 'over_threshold']);

const LABELS = {
  anthropic_key: 'Anthropic (Claude) API key',
  openai_key: 'OpenAI API key',
  anthropic_admin: 'Anthropic key status',
  anthropic_budget: 'Anthropic monthly budget',
};

const IMPACT = {
  anthropic_key: 'The IPS AI chat cannot answer anyone until this is fixed.',
  openai_key: 'Document and email search (embeddings) and Zoom meeting transcription are failing.',
  anthropic_admin: 'The chat key is no longer usable, so the IPS AI chat is down.',
  anthropic_budget: 'Spend is running high for the month.',
};

const FIX = {
  anthropic_key: {
    invalid: 'Create a new key at console.anthropic.com → API Keys and set it as ANTHROPIC_API_KEY on the ips-agent-api Render service.',
    no_credit: 'Add credit or raise the spend limit at console.anthropic.com → Billing. Turning on auto-reload prevents this.',
    forbidden: 'The key is not allowed to use this model. Check the key\'s workspace permissions at console.anthropic.com.',
    missing: 'Set ANTHROPIC_API_KEY on the ips-agent-api Render service.',
  },
  openai_key: {
    invalid: 'Create a new key at platform.openai.com/api-keys and set it as OPENAI_API_KEY on the ips-agent-api Render service.',
    no_credit: 'Add credit or raise the usage limit at platform.openai.com → Billing.',
    forbidden: 'The key\'s project does not allow embeddings. Check the project permissions at platform.openai.com.',
    missing: 'Set OPENAI_API_KEY on the ips-agent-api Render service.',
  },
  anthropic_admin: {
    invalid: 'Create a new Admin key at console.anthropic.com → Settings → Admin Keys and set it as ANTHROPIC_ADMIN_API_KEY.',
    key_not_found: 'The chat key was deleted or belongs to another Anthropic organization. Create a new key in this organization and update ANTHROPIC_API_KEY.',
    key_inactive: 'Create a new key at console.anthropic.com → API Keys and update ANTHROPIC_API_KEY on the ips-agent-api Render service.',
  },
  anthropic_budget: {
    over_threshold: 'Review usage at console.anthropic.com → Usage, or raise ANTHROPIC_MONTHLY_BUDGET_USD if the new level is expected.',
  },
};

// Last email delivery attempt, for the admin status endpoint.
const delivery = { last_attempt_at: null, ok: null, error: null, recipients: [] };

let running = null;
let lastChatTriggerAt = 0;

const round2 = (n) => Math.round(n * 100) / 100;
const keyHint = (key) => (key ? `…${key.slice(-4)}` : null);

async function request(url, opts = {}) {
  const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(TIMEOUT_MS) });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

// ---------------------------------------------------------------------------
// Provider key checks
// ---------------------------------------------------------------------------
async function checkAnthropicKey() {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return { status: 'missing', message: 'ANTHROPIC_API_KEY is not set' };
  const model = MODEL_REGISTRY['claude-fast'].modelId;
  const { status, body } = await request(`${ANTHROPIC}/v1/messages`, {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': ANTHROPIC_VERSION, 'content-type': 'application/json' },
    body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }),
  });
  const msg = body?.error?.message || '';
  const detail = { key_hint: keyHint(key), http_status: status, model };
  if (status === 200) return { status: 'ok', message: 'Key is valid and the account has credit', detail };
  if (status === 401) return { status: 'invalid', message: `Anthropic rejected the key (${msg || 'unauthorized'})`, detail };
  if (status === 403) return { status: 'forbidden', message: `Anthropic refused the request (${msg || 'forbidden'})`, detail };
  if (/credit balance|usage limits?/i.test(msg)) {
    return { status: 'no_credit', message: `Anthropic account cannot be billed (${msg})`, detail };
  }
  if (status === 429) return { status: 'rate_limited', message: 'Key is valid; rate limited at check time', detail };
  return { status: 'unavailable', message: `Anthropic returned HTTP ${status}${msg ? ` (${msg})` : ''}`, detail };
}

async function checkOpenAIKey() {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return { status: 'missing', message: 'OPENAI_API_KEY is not set' };
  const { status, body } = await request('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'text-embedding-3-small', input: 'ping' }),
  });
  const msg = body?.error?.message || '';
  const detail = { key_hint: keyHint(key), http_status: status };
  if (status === 200) return { status: 'ok', message: 'Key is valid and the account has quota', detail };
  if (status === 401) return { status: 'invalid', message: `OpenAI rejected the key (${msg.split('.')[0] || 'unauthorized'})`, detail };
  if (status === 403) return { status: 'forbidden', message: `OpenAI refused the request (${msg || 'forbidden'})`, detail };
  if (status === 429 && body?.error?.code === 'insufficient_quota') {
    return { status: 'no_credit', message: `OpenAI account is out of quota (${msg})`, detail };
  }
  if (status === 429) return { status: 'rate_limited', message: 'Key is valid; rate limited at check time', detail };
  return { status: 'unavailable', message: `OpenAI returned HTTP ${status}${msg ? ` (${msg})` : ''}`, detail };
}

// ---------------------------------------------------------------------------
// Anthropic Admin API (key list + cost report)
// ---------------------------------------------------------------------------
const adminConfigured = () => !!process.env.ANTHROPIC_ADMIN_API_KEY;

async function adminGet(path, params = {}) {
  const url = new URL(path, ANTHROPIC);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, v);
  }
  const { status, body } = await request(url, {
    headers: { 'x-api-key': process.env.ANTHROPIC_ADMIN_API_KEY, 'anthropic-version': ANTHROPIC_VERSION },
  });
  if (status !== 200) {
    const err = new Error(`Anthropic Admin API HTTP ${status}${body?.error?.message ? ` (${body.error.message})` : ''}`);
    err.status = status;
    throw err;
  }
  return body;
}

async function listApiKeys() {
  const keys = [];
  let after = null;
  do {
    const page = await adminGet('/v1/organizations/api_keys', { limit: 1000, after_id: after });
    keys.push(...(page.data || []));
    after = page.has_more ? page.last_id : null;
  } while (after);
  return keys;
}

// partial_key_hint looks like "sk-ant-api03-R2D...igAA"
function matchesHint(key, hint) {
  if (!key || !hint) return false;
  const [prefix, suffix] = hint.split(/\.\.\.|…/);
  return suffix !== undefined && key.startsWith(prefix) && key.endsWith(suffix);
}

async function checkAdminKeyStatus() {
  if (!adminConfigured()) {
    return { status: 'not_configured', message: 'ANTHROPIC_ADMIN_API_KEY is not set; key-status and spend checks are off' };
  }
  const keys = await listApiKeys();
  const chatKey = process.env.ANTHROPIC_API_KEY;
  const match = keys.find((k) => matchesHint(chatKey, k.partial_key_hint));
  const detail = { org_keys: keys.length, active_keys: keys.filter((k) => k.status === 'active').length };
  if (!chatKey) return { status: 'ok', message: 'No chat key set to look up', detail };
  if (!match) {
    return {
      status: 'key_not_found',
      message: 'The chat key (ANTHROPIC_API_KEY) is not in this Anthropic organization: it was deleted, or the Admin key belongs to a different organization',
      detail,
    };
  }
  Object.assign(detail, { key_name: match.name, key_status: match.status, key_created_at: match.created_at, key_expires_at: match.expires_at });
  if (match.status !== 'active') {
    return { status: 'key_inactive', message: `The chat key "${match.name}" is ${match.status} in the Anthropic Console`, detail };
  }
  return { status: 'ok', message: `The chat key "${match.name}" is active`, detail };
}

function monthStartUtc(d) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

/** Daily USD cost from the cost report, oldest first. Amounts arrive in cents. */
async function costByDay(startingAt) {
  const days = [];
  let page = null;
  do {
    const body = await adminGet('/v1/organizations/cost_report', {
      starting_at: startingAt.toISOString(),
      bucket_width: '1d',
      limit: 31,
      page,
    });
    for (const bucket of body.data || []) {
      const cents = (bucket.results || []).reduce((s, r) => s + Number(r.amount || 0), 0);
      days.push({ day: bucket.starting_at.slice(0, 10), usd: round2(cents / 100) });
    }
    page = body.has_more ? body.next_page : null;
  } while (page);
  return days;
}

async function checkBudget() {
  if (!adminConfigured()) return { status: 'not_configured', message: 'ANTHROPIC_ADMIN_API_KEY is not set' };
  const now = new Date();
  const start = monthStartUtc(now);
  const days = await costByDay(start);
  const mtd = round2(days.reduce((s, d) => s + d.usd, 0));
  const daysInMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
  const elapsedDays = (now - start) / 86400000;
  const projected = elapsedDays >= 1 ? round2((mtd / elapsedDays) * daysInMonth) : null;
  const budget = parseFloat(process.env.ANTHROPIC_MONTHLY_BUDGET_USD || '') || null;
  const month = start.toISOString().slice(0, 7);
  const pace = projected !== null ? `, on pace for $${projected}` : '';
  const detail = { month, mtd_usd: mtd, projected_usd: projected, budget_usd: budget };

  if (!budget) return { status: 'ok', message: `Month-to-date spend $${mtd}${pace} (no budget set)`, detail };

  const pct = Math.round((mtd / budget) * 1000) / 10;
  detail.pct_of_budget = pct;
  const thresholds = (process.env.API_MONITOR_BUDGET_THRESHOLDS || '75,90,100')
    .split(',')
    .map(Number)
    .filter((n) => n > 0)
    .sort((a, b) => a - b);
  const crossed = thresholds.filter((t) => pct >= t).pop();
  const message = `Month-to-date spend $${mtd} is ${pct}% of the $${budget} budget${pace}`;
  if (crossed) {
    return { status: 'over_threshold', message, detail: { ...detail, threshold: crossed }, signature: `${month}:${crossed}` };
  }
  return { status: 'ok', message, detail };
}

/** Monthly totals for the last `months` full months plus the current one. */
async function spendHistory(months = 3) {
  if (!adminConfigured()) throw new Error('ANTHROPIC_ADMIN_API_KEY is not set');
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - months, 1));
  const days = await costByDay(start);
  const byMonth = new Map();
  for (const d of days) {
    const m = d.day.slice(0, 7);
    byMonth.set(m, round2((byMonth.get(m) || 0) + d.usd));
  }
  return { months: [...byMonth].map(([month, usd]) => ({ month, usd })), daily: days };
}

// ---------------------------------------------------------------------------
// Alerting
// ---------------------------------------------------------------------------
async function alertRecipients(dbPool) {
  const configured = (process.env.API_MONITOR_ALERT_EMAILS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (configured.length) return configured;
  const admins = await dbPool
    .query(`SELECT email FROM users WHERE role = 'admin' AND email IS NOT NULL`)
    .catch(() => ({ rows: [] }));
  return admins.rows.map((r) => r.email);
}

const escapeHtml = (s) =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function renderEmail(problems, recoveries) {
  const section = (title, color, items, withFix) =>
    items.length
      ? `<h3 style="color:${color};margin:20px 0 8px">${title}</h3>` +
        items
          .map(
            ({ key, result }) => `
          <div style="border-left:4px solid ${color};padding:8px 12px;margin-bottom:12px;background:#f8f9fa">
            <div style="font-weight:600">${escapeHtml(LABELS[key])}</div>
            <div>${escapeHtml(result.message)}</div>
            ${withFix && IMPACT[key] ? `<div style="margin-top:6px"><b>Impact:</b> ${escapeHtml(IMPACT[key])}</div>` : ''}
            ${withFix && FIX[key]?.[result.status] ? `<div style="margin-top:6px"><b>Fix:</b> ${escapeHtml(FIX[key][result.status])}</div>` : ''}
          </div>`
          )
          .join('')
      : '';
  return `<div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;color:#222;max-width:640px">
    <p>The IPS AI platform's hourly API health check found the following.</p>
    ${section('Needs attention', '#c0392b', problems, true)}
    ${section('Resolved', '#27ae60', recoveries, false)}
    <p style="color:#777;font-size:12px;margin-top:24px">Sent by the ips-agent-api health monitor. Current status: /admin/ops on the IPS AI platform.</p>
  </div>`;
}

async function sendAlert(dbPool, problems, recoveries, subjectOverride = null) {
  const to = await alertRecipients(dbPool);
  const from = process.env.API_MONITOR_FROM_MAILBOX;
  const names = (items) => items.map((i) => LABELS[i.key]).join(', ');
  const subject =
    subjectOverride ||
    (problems.length ? `[IPS AI] Action needed: ${names(problems)}` : `[IPS AI] Resolved: ${names(recoveries)}`);

  Object.assign(delivery, { last_attempt_at: new Date().toISOString(), recipients: to });
  if (!from || !msGraph.isConfigured() || !to.length) {
    delivery.ok = false;
    delivery.error = !from
      ? 'API_MONITOR_FROM_MAILBOX is not set'
      : !to.length
        ? 'No recipients (set API_MONITOR_ALERT_EMAILS)'
        : 'Microsoft Graph is not configured';
    console.warn(`[API-MONITOR] Email not sent (${delivery.error}): ${subject}`);
    return;
  }
  try {
    await msGraph.sendMail({ from, to, subject, html: renderEmail(problems, recoveries) });
    delivery.ok = true;
    delivery.error = null;
    console.log(`[API-MONITOR] Alert emailed to ${to.join(', ')}: ${subject}`);
  } catch (err) {
    delivery.ok = false;
    delivery.error =
      err.status === 403
        ? 'Graph refused sendMail (403): grant the Mail.Send application permission to the IPS app registration'
        : err.message;
    console.warn(`[API-MONITOR] Alert email failed (${delivery.error}): ${subject}`);
  }
}

/**
 * Persist one check result and decide whether it needs an alert.
 * Returns 'problem', 'recovered' or null.
 */
async function recordResult(dbPool, key, result) {
  const prev = (await dbPool.query('SELECT * FROM api_health_checks WHERE check_key = $1', [key])).rows[0];
  const now = Date.now();
  const bad = BAD.has(result.status);
  const signature = result.signature || result.status;
  let alertSignature = prev?.alert_signature || null;
  let lastAlertedAt = prev?.last_alerted_at || null;
  let alert = null;

  if (bad) {
    const isNew = alertSignature !== signature;
    const reminderDue = key !== 'anthropic_budget' && (!lastAlertedAt || now - new Date(lastAlertedAt).getTime() > REMINDER_MS);
    if (isNew || reminderDue) {
      alert = 'problem';
      alertSignature = signature;
      lastAlertedAt = new Date(now);
    }
  } else if (result.status === 'ok' && alertSignature && key !== 'anthropic_budget') {
    alert = 'recovered';
    alertSignature = null;
  }

  await dbPool.query(
    `INSERT INTO api_health_checks
       (check_key, status, message, detail, last_checked_at, last_ok_at, last_alerted_at, alert_signature)
     VALUES ($1, $2, $3, $4, NOW(), CASE WHEN $5 THEN NOW() END, $6, $7)
     ON CONFLICT (check_key) DO UPDATE SET
       status = EXCLUDED.status,
       message = EXCLUDED.message,
       detail = EXCLUDED.detail,
       last_checked_at = NOW(),
       last_ok_at = COALESCE(EXCLUDED.last_ok_at, api_health_checks.last_ok_at),
       last_alerted_at = EXCLUDED.last_alerted_at,
       alert_signature = EXCLUDED.alert_signature`,
    [key, result.status, result.message || null, result.detail ? JSON.stringify(result.detail) : null,
      result.status === 'ok', lastAlertedAt, alertSignature]
  );
  return alert;
}

async function safely(fn) {
  try {
    return await fn();
  } catch (err) {
    if (err.status === 401 || err.status === 403) {
      return { status: 'invalid', message: `The Anthropic Admin key was rejected (${err.message})`, adminRejected: true };
    }
    return { status: 'unavailable', message: err.message };
  }
}

async function runChecksOnce(dbPool, reason) {
  const results = {};
  const [anthropic, openai, admin] = await Promise.all([
    safely(checkAnthropicKey),
    safely(checkOpenAIKey),
    safely(checkAdminKeyStatus),
  ]);
  results.anthropic_key = anthropic;
  results.openai_key = openai;
  results.anthropic_admin = admin;
  results.anthropic_budget = admin.adminRejected
    ? { status: 'unavailable', message: 'Skipped: the Anthropic Admin key was rejected' }
    : await safely(checkBudget);

  const problems = [];
  const recoveries = [];
  for (const [key, result] of Object.entries(results)) {
    const alert = await recordResult(dbPool, key, result);
    if (alert === 'problem') problems.push({ key, result });
    if (alert === 'recovered') recoveries.push({ key, result });
  }

  for (const { key, result } of problems) {
    await recordFailure(dbPool, { source: 'api_monitor', reference: LABELS[key], error: result.message, detail: result.detail });
  }
  if (problems.length || recoveries.length) await sendAlert(dbPool, problems, recoveries);

  const summary = Object.fromEntries(Object.entries(results).map(([k, r]) => [k, r.status]));
  console.log(`🩺 API health (${reason}): ${JSON.stringify(summary)}`);
  return results;
}

/** Run every check. Concurrent callers share the in-flight run. */
function runChecks(dbPool, { reason = 'scheduled' } = {}) {
  if (!running) {
    running = runChecksOnce(dbPool, reason).finally(() => {
      running = null;
    });
  }
  return running;
}

/** Called by the chat when Anthropic rejects a request, so admins hear about it within minutes. */
function onChatAuthFailure(dbPool) {
  if (Date.now() - lastChatTriggerAt < CHAT_TRIGGER_DEBOUNCE_MS) return;
  lastChatTriggerAt = Date.now();
  runChecks(dbPool, { reason: 'chat failure' }).catch((err) => console.warn('[API-MONITOR] check failed:', err.message));
}

async function getStatus(dbPool) {
  const rows = await dbPool
    .query('SELECT * FROM api_health_checks ORDER BY check_key')
    .catch(() => ({ rows: [] }));
  return {
    checks: rows.rows.map((r) => ({ ...r, label: LABELS[r.check_key] || r.check_key })),
    config: {
      admin_api: adminConfigured(),
      monthly_budget_usd: parseFloat(process.env.ANTHROPIC_MONTHLY_BUDGET_USD || '') || null,
      from_mailbox: process.env.API_MONITOR_FROM_MAILBOX || null,
      recipients: await alertRecipients(dbPool),
    },
    email_delivery: delivery,
  };
}

async function sendTestEmail(dbPool) {
  await sendAlert(
    dbPool,
    [],
    [{ key: 'anthropic_key', result: { status: 'ok', message: 'Test email from the API health monitor. Alerts will arrive like this.' } }],
    '[IPS AI] Test: API health alerts'
  );
  return delivery;
}

module.exports = { runChecks, onChatAuthFailure, getStatus, spendHistory, sendTestEmail };
