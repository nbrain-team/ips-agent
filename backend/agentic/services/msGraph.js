/**
 * msGraph — Microsoft Graph integration for IPS's M365 tenant.
 *
 * Two auth modes:
 *  - APP (client credentials): tenant-wide email sync for ALL users, before
 *    they ever sign in. Requires APPLICATION permissions User.Read.All +
 *    Mail.Read with admin consent in the IPS tenant.
 *  - DELEGATED (auth code): user SSO sign-in (handled in routes/auth-microsoft).
 *
 * Sync policy: last EMAIL_SYNC_DAYS (default 30) days per mailbox, re-synced
 * on an interval with a 1-day overlap; upserts are idempotent on
 * ms_message_id. Per-mailbox failures (no license, no mailbox) are recorded
 * on ms_mailboxes.sync_error and never abort the run.
 */

const GRAPH = 'https://graph.microsoft.com/v1.0';
const SYNC_DAYS = parseInt(process.env.EMAIL_SYNC_DAYS || '30', 10);
const MAX_PAGES_PER_MAILBOX = parseInt(process.env.MS_SYNC_MAX_PAGES || '20', 10); // x50 msgs
const BODY_CHAR_CAP = 20000;

function isConfigured() {
  return !!(
    process.env.MS_GRAPH_CLIENT_ID &&
    process.env.MS_GRAPH_CLIENT_SECRET &&
    process.env.MS_GRAPH_TENANT_ID
  );
}

// ---------------------------------------------------------------------------
// App-only token (cached until 5 min before expiry)
// ---------------------------------------------------------------------------
let cached = { token: null, expiresAt: 0 };

