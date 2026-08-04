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

const AGENT_ID = 'ips';
const LABEL = 'IPS — Ingram Petroleum Services';
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
const PROMPT_FRAGMENT = `IPS, Inc. (Ingram Professional Services) is an oilfield electrical services contractor established 2012, serving Southeast New Mexico, Midland TX, and the Permian Basin. Offices in Hobbs NM, Loving NM, and Midland TX. Services: oil & gas electrical, automation & control (PLC, SCADA, custody transfer), oilfield fiber optics, powerline construction, hydro excavation, and safety services.

Data routing for IPS questions:
- Field tickets, invoices, billing, customers, AR/AP, fleet and Motive GPS, payroll and Paycom hours, JSA safety records, crews → ips.query_billing_database.
- Company information, services, safety procedures, policies, SOPs, and ingested documents → ips.hybrid_search.
- Meeting transcripts (Read.ai and Otter) live in the IPS knowledge base — reach them via ips.hybrid_search, or ips.query_operational_database when filtering by date or participant.
- Never invent IPS figures. Every number must come from a tool result.

The pilot billing customer is Mewbourne Oil Co. IPS uses "field ticket" (not work order) and "JSA" for job safety analysis.`;

/** Per-tool overrides where the name heuristic in index.js guesses wrong. */
const KIND_OVERRIDES = {
  // "execute" in the name reads as reason, which is correct, but be explicit:
  // this one runs arbitrary code and should never be mistaken for a data read.
  execute_python: { kind: 'reason', modality: 'text' },
  // "create_document" and "generate_pdf" correctly infer write; named here so
  // the set of writes IPS exposes is greppable in one place.
  create_document: { kind: 'write', modality: 'text' },
  generate_pdf: { kind: 'write', modality: 'pdf' },
  create_task: { kind: 'write', modality: 'table' },
  list_data_sources: { kind: 'read', modality: 'table' },
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
    return registry.getAll().map((tool) => ({ ...tool, ...(KIND_OVERRIDES[tool.name] || {}) }));
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
    promptFragment: () => PROMPT_FRAGMENT,
    dataSources: buildDataSources(dbPool, billingDbPool),
  });
}

module.exports = { createIpsFederationRouter, AGENT_ID, PROMPT_FRAGMENT };
