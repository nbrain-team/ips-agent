/**
 * SAP S/4HANA Cloud (IPS's system of record from the August 1, 2026 cutover),
 * copied into the sap_s4 schema from the read-only CDS views VistaVu exposed
 * on Communication Arrangement YY1_CUSTOM_INTEGRATION (OData V2, Basic auth).
 *
 * The views carry no last-changed timestamps, so there is no delta: master
 * data is replaced in full every run; journal and billing items replace a
 * rolling window by posting / billing date, with a full refresh once a day so
 * back-dated postings and reversal flags on older lines are picked up. Every
 * replace runs in one transaction and only commits when the rows pulled match
 * SAP's own $count for the same filter.
 *
 * Columns come from sapS4Schema.js, generated from the views' $metadata by
 * scripts/sap-s4-schema-gen.js. A field SAP adds later is reported as drift
 * in sap_s4.sync_state until the generator is re-run.
 *
 * SAP_S4_ENVIRONMENT says whether the tenant is IPS's production system. It
 * defaults to "test": the first tenant VistaVu connected (my432369) holds test
 * postings, and sap.gl_lines only includes S/4 rows when this is "production".
 * Pointing SAP_S4_BASE_URL at a different host wipes sap_s4 before loading.
 *
 * Env: SAP_S4_BASE_URL  SAP_S4_USERNAME  SAP_S4_PASSWORD
 * Optional: SAP_S4_ENVIRONMENT (test | production)  SAP_S4_PAGE_SIZE (5000)
 *           SAP_S4_TIMEOUT_MS (120000)  SAP_S4_WINDOW_DAYS (62)  SAP_S4_SYNC_INTERVAL_MIN (60)
 */

const https = require('https');
const { bulkUpsert, dedupe } = require('./sapB1History');
const SCHEMA_SPEC = require('./sapS4Schema');

const SCHEMA = 'sap_s4';
// Must match the date in sap.gl_lines (migration 045).
const CUTOVER_DATE = '2026-08-01';
const ODATA_PATH = '/sap/opu/odata/sap';
const FULL_REFRESH_MS = 20 * 3600000;

// view = the YY1_EXT_<view>_READ CDS view; dateField drives the rolling window;
// orderby replaces the key for paging where SAP cannot sort on it.
const ENTITIES = [
  { table: 'customers', view: 'CUSTOMER' },
  { table: 'suppliers', view: 'SUPPLIER' },
  { table: 'ship_to_partners', view: 'SHIP_TO' },
  { table: 'products', view: 'PRODUCT' },
  { table: 'gl_accounts', view: 'GLACCOUNT' },
  { table: 'cost_centers', view: 'COST_CENTER' },
  { table: 'profit_centers', view: 'PROFIT_CENTER' },
  {
    table: 'journal_entry_items',
    view: 'JOURNALS',
    dateField: 'PostingDate',
    // ID is generated from these ('.1~0L.2~1710.3~2026.4~0100000000.5~000001.6~0L') and is not sortable.
    orderby: 'SourceLedger,CompanyCode,FiscalYear,AccountingDocument,LedgerGLLineItem,Ledger',
  },
  { table: 'billing_document_items', view: 'BILLDOCITEM', dateField: 'BillingDocumentDate' },
];

const serviceUrl = (view) => `${ODATA_PATH}/YY1_EXT_${view}_READ_CDS`;
const entitySetUrl = (view) => `${serviceUrl(view)}/YY1_EXT_${view}_READ`;

function isConfigured() {
  return Boolean(process.env.SAP_S4_BASE_URL && process.env.SAP_S4_USERNAME && process.env.SAP_S4_PASSWORD);
}

function environment() {
  return String(process.env.SAP_S4_ENVIRONMENT || 'test').toLowerCase() === 'production' ? 'production' : 'test';
}

const isProduction = () => isConfigured() && environment() === 'production';

function host() {
  return new URL(process.env.SAP_S4_BASE_URL).host;
}

// ── OData client ─────────────────────────────────────────────────────────────
class S4Client {
  constructor(opts = {}) {
    this.host = opts.host || host();
    this.auth = `Basic ${Buffer.from(
      `${opts.username || process.env.SAP_S4_USERNAME}:${opts.password || process.env.SAP_S4_PASSWORD}`
    ).toString('base64')}`;
    this.timeoutMs = opts.timeoutMs || parseInt(process.env.SAP_S4_TIMEOUT_MS || '120000', 10);
  }