async function getAppToken() {
  if (cached.token && Date.now() < cached.expiresAt - 300000) return cached.token;
  const res = await fetch(
    `https://login.microsoftonline.com/${process.env.MS_GRAPH_TENANT_ID}/oauth2/v2.0/token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.MS_GRAPH_CLIENT_ID,
        client_secret: process.env.MS_GRAPH_CLIENT_SECRET,
        scope: 'https://graph.microsoft.com/.default',
        grant_type: 'client_credentials',
      }),
    }
  );
  const data = await res.json();
  if (!res.ok) {
    throw new Error(`Graph token error: ${data.error_description || data.error || res.status}`);
  }
  cached = { token: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
  return cached.token;
}

/** GET with retry on 429/503 honoring Retry-After. */
async function graphGet(url, token, extraHeaders = {}) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, ...extraHeaders },
    });
    if (res.status === 429 || res.status === 503) {
      const wait = (parseInt(res.headers.get('retry-after') || '5', 10) + 1) * 1000;
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error?.message || `Graph ${res.status}`);
      err.code = data.error?.code;
      err.status = res.status;
      throw err;
    }
    return data;
  }
  throw new Error('Graph rate limit: retries exhausted');
}

// ---------------------------------------------------------------------------
// Tenant users → ms_mailboxes
// ---------------------------------------------------------------------------
async function listTenantUsers() {
  const token = await getAppToken();
  const users = [];
  let url = `${GRAPH}/users?$select=id,displayName,mail,userPrincipalName,accountEnabled&$top=999`;
  while (url) {
    const data = await graphGet(url, token);
    for (const u of data.value || []) {
      const email = (u.mail || u.userPrincipalName || '').toLowerCase();
      if (!email || email.includes('#ext#')) continue; // skip guests
      users.push({
        msUserId: u.id,
        email,
        displayName: u.displayName || null,
        accountEnabled: u.accountEnabled !== false,
      });
    }
    url = data['@odata.nextLink'] || null;
  }
  return users;
}

async function upsertMailboxes(dbPool) {
  const users = await listTenantUsers();
  for (const u of users) {
    await dbPool.query(
      `INSERT INTO ms_mailboxes (ms_user_id, email, display_name, account_enabled)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (ms_user_id) DO UPDATE SET
         email = EXCLUDED.email,
         display_name = EXCLUDED.display_name,
         account_enabled = EXCLUDED.account_enabled`,
      [u.msUserId, u.email, u.displayName, u.accountEnabled]
    );
  }
  return users.length;
}

// ---------------------------------------------------------------------------
// Mail sync
// ---------------------------------------------------------------------------
function addressList(recipients) {
  return (recipients || [])
    .map((r) => (r.emailAddress?.address || '').toLowerCase())
    .filter(Boolean);
}

async function syncMailbox(dbPool, mailbox) {
  const token = await getAppToken();

  // Incremental: overlap 1 day past last sync; initial: full window
  let since = new Date(Date.now() - SYNC_DAYS * 86400000);
  if (mailbox.last_synced_at) {
    const overlap = new Date(new Date(mailbox.last_synced_at).getTime() - 86400000);
    if (overlap > since) since = overlap;
  }
  const sinceIso = since.toISOString();

  let url =
    `${GRAPH}/users/${mailbox.ms_user_id}/messages` +
    `?$select=id,subject,bodyPreview,body,from,toRecipients,ccRecipients,receivedDateTime,isRead,hasAttachments,webLink` +
    `&$filter=receivedDateTime ge ${sinceIso}` +
    `&$orderby=receivedDateTime desc&$top=50`;

  let saved = 0;
  let pages = 0;
  while (url && pages < MAX_PAGES_PER_MAILBOX) {
    pages++;
    const data = await graphGet(url, token, { Prefer: 'outlook.body-content-type="text"' });
    for (const m of data.value || []) {
      let bodyText = m.body?.content || m.bodyPreview || '';
      bodyText = bodyText.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, BODY_CHAR_CAP);
      const result = await dbPool.query(
        `INSERT INTO ms_emails
           (ms_message_id, mailbox_email, subject, from_name, from_address,
            to_addresses, cc_addresses, body_preview, body_text, received_at,
            is_read, has_attachments, web_link)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         ON CONFLICT (ms_message_id) DO UPDATE SET is_read = EXCLUDED.is_read`,
        [
          m.id,
          mailbox.email,
          (m.subject || '').slice(0, 1000),
          m.from?.emailAddress?.name || null,
          (m.from?.emailAddress?.address || '').toLowerCase() || null,
          addressList(m.toRecipients),
          addressList(m.ccRecipients),
          (m.bodyPreview || '').slice(0, 2000),
          bodyText,
          m.receivedDateTime || null,
          m.isRead ?? null,
          !!m.hasAttachments,
          m.webLink || null,
        ]
      );
      saved += result.rowCount;
    }
    url = data['@odata.nextLink'] || null;
  }
  return saved;
}

/**
 * Full tenant sync: refresh mailbox list, then sync every enabled mailbox.
 * Never throws for per-mailbox errors — returns a summary.
 */
async function syncAllMailboxes(dbPool) {
  if (!isConfigured()) {
    return { skipped: true, reason: 'MS_GRAPH_* env vars not set' };
  }
  const started = Date.now();
  const discovered = await upsertMailboxes(dbPool);

  const { rows: mailboxes } = await dbPool.query(
    `SELECT * FROM ms_mailboxes WHERE account_enabled = true ORDER BY last_synced_at ASC NULLS FIRST`
  );

  let ok = 0;
  let failed = 0;
  let totalSaved = 0;
  for (const mb of mailboxes) {
    try {
      const saved = await syncMailbox(dbPool, mb);
      totalSaved += saved;
      ok++;
      await dbPool.query(
        `UPDATE ms_mailboxes SET last_synced_at = NOW(), sync_status = 'ok', sync_error = NULL,
           message_count = (SELECT COUNT(*) FROM ms_emails WHERE mailbox_email = $1)
         WHERE id = $2`,
        [mb.email, mb.id]
      );
    } catch (err) {
      failed++;
      // Common: MailboxNotEnabledForRESTAPI (unlicensed/shared), ErrorAccessDenied (consent)
      await dbPool.query(
        `UPDATE ms_mailboxes SET sync_status = 'error', sync_error = $1 WHERE id = $2`,
        [String(err.message).slice(0, 500), mb.id]
      );
    }
  }
  const summary = {
    discovered,
    mailboxes: mailboxes.length,
    synced_ok: ok,
    failed,
    new_messages: totalSaved,
    duration_s: Math.round((Date.now() - started) / 1000),
  };
  console.log(`📧 Email sync: ${JSON.stringify(summary)}`);
  return summary;
}

module.exports = { isConfigured, getAppToken, graphGet, listTenantUsers, syncAllMailboxes, GRAPH };
