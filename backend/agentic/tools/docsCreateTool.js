/**
 * create_document — draft a structured business document (proposal / RFP
 * response / SOW / report / safety doc) as rich markdown, saved as an
 * artifact. The document_creator specialized prompt shapes the content.
 */
const ModelRouter = require('../services/modelRouter');
const clientConfig = require('../config/client-config');

let router = null;
function getRouter() {
  if (!router) router = new ModelRouter();
  return router;
}

module.exports = {
  name: 'create_document',
  description: `Draft a structured IPS business document — proposal, RFP response, scope of work (SOW), report, or safety document — returned as rich markdown.

WHEN TO USE: the user asks to "create/draft/write a document/proposal/SOW/RFP response/report".
Example: "draft a proposal for electrical installation at a new tank battery site".`,
  category: 'documents',
  requiresApproval: false,
  parameters: {
    type: 'object',
    properties: {
      document_type: {
        type: 'string',
        description: 'proposal | rfp_response | sow | report | safety_doc | other',
      },
      title: { type: 'string', description: 'Document title.' },
      requirements: { type: 'string', description: 'What the document must cover — audience, scope, key facts, any data to include.' },
    },
    required: ['document_type', 'title', 'requirements'],
  },
  async execute(params, context) {
    try {
      const { text } = await getRouter().generateText({
        taskType: 'content',
        maxTokens: 8000,
        system: clientConfig.getSystemPrompt('document_creator'),
        prompt: `Create a ${params.document_type} titled "${params.title}".\n\nREQUIREMENTS:\n${params.requirements}\n\nReturn the complete document as well-structured markdown (headings, lists, tables where useful). No preamble.`,
      });
      const saved = await context.dbPool.query(
        `INSERT INTO agent_artifacts (session_id, type, title, content)
         VALUES ($1, 'markdown', $2, $3) RETURNING id`,
        [context.sessionId || null, params.title, text]
      );
      return {
        success: true,
        data: { artifactId: saved.rows[0].id, markdown: text },
        summary: `Document "${params.title}" drafted (${text.length} chars)`,
        confidence: 0.9,
        source_type: 'generated_document',
      };
    } catch (error) {
      return { success: false, error: error.message, confidence: 0 };
    }
  },
};
