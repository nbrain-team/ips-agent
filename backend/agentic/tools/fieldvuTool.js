/**
 * query_fieldvu — live queries against FieldVu Cloud (IPS's field-service
 * platform on SAP S/4HANA since the 2026 cutover): jobs, equipment, field
 * tickets, work orders, workers, customers, items, inventory, and the
 * third-party billing lines charged to jobs.
 *
 * This is LIVE operational data straight from FieldVu — always current. It
 * starts Feb 6, 2026; the SAP B1 history before that lives in sap_b1.*.
 */
const fieldvu = require('../services/fieldvu');

// entity → { host, path builder, supports OData query options }
const ENTITIES = {
  jobs: { base: () => `${fieldvu.API}/Jobs`, odata: true, select: true },
  equipment: { base: () => `${fieldvu.API}/OrgEquipment`, odata: true, select: true },
  equipment_types: { base: () => `${fieldvu.API}/OrgEquipmentTypes`, odata: true, select: true },
  workers: { base: () => `${fieldvu.API}/OrgWorkers?$expand=orgWorkerWorkTypes`, odata: true },
  customers: { base: () => `${fieldvu.API}/OrgBusinessPartners?$expand=orgBusinessPartnerAddresses`, odata: true },
  items: { base: () => `${fieldvu.API}/OrgItems`, odata: true, select: true },
  inventory: {
    base: () =>
      `${fieldvu.API}/ItemUnitOfMeasureInventories` +
      `?$select=inventoryLocation,inventoryLocationDescription,erpInventoryReported,nonSubmittedTicketConsumption,submittedTicketConsumption,updatedOn` +
      `&$expand=itemUnitOfMeasure($select=orgUnitOfMeasure,item;$expand=orgUnitOfMeasure($select=code),item($select=code;$expand=orgItem($select=code,name,isCurrentlyActive))),companyBranch($select=code,name)` +
      `&$filter=(itemUnitOfMeasure/item/orgItem/isCurrentlyActive eq true)`,
    odata: true,
    hasFilter: true,
  },
  price_lists: { base: () => `${fieldvu.API}/PriceLists?$expand=orgBusinessPartner`, odata: true },
  branches: { base: () => `${fieldvu.API}/CompanyBranches`, odata: true, select: true },
  billing_items: { base: () => `${fieldvu.API}/BillingItems`, odata: true, select: true },
  field_tickets: {
    base: () => `${fieldvu.MOBILE}/GetFieldTicketLimitedHeaders(companyId=${fieldvu.companyId()})`,
    odata: true,
  },
  field_ticket_detail: { base: (id) => `${fieldvu.MOBILE}/FieldTickets(${id})`, needsId: true },
  work_orders: {
    base: () => `${fieldvu.MOBILE}/GetWorkOrderLimitedHeaders(companyId=${fieldvu.companyId()})`,
    odata: true,
  },
  work_order_detail: { base: (id) => `${fieldvu.MOBILE}/WorkOrders(${id})`, needsId: true },
};

const JOB_STATUSES = ['ACTIVE', 'COMPLETED', 'CANCELLED', 'PLANNING'];
const SCAN_PAGE = 1000;
const MAX_SCAN_ROWS = 60000;
const AMOUNT_FIELDS = ['unitCost', 'quantity', 'supplierInvoiceIsCreditMemo'];

let jobStatusById = null;
async function jobStatuses() {
  if (!jobStatusById) {
    const data = await fieldvu.fvGet(`${fieldvu.API}/OrgStatuses?$top=200`);
    jobStatusById = new Map(
      (data.value || []).filter((s) => s.entityType === 'Job').map((s) => [s.id, s.statusCode])
    );
  }
  return jobStatusById;
}

async function jobIdForCode(code) {
  const data = await fieldvu.fvGet(
    `${fieldvu.API}/Jobs?$top=1&$select=id,code&$filter=${encodeURIComponent(`code eq '${String(code).replace(/'/g, "''")}'`)}`
  );
  return data.value?.[0]?.id || null;
}

/** Signed third-party amount: unit cost × quantity, credit memos negative. */
function billingAmount(r) {
  const amount = (Number(r.unitCost) || 0) * (Number(r.quantity) || 0);
  return r.supplierInvoiceIsCreditMemo ? -amount : amount;
}
const cents = (n) => Math.round(n * 100) / 100;

