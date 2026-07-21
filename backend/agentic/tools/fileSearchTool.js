/**
 * search_files — search OneDrive / SharePoint files by name and content via
 * Microsoft Graph drive search (app token). Returns file names, locations,
 * and web links (no content download). Permission scoping mirrors email:
 * regular users search their own OneDrive; admins can search anyone's.
 * Requires the Files.Read.All APPLICATION permission (admin consent) —
 * degrades with a clear error until consent is granted.
 */
const msGraph = require('../services/msGraph');

module.exports = {
  name: 'search_files',
  description: `Search OneDrive / SharePoint files (documents, spreadsheets, PDFs) by name or content. Returns file names, modified dates, and links to open them.

WHEN TO USE: "find the bid spreadsheet", "where is the safety manual doc?", "files about the Chevron project".

PERMISSIONS (enforced automatically): regular users search their OWN OneDrive; admins can specify another person's mailbox.`,
  category: 'files',
  requiresApproval: false,
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'File name or content keywords.' },
      mailbox: {
        type: 'string',
        description: "ADMIN ONLY: another person's email address to search their OneDrive.",
      },
      limit: { type: 'number', description: 'Max results (default 15, max 40).' },
    },
    required: ['query'],
  },
  async execute(params, context) {
    try {
      if (!msGraph.isConfigured()) {
        return { success: false, error: 'Microsoft 365 is not configured on this deployment.', confidence: 0 };
      }
      const isAdmin = context.userRole === 'admin';
      const ownEmail = (context.userEmail || '').toLowerCase();
      let target = ownEmail;
      if (params.mailbox) {
        if (!isAdmin && params.mailbox.toLowerCase() !== ownEmail) {
          return {
            success: false,
            error: "Permission denied: only admins can search other people's files.",
            confidence: 0,
          };
        }
        target = params.mailbox.toLowerCase();
      }
      if (!target) {
        return { success: false, error: 'No account email available for file search.', confidence: 0 };
      }

      const limit = Math.min(Math.max(1, params.limit || 15), 40);
      const q = String(params.query).replace(/'/g, "''").slice(0, 200);
      const token = await msGraph.getAppToken();
      const url =
        `${msGraph.GRAPH}/users/${encodeURIComponent(target)}/drive/root/search(q='${encodeURIComponent(q)}')` +
        `?$select=name,size,lastModifiedDateTime,webUrl,createdBy,parentReference&$top=${limit}`;

      let data;
      try {
        data = await msGraph.graphGet(url, token);
      } catch (err) {
        if (err.status === 403) {
          return {
            success: false,
            error:
              'File access has not been granted yet. IPS IT needs to add the "Files.Read.All" APPLICATION permission (with admin consent) to the same Entra app used for email.',
            confidence: 0,
          };
        }
        if (err.status === 404) {
          return { success: false, error: `No OneDrive found for ${target}.`, confidence: 0 };
        }
        throw err;
      }

      const files = (data.value || []).map((f) => ({
        title: f.name,
        url: f.webUrl || null,
        size_kb: f.size ? Math.round(f.size / 1024) : null,
        modified: f.lastModifiedDateTime || null,
        folder: f.parentReference?.path?.replace(/^\/drive\/root:/, '') || null,
      }));

      return {
        success: true,
        data: files,
        summary: `${files.length} file(s) matching "${params.query}" in ${target}'s OneDrive`,
        confidence: files.length ? 0.9 : 0.4,
        source_type: 'files',
        source_summary: 'OneDrive/SharePoint search (live)',
      };
    } catch (error) {
      return { success: false, error: error.message, confidence: 0 };
    }
  },
};
