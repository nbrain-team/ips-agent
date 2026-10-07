/**
 * IPS federation wiring — supplies the four agent-specific callbacks that
 * backend/federation/index.js needs, and returns a mounted router.
 *
 * The tool registry is read through a getter rather than captured, because the
 * orchestrator registers its two SmartDatabaseTool instances
 * (query_operational_database and query_billing_database) in its constructor,
 * which runs after this module is built. Capturing the array here would publish
 * a manifest missing the two most valuable tools IPS has.
 */

const { createFederationRouter } = require('./index');
const clientConfig = require('../agentic/config/client-config');
const ipsDomain = require('../agentic/config/ipsDomainKnowledge');

const AGENT_ID = 'ips';
const LABEL = 'IPS — Ingram Professional Services';
const DESCRIPTION =
  'Oilfield electrical services contractor operating across Southeast New Mexico, ' +
  'Midland TX, and the Permian Basin. Electrical construction, automation and SCADA, ' +
  'fiber optics, powerline construction, hydro excavation, and safety services.';

/**
 * A condensed version of the IPS system prompt for the master to honour when
 * it uses IPS tools. Not the whole prompt — the master has its own identity and
 * its own output rules, and pasting 8KB of IPS instructions into a shared
 * prompt would fight with the other three agents' fragments.
 */
const PROMPT_FRAGMENT = `IPS, Inc. (Ingram Professional Services) is an oilfield electrical services contractor established 2012, serving Southeast New Mexico, Midland TX, and the Permian Basin. Offices in Hobbs NM and Midland TX (there is no longer a Loving NM office; fiber and automation run out of 800 Division/Hobbs, and safety & compliance is a corporate function spanning every division). Services: oil & gas electrical, automation & control (PLC, SCADA, custody transfer), oilfield fiber optics, powerline construction, hydro excavation, and safety services.

Data routing for IPS questions:
- Billing verification (recent field tickets, exceptions, open invoices), customers, fleet and Motive GPS, payroll and Paycom hours, JSA safety records, crews → ips.query_billing_database. Field-ticket, invoice, vendor-spend, payment and general-ledger HISTORY follows the systems-of-record section below.
- Ramp corporate cards and spend (card transactions, cardholders, cards, spend limits, reimbursement trips, vendors, GL / Division / Location coding, missing receipts) → ips.query_operational_database with a hint naming the ramp table: ramp.transactions, ramp.users, ramp.cards, ramp.limits, ramp.trips, ramp.vendors, ramp.accounting_gl_accounts. Ramp history starts May 2025 and syncs nightly. Card spend is ramp.transactions summed by purchase date, refunds netted; IPS's AP bills are in SAP, not Ramp. This is IPS's Ramp account only — Studio Golf's Ramp is a separate account and is never in IPS data.
- Employees, headcount, rosters by department or manager, titles, tenure, hire and termination dates → ips.query_operational_database with hint "paycom.employees" (Paycom employee master, synced nightly, work profile only: no pay or personal details). Headcount = employee_status 'A'. Hours and punches stay in ips.query_billing_database.
- Company information, services, safety procedures, policies, SOPs, and ingested documents → ips.hybrid_search.
- Meeting transcripts (Read.ai and Otter) live in the IPS knowledge base — reach them via ips.hybrid_search, or ips.query_operational_database when filtering by date or participant.
- Never invent IPS figures. Every number must come from a tool result.

Large results:
- ips.query_operational_database and ips.query_billing_database return at most 250 rows for raw lists and 2,000 rows for aggregated results. Ask for totals and rankings directly ("all vendors ranked by total spend with amounts") so the SQL aggregates; a result marked CAPPED is partial and must not be presented as complete.
- For "all", "every", "full list", "export", "spreadsheet"/"Excel" requests, or anything beyond a few hundred rows, call ips.export_query_result with the same query and hint plus source ("primary" for the SAP B1 history, Ramp and FieldVu tables; "billing" for ips_cb). It returns a download link (no login, expires in 24 hours), the row count, column totals and the first rows. Answer in chat from that summary and give the link; do not paste the whole table.

{{SYSTEMS_OF_RECORD}}

${ipsDomain.SYSTEMS_OF_RECORD}

${ipsDomain.DIVISIONS_AND_LOCATIONS}

${ipsDomain.GL_QUESTIONS}

${ipsDomain.BILLING_VERIFICATION}

${ipsDomain.ANSWER_HABITS}

ALWAYS pass the "hint" parameter to ips.query_billing_database with the most likely table name. Its semantic table discovery is unreliable without one and will silently answer from the wrong table. The billing schema is:
  ips_cb.field_tickets, field_ticket_lines, field_ticket_verifications — recent SAP B1 field tickets under billing verification
  ips_cb.invoices, invoice_lines, document_bundles, portal_submissions — billing output
  ips_cb.exceptions — verification failures needing review
  ips_cb.customers, customer_rules — customers (pilot: Mewbourne Oil Co)
  ips_cb.jsa_records — KPA job safety analyses
  ips_cb.gps_snapshots, motive_driving_periods, employee_vehicle_map — Motive fleet GPS (Jul 6, 2026 onward, active units only)
  ips_cb.paycom_time_entries, payroll_truth, payroll_dsr_truth — Paycom payroll and hours (time punches, not the employee master; never headcount)
  ips_cb.crews, crew_members, persons — people and crew assignments
  ips_cb.job_overlay, data_source_status, tax_rates — supporting reference data
If a billing result looks implausible (zero rows where you expect data, or a table name unrelated to the question), retry once with an explicit hint before reporting the number.

The pilot billing customer is Mewbourne Oil Co. IPS uses "field ticket" (not work order) and "JSA" for job safety analysis.`;