async function decorate(entity, rows) {
  if (entity === 'jobs') {
    const statuses = await jobStatuses().catch(() => new Map());
    for (const r of rows) if (r && r.orgStatusId) r.status = statuses.get(r.orgStatusId) || r.orgStatusId;
  }
  if (entity === 'billing_items') {
    for (const r of rows) if (r && 'unitCost' in r) r.amount = cents(billingAmount(r));
  }
  return rows;
}

function withQuery(url, parts) {
  const extra = parts.filter(Boolean).join('&');
  if (!extra) return url;
  return `${url}${url.includes('?') ? '&' : '?'}${extra}`;
}

/** Page through every matching record (FieldVu caps one response, so a single page is never a count). */
async function scanAll(spec, filterPart, selectFields) {
  const rows = [];
  let skip = 0;
  for (;;) {
    const select = spec.select && selectFields ? `$select=${selectFields.join(',')}` : null;
    const url = withQuery(spec.base(), [`$top=${SCAN_PAGE}`, skip ? `$skip=${skip}` : null, select, filterPart]);
    const data = await fieldvu.fvGet(url);
    const page = Array.isArray(data.value) ? data.value : [];
    rows.push(...page);
    if (!page.length || rows.length >= MAX_SCAN_ROWS) break;
    skip += page.length;
  }
  return { rows, capped: rows.length >= MAX_SCAN_ROWS };
}

