/**
 * Paycom employee master → paycom.employees (work profile only).
 *
 * Before this the agent saw Paycom only as time punches in the billing
 * platform, so "how many employees do we have" was answered with a count of
 * people who clocked in, and office staff, people on leave and new hires who
 * had not hit a pay cycle all went missing (Oct 2, 2026: 311 / 337 against
 * Paycom's 342).
 *
 * Only the columns in COLUMNS are ever written. Paycom's employee record also
 * carries pay, address, phone, birth date, emergency contacts and EEO data;
 * those stay in Paycom until the agent can scope them per manager the way
 * Paycom does.
 */

const { bulkUpsert, dedupe } = require('./sapB1History');

const COLUMNS = {
  eecode: 'eecode',
  employee_name: 'employee_name',
  first_name: 'firstname',
  last_name: 'lastname',
  preferred_first_name: 'preferred_first_name',
  employee_status: 'employee_status',
  department_code: 'department_code',
  department_description: 'department_description',
  location: 'location',
  cat1: 'cat1',
  cat1_desc: 'cat1desc',
  cat2: 'cat2',
  cat2_desc: 'cat2desc',
  business_title: 'business_title',
  position_title: 'position_title',
  position_family_name: 'position_family_name',
  supervisor_primary: 'supervisor_primary',
  supervisor_primary_code: 'supervisor_primary_code',
  fulltime_or_parttime: 'fulltime_or_parttime',
  hourly_or_salary: 'hourly_or_salary',
  hire_date: 'hire_date',
  rehire_date: 'rehire_date',
  termination_date: 'termination_date',
  previous_termination_date: 'previous_termination_date',
  termination_type: 'termination_type',
  last_position_change_date: 'last_position_change_date',
  company_establishment_id: 'companyEstablishmentId',
  company_location_id: 'companyLocationId',
};
const DATE_COLUMNS = new Set([
  'hire_date', 'rehire_date', 'termination_date', 'previous_termination_date', 'last_position_change_date',
]);

function credential(name) {
  return String(process.env[name] || '').trim().replace(/^["']+|["']+$/g, '').trim();
}

function isConfigured() {
  return Boolean(credential('PAYCOM_SID') && credential('PAYCOM_TOKEN'));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function text(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s : null;
}

/** Paycom sends YYYY-MM-DD, MM/DD/YYYY, or 0000-00-00 for "none". */
function toDate(v) {
  const s = text(v);
  if (!s || s.startsWith('0000')) return null;
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  return null;
}

function mapEmployee(rec) {
  const row = {};
  for (const [col, key] of Object.entries(COLUMNS)) {
    row[col] = DATE_COLUMNS.has(col) ? toDate(rec[key]) : text(rec[key]);
  }
  return row;
}

class PaycomSync {
  constructor(pool) {
    if (!isConfigured()) throw new Error('Paycom not configured (PAYCOM_SID / PAYCOM_TOKEN)');
    this.pool = pool;
    this.baseUrl = (process.env.PAYCOM_BASE_URL || 'https://api.paycomonline.net/v4/rest/index.php').replace(/\/+$/, '') + '/';
    this.auth = 'Basic ' + Buffer.from(`${credential('PAYCOM_SID')}:${credential('PAYCOM_TOKEN')}`).toString('base64');
    this.timeoutMs = parseInt(process.env.PAYCOM_TIMEOUT || '45000', 10);
    this.detailSleepMs = parseFloat(process.env.PAYCOM_DETAIL_SLEEP || '0.25') * 1000;
  }

  /** GET with backoff on 429 / 5xx / network errors. Returns { status, body }. */
  async get(path, params = {}) {
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    let lastErr;
    for (let attempt = 1; attempt <= 6; attempt++) {
      try {
        const res = await fetch(url, {
          headers: { Authorization: this.auth, Accept: 'application/json' },
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (res.status === 429 || res.status >= 500) {
          await sleep(Math.min(60000, 2 ** attempt * 1000));
          continue;
        }
        return { status: res.status, body: await res.json().catch(() => null) };
      } catch (err) {
        lastErr = err;
        await sleep(5000 * attempt);
      }
    }
    throw lastErr || new Error(`Paycom ${path}: retries exhausted`);
  }

  /** Every employee code, active and terminated. 206 means more pages. */
  async employeeCodes() {
    const codes = [];
    for (let page = 1; page < 1000; page++) {
      const { status, body } = await this.get('api/v1/employeeid/', { page, pagesize: 500 });
      if (status !== 200 && status !== 206) throw new Error(`Paycom employeeid: HTTP ${status}`);
      const rows = Array.isArray(body?.data) ? body.data : [];
      codes.push(...rows.map((r) => text(r.eecode)).filter(Boolean));
      if (status === 200 || !rows.length) break;
    }
    return [...new Set(codes)];
  }

  async employee(eecode) {
    const { status, body } = await this.get(`api/v1/employee/${encodeURIComponent(eecode)}`);
    if (status !== 200) return null;
    const data = body?.data;
    return Array.isArray(data) ? data[0] || null : data || null;
  }

  async sync() {
    const codes = await this.employeeCodes();
    const rows = [];
    let failed = 0;
    for (const code of codes) {
      const rec = await this.employee(code).catch(() => null);
      await sleep(this.detailSleepMs);
      if (rec) rows.push(mapEmployee({ ...rec, eecode: rec.eecode || code }));
      else failed++;
    }
    if (!rows.length) throw new Error(`Paycom returned ${codes.length} employee codes but no employee records`);

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await bulkUpsert(client, 'paycom.employees', Object.keys(COLUMNS), dedupe(rows, ['eecode']), ['eecode'], { touch: true });
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    const active = rows.filter((r) => r.employee_status === 'A').length;
    return { codes: codes.length, stored: rows.length, failed, active };
  }
}

module.exports = { PaycomSync, isConfigured, mapEmployee, toDate };