const b1History = () => `- 2017 → July 31, 2026: SAP Business One (IPS moved to SAP S/4HANA on August 1, 2026). The B1 history — field tickets, receivables, payables, payments, and the general ledger — is in the sap_b1 schema → ips.query_operational_database.
  ${require('../agentic/services/sapB1History').catalogText()}`;

const B1_NOT_CONNECTED = `- 2017 → July 31, 2026: SAP Business One (S/4HANA from August 1, 2026). The full B1 history is NOT connected yet. For anything before mid-2025, say the B1 history is not yet available — never conclude a record does not exist.`;

function systemsOfRecord() {
  const b1 = require('../agentic/services/sapB1History').isConfigured() ? b1History() : B1_NOT_CONNECTED;
  return `IPS systems of record over time — pick the source by date:
${b1}
- Feb 2026 onward: FieldVu Cloud on SAP S/4HANA (new customer numbering, S/4 billing documents; it ran alongside B1 until the August 1, 2026 cutover). Stored in fieldvu.field_tickets (ips.query_operational_database), or live via ips.query_fieldvu. FieldVu is NOT B1 — never label FieldVu results as B1, and never infer B1's start date from FieldVu.
- The two overlap during the 2026 transition with different numbering. Report them side by side; do not add their counts together.
- ips_cb (query_billing_database) holds only the recent tickets the billing platform verifies (June 2025 onward) and open invoices. Use it for verification, exceptions, GPS/payroll/JSA checks — not for history.`;
}

const promptFragment = () => PROMPT_FRAGMENT.replace('{{SYSTEMS_OF_RECORD}}', systemsOfRecord());

/** Per-tool overrides where the name heuristic in index.js guesses wrong. */
const KIND_OVERRIDES = {
  // "execute" in the name reads as reason, which is correct, but be explicit:
  // this one runs arbitrary code and should never be mistaken for a data read.
  execute_python: { kind: 'reason', modality: 'text' },
  // Drafts markdown into agent_artifacts and changes nothing else, so it is not
  // a write. Labelled one, every document request queued for approval, and the
  // approved run then hit the master's 45s default timeout mid-draft.
  create_document: { kind: 'reason', modality: 'text', timeoutMs: 150000 },
  // "generate_pdf" correctly infers write; named here so the set of writes IPS
  // exposes is greppable in one place.
  generate_pdf: { kind: 'write', modality: 'pdf' },
  create_task: { kind: 'write', modality: 'table' },
  list_data_sources: { kind: 'read', modality: 'table' },
  // Writes a spreadsheet artifact, but changes no business data.
  export_query_result: { kind: 'read', modality: 'table' },
};

