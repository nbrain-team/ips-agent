/**
 * SAP Business One history — the complete legacy record (July 2017 through the
 * 2026 S/4HANA cutover) copied into the sap_b1 schema, then kept current.
 *
 * Why this exists: the billing platform only syncs the newest 4,000 field
 * tickets and open invoices, and the master's `sap` dump pages oldest-first and
 * stops at 10,000 rows. Neither can answer "show me 2019", which is what audit
 * work needs. This copies everything.
 *
 * How it copies: keyset pagination on DocEntry (`DocEntry gt <cursor>`,
 * ascending). Each page is written in one transaction together with the new
 * cursor, so a redeploy mid-backfill resumes exactly where it stopped. Entities
 * are processed in time slices so field tickets and invoices both make progress
 * instead of one waiting hours behind the other.
 *
 * The Service Layer is slow on documents with inline lines — the billing
 * platform's sync has been failing on 60s timeouts — so requests get a long
 * timeout and a page that still times out is retried at half the size.
 *
 * Env: SAP_BASE_URL  SAP_USERNAME  SAP_PASSWORD  SAP_COMPANY_DB (production DB)
 * Optional: SAP_B1_PAGE_SIZE (100)  SAP_B1_TIMEOUT_MS (180000)  SAP_B1_SLICE_MIN (5)
 */

const https = require('https');

const SCHEMA = 'sap_b1';

function isConfigured() {
  return Boolean(
    (process.env.SAP_BASE_URL || process.env.SAP_B1_BASE_URL) &&
      (process.env.SAP_USERNAME || process.env.SAP_B1_USER) &&
      (process.env.SAP_PASSWORD || process.env.SAP_B1_PASSWORD) &&
      (process.env.SAP_COMPANY_DB || process.env.SAP_B1_COMPANY_DB)
  );
}

// ── value helpers ────────────────────────────────────────────────────────────
const str = (v) => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
};
const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
};
const int = (v) => {
  const n = num(v);
  return n === null ? null : Math.trunc(n);
};
// B1 uses 1899-12-30 / 1900-01-01 as "no date".
const date = (v) => {
  const m = v && String(v).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m || Number(m[1]) < 1901) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
};
const yes = (v) => v === 'Y' || v === 'tYES';

/** Drop arrays, nulls and empty strings — B1 records are mostly empty fields. */
function compact(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    if (v === null || v === '' || Array.isArray(v) || k.startsWith('odata.') || k.startsWith('@')) continue;
    out[k] = v;
  }
  return out;
}

function dedupe(rows, keyCols) {
  const seen = new Map();
  for (const r of rows) seen.set(keyCols.map((c) => r[c]).join('\u0001'), r);
  return [...seen.values()];
}

/**
 * Multi-row INSERT … ON CONFLICT. Chunked under Postgres's 65,535-parameter
 * limit. `touch` adds synced_at = NOW() to the update for header tables.
 */
async function bulkUpsert(client, table, cols, rows, conflictCols, { touch = false } = {}) {
  if (!rows.length) return;
  const perChunk = Math.max(1, Math.floor(60000 / cols.length));
  const updates = cols.filter((c) => !conflictCols.includes(c)).map((c) => `${c} = EXCLUDED.${c}`);
  if (touch) updates.push('synced_at = NOW()');
  const onConflict = updates.length ? `DO UPDATE SET ${updates.join(', ')}` : 'DO NOTHING';
  for (let i = 0; i < rows.length; i += perChunk) {
    const chunk = rows.slice(i, i + perChunk);
    const params = [];
    const tuples = chunk.map(
      (r) =>
        `(${cols
          .map((c) => {
            params.push(r[c] === undefined ? null : r[c]);
            return `$${params.length}`;
          })
          .join(',')})`
    );
    await client.query(
      `INSERT INTO ${table} (${cols.join(',')}) VALUES ${tuples.join(',')}
       ON CONFLICT (${conflictCols.join(',')}) ${onConflict}`,
      params
    );
  }
}

