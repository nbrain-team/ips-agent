/**
 * query_fieldvu — live queries against FieldVu Cloud (IPS's field-service
 * platform on top of SAP Business One): jobs, equipment, field tickets,
 * work orders, workers, customers, items, and inventory.
 *
 * This is LIVE operational data straight from FieldVu — always current,
 * unlike the billing database's synced SAP copies.
 */
const fieldvu = require('../services/fieldvu');

// entity → { host, path builder, supports OData query options }
const ENTITIES = {
  jobs: { base: () => `${fieldvu.API}/Jobs`, odata: true },
  equipment: { base: () => `${fieldvu.API}/OrgEquipment`, odata: true },
  equipment_types: { base: () => `${fieldvu.API}/OrgEquipmentTypes`, odata: true },
  workers: { base: () => `${fieldvu.API}/OrgWorkers?$expand=orgWorkerWorkTypes`, odata: true },
  customers: { base: () => `${fieldvu.API}/OrgBusinessPartners?$expand=orgBusinessPartnerAddresses`, odata: true },
  items: { base: () => `${fieldvu.API}/OrgItems`, odata: true },
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
  branches: { base: () => `${fieldvu.API}/CompanyBranches`, odata: true },
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

module.exports = {
  name: 'query_fieldvu',
  description: `Query FieldVu Cloud LIVE — IPS's field-service platform (front end to SAP Business One). Always-current data on: jobs, equipment & equipment types, field tickets (headers + full detail), work orders, workers/technicians, customers, items/services, material inventory, price lists, and branches.

WHEN TO USE: current field-operations questions — "open field tickets this week", "what jobs are active for XTO?", "equipment list", "who are our field workers?", "inventory at Hobbs", "get field ticket 1396 details". For HISTORICAL/billing analysis (invoices, paid status, exceptions), prefer query_billing_database.

ENTITIES: jobs, equipment, equipment_types, workers, customers, items, inventory, price_lists, branches, field_tickets, work_orders (lists) — field_ticket_detail, work_order_detail (single record by id).

FIELD TICKET HEADERS include: DocNum, Date, JobCode, JobName, CustomerCode, CustomerName, Status (e.g. Approved/Submitted), CreatedBy, Description, BillingDocumentId.

FILTERING: pass OData $filter syntax in "filter", e.g. "Status eq 'Approved'", "Date ge 2026-08-01T00:00:00Z", "contains(CustomerName,'XTO')", "contains(name,'pump')". Paginate with top/skip.`,
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

      let url = spec.base(params.id);
      if (spec.odata) {
        const top = Math.min(Math.max(1, params.top ?? 25), 100);
        const skip = Math.max(0, params.skip ?? 0);
        const sep = () => (url.includes('?') ? '&' : '?');
        url += `${sep()}$top=${top}`;
        if (skip) url += `&$skip=${skip}`;
        if (params.filter) {
          // The inventory base URL already carries a $filter — AND them together.
          if (spec.hasFilter) {
            url = url.replace(/\$filter=\(/, `$filter=(${encodeURIComponent(params.filter)}) and (`);
          } else {
            url += `&$filter=${encodeURIComponent(params.filter)}`;
          }
        }
      }

      const data = await fieldvu.fvGet(url);
      const rows = Array.isArray(data.value) ? data.value : [data];
      // Strip null-heavy noise to keep token usage sane on wide records
      const cleaned = rows.slice(0, 100).map((r) => {
        if (r && typeof r === 'object') {
          const out = {};
          for (const [k, v] of Object.entries(r)) {
            if (v !== null && k !== '@odata.context' && k !== '@odata.etag') out[k] = v;
          }
          return out;
        }
        return r;
      });

      return {
        success: true,
        data: cleaned,
        summary: `FieldVu ${params.entity}: ${cleaned.length} record(s)${params.filter ? ` (filter: ${params.filter})` : ''}`,
        confidence: 0.95,
        source_type: 'fieldvu',
        source_summary: `FieldVu Cloud (live) — ${params.entity}`,
      };
    } catch (error) {
      return { success: false, error: error.message, confidence: 0 };
    }
  },
};
