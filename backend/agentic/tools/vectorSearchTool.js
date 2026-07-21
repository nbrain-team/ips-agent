/**
 * vector_search — semantic search over the IPS knowledge base
 * (ipsaecorp.com content, SOPs, safety manuals, ingested documents).
 */
const { vectorSearch } = require('../services/hybridSearch');
const clientConfig = require('../config/client-config');

module.exports = {
  name: 'vector_search',
  description: `Semantic (meaning-based) search over the IPS knowledge base: ipsaecorp.com website content, SOPs, safety manuals, spec sheets, and ingested documents.

WHEN TO USE: questions about IPS the company, its services (oil & gas electrical, automation/SCADA, fiber optics, powerline, hydro excavation, safety), policies, procedures, or safety practices — anything answered by documents rather than structured data.
Examples: "what hydro excavation services does IPS offer?", "what is our safety program?", "summarize our automation capabilities".`,
  category: 'knowledge',
  requiresApproval: false,
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'What to search for (natural language).' },
      top_k: { type: 'number', description: 'How many results (default 10).' },
    },
    required: ['query'],
  },
  async execute(params, context) {
    try {
      const cfg = clientConfig.getToolConfig('vector_search');
      const results = await vectorSearch(context.dbPool, params.query, {
        topK: params.top_k || cfg.top_k || 10,
      });
      return {
        success: true,
        data: results.map((r) => ({
          title: r.title,
          url: r.url,
          category: r.category,
          similarity: Number(r.similarity).toFixed(2),
          content: String(r.content).slice(0, 2000),
        })),
        summary: `${results.length} knowledge-base match(es)`,
        confidence: results.length ? Math.min(0.95, Number(results[0].similarity)) : 0.2,
        source_type: 'knowledge_base',
      };
    } catch (error) {
      return { success: false, error: error.message, confidence: 0 };
    }
  },
};