function buildDataSources(dbPool, billingDbPool) {
  return async () => {
    const sources = [];

    const probe = async (pool, entry) => {
      if (!pool) return { ...entry, status: 'not_configured' };
      try {
        await pool.query('SELECT 1');
        return { ...entry, status: 'connected' };
      } catch (err) {
        return { ...entry, status: 'degraded', detail: `${entry.detail} — ${err.message}` };
      }
    };

    sources.push(
      await probe(dbPool, {
        id: 'ips_platform',
        label: 'IPS Agent Platform (Postgres)',
        kind: 'postgres',
        detail: 'Knowledge base, meeting transcripts, synced M365 email, agent memory',
      })
    );

    sources.push(
      await probe(billingDbPool, {
        id: 'ips_cb',
        label: 'IPS Billing Platform (Postgres, read-only)',
        kind: 'postgres',
        detail:
          'Field tickets and lines, invoices, verifications and exceptions, customers, ' +
          'Motive GPS, Paycom payroll, KPA JSA records, crews',
      })
    );

    if (require('../agentic/services/rampSync').isConfigured()) {
      const ramp = await dbPool
        .query('SELECT MAX(synced_at) AS at FROM ramp.business')
        .then((r) => r.rows[0]?.at)
        .catch(() => null);
      sources.push({
        id: 'ips_ramp',
        label: 'Ramp (IPS corporate spend)',
        kind: 'api',
        status: ramp ? 'connected' : 'degraded',
        detail: ramp ? `Synced nightly; last sync ${new Date(ramp).toISOString()}` : 'Configured; first sync not yet complete',
      });
    }

    if (require('../agentic/services/sapB1History').isConfigured()) {
      await require('../agentic/services/sapB1History').refreshTableCatalog(dbPool).catch(() => {});
      const cov = await require('../agentic/services/sapB1History').coverage(dbPool).catch(() => null);
      const describe = (c) =>
        `${c.entity} ${c.rows.toLocaleString()}${c.rows ? ` (${c.earliest} → ${c.latest})` : ''}${c.backfill_complete ? '' : ' loading'}`;
      sources.push({
        id: 'ips_sap_b1_history',
        label: 'SAP Business One history (2017 → S/4HANA cutover)',
        kind: 'postgres',
        status: cov && cov.some((c) => c.rows > 0) ? 'connected' : 'degraded',
        detail: cov ? cov.map(describe).join('; ') : 'Configured; first backfill not yet started',
      });
    }

    // Knowledge-base vector coverage — reported as a count so the master's
    // sidebar can show "8,412 chunks" rather than a bare green dot.
    try {
      const { rows } = await dbPool.query(
        'SELECT COUNT(*)::int AS n FROM website_content WHERE embedding IS NOT NULL'
      );
      sources.push({
        id: 'ips_kb_vectors',
        label: 'IPS Knowledge Base (pgvector)',
        kind: 'vector',
        status: rows[0].n > 0 ? 'connected' : 'degraded',
        detail: `${rows[0].n.toLocaleString()} embedded chunks`,
      });
    } catch (_e) {
      sources.push({
        id: 'ips_kb_vectors',
        label: 'IPS Knowledge Base (pgvector)',
        kind: 'vector',
        status: 'not_configured',
        detail: 'website_content table unavailable',
      });
    }

    sources.push({
      id: 'ips_m365',
      label: 'Microsoft 365 (Graph)',
      kind: 'api',
      status: process.env.MS_GRAPH_CLIENT_ID ? 'connected' : 'not_configured',
      detail: 'Synced mail, live calendar and OneDrive/SharePoint file search',
    });

    return sources;
  };
}

/**
 * @param {object}   deps
 * @param {object}   deps.dbPool
 * @param {object}   deps.billingDbPool
 * @param {function} deps.getToolRegistry  Lazy getter — the orchestrator adds tools after boot.
 */
function createIpsFederationRouter({ dbPool, billingDbPool, getToolRegistry }) {
  const listTools = () => {
    const registry = getToolRegistry();
    if (!registry) return [];
    return registry
      .getAll()
      // A disabled tool still registers; offered to the master, it was picked
      // and returned "Code execution is disabled" mid-answer.
      .filter((tool) => tool.name !== 'execute_python' || clientConfig.isFeatureEnabled('code_execution'))
      .map((tool) => ({ ...tool, ...(KIND_OVERRIDES[tool.name] || {}) }));
  };

  const executeTool = async (name, input, context) => {
    const registry = getToolRegistry();
    const tool = registry && registry.get(name);
    if (!tool) throw new Error(`Tool ${name} is not registered`);

    // The master calls as a service principal with admin rights, so
    // permission-scoped tools (mailbox search) return the full picture rather
    // than an empty result. See §4 of the federation protocol.
    return tool.execute(input, {
      dbPool,
      billingDbPool,
      userId: null,
      userEmail: context.userEmail || 'federation@ingrambusinesses.com',
      userRole: context.userRole || 'admin',
      clientId: clientConfig.CLIENT_ID,
      projectId: null,
      sessionId: null,
      origin: context.origin || 'ingram-master',
      requestId: context.requestId,
    });
  };

  return createFederationRouter({
    agentId: AGENT_ID,
    label: LABEL,
    description: DESCRIPTION,
    listTools,
    executeTool,
    promptFragment,
    dataSources: buildDataSources(dbPool, billingDbPool),
  });
}

module.exports = { createIpsFederationRouter, AGENT_ID, PROMPT_FRAGMENT, promptFragment };