// ── mappers ──────────────────────────────────────────────────────────────────
const FT_COLS = [
  'doc_entry', 'doc_num', 'series', 'ticket_date', 'customer_code', 'customer_name', 'job_code',
  'contact', 'description', 'ref1', 'ref2', 'ref3', 'ref4', 'ref5', 'ref6', 'ship_to_code',
  'status', 'canceled', 'approved', 'first_level_approved', 'approved_date', 'approved_by',
  'labor_total', 'equipment_total', 'material_total', 'doc_total', 'billed_doc_type',
  'billed_doc_nums', 'created_date', 'updated_date', 'raw_data',
];
const FTL_COLS = [
  'doc_entry', 'line_type', 'line_id', 'work_date', 'employee_id', 'employee_name', 'work_type',
  'item_code', 'item_name', 'quantity', 'st_hours', 'ot_hours', 'pd_hours', 'st_rate', 'ot_rate',
  'pd_rate', 'price', 'amount', 'project_code', 'billable', 'target_doc_type', 'target_doc_num',
  'comments', 'raw_data',
];

function lineCollections(ticket) {
  const out = [];
  for (const [prop, val] of Object.entries(ticket)) {
    if (!Array.isArray(val) || /attach/i.test(prop)) continue;
    const type = /labor/i.test(prop) ? 'labor' : /equip/i.test(prop) ? 'equipment' : /mat/i.test(prop) ? 'material' : null;
    if (type) out.push([type, val]);
  }
  return out;
}

function mapFieldTicket(t) {
  const lines = [];
  const projects = new Map();
  const targets = new Set();
  let targetType = null;

  for (const [type, collection] of lineCollections(t)) {
    for (const l of collection) {
      const st = num(l.U_ST);
      const ot = num(l.U_OT);
      const pd = num(l.U_PD);
      const project = str(l.U_PrjCode);
      if (project) projects.set(project, (projects.get(project) || 0) + 1);
      const tdn = str(l.U_CRCSTDN);
      if (tdn && tdn !== '0') {
        targets.add(tdn);
        targetType = targetType || str(l.U_CRCSTDT);
      }
      lines.push({
        doc_entry: t.DocEntry,
        line_type: type,
        line_id: int(l.LineId) ?? lines.length + 1,
        work_date: date(l.U_LaborDate),
        employee_id: type === 'labor' ? str(l.U_EmpId) : null,
        employee_name: type === 'labor' ? str(l.U_EmpName) : null,
        work_type: type === 'labor' ? str(l.U_WorkType) : null,
        item_code: type === 'labor' ? null : str(l.U_ItemCode),
        item_name: type === 'labor' ? null : str(l.U_ItemName),
        quantity: type === 'labor' ? (st || 0) + (ot || 0) + (pd || 0) : num(l.U_Qty ?? l.U_Units),
        st_hours: type === 'labor' ? st : null,
        ot_hours: type === 'labor' ? ot : null,
        pd_hours: type === 'labor' ? pd : null,
        st_rate: num(l.U_STRate),
        ot_rate: num(l.U_OTRate),
        pd_rate: num(l.U_PDRate),
        price: num(l.U_Price),
        amount: num(l.U_Amount),
        project_code: project,
        billable: str(l.U_Billable),
        target_doc_type: str(l.U_CRCSTDT),
        target_doc_num: tdn && tdn !== '0' ? tdn : null,
        comments: str(l.U_Comments),
        raw_data: JSON.stringify(compact(l)),
      });
    }
  }

  let jobCode = null;
  let best = 0;
  for (const [code, n] of projects) if (n > best) [jobCode, best] = [code, n];

  const header = {
    doc_entry: t.DocEntry,
    doc_num: int(t.DocNum),
    series: int(t.Series),
    ticket_date: date(t.U_date),
    customer_code: str(t.U_cardCode),
    customer_name: str(t.U_cardName),
    job_code: jobCode,
    contact: str(t.U_contact),
    description: str(t.U_description),
    ref1: str(t.U_ref1),
    ref2: str(t.U_ref2),
    ref3: str(t.U_ref3),
    ref4: str(t.U_ref4),
    ref5: str(t.U_ref5),
    ref6: str(t.U_ref6),
    ship_to_code: str(t.U_shipToCode),
    status: str(t.Status),
    canceled: yes(t.Canceled),
    approved: yes(t.U_approved),
    first_level_approved: yes(t.U_firstLevelApproved),
    approved_date: date(t.U_approvedDate),
    approved_by: str(t.U_approvedUser),
    labor_total: num(t.U_laborTotal),
    equipment_total: num(t.U_equipTotal),
    material_total: num(t.U_matTotal),
    doc_total: num(t.U_docTotal),
    billed_doc_type: targetType,
    billed_doc_nums: targets.size ? [...targets].join(',') : null,
    created_date: date(t.CreateDate),
    updated_date: date(t.UpdateDate),
    raw_data: JSON.stringify(compact(t)),
  };
  return { header, lines };
}

