/**
 * generate_pdf — render a simple, branded PDF document from structured
 * content and store it as an artifact record. Returns a download path.
 */
const PDFDocument = require('pdfkit');
const clientConfig = require('../config/client-config');

module.exports = {
  name: 'generate_pdf',
  description: `Generate a PDF document (report, summary, proposal draft, safety briefing) from title + sections of text.

WHEN TO USE: the user explicitly asks for a PDF or a downloadable document.
Example: "generate a PDF summary of this analysis".`,
  category: 'documents',
  requiresApproval: false,
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Document title.' },
      sections: {
        type: 'array',
        description: 'Ordered document sections.',
        items: {
          type: 'object',
          properties: {
            heading: { type: 'string' },
            body: { type: 'string' },
          },
          required: ['body'],
        },
      },
    },
    required: ['title', 'sections'],
  },
  async execute(params, context) {
    try {
      const buffer = await new Promise((resolve, reject) => {
        const doc = new PDFDocument({ margin: 54 });
        const chunks = [];
        doc.on('data', (c) => chunks.push(c));
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);

        const primary = clientConfig.BRAND_COLORS.primary;
        doc.rect(0, 0, doc.page.width, 6).fill(primary);
        doc.moveDown(1);
        doc.fillColor(clientConfig.BRAND_COLORS.secondary).fontSize(22).text(params.title, { align: 'left' });
        doc.moveDown(0.3);
        doc.fillColor('#5a6577').fontSize(10).text(`${clientConfig.CLIENT_NAME}, Inc. — generated ${new Date().toLocaleDateString()}`);
        doc.moveDown(1);

        for (const section of params.sections) {
          if (section.heading) {
            doc.fillColor(primary).fontSize(14).text(section.heading);
            doc.moveDown(0.3);
          }
          doc.fillColor('#1a1a1a').fontSize(11).text(section.body, { lineGap: 3 });
          doc.moveDown(0.8);
        }
        doc.end();
      });

      const saved = await context.dbPool.query(
        `INSERT INTO agent_artifacts (session_id, type, title, content, content_binary)
         VALUES ($1, 'pdf', $2, $3, $4) RETURNING id`,
        [context.sessionId || null, params.title, `PDF: ${params.title}`, buffer]
      );
      const artifactId = saved.rows[0].id;
      return {
        success: true,
        data: { artifactId, downloadUrl: `/api/exports/artifact/${artifactId}`, bytes: buffer.length },
        summary: `PDF "${params.title}" generated (${Math.round(buffer.length / 1024)} KB)`,
        confidence: 0.95,
        source_type: 'generated_document',
      };
    } catch (error) {
      return { success: false, error: error.message, confidence: 0 };
    }
  },
};
