/**
 * hybrid_search — vector + keyword fused search over the IPS knowledge base.
 * Prefer this over vector_search when exact terms matter (part numbers,
 * regulation names, proper nouns).
 */
const { hybridSearch } = require('../services/hybridSearch');

module.exports = {
  name: 'hybrid_search',
  description: `Hybrid (semantic + keyword) search over the IPS knowledge base — website content, SOPs, safety manuals, and ingested documents. Best when EXACT terms matter (regulation names, equipment models, place names, proper nouns) as well as meaning.

WHEN TO USE: company/service/safety/policy questions, especially with specific terminology.
Examples: "NEC requirements referenced in our docs", "ISNetworld requirements", "Loving NM office details".`,
  category: 'knowledge',
  requiresApproval: false,
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'What to search for.' },
      top_k: { type: 'number', description: 'How many results (default 10).' },
    },
    required: ['query'],
  },
  async execute(params, context) {
    try {
      const results = await hybridSearch(context.dbPool, params.query, { topK: params.top_k || 10 });
      return {
        success: true,
        data: results.map((r) => ({
          title: r.title,
          url: r.url,
          category: r.category,
          content: String(r.content).slice(0, 4000),
        })),
        summary: `${results.length} knowledge-base match(es)`,
        confidence: results.length ? 0.85 : 0.2,
        source_type: 'knowledge_base',
      };
    } catch (error) {
      return { success: false, error: error.message, confidence: 0 };
    }
  },
};