const AR_COLS = [
  'doc_entry', 'doc_num', 'series', 'doc_date', 'due_date', 'customer_code', 'customer_name',
  'customer_ref', 'project', 'doc_total', 'tax_total', 'paid_to_date', 'document_status',
  'cancelled', 'comments', 'journal_memo', 'created_date', 'updated_date', 'raw_data',
];
const ARL_COLS = [
  'doc_entry', 'line_num', 'item_code', 'description', 'quantity', 'price', 'line_total',
  'project_code', 'account_code', 'base_type', 'base_entry', 'field_ticket_doc_type',
  'field_ticket_doc_num', 'work_details', 'raw_data',
];
const AR_SELECT = [
  'DocEntry', 'DocNum', 'Series', 'DocDate', 'DocDueDate', 'CardCode', 'CardName', 'NumAtCard',
  'Project', 'DocTotal', 'VatSum', 'PaidToDate', 'DocumentStatus', 'Cancelled', 'Comments',
  'JournalMemo', 'CreationDate', 'UpdateDate', 'DocCurrency', 'Reference1', 'Reference2',
  'DocumentLines',
].join(',');

function mapArDocument(d) {
  const header = {
    doc_entry: d.DocEntry,
    doc_num: int(d.DocNum),
    series: int(d.Series),
    doc_date: date(d.DocDate),
    due_date: date(d.DocDueDate),
    customer_code: str(d.CardCode),
    customer_name: str(d.CardName),
    customer_ref: str(d.NumAtCard),
    project: str(d.Project),
    doc_total: num(d.DocTotal),
    tax_total: num(d.VatSum),
    paid_to_date: num(d.PaidToDate),
    document_status: str(d.DocumentStatus),
    cancelled: yes(d.Cancelled),
    comments: str(d.Comments),
    journal_memo: str(d.JournalMemo),
    created_date: date(d.CreationDate),
    updated_date: date(d.UpdateDate),
    raw_data: JSON.stringify(compact(d)),
  };
  const lines = (d.DocumentLines || []).map((l, i) => {
    const bdn = str(l.U_CRCSBDN);
    return {
      doc_entry: d.DocEntry,
      line_num: int(l.LineNum) ?? i,
      item_code: str(l.ItemCode),
      description: str(l.ItemDescription),
      quantity: num(l.Quantity),
      price: num(l.Price ?? l.UnitPrice),
      line_total: num(l.LineTotal),
      project_code: str(l.ProjectCode),
      account_code: str(l.AccountCode),
      base_type: int(l.BaseType),
      base_entry: int(l.BaseEntry),
      field_ticket_doc_type: str(l.U_CRCSBDT),
      field_ticket_doc_num: bdn && bdn !== '0' ? bdn : null,
      work_details: str(l.U_WorkDetails),
      raw_data: JSON.stringify(compact(l)),
    };
  });
  return { header, lines };
}