  getOnce(path, accept) {
    return new Promise((resolve, reject) => {
      const req = https.get(
        { host: this.host, path, headers: { Authorization: this.auth, Accept: accept } },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
        }
      );
      req.setTimeout(this.timeoutMs, () => req.destroy(new Error(`timeout after ${this.timeoutMs}ms`)));
      req.on('error', reject);
    });
  }

  /** GET with retries on timeouts, dropped connections and 5xx. 401/403/404 fail at once. */
  async get(path, accept = 'application/json') {
    let lastErr;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await this.getOnce(path, accept);
        if (res.status === 200) return res.body;
        const sapMessage = (res.body.match(/"message":\{[^}]*"value":"([^"]+)"/) || res.body.match(/<message[^>]*>([^<]+)</) || [])[1];
        const err = new Error(`S/4 ${res.status} on ${path.split('?')[0]}${sapMessage ? `: ${sapMessage}` : ''}`);
        err.status = res.status;
        if (res.status < 500) throw err;
        lastErr = err;
      } catch (err) {
        if (err.status && err.status < 500) throw err;
        lastErr = err;
      }
      await new Promise((r) => setTimeout(r, attempt * 5000));
    }
    throw lastErr;
  }

  metadata(view) {
    return this.get(`${serviceUrl(view)}/$metadata`, 'application/xml');
  }

  async count(view, filter) {
    const qs = filter ? `?$filter=${encodeURIComponent(filter)}` : '';
    return parseInt(await this.get(`${entitySetUrl(view)}/$count${qs}`, 'text/plain'), 10);
  }

  /** Every record matching `filter`, one page at a time, in key order so $skip pages are stable. */
  async *pages(view, { filter, orderby, pageSize }) {
    for (let skip = 0; ; skip += pageSize) {
      const qs = [
        '$format=json',
        `$top=${pageSize}`,
        `$skip=${skip}`,
        `$orderby=${encodeURIComponent(orderby)}`,
        filter ? `$filter=${encodeURIComponent(filter)}` : null,
      ].filter(Boolean);
      const rows = JSON.parse(await this.get(`${entitySetUrl(view)}?${qs.join('&')}`)).d.results;
      if (rows.length) yield rows;
      if (rows.length < pageSize) return;
    }
  }
}

