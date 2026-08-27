/**
 * fieldvu — FieldVu Cloud API client (VistaVu field-service platform).
 *
 * IPS runs FieldVu on top of SAP Business One for field operations: jobs,
 * equipment, field tickets, work orders, workers, items, and inventory.
 * Auth is HTTP Basic with a dedicated API user; all data is company-scoped
 * by FIELDVU_COMPANY_ID.
 *
 * Two hosts:
 *  - api.fieldvu.io/v1        → OData entity sets (Jobs, OrgEquipment, ...)
 *  - mobileapi.fieldvu.io/v1  → field tickets + work orders (function endpoints)
 */

const API = 'https://api.fieldvu.io/v1';
const MOBILE = 'https://mobileapi.fieldvu.io/v1';

function isConfigured() {
  return !!(
    process.env.FIELDVU_USERNAME &&
    process.env.FIELDVU_PASSWORD &&
    process.env.FIELDVU_COMPANY_ID
  );
}

function companyId() {
  return process.env.FIELDVU_COMPANY_ID;
}

function authHeader() {
  const creds = `${process.env.FIELDVU_USERNAME}:${process.env.FIELDVU_PASSWORD}`;
  return `Basic ${Buffer.from(creds).toString('base64')}`;
}

/** GET with basic auth + retry on 429/503. Returns parsed JSON. */
async function fvGet(url) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url, {
      headers: { Authorization: authHeader(), Accept: 'application/json' },
    });
    if (res.status === 429 || res.status === 503) {
      const wait = (parseInt(res.headers.get('retry-after') || '3', 10) + 1) * 1000;
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    if (res.status === 401) throw new Error('FieldVu authentication failed (check FIELDVU_USERNAME/PASSWORD)');
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`FieldVu API ${res.status}: ${body.slice(0, 300)}`);
    }
    return res.json();
  }
  throw new Error('FieldVu API rate limit: retries exhausted');
}

module.exports = { isConfigured, companyId, fvGet, API, MOBILE };