/** Document entities, synced by DocEntry keyset. Order = slice order. */
const DOC_ENTITIES = [
  { key: 'field_tickets', path: 'CRCS_oFieldTicket', table: 'field_tickets', linesTable: 'field_ticket_lines',
    cols: FT_COLS, lineCols: FTL_COLS, lineKey: ['doc_entry', 'line_type', 'line_id'], map: mapFieldTicket },
  { key: 'ar_invoices', path: 'Invoices', table: 'ar_invoices', linesTable: 'ar_invoice_lines',
    cols: AR_COLS, lineCols: ARL_COLS, lineKey: ['doc_entry', 'line_num'], map: mapArDocument, select: AR_SELECT },
  { key: 'ar_credit_memos', path: 'CreditNotes', table: 'ar_credit_memos', linesTable: 'ar_credit_memo_lines',
    cols: AR_COLS, lineCols: ARL_COLS, lineKey: ['doc_entry', 'line_num'], map: mapArDocument, select: AR_SELECT },
  { key: 'delivery_notes', path: 'DeliveryNotes', table: 'delivery_notes', linesTable: 'delivery_note_lines',
    cols: AR_COLS, lineCols: ARL_COLS, lineKey: ['doc_entry', 'line_num'], map: mapArDocument, select: AR_SELECT },
];

// ── Service Layer client ─────────────────────────────────────────────────────
class ServiceLayer {
  constructor() {
    this.base = (process.env.SAP_BASE_URL || process.env.SAP_B1_BASE_URL || '').replace(/\/+$/, '');
    this.user = process.env.SAP_USERNAME || process.env.SAP_B1_USER;
    this.password = process.env.SAP_PASSWORD || process.env.SAP_B1_PASSWORD;
    this.companyDb = process.env.SAP_COMPANY_DB || process.env.SAP_B1_COMPANY_DB;
    this.timeoutMs = parseInt(process.env.SAP_B1_TIMEOUT_MS || '180000', 10);
    // The Service Layer presents a self-signed certificate.
    this.agent = new https.Agent({ rejectUnauthorized: false, keepAlive: true });
    this.cookie = null;
    this.expiresAt = 0;
  }

  raw(method, path, { body, headers = {} } = {}) {
    const url = new URL(`${this.base}/b1s/v1/${path}`);
    const payload = body ? JSON.stringify(body) : null;
    return new Promise((resolve, reject) => {
      const req = https.request(
        url,
        {
          method,
          agent: this.agent,
          headers: {
            Accept: 'application/json',
            ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
            ...(this.cookie ? { Cookie: this.cookie } : {}),
            ...headers,
          },
        },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            let json = null;
            try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON error page */ }
            resolve({ status: res.statusCode, headers: res.headers, json, text });
          });
        }
      );
      req.setTimeout(this.timeoutMs, () => req.destroy(Object.assign(new Error(`SAP request timed out after ${this.timeoutMs}ms`), { code: 'ETIMEDOUT' })));
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  async login() {
    this.cookie = null;
    const res = await this.raw('POST', 'Login', {
      body: { UserName: this.user, Password: this.password, CompanyDB: this.companyDb },
    });
    if (res.status !== 200) {
      throw new Error(`SAP login failed (HTTP ${res.status}): ${res.json?.error?.message?.value || res.text.slice(0, 200)}`);
    }
    this.cookie = (res.headers['set-cookie'] || []).map((c) => c.split(';')[0]).join('; ');
    // Renew a minute before the Service Layer's idle timeout.
    this.expiresAt = Date.now() + ((res.json?.SessionTimeout || 30) - 1) * 60000;
  }

  async logout() {
    if (!this.cookie) return;
    await this.raw('POST', 'Logout').catch(() => {});
    this.cookie = null;
  }

  /** GET with re-login on 401 and backoff on timeouts / 5xx. Throws on 4xx. */
  async get(path, { headers } = {}) {
    let lastErr;
    for (let attempt = 1; attempt <= 4; attempt++) {
      if (!this.cookie || Date.now() >= this.expiresAt) await this.login();
      let res;
      try {
        res = await this.raw('GET', path, { headers });
      } catch (err) {
        lastErr = err;
        if (err.code === 'ETIMEDOUT' && attempt >= 2) throw err; // caller shrinks the page
        await new Promise((r) => setTimeout(r, 5000 * attempt));
        continue;
      }
      if (res.status === 401) { this.cookie = null; continue; }
      if (res.status >= 500 || res.status === 429) {
        lastErr = new Error(`SAP HTTP ${res.status}: ${res.json?.error?.message?.value || res.text.slice(0, 200)}`);
        await new Promise((r) => setTimeout(r, 5000 * attempt));
        continue;
      }
      if (res.status >= 400) {
        throw Object.assign(new Error(`SAP HTTP ${res.status}: ${res.json?.error?.message?.value || res.text.slice(0, 200)}`), { status: res.status });
      }
      return res.json;
    }
    throw lastErr || new Error('SAP request failed after retries');
  }

  /** One keyset page: DocEntry > after, ascending. */
  async page(path, { after, top, filter, select }) {
    const parts = [`$filter=${encodeURIComponent(`DocEntry gt ${after}${filter ? ` and ${filter}` : ''}`)}`,
      `$orderby=${encodeURIComponent('DocEntry asc')}`, `$top=${top}`];
    if (select) parts.push(`$select=${select}`);
    const json = await this.get(`${path}?${parts.join('&')}`, { headers: { Prefer: `odata.maxpagesize=${top}` } });
    return json?.value || [];
  }

  /** Follow nextLink through a whole (small) entity set. */
  async all(pathWithQuery) {
    const out = [];
    let next = pathWithQuery;
    for (let i = 0; next && i < 2000; i++) {
      const json = await this.get(next, { headers: { Prefer: 'odata.maxpagesize=500' } });
      out.push(...(json?.value || []));
      const link = json?.['odata.nextLink'] || json?.['@odata.nextLink'];
      next = link ? String(link).replace(/^\/?(b1s\/v[12]\/)?/, '') : null;
    }
    return out;
  }
}