module.exports = {
  name: 'query_fieldvu',
  description: `Query FieldVu Cloud LIVE — IPS's field-service platform on SAP S/4HANA since the 2026 cutover. Always-current data on: jobs, equipment & equipment types, field tickets (headers + full detail), work orders, workers/technicians, customers, items/services, material inventory, price lists, branches, and third-party billing (billing_items).

COVERAGE: field tickets start Feb 6, 2026. FieldVu is NOT SAP Business One — never present these results as B1 data or use them to judge how far back B1 goes. Everything before the cutover (July 2017 onward) is in the sap_b1.* tables via query_operational_database.

WHEN TO USE: current field-operations questions — "open field tickets this week", "how many active jobs for Mewbourne?", "equipment list", "who are our field workers?", "inventory at Hobbs", "get field ticket 1396 details", "third-party purchases on job 91891", "open purchase orders".

ENTITIES: jobs, equipment, equipment_types, workers, customers, items, inventory, price_lists, branches, billing_items, field_tickets, work_orders (lists) — field_ticket_detail, work_order_detail (single record by id).

JOBS (camelCase fields): code, name, customerName, startDate, endDate, createdOn, jobType (SVO1 service, SVO2 fixed-price / bid), status (ACTIVE / COMPLETED / CANCELLED / PLANNING), companyBranchId. Jobs are not field tickets. "Jobs since <date>" filters on startDate, not createdOn.

BILLING_ITEMS = the job's 3rd Party tab: sourceDocType (PurchaseOrder | SupplierInvoice), docNum, jobId, description, supplierName, supplierCode, unitCost, quantity, amount (unitCost × quantity, credit memos negative), isFullyBilled, remainingQuantity, billable, markup, invoiceDate, poBillingItemId (the PO line a supplier invoice line bills against: never add PO and invoice lines together). Pass job_code to scope one job.

FIELD TICKET HEADERS (PascalCase fields): DocNum, Date, JobCode, JobName, CustomerCode, CustomerName, Status (e.g. Approved/Submitted), CreatedBy, Description, BillingDocumentId (set once a ticket is invoiced; it is FieldVu's reference, not the S/4 billing document number: S/4 billing items link by field ticket number).

COUNTS AND TOTALS: a list returns at most 100 rows, so it is never a count. For "how many" use count_only (exact total matching the filter). For "by customer / status / branch / type" or a dollar total use group_by (pages through every match; returns count per value, and amount totals for billing_items).

FILTERING: pass OData $filter syntax in "filter", e.g. "Status eq 'Approved'", "Date ge 2026-08-01T00:00:00Z", "contains(customerName,'Mewbourne') and startDate ge 2026-08-01", "contains(name,'pump')". Use "status" for job status and "job_code" for one job. Paginate lists with top/skip.

SORTING: results are NOT sorted by default — for "most recent"/"latest" questions ALWAYS pass orderby, e.g. "Date desc" for field_tickets/work_orders, "startDate desc" for jobs.`,
  category: 'database',
  requiresApproval: false,
  parameters: {
    type: 'object',
    properties: {
      entity: {
        type: 'string',
        enum: Object.keys(ENTITIES),
        description: 'Which FieldVu dataset to query.',
      },
      id: {
        type: 'string',
        description: 'Record id — REQUIRED for field_ticket_detail (numeric DocEntry, e.g. 1396) and work_order_detail (GUID).',
      },
      filter: {
        type: 'string',
        description: "Optional OData $filter expression, e.g. \"Status eq 'Approved' and Date ge 2026-08-01T00:00:00Z\".",
      },
      status: {
        type: 'string',
        enum: JOB_STATUSES,
        description: 'jobs only: job status. "Active jobs" = ACTIVE.',
      },
      job_code: {
        type: 'string',
        description: 'jobs / billing_items: the FieldVu job number (e.g. "91891").',
      },
      count_only: {
        type: 'boolean',
        description: 'Return only the exact number of records matching the filter (what an export would contain).',
      },
      group_by: {
        type: 'string',
        description: 'Count every matching record per value of this field (e.g. "customerName", "status", "jobType", "sourceDocType", "supplierName"); billing_items also get amount totals. Use for breakdowns and dollar totals.',
      },
      orderby: {
        type: 'string',
        description: 'Optional OData $orderby, e.g. "Date desc" (field_tickets/work_orders) — REQUIRED for most-recent/latest questions since results are unsorted by default.',
      },
      top: { type: 'number', description: 'Max rows to return (default 25, max 100).' },
      skip: { type: 'number', description: 'Rows to skip for pagination (default 0).' },
    },
    required: ['entity'],
  },
  async execute(params, _context) {
    try {
      if (!fieldvu.isConfigured()) {
        return {
          success: false,
          error: 'FieldVu is not configured on this deployment (FIELDVU_* env vars missing).',
          confidence: 0,
        };
      }
      const spec = ENTITIES[params.entity];
      if (!spec) {
        return { success: false, error: `Unknown entity "${params.entity}"`, confidence: 0 };
      }
      if (spec.needsId && !params.id) {
        return { success: false, error: `entity "${params.entity}" requires an "id" parameter`, confidence: 0 };
      }

      // Every filter the call implies, ANDed: the caller's own, job status, job number.
      const filters = [];
      if (params.filter) filters.push(`(${params.filter})`);
      if (params.status) {
        if (params.entity !== 'jobs') return { success: false, error: 'status applies to entity "jobs" only', confidence: 0 };
        const want = String(params.status).toUpperCase();
        const statuses = await jobStatuses();
        const id = [...statuses].find(([, code]) => code === want)?.[0];
        if (!id) return { success: false, error: `Unknown job status "${params.status}" (use ${JOB_STATUSES.join(', ')})`, confidence: 0 };
        filters.push(`orgStatusId eq ${id}`);
      }
      if (params.job_code) {
        if (params.entity === 'jobs') {
          filters.push(`code eq '${String(params.job_code).replace(/'/g, "''")}'`);
        } else if (params.entity === 'billing_items') {
          const jobId = await jobIdForCode(params.job_code);
          if (!jobId) return { success: false, error: `No FieldVu job with code ${params.job_code}`, confidence: 0.9 };
          filters.push(`jobId eq ${jobId}`);
        } else {
          return { success: false, error: 'job_code applies to entities "jobs" and "billing_items"', confidence: 0 };
        }
      }
      const filterText = filters.join(' and ');
      let filterPart = null;
      let base = spec.base(params.id);
      if (filterText && spec.odata) {
        // The inventory base URL already carries a $filter — AND them together.
        if (spec.hasFilter) base = base.replace(/\$filter=\(/, `$filter=(${encodeURIComponent(filterText)}) and (`);
        else filterPart = `$filter=${encodeURIComponent(filterText)}`;
      }
      const scoped = { ...spec, base: () => base };
      const described = filterText ? ` (filter: ${filterText}${params.status ? `; status ${params.status}` : ''})` : '';

      if (spec.odata && params.count_only && !params.group_by) {
        const data = await fieldvu.fvGet(withQuery(base, ['$count=true', '$top=1', filterPart]));
        let count = data['@odata.count'];
        let capped = false;
        if (typeof count !== 'number') {
          const scan = await scanAll(scoped, filterPart, null);
          count = scan.rows.length;
          capped = scan.capped;
        }
        return {
          success: true,
          data: { entity: params.entity, count, complete: !capped, filter: filterText || null },
          summary: `FieldVu ${params.entity}: ${count.toLocaleString()} record(s)${described}${capped ? ' — scan stopped at the safety limit' : ''}`,
          confidence: capped ? 0.6 : 0.95,
          source_type: 'fieldvu',
          source_summary: `FieldVu Cloud (live) — ${params.entity} count`,
        };
      }

      if (spec.odata && params.group_by) {
        const field = String(params.group_by);
        const isStatus = params.entity === 'jobs' && field === 'status';
        const selectFields = spec.select
          ? [...new Set([isStatus ? 'orgStatusId' : field, ...(params.entity === 'billing_items' ? AMOUNT_FIELDS : [])])]
          : null;
        const { rows, capped } = await scanAll(scoped, filterPart, selectFields);
        await decorate(params.entity, rows);
        const groups = new Map();
        for (const r of rows) {
          const key = r[field] === undefined || r[field] === null ? '(blank)' : String(r[field]);
          const g = groups.get(key) || { [field]: key, count: 0, ...(params.entity === 'billing_items' ? { amount: 0 } : {}) };
          g.count += 1;
          if ('amount' in g) g.amount += billingAmount(r);
          groups.set(key, g);
        }
        const totalAmount = params.entity === 'billing_items' ? cents(rows.reduce((n, r) => n + billingAmount(r), 0)) : undefined;
        const out = [...groups.values()]
          .map((g) => ('amount' in g ? { ...g, amount: cents(g.amount) } : g))
          .sort((a, b) => b.count - a.count);
        return {
          success: true,
          data: {
            entity: params.entity,
            group_by: field,
            total_count: rows.length,
            ...(totalAmount !== undefined ? { total_amount: totalAmount } : {}),
            complete: !capped,
            groups: out.slice(0, 500),
            groups_shown: Math.min(out.length, 500),
            groups_total: out.length,
          },
          summary: `FieldVu ${params.entity}: ${rows.length.toLocaleString()} record(s) in ${out.length} group(s) by ${field}${described}${capped ? ' — scan stopped at the safety limit, totals are partial' : ''}`,
          confidence: capped ? 0.6 : 0.95,
          source_type: 'fieldvu',
          source_summary: `FieldVu Cloud (live) — ${params.entity} by ${field}`,
        };
      }

      let url = base;
      if (spec.odata) {
        const top = Math.min(Math.max(1, params.top ?? 25), 100);
        const skip = Math.max(0, params.skip ?? 0);
        url = withQuery(url, [
          `$top=${top}`,
          skip ? `$skip=${skip}` : null,
          params.orderby ? `$orderby=${encodeURIComponent(params.orderby)}` : null,
          filterPart,
        ]);
      }

      const data = await fieldvu.fvGet(url);
      const rows = Array.isArray(data.value) ? data.value : [data];
      // Strip null-heavy noise to keep token usage sane on wide records
      const cleaned = (await decorate(params.entity, rows.slice(0, 100))).map((r) => {
        if (r && typeof r === 'object') {
          const out = {};
          for (const [k, v] of Object.entries(r)) {
            if (v !== null && k !== '@odata.context' && k !== '@odata.etag') out[k] = v;
          }
          return out;
        }
        return r;
      });
      const full = spec.odata && cleaned.length >= Math.min(Math.max(1, params.top ?? 25), 100);
      const pageNote = 'One full page: more records may match. This is not a count; use count_only or group_by for totals.';

      return {
        success: true,
        data: cleaned,
        ...(full ? { formatted: { note: pageNote, records: cleaned } } : {}),
        summary: `FieldVu ${params.entity}: ${cleaned.length} record(s)${described}${full ? ` — ${pageNote}` : ''}`,
        confidence: 0.95,
        source_type: 'fieldvu',
        source_summary: `FieldVu Cloud (live) — ${params.entity}`,
      };
    } catch (error) {
      return { success: false, error: error.message, confidence: 0 };
    }
  },
};
