/**
 * Zoom cloud recordings → meeting_transcripts (source 'zoom') + the
 * 'meeting_transcript' knowledge chunks, through the same ingestMeeting path
 * Read.ai and Otter use.
 *
 * IPS connects several Zoom accounts, each through its own Server-to-Server
 * OAuth app. An account is three env vars sharing a label:
 *   ZOOM_<LABEL>_ACCOUNT_ID, ZOOM_<LABEL>_CLIENT_ID, ZOOM_<LABEL>_CLIENT_SECRET
 * Every complete set found in the environment is synced; adding an account
 * needs no code change. The display name is ZOOM_<LABEL>_NAME, or the label
 * title-cased (CLAYTON_BAXLEY → "Clayton Baxley"). ZOOM_EXPECTED_ACCOUNTS is
 * how many accounts IPS is connecting, so the data page can show the ones
 * still waiting on credentials.
 *
 * Per account: the first run walks the whole cloud-recording history month by
 * month (the list API caps a request at one month), later runs re-read the last
 * ZOOM_LOOKBACK_DAYS. A meeting is re-ingested only when its set of completed
 * transcript/summary files changes, so hourly runs cost a handful of list
 * calls, and a transcript Zoom finishes processing after the first sighting
 * still gets picked up.
 *
 * Granted scopes cover users, meetings, report participants and recordings.
 * The AI Companion summary arrives as SUMMARY recording files, so no
 * meeting_summary scope is needed. Recordings without a transcript (audio /
 * video only) are stored as metadata rows with no transcript text.
 */

const { ingestMeeting } = require('./readaiIngest');

const API = 'https://api.zoom.us/v2';
const LABEL_RE = /^ZOOM_([A-Z0-9_]+)_ACCOUNT_ID$/;