// ── sync ─────────────────────────────────────────────────────────────────────
class SapB1History {
  constructor(pool) {
    if (!isConfigured()) throw new Error('SAP B1 not configured (SAP_BASE_URL / SAP_USERNAME / SAP_PASSWORD / SAP_COMPANY_DB)');
    this.pool = pool;
    this.sl = new ServiceLayer();
    this.pageSize = parseInt(process.env.SAP_B1_PAGE_SIZE || '100', 10);
    this.sliceMs = parseFloat(process.env.SAP_B1_SLICE_MIN || '5') * 60000;
    this.selectBroken = new Set();
    this.pageSizes = {};
  }

  async state(entity) {
    await this.pool.query(
      `INSERT INTO ${SCHEMA}.sync_state (entity, backfill_started_at, changes_since)
       VALUES ($1, NOW(), CURRENT_DATE) ON CONFLICT (entity) DO NOTHING`,
      [entity]
    );
    // DATE as text: node-postgres turns DATE into a local-midnight Date, which
    // can shift the watermark by a day once serialized.
    const { rows } = await this.pool.query(
      `SELECT *, changes_since::text AS changes_since FROM ${SCHEMA}.sync_state WHERE entity = $1`,
      [entity]
    );
    return rows[0];
  }

  async markRun(entity, status, error = null) {
    await this.pool.query(
      `UPDATE ${SCHEMA}.sync_state SET last_run_at = NOW(), last_status = $2, last_error = $3 WHERE entity = $1`,
      [entity, status, error ? String(error).slice(0, 1000) : null]
    );
  }

  /** Fetch one page, shrinking it when the Service Layer times out. */
  async fetchPage(spec, after, filter) {
    let top = this.pageSizes[spec.key] || this.pageSize;
    for (;;) {
      try {
        const select = spec.select && !this.selectBroken.has(spec.key) ? spec.select : null;
        const rows = await this.sl.page(spec.path, { after, top, filter, select });
        this.pageSizes[spec.key] = top;
        return rows;
      } catch (err) {
        if (err.status === 400 && spec.select && !this.selectBroken.has(spec.key)) {
          console.warn(`[SAP B1] ${spec.path} rejected $select (${err.message}); fetching full records`);
          this.selectBroken.add(spec.key);
          continue;
        }
        if (err.code === 'ETIMEDOUT' && top > 10) {
          top = Math.max(10, Math.floor(top / 2));
          console.warn(`[SAP B1] ${spec.path} page timed out; retrying at ${top} rows`);
          continue;
        }
        throw err;
      }
    }
  }