// ── value conversion (OData V2 JSON → Postgres) ──────────────────────────────
function toDate(v) {
  const m = v && String(v).match(/\/Date\((-?\d+)/);
  return m ? new Date(Number(m[1])).toISOString().slice(0, 10) : null;
}

function convert(v, col) {
  if (v === null || v === undefined) return null;
  switch (col.type) {
    case 'date':
      return toDate(v);
    case 'timestamptz': {
      const m = String(v).match(/\/Date\((-?\d+)/);
      return m ? new Date(Number(m[1])).toISOString() : String(v);
    }
    case 'numeric':
      return v === '' || !Number.isFinite(Number(v)) ? null : String(v);
    case 'integer':
    case 'bigint':
      return v === '' ? null : String(parseInt(v, 10));
    case 'boolean':
      return v === true || v === 'X' || v === 'true';
    case 'time': {
      const m = String(v).match(/PT(\d+)H(\d+)M(\d+)S/);
      return m ? `${m[1].padStart(2, '0')}:${m[2]}:${m[3]}` : null;
    }
    default: {
      // Key columns keep '' (SAP's "not set"); everywhere else empty means NULL.
      const s = String(v);
      return s === '' && !col.key ? null : s;
    }
  }
}

function toRow(record, spec) {
  const row = {};
  for (const col of spec.columns) row[col.column] = convert(record[col.field], col);
  return row;
}

/** Fields in the live $metadata that the generated spec does not have, and the reverse. */
function schemaDrift(xml, spec) {
  const view = spec.entityType;
  const block = (xml.match(new RegExp(`<EntityType Name="${view}"[\\s\\S]*?</EntityType>`)) || [''])[0];
  const live = new Set([...block.matchAll(/<Property Name="([^"]+)"/g)].map((m) => m[1]));
  const known = new Set(spec.columns.map((c) => c.field));
  return {
    added: [...live].filter((f) => !known.has(f)),
    removed: [...known].filter((f) => !live.has(f)),
  };
}

// ── sync ─────────────────────────────────────────────────────────────────────
class SapS4Sync {
  constructor(pool, opts = {}) {
    this.pool = pool;
    this.client = opts.client || new S4Client();
    this.pageSize = opts.pageSize || parseInt(process.env.SAP_S4_PAGE_SIZE || '5000', 10);
    this.windowDays = opts.windowDays || parseInt(process.env.SAP_S4_WINDOW_DAYS || '62', 10);
  }

  /** A different tenant (test → production) must never inherit the previous tenant's rows. */
  async ensureTenant() {
    const { rows } = await this.pool.query(`SELECT host FROM ${SCHEMA}.tenant WHERE id`);
    const current = this.client.host;
    if (rows.length && rows[0].host !== current) {
      console.warn(`[SAP S/4] tenant changed ${rows[0].host} → ${current}; clearing sap_s4 before loading`);
      const db = await this.pool.connect();
      try {
        await db.query('BEGIN');
        for (const e of ENTITIES) await db.query(`DELETE FROM ${SCHEMA}.${e.table}`);
        await db.query(`DELETE FROM ${SCHEMA}.sync_state`);
        await db.query('COMMIT');
      } catch (err) {
        await db.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        db.release();
      }
    }
    await this.pool.query(
      `INSERT INTO ${SCHEMA}.tenant (id, host, environment, updated_at) VALUES (TRUE, $1, $2, NOW())
       ON CONFLICT (id) DO UPDATE SET host = EXCLUDED.host, environment = EXCLUDED.environment, updated_at = NOW()`,
      [current, environment()]
    );
  }

  async state(table) {
    const { rows } = await this.pool.query(`SELECT * FROM ${SCHEMA}.sync_state WHERE entity = $1`, [table]);
    return rows[0] || {};
  }

  /**
   * Replace an entity's rows (all of them, or those dated on/after `since`)
   * with what SAP returns now. Commits only if the pull matches SAP's $count.
   */
  async replace(entity, since) {
    const spec = SCHEMA_SPEC[entity.table];
    const dateCol = entity.dateField && spec.columns.find((c) => c.field === entity.dateField).column;
    const filter = since ? `${entity.dateField} ge datetime'${since}T00:00:00'` : null;
    const cols = spec.columns.map((c) => c.column);
    const keyCols = spec.columns.filter((c) => c.key).map((c) => c.column);
    const orderby = entity.orderby || spec.columns.filter((c) => c.key).map((c) => c.field).join(',');
    const table = `${SCHEMA}.${entity.table}`;

    const expected = await this.client.count(entity.view, filter);
    const db = await this.pool.connect();
    try {
      await db.query('BEGIN');
      if (since) await db.query(`DELETE FROM ${table} WHERE ${dateCol} >= $1`, [since]);
      else await db.query(`DELETE FROM ${table}`);
      for await (const page of this.client.pages(entity.view, { filter, orderby, pageSize: this.pageSize })) {
        const rows = dedupe(page.map((r) => toRow(r, spec)), keyCols);
        await bulkUpsert(db, table, cols, rows, keyCols, { touch: true });
      }
      const { rows } = await db.query(
        `SELECT COUNT(*)::int AS n FROM ${table}${since ? ` WHERE ${dateCol} >= $1` : ''}`,
        since ? [since] : []
      );
      if (rows[0].n < expected) throw new Error(`loaded ${rows[0].n} of ${expected} rows SAP reports`);
      await db.query('COMMIT');
      return rows[0].n;
    } catch (err) {
      await db.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      db.release();
    }
  }

  async markRun(entity, fields) {
    const set = Object.keys(fields).map((k, i) => `${k} = $${i + 2}`);
    await this.pool.query(
      `INSERT INTO ${SCHEMA}.sync_state (entity, ${Object.keys(fields).join(', ')}) VALUES ($1, ${set
        .map((_, i) => `$${i + 2}`)
        .join(', ')})
       ON CONFLICT (entity) DO UPDATE SET ${set.join(', ')}`,
      [entity, ...Object.values(fields)]
    );
  }

  async run() {
    await this.ensureTenant();
    const summary = {};
    for (const entity of ENTITIES) {
      const st = await this.state(entity.table);
      const full = !entity.dateField || !st.last_full_at || Date.now() - new Date(st.last_full_at).getTime() > FULL_REFRESH_MS;
      const since = full
        ? null
        : new Date(Date.now() - this.windowDays * 86400000).toISOString().slice(0, 10);
      try {
        const rows = await this.replace(entity, since);
        const fields = { last_run_at: new Date(), last_status: 'ok', last_error: null, rows_in_window: rows };
        if (full) {
          fields.last_full_at = new Date();
          const drift = schemaDrift(await this.client.metadata(entity.view), SCHEMA_SPEC[entity.table]);
          fields.schema_drift = drift.added.length || drift.removed.length ? JSON.stringify(drift) : null;
          if (fields.schema_drift) {
            console.warn(`[SAP S/4] ${entity.table} fields changed in SAP (re-run scripts/sap-s4-schema-gen.js): ${fields.schema_drift}`);
          }
        }
        await this.markRun(entity.table, fields);
        summary[entity.table] = `${rows}${full ? '' : ` since ${since}`}`;
      } catch (err) {
        const status = err.status === 401 || err.status === 403 ? 'not_authorized' : 'error';
        console.warn(`[SAP S/4] ${entity.table} failed: ${err.message}`);
        await this.markRun(entity.table, { last_run_at: new Date(), last_status: status, last_error: err.message });
        summary[entity.table] = `${status}: ${err.message}`;
      }
    }
    await refreshCatalog(this.pool).catch(() => {});
    return summary;
  }
}

// ── catalog for prompts ──────────────────────────────────────────────────────
let catalog = { environment: environment(), host: null, tables: [] };

async function refreshCatalog(pool) {
  const [tenant, tables] = await Promise.all([
    pool.query(`SELECT host, environment FROM ${SCHEMA}.tenant WHERE id`),
    pool.query(
      `SELECT c.relname AS name, GREATEST(c.reltuples, 0)::bigint AS approx_rows
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = '${SCHEMA}' AND c.relkind IN ('r', 'p') AND c.relname NOT IN ('tenant', 'sync_state')
        ORDER BY c.relname`
    ),
  ]);
  catalog = {
    environment: tenant.rows[0]?.environment || environment(),
    host: tenant.rows[0]?.host || null,
    tables: tables.rows.map((r) => ({ name: `${SCHEMA}.${r.name}`, approxRows: Number(r.approx_rows) })),
  };
  return catalog;
}

const TABLE_GUIDE = `  Tables (schema sap_s4, one row per SAP record; every column carries SAP's field label as its comment):
    customers (customer), suppliers (supplier), ship_to_partners (customer + sales area + partner function), products (product; fieldvu_related flags FieldVu items),
    gl_accounts (chart_of_accounts 'YCOA' + gl_account), cost_centers / profit_centers (controlling_area + center + validity_end_date: filter validity_end_date >= CURRENT_DATE for the current record),
    journal_entry_items (id; the universal journal, one row per ledger line), billing_document_items (billing_document + billing_document_item; customer invoices and credit memos with FieldVu's field_ticket_no and job_no).
  How they connect:
    journal_entry_items.gl_account = gl_accounts.gl_account (chart_of_accounts = 'YCOA'); .customer = customers.customer; .supplier = suppliers.supplier; .cost_center = cost_centers.cost_center; .profit_center = profit_centers.profit_center.
    billing_document_items.sold_to_party / payer_party / bill_to_party / ship_to_party = customers.customer; .product = products.product.
    Billing to the ledger: journal_entry_items.reference_document_type = 'VBRK' AND reference_document = billing_document_items.billing_document. A billing document with no such journal line has not been posted to accounting.
    Billing to FieldVu: billing_document_items.billing_document = fieldvu.field_tickets.billing_document_id; billing_document_items.field_ticket_no is FieldVu's field ticket number, zero-padded.
  Money rules:
    Use ledger = '0L' only. Every 0L line is repeated in ledger '0E', which also has lines of its own, so mixing ledgers double-counts.
    amount_in_company_code_currency is signed: positive = debit, negative = credit. Activity = SUM(amount_in_company_code_currency); revenue = -SUM on revenue accounts. debit_credit_code is not the sign (reversals flip it); never sum debits or credits alone.
    Reversals: is_reversal / is_reversed mark both halves; both stay in the sum, which nets them out.
    company_code '1710' is IPS. fiscal_year / fiscal_period follow the calendar (period 001 = January).
    Revenue and P&L come from journal_entry_items, never from billing items: billed amounts include documents not yet posted.
    gl_accounts: is_balance_sheet_account separates balance sheet from P&L; gl_account_type 'S' (e.g. 999999 Service Time) is a secondary cost element for internal allocations, and 999997 Material Cost OH / 999998 Equipment Cost Alloc are allocation accounts. All three net to zero company-wide: leave them out of P&L totals, but they matter for a single profit center or cost center.
    Legacy B1 account numbers carry over without the dash ('541200-000' → '541200'); some lines use S/4 8-digit accounts (61008000, 11001050). Match on gl_accounts.gl_account and gl_account_name.
    Profit center and division: profit_center is mostly a location ('HOB', 'MID', 'LOV' Loving, 'CORP'), sometimes division + location ('100HOB'). The division is the first three digits of cost_center ('100HOBB' = Hobbs Electrical), else of profit_center, else organization_division × 10 ('10' = 100). sap.gl_lines applies this rule.
    Billing credit memos: sales_document_item_category 'G2W' / 'G2N' / 'SG2N' items are credit memos and carry positive amounts: subtract them for net billing. Cancelled billing documents cannot be identified yet (there is no billing document type or cancellation flag).
  sync_state shows when each table last loaded and any error. last_status 'not_authorized' means SAP refused the read: say that table is not available yet.`;

function catalogText() {
  const tables = catalog.tables.length
    ? catalog.tables.map((t) => `${t.name}${t.approxRows > 0 ? ` (~${t.approxRows.toLocaleString()})` : ''}`).join(', ')
    : ENTITIES.map((e) => `${SCHEMA}.${e.table}`).join(', ');
  if (catalog.environment !== 'production') {
    return `SAP S/4HANA TEST tenant${catalog.host ? ` (${catalog.host})` : ''}: VistaVu's test system, NOT IPS's books. It is loaded in schema sap_s4 (${tables}) so its structure can be checked.
  Never use sap_s4.* to answer a question about IPS's real revenue, costs, customers, invoices, balances or tickets, and never combine it with SAP B1 or FieldVu figures. For IPS money after July 31, 2026, say production S/4HANA is not connected yet.
  Query sap_s4.* only when the user asks about the S/4 test system, and label every figure "S/4 TEST tenant".
${TABLE_GUIDE}`;
  }
  return `SAP S/4HANA (IPS's system of record from August 1, 2026), via query_operational_database: ${tables}.
${TABLE_GUIDE}`;
}

/** Row counts, date span and last load per table, for data-source listings. */
async function coverage(pool) {
  const { rows } = await pool.query(`
    SELECT e.entity, s.last_status, s.last_run_at, s.last_full_at, s.last_error, e.rows, e.earliest, e.latest
      FROM (
        SELECT 'journal_entry_items' AS entity, COUNT(*)::int AS rows, MIN(posting_date)::text AS earliest, MAX(posting_date)::text AS latest FROM ${SCHEMA}.journal_entry_items
        UNION ALL SELECT 'billing_document_items', COUNT(*)::int, MIN(billing_document_date)::text, MAX(billing_document_date)::text FROM ${SCHEMA}.billing_document_items
        UNION ALL SELECT 'customers', COUNT(*)::int, NULL, NULL FROM ${SCHEMA}.customers
        UNION ALL SELECT 'suppliers', COUNT(*)::int, NULL, NULL FROM ${SCHEMA}.suppliers
        UNION ALL SELECT 'ship_to_partners', COUNT(*)::int, NULL, NULL FROM ${SCHEMA}.ship_to_partners
        UNION ALL SELECT 'products', COUNT(*)::int, NULL, NULL FROM ${SCHEMA}.products
        UNION ALL SELECT 'gl_accounts', COUNT(*)::int, NULL, NULL FROM ${SCHEMA}.gl_accounts
        UNION ALL SELECT 'cost_centers', COUNT(*)::int, NULL, NULL FROM ${SCHEMA}.cost_centers
        UNION ALL SELECT 'profit_centers', COUNT(*)::int, NULL, NULL FROM ${SCHEMA}.profit_centers
      ) e
      LEFT JOIN ${SCHEMA}.sync_state s ON s.entity = e.entity`);
  return rows;
}

module.exports = {
  SapS4Sync, S4Client, ENTITIES, TABLE_GUIDE, CUTOVER_DATE, isConfigured, environment, isProduction, refreshCatalog,
  catalogText, coverage, toRow, schemaDrift,
};