// Values pasted into the Render dashboard pick up spaces, newlines and quotes.
function credential(name) {
  return String(process.env[name] || '').trim().replace(/^["']+|["']+$/g, '').trim();
}

function configuredAccounts() {
  const accounts = [];
  for (const key of Object.keys(process.env).sort()) {
    const m = key.match(LABEL_RE);
    if (!m) continue;
    const label = m[1];
    const accountId = credential(key);
    const clientId = credential(`ZOOM_${label}_CLIENT_ID`);
    const clientSecret = credential(`ZOOM_${label}_CLIENT_SECRET`);
    if (accountId && clientId && clientSecret) {
      const name =
        credential(`ZOOM_${label}_NAME`) ||
        label.toLowerCase().split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
      accounts.push({ label: label.toLowerCase(), name, accountId, clientId, clientSecret });
    } else {
      console.warn(`[Zoom] ${label}: ACCOUNT_ID set but CLIENT_ID / CLIENT_SECRET missing, skipped`);
    }
  }
  return accounts;
}

function isConfigured() {
  return configuredAccounts().length > 0;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isoDate = (d) => d.toISOString().slice(0, 10);

/** Calendar-month windows [from, to] covering start..end (UTC dates). */
function monthWindows(start, end) {
  const windows = [];
  let cur = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
  while (cur <= end) {
    const monthEnd = new Date(Date.UTC(cur.getUTCFullYear(), cur.getUTCMonth() + 1, 0));
    const from = cur < start ? start : cur;
    windows.push([isoDate(from), isoDate(monthEnd < end ? monthEnd : end)]);
    cur = new Date(Date.UTC(cur.getUTCFullYear(), cur.getUTCMonth() + 1, 1));
  }
  return windows;
}

// Zoom requires meeting UUIDs that start with "/" or contain "//" to be
// double-encoded in paths.
function encodeUuid(uuid) {
  const once = encodeURIComponent(uuid);
  return uuid.startsWith('/') || uuid.includes('//') ? encodeURIComponent(once) : once;
}

/** WebVTT → "Speaker: words" lines, consecutive cues by one speaker merged. */
function vttToText(vtt) {
  const lines = [];
  let last = null;
  for (const block of String(vtt || '').replace(/\r/g, '').split(/\n\n+/)) {
    const rows = block.split('\n').filter((l) => l.trim() && !/^WEBVTT/.test(l) && !/^\d+$/.test(l.trim()) && !/-->/.test(l));
    if (!rows.length) continue;
    const text = rows.join(' ').trim();
    const m = text.match(/^([^:]{1,80}):\s+(.*)$/);
    const speaker = m ? m[1].trim() : 'Speaker';
    const words = m ? m[2] : text;
    if (last && last.speaker === speaker) last.words += ` ${words}`;
    else lines.push((last = { speaker, words }));
  }
  return lines.map((l) => `${l.speaker}: ${l.words}`).join('\n');
}

class ZoomAccountSync {
  constructor(pool, account) {
    this.pool = pool;
    this.account = account;
    this.label = account.label;
    this.token = null;
    this.tokenExpiresAt = 0;
    this.lookbackDays = parseInt(process.env.ZOOM_LOOKBACK_DAYS || '7', 10);
    this.backfillFrom = new Date(`${process.env.ZOOM_BACKFILL_FROM || '2020-01-01'}T00:00:00Z`);
    this.sleepMs = parseInt(process.env.ZOOM_SLEEP_MS || '150', 10);
    this.timeout = parseInt(process.env.ZOOM_TIMEOUT_MS || '60000', 10);
  }

  async authenticate() {
    const { accountId, clientId, clientSecret } = this.account;
    const resp = await fetch(
      `https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${encodeURIComponent(accountId)}`,
      {
        method: 'POST',
        headers: { Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}` },
        signal: AbortSignal.timeout(this.timeout),
      }
    );
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || !data.access_token) {
      const reason = data.reason || data.error || '';
      throw new Error(
        `Zoom rejected the ${this.account.name} credentials (HTTP ${resp.status}: ${reason})` +
          (/client_id|client_secret/i.test(reason)
            ? ' — check the Server-to-Server OAuth app is activated in the Zoom Marketplace and the Client ID / Secret are current'
            : '')
      );
    }
    this.token = data.access_token;
    this.tokenExpiresAt = Date.now() + (data.expires_in || 3600) * 1000 - 5 * 60000;
    this.scopes = String(data.scope || '').split(' ').filter(Boolean);
  }

  async request(url, { raw = false } = {}, attempt = 1) {
    if (!this.token || Date.now() > this.tokenExpiresAt) await this.authenticate();
    let resp;
    try {
      resp = await fetch(url.startsWith('http') ? url : `${API}${url}`, {
        headers: { Authorization: `Bearer ${this.token}` },
        signal: AbortSignal.timeout(this.timeout),
      });
    } catch (err) {
      if (attempt >= 5) throw err;
      await sleep(3000 * attempt);
      return this.request(url, { raw }, attempt + 1);
    }
    if (resp.status === 401 && attempt === 1) {
      this.token = null;
      return this.request(url, { raw }, attempt + 1);
    }
    if ((resp.status === 429 || resp.status >= 500) && attempt < 6) {
      const retryAfter = parseFloat(resp.headers.get('retry-after') || '0');
      await sleep(retryAfter ? retryAfter * 1000 : Math.min(60000, 2 ** attempt * 1000));
      return this.request(url, { raw }, attempt + 1);
    }
    await sleep(this.sleepMs);
    const text = await resp.text();
    if (raw) return { status: resp.status, text };
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch (_e) {
      data = null;
    }
    return { status: resp.status, data };
  }

  async listRecordings(from, to) {
    const meetings = [];
    let next = '';
    do {
      const qs = new URLSearchParams({ page_size: '300', from, to });
      if (next) qs.set('next_page_token', next);
      const { status, data } = await this.request(`/accounts/me/recordings?${qs}`);
      if (status !== 200) throw new Error(`Zoom ${this.label}: recordings ${from}..${to} HTTP ${status} ${data?.message || ''}`);
      meetings.push(...(data.meetings || []));
      next = data.next_page_token || '';
    } while (next);
    return meetings;
  }

  async downloadFile(file, asJson) {
    const { status, text } = await this.request(file.download_url, { raw: true });
    if (status !== 200) throw new Error(`${file.file_type}/${file.recording_type} download HTTP ${status}`);
    if (!asJson) return text;
    try {
      return JSON.parse(text);
    } catch (_e) {
      return null;
    }
  }

  async participants(uuid) {
    const people = new Map();
    let next = '';
    do {
      const qs = new URLSearchParams({ page_size: '300' });
      if (next) qs.set('next_page_token', next);
      const { status, data } = await this.request(`/report/meetings/${encodeUuid(uuid)}/participants?${qs}`);
      if (status !== 200) return [...people.values()];
      for (const p of data.participants || []) {
        const email = String(p.user_email || '').toLowerCase() || null;
        const key = email || String(p.name || '').toLowerCase();
        if (key && !people.has(key)) people.set(key, { name: p.name || null, email });
      }
      next = data.next_page_token || '';
    } while (next);
    return [...people.values()];
  }

  /** Completed transcript + summary files; a change means the meeting has new content. */
  contentFiles(rec) {
    return (rec.recording_files || []).filter(
      (f) => ['TRANSCRIPT', 'SUMMARY'].includes(f.file_type) && f.status === 'completed' && f.download_url
    );
  }

  async processRecording(rec) {
    const sessionId = `zoom-${rec.uuid}`;
    const files = this.contentFiles(rec);
    const sig = files.map((f) => f.id).sort().join(',');
    const existing = await this.pool.query(
      `SELECT raw_payload->'zoom'->>'file_sig' AS sig FROM meeting_transcripts WHERE session_id = $1`,
      [sessionId]
    );
    if (existing.rows.length && existing.rows[0].sig === sig) return false;

    let transcriptText = '';
    let summary = '';
    let topics = [];
    let actionItems = [];
    for (const f of files) {
      if (f.file_type === 'TRANSCRIPT') {
        transcriptText = vttToText(await this.downloadFile(f, false));
      } else if (f.recording_type === 'summary_next_steps') {
        const j = await this.downloadFile(f, true);
        actionItems = (j?.items || []).map((i) => i.action_item_text || i.rephrased_text).filter(Boolean);
      } else {
        const j = await this.downloadFile(f, true);
        if (j?.overall_summary) {
          const sections = (j.items || []).filter((i) => i.summary).map((i) => `${i.label}: ${i.summary}`);
          summary = [j.overall_summary, ...sections].join('\n\n');
          topics = (j.items || []).map((i) => i.label).filter(Boolean);
        }
      }
    }

    const start = rec.start_time ? new Date(rec.start_time) : null;
    const end = start && rec.duration ? new Date(start.getTime() + rec.duration * 60000) : null;
    await ingestMeeting(this.pool, {
      session_id: sessionId,
      source: 'zoom',
      source_account: this.label,
      trigger: 'zoom_recording_sync',
      title: rec.topic || 'Untitled Zoom meeting',
      start_time: start ? start.toISOString() : null,
      end_time: end ? end.toISOString() : null,
      owner: { email: rec.host_email || null },
      participants: await this.participants(rec.uuid),
      summary,
      action_items: actionItems,
      topics,
      report_url: rec.share_url || null,
      transcript_text: transcriptText,
      zoom: {
        file_sig: sig,
        account: this.label,
        meeting_id: rec.id,
        uuid: rec.uuid,
        host_email: rec.host_email || null,
        duration_min: rec.duration || null,
        has_transcript: Boolean(transcriptText),
        has_summary: Boolean(summary),
        files: (rec.recording_files || []).map((f) => ({ type: f.file_type, recording_type: f.recording_type, status: f.status })),
      },
    });
    return true;
  }

  async loadState() {
    await this.pool.query(
      `INSERT INTO zoom_sync_state (account_label, zoom_account_id) VALUES ($1, $2)
       ON CONFLICT (account_label) DO UPDATE SET zoom_account_id = EXCLUDED.zoom_account_id`,
      [this.label, this.account.accountId]
    );
    const { rows } = await this.pool.query(`SELECT * FROM zoom_sync_state WHERE account_label = $1`, [this.label]);
    return rows[0];
  }

  async sync() {
    const state = await this.loadState();
    const backfill = !state.backfill_completed_at;
    const now = new Date();
    const from = backfill ? this.backfillFrom : new Date(now.getTime() - this.lookbackDays * 86400000);
    await this.pool.query(`UPDATE zoom_sync_state SET last_run_at = NOW(), updated_at = NOW() WHERE account_label = $1`, [this.label]);

    let seen = 0;
    let ingested = 0;
    let failed = 0;
    let earliest = null;
    const { recordFailure } = require('./ingestFailures');
    for (const [wFrom, wTo] of monthWindows(from, now)) {
      const recs = await this.listRecordings(wFrom, wTo);
      for (const rec of recs.sort((a, b) => String(a.start_time).localeCompare(String(b.start_time)))) {
        seen++;
        if (rec.start_time && (!earliest || rec.start_time < earliest)) earliest = rec.start_time;
        try {
          if (await this.processRecording(rec)) ingested++;
        } catch (err) {
          failed++;
          console.warn(`[Zoom] ${this.label}: "${rec.topic}" (${rec.start_time}) failed: ${err.message}`);
          await recordFailure(this.pool, {
            source: 'zoom_sync',
            reference: `${this.label}: ${rec.topic || rec.uuid} (${rec.start_time || 'no date'})`,
            error: err.message,
          });
        }
      }
    }

    await this.pool.query(
      `UPDATE zoom_sync_state SET
         last_success_at = NOW(), last_error = NULL, updated_at = NOW(),
         recordings_seen = CASE WHEN $2 THEN $3 ELSE recordings_seen END,
         meetings_ingested = meetings_ingested + $4,
         earliest_recording = LEAST(COALESCE(earliest_recording, $5::timestamptz), $5::timestamptz),
         backfill_completed_at = CASE WHEN $2 AND $6 = 0 THEN NOW() ELSE backfill_completed_at END
       WHERE account_label = $1`,
      [this.label, backfill, seen, ingested, earliest, failed]
    );
    return { account: this.label, backfill, seen, ingested, failed };
  }
}

/** One run over every configured account; one account's failure does not stop the others. */
async function syncAllAccounts(pool) {
  const results = [];
  for (const account of configuredAccounts()) {
    const runner = new ZoomAccountSync(pool, account);
    try {
      const r = await runner.sync();
      console.log(`🎥 Zoom ${r.account}: ${r.ingested} meetings ingested of ${r.seen} recordings${r.backfill ? ' (history backfill)' : ''}${r.failed ? `, ${r.failed} failed` : ''}`);
      results.push(r);
    } catch (err) {
      console.warn(`[Zoom] ${account.label} sync failed: ${err.message}`);
      const message = err.message.slice(0, 2000);
      // Rejected credentials fail the same way every hour until someone fixes
      // the Zoom app; one failure-inbox entry per distinct error, not 24 a day.
      const prev = await pool
        .query(`SELECT last_error FROM zoom_sync_state WHERE account_label = $1`, [account.label])
        .then((r) => r.rows[0]?.last_error)
        .catch(() => null);
      await pool
        .query(
          `INSERT INTO zoom_sync_state (account_label, zoom_account_id, last_run_at, last_error)
           VALUES ($1, $2, NOW(), $3)
           ON CONFLICT (account_label) DO UPDATE SET last_run_at = NOW(), last_error = $3, updated_at = NOW()`,
          [account.label, account.accountId, message]
        )
        .catch(() => {});
      if (prev !== message) {
        await require('./ingestFailures').recordFailure(pool, { source: 'zoom_sync', reference: account.name, error: err.message });
      }
      results.push({ account: account.label, error: err.message });
    }
  }
  return results;
}

/** One row per Zoom account for the data page, plus placeholders for accounts not connected yet. */
async function accountStatus(pool) {
  const configured = configuredAccounts();
  const [state, meetings] = await Promise.all([
    pool.query(`SELECT * FROM zoom_sync_state`).catch(() => ({ rows: [] })),
    pool
      .query(
        `SELECT source_account, COUNT(*)::int AS meetings,
                COUNT(*) FILTER (WHERE COALESCE(transcript_text, '') <> '')::int AS with_transcript,
                COALESCE(SUM(jsonb_array_length(action_items)), 0)::int AS action_items,
                COALESCE(SUM(chunk_count), 0)::int AS chunks,
                MIN(meeting_start) AS earliest_meeting, MAX(meeting_start) AS latest_meeting
         FROM meeting_transcripts WHERE source = 'zoom' GROUP BY source_account`
      )
      .catch(() => ({ rows: [] })),
  ]);
  const stateBy = Object.fromEntries(state.rows.map((r) => [r.account_label, r]));
  const meetingsBy = Object.fromEntries(meetings.rows.map((r) => [r.source_account, r]));

  const accounts = configured.map((a) => {
    const s = stateBy[a.label] || {};
    const m = meetingsBy[a.label] || {};
    let status = 'syncing';
    if (s.last_error) status = 'error';
    else if (s.backfill_completed_at) status = 'connected';
    else if (!s.last_run_at) status = 'pending_first_run';
    return {
      name: a.name,
      label: a.label,
      status,
      error: s.last_error || null,
      meetings: m.meetings || 0,
      with_transcript: m.with_transcript || 0,
      action_items: m.action_items || 0,
      chunks: m.chunks || 0,
      earliest_meeting: m.earliest_meeting || null,
      latest_meeting: m.latest_meeting || null,
      history_loaded_at: s.backfill_completed_at || null,
      last_synced: s.last_success_at || null,
      last_attempt: s.last_run_at || null,
    };
  });
  // Order of connection: accounts whose history has loaded first, oldest first.
  accounts.sort((x, y) => String(x.history_loaded_at || '9999').localeCompare(String(y.history_loaded_at || '9999')));
  const expected = parseInt(process.env.ZOOM_EXPECTED_ACCOUNTS || '0', 10);
  for (let i = accounts.length; i < expected; i++) {
    accounts.push({ name: `Zoom account ${i + 1}`, label: null, status: 'not_connected', meetings: 0 });
  }
  return accounts;
}

module.exports = { syncAllAccounts, configuredAccounts, isConfigured, accountStatus, vttToText, monthWindows };