  /** Write one page and (optionally) advance the cursor, atomically. */
  async storePage(spec, records, { advanceCursor }) {
    const headers = [];
    const lines = [];
    for (const r of records) {
      const { header, lines: l } = spec.map(r);
      headers.push(header);
      lines.push(...l);
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await bulkUpsert(client, `${SCHEMA}.${spec.table}`, spec.cols, dedupe(headers, ['doc_entry']), ['doc_entry'], { touch: true });
      const entries = headers.map((h) => h.doc_entry);
      await client.query(`DELETE FROM ${SCHEMA}.${spec.linesTable} WHERE doc_entry = ANY($1::int[])`, [entries]);
      await bulkUpsert(client, `${SCHEMA}.${spec.linesTable}`, spec.lineCols, dedupe(lines, spec.lineKey), spec.lineKey);
      const maxEntry = Math.max(...entries);
      await client.query(
        `UPDATE ${SCHEMA}.sync_state
            SET rows_synced = rows_synced + $2,
                backfill_cursor = CASE WHEN $3 THEN GREATEST(backfill_cursor, $4) ELSE backfill_cursor END
          WHERE entity = $1`,
        [spec.key, headers.length, advanceCursor, maxEntry]
      );
      await client.query('COMMIT');
      return maxEntry;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Pull new documents past the cursor until caught up or the slice ends.
   * Returns true when there is nothing left to fetch.
   */
  async pullNew(spec, deadline) {
    let { backfill_cursor: cursor } = await this.state(spec.key);
    while (Date.now() < deadline) {
      const rows = await this.fetchPage(spec, cursor);
      if (!rows.length) return true;
      cursor = await this.storePage(spec, rows, { advanceCursor: true });
    }
    return false;
  }

  /** Re-pull documents updated since the watermark (status changes, payments). */
  async pullChanges(spec) {
    const since = date((await this.state(spec.key)).changes_since);
    if (!since) return 0;
    const startedOn = new Date().toISOString().slice(0, 10);
    let after = 0;
    let n = 0;
    for (;;) {
      const rows = await this.fetchPage(spec, after, `UpdateDate ge '${since}'`);
      if (!rows.length) break;
      after = await this.storePage(spec, rows, { advanceCursor: false });
      n += rows.length;
    }
    // Overlap by a day: UpdateDate has no time component in the filter.
    await this.pool.query(
      `UPDATE ${SCHEMA}.sync_state SET changes_since = ($2::date - 1) WHERE entity = $1`,
      [spec.key, startedOn]
    );
    return n;
  }

  async refreshReference() {
    const bps = await this.sl.all('BusinessPartners?$select=CardCode,CardName,CardType,Valid,Frozen,Phone1,EmailAddress');
    const projects = await this.sl.all('Projects?$select=Code,Name,Active,ValidFrom,ValidTo');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await bulkUpsert(
        client, `${SCHEMA}.business_partners`,
        ['card_code', 'card_name', 'card_type', 'active', 'phone', 'email', 'raw_data'],
        dedupe(bps.filter((b) => b.CardCode).map((b) => ({
          card_code: b.CardCode, card_name: str(b.CardName), card_type: str(b.CardType),
          active: b.Valid !== 'tNO' && b.Frozen !== 'tYES', phone: str(b.Phone1), email: str(b.EmailAddress),
          raw_data: JSON.stringify(compact(b)),
        })), ['card_code']),
        ['card_code'], { touch: true }
      );
      await bulkUpsert(
        client, `${SCHEMA}.projects`,
        ['code', 'name', 'active', 'valid_from', 'valid_to'],
        dedupe(projects.filter((p) => p.Code).map((p) => ({
          code: p.Code, name: str(p.Name), active: p.Active === 'tYES', valid_from: date(p.ValidFrom), valid_to: date(p.ValidTo),
        })), ['code']),
        ['code'], { touch: true }
      );
      await client.query(
        `INSERT INTO ${SCHEMA}.sync_state (entity, backfill_complete, backfill_completed_at, rows_synced, last_run_at, last_status)
         VALUES ('reference', TRUE, NOW(), $1, NOW(), 'ok')
         ON CONFLICT (entity) DO UPDATE SET rows_synced = EXCLUDED.rows_synced, last_run_at = NOW(), last_status = 'ok', last_error = NULL`,
        [bps.length + projects.length]
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    return { business_partners: bps.length, projects: projects.length };
  }

  /**
   * One scheduled run. While any backfill is unfinished this keeps cycling
   * through the entities a slice at a time until all are caught up, calling
   * onRound after each full cycle; afterwards a run is a quick incremental
   * pass (new documents + documents updated since the last pass).
   */
  async run({ onRound } = {}) {
    await this.pool.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
    const summary = {};
    try {
      const refState = await this.pool
        .query(`SELECT last_run_at FROM ${SCHEMA}.sync_state WHERE entity = 'reference'`)
        .then((r) => r.rows[0]);
      if (!refState?.last_run_at || Date.now() - new Date(refState.last_run_at).getTime() > 20 * 3600000) {
        summary.reference = await this.refreshReference().catch((err) => {
          console.warn('[SAP B1] reference refresh failed:', err.message);
          return { error: err.message };
        });
      }

      let pending = DOC_ENTITIES;
      for (let round = 1; pending.length; round++) {
        const stillPending = [];
        for (const spec of pending) {
          const st = await this.state(spec.key);
          try {
            const caughtUp = await this.pullNew(spec, Date.now() + this.sliceMs);
            if (!caughtUp) {
              stillPending.push(spec);
              await this.markRun(spec.key, 'backfilling');
              continue;
            }
            if (!st.backfill_complete) {
              await this.pool.query(
                `UPDATE ${SCHEMA}.sync_state SET backfill_complete = TRUE, backfill_completed_at = NOW() WHERE entity = $1`,
                [spec.key]
              );
              console.log(`[SAP B1] ${spec.key}: backfill complete`);
            } else {
              summary[`${spec.key}_changed`] = await this.pullChanges(spec).catch((err) => {
                // UpdateDate filtering is optional — new documents still flow.
                console.warn(`[SAP B1] ${spec.key} change pass failed: ${err.message}`);
                return 0;
              });
            }
            await this.markRun(spec.key, 'ok');
          } catch (err) {
            console.warn(`[SAP B1] ${spec.key} failed: ${err.message}`);
            await this.markRun(spec.key, 'error', err.message);
          }
        }
        const counts = await this.progress();
        console.log(`[SAP B1] round ${round}: ${counts.map((c) => `${c.entity}=${c.rows_synced}${c.backfill_complete ? '' : '…'}`).join(' ')}`);
        if (onRound) await onRound(round).catch(() => {});
        pending = stillPending;
      }
      summary.progress = await this.progress();
      return summary;
    } finally {
      await this.sl.logout();
    }
  }

  async progress() {
    const { rows } = await this.pool.query(
      `SELECT entity, rows_synced, backfill_cursor, backfill_complete, last_status, last_run_at
         FROM ${SCHEMA}.sync_state ORDER BY entity`
    );
    return rows;
  }
}

/** Coverage summary for data-source listings: row counts and date span per table. */
async function coverage(pool) {
  const { rows } = await pool.query(`
    SELECT 'field_tickets' AS entity, COUNT(*)::int AS rows, MIN(ticket_date)::text AS earliest, MAX(ticket_date)::text AS latest FROM sap_b1.field_tickets
    UNION ALL SELECT 'ar_invoices', COUNT(*)::int, MIN(doc_date)::text, MAX(doc_date)::text FROM sap_b1.ar_invoices
    UNION ALL SELECT 'ar_credit_memos', COUNT(*)::int, MIN(doc_date)::text, MAX(doc_date)::text FROM sap_b1.ar_credit_memos
    UNION ALL SELECT 'delivery_notes', COUNT(*)::int, MIN(doc_date)::text, MAX(doc_date)::text FROM sap_b1.delivery_notes`);
  const state = await pool.query(`SELECT entity, backfill_complete, last_run_at FROM sap_b1.sync_state`);
  const byEntity = Object.fromEntries(state.rows.map((s) => [s.entity, s]));
  return rows.map((r) => ({
    ...r,
    backfill_complete: byEntity[r.entity]?.backfill_complete || false,
    last_run_at: byEntity[r.entity]?.last_run_at || null,
  }));
}

module.exports = { SapB1History, ServiceLayer, isConfigured, coverage, mapFieldTicket, mapArDocument, DOC_ENTITIES };
