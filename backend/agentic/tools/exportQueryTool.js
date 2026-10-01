/**
 * export_query_result — the full result of a data question as a spreadsheet.
 *
 * The chat tools return a bounded result (250 rows for lists, 2,000 for
 * aggregates) because every row goes through the model. A request for "all
 * vendors ranked by spend" or "every field ticket in 2024" needs every row and
 * none of them in the model, so this tool runs the same NL-to-SQL pipeline
 * with export limits, writes an .xlsx, and hands back a signed download link
 * plus a short summary the model can answer from.
 *
 * Class-based (instantiated by the orchestrator, not auto-loaded) because it
 * reuses the query services of the two SmartDatabaseTool instances.
 */
const XLSX = require('xlsx');
const { toCsv, numericTotals, NUMERIC_OIDS } = require('../utils/tabular');
const { signedDownloadUrl } = require('../services/exportLinks');
const { writeZip } = require('../utils/zipWriter');

const EXPORT_MAX_ROWS = parseInt(process.env.EXPORT_MAX_ROWS || '500000', 10);
// Rows are held in memory while the workbook is written, so rows × columns is
// what has to fit, not rows alone. Sized for a 512 MB instance.
const EXPORT_MAX_CELLS = parseInt(process.env.EXPORT_MAX_CELLS || '1500000', 10);
const EXPORT_TIMEOUT_MS = parseInt(process.env.EXPORT_STATEMENT_TIMEOUT_MS || '120000', 10);
const PREVIEW_ROWS = 25;
const XLSX_CELL_MAX = 32767;

const INVALID_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g;

function xmlText(s) {
  const t = s.length > XLSX_CELL_MAX ? s.slice(0, XLSX_CELL_MAX) : s;
  return t
    .replace(INVALID_XML, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function columnLetters(index) {
  let n = index + 1;
  let out = '';
  while (n > 0) {
    const m = (n - 1) % 26;
    out = String.fromCharCode(65 + m) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

function cellXml(ref, value, numeric) {
  if (value === null || value === undefined) return '';
  if (numeric || typeof value === 'number') {
    const n = Number(value);
    if (Number.isFinite(n)) return `<c r="${ref}"><v>${n}</v></c>`;
  }
  if (typeof value === 'boolean') return `<c r="${ref}" t="b"><v>${value ? 1 : 0}</v></c>`;
  let s;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return '';
    s = value.toISOString().replace('T00:00:00.000Z', '');
  } else if (Buffer.isBuffer(value)) {
    s = `<${value.length} bytes>`;
  } else {
    s = typeof value === 'object' ? JSON.stringify(value) : String(value);
  }
  return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlText(s)}</t></is></c>`;
}

/**
 * The Data worksheet XML, generated in ~1 MB chunks.
 *
 * SheetJS keeps an object per cell and then serialises them, which for a
 * 200k-row export costs several hundred MB — more than a 512 MB instance has.
 * Generating the XML as strings and deflating each chunk as it is produced
 * costs the compressed size plus one chunk.
 */
function* dataSheetXml(columns, rows, numeric) {
  const letters = columns.map((_c, i) => columnLetters(i));
  yield Buffer.from(
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      `<dimension ref="A1:${letters[letters.length - 1] || 'A'}${rows.length + 1}"/>` +
      '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' +
      '<sheetData>'
  );
  let part = `<row r="1">${columns.map((c, i) => cellXml(`${letters[i]}1`, c, false)).join('')}</row>`;
  for (let i = 0; i < rows.length; i++) {
    const r = i + 2;
    const row = rows[i];
    let line = `<row r="${r}">`;
    for (let j = 0; j < columns.length; j++) {
      line += cellXml(letters[j] + r, row[columns[j]], numeric.has(columns[j]));
    }
    part += `${line}</row>`;
    if (part.length > 1 << 20) {
      yield Buffer.from(part);
      part = '';
    }
  }
  yield Buffer.from(`${part}</sheetData></worksheet>`);
}

/**
 * Build the .xlsx buffer: a Data sheet with every row and a Query sheet saying
 * where it came from. SheetJS writes the package parts and the small Query
 * sheet; the Data sheet is generated here and streamed into the ZIP.
 */
async function buildWorkbook({ rows, fields, question, sql, capped, cap, source }) {
  const columns = [...new Set(fields.map((f) => f.name))];
  const numeric = new Set(fields.filter((f) => NUMERIC_OIDS.has(f.dataTypeID)).map((f) => f.name));

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['']]), 'Data');
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet([
      ['Request', question],
      ['Source', source],
      ['Rows', rows.length],
      ['Complete', capped ? `No: capped at ${cap} rows` : 'Yes'],
      ['Generated (UTC)', new Date().toISOString()],
      ['SQL', String(sql).slice(0, XLSX_CELL_MAX)],
    ]),
    'Query'
  );
  const pkg = XLSX.CFB.read(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }), { type: 'buffer' });

  const entries = [];
  let sawSheet = false;
  pkg.FullPaths.forEach((full, i) => {
    const name = full.replace(/^Root Entry\//, '');
    const file = pkg.FileIndex[i];
    if (!name || name.endsWith('/') || name.startsWith('\u0001') || !file.content) return;
    if (name === 'xl/worksheets/sheet1.xml') {
      sawSheet = true;
      entries.push({ name, chunks: dataSheetXml(columns, rows, numeric) });
    } else {
      entries.push({ name, content: Buffer.from(file.content) });
    }
  });
  if (!sawSheet) throw new Error('Workbook package is missing its first worksheet');
  entries.sort((a, b) => (a.name === '[Content_Types].xml' ? -1 : b.name === '[Content_Types].xml' ? 1 : 0));
  return writeZip(entries);
}

class ExportQueryTool {
  /**
   * @param {object} sources  { primary: MultiSourceQueryService, billing?: MultiSourceQueryService }
   * @param {object} opts     { dbPool } — where the artifact is stored
   */
  constructor(sources, { dbPool }) {
    this.sources = sources;
    this.dbPool = dbPool;
    this.name = 'export_query_result';
  }

  asTool() {
    const sourceEnum = Object.keys(this.sources).filter((k) => this.sources[k]);
    return {
      name: this.name,
      description: `Export the FULL result of a data question to an Excel spreadsheet (.xlsx) and return a download link plus a short summary (row count, columns, numeric totals, first ${PREVIEW_ROWS} rows).

WHEN TO USE: the user asks for "all", "every", a "full list", an "export", a "spreadsheet"/"Excel", or the answer is more than a few hundred rows (e.g. every vendor ranked by spend, every field ticket in a year). The chat query tools return at most 250 list rows / 2,000 aggregated rows; this returns up to ${EXPORT_MAX_ROWS.toLocaleString()} rows.
Same input as query_operational_database / query_billing_database: a natural-language request (NOT SQL), an optional table hint, and which database to query.
Answer in chat with the summary and the download link. The link needs no login and expires.`,
      category: 'data',
      requiresApproval: false,
      // Generating SQL, a 120s statement and building the workbook can exceed
      // the master's default 45s federated-call timeout.
      timeoutMs: EXPORT_TIMEOUT_MS + 60000,
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Natural-language description of the rows you need (NOT SQL).' },
          hint: { type: 'string', description: 'Optional: a specific table name to prioritize, e.g. sap_b1.ap_invoices.' },
          source: {
            type: 'string',
            enum: sourceEnum,
            description:
              'Which database: "primary" = query_operational_database (SAP B1 history, Ramp, FieldVu, transcripts); ' +
              '"billing" = query_billing_database (ips_cb billing platform). Default primary.',
          },
          title: { type: 'string', description: 'Optional short file title, e.g. "IPS vendors by spend".' },
        },
        required: ['query'],
      },
      execute: (params, context) => this.execute(params, context),
    };
  }

  async execute(params, context = {}) {
    const sourceKey = params.source === 'billing' ? 'billing' : 'primary';
    const service = this.sources[sourceKey];
    if (!service) {
      return { success: false, error: `The ${sourceKey} database is not configured on this service.`, confidence: 0 };
    }
    try {
      const result = await service.query(params.query, {
        hint: params.hint || null,
        purpose: 'export',
        limits: { rowCap: EXPORT_MAX_ROWS, cellBudget: EXPORT_MAX_CELLS, timeoutMs: EXPORT_TIMEOUT_MS },
      });
      if (!result.success) {
        return {
          success: false,
          error: result.error,
          unanswerable: result.unanswerable || false,
          formatted: result.error,
          formattedComplete: true,
          summary: result.unanswerable ? 'No matching data in this database' : 'Export failed',
          confidence: 0,
        };
      }

      const oneLineSql = String(result.sql || '').replace(/\s+/g, ' ').trim();
      if (result.rowCount === 0) {
        return {
          success: true,
          data: { rowCount: 0, rows: [], sql: result.sql, tables: result.tables },
          formatted: `The query returned no rows, so no spreadsheet was created. SQL: ${oneLineSql}`,
          formattedComplete: true,
          summary: 'Export: 0 rows',
          confidence: 0.4,
        };
      }

      const title = String(params.title || params.query).replace(/\s+/g, ' ').trim().slice(0, 80) || 'Export';
      const buffer = await buildWorkbook({ ...result, question: params.query, source: sourceKey });
      const saved = await (context.dbPool || this.dbPool).query(
        `INSERT INTO agent_artifacts (session_id, type, title, content, content_binary)
         VALUES ($1, 'xlsx', $2, $3, $4) RETURNING id`,
        [context.sessionId || null, title, `Export (${result.rowCount} rows): ${params.query}\n\nSQL: ${result.sql}`, buffer]
      );
      const artifactId = saved.rows[0].id;
      const { url, expiresAt } = signedDownloadUrl(artifactId);

      const columns = [...new Set(result.fields.map((f) => f.name))];
      const totals = numericTotals(result.rows, result.fields);
      const preview = result.rows.slice(0, PREVIEW_ROWS);
      const capNote = result.capped
        ? ` CAPPED at ${result.cap.toLocaleString()} rows (the export limit for ${columns.length} columns); more rows exist — narrow the request or select fewer columns for the rest.`
        : ' This is the complete result.';
      const totalsText = Object.keys(totals).length
        ? Object.entries(totals).map(([k, v]) => `${k}=${v}`).join(', ')
        : 'none (no numeric columns)';

      const formatted = [
        `Exported ${result.rowCount.toLocaleString()} rows x ${columns.length} columns to "${title}.xlsx" (${Math.round(buffer.length / 1024)} KB).${capNote}`,
        `Download link (no login needed; expires ${expiresAt}): ${url}`,
        `Columns: ${columns.join(', ')}`,
        `Totals of numeric columns over all ${result.rowCount.toLocaleString()} rows: ${totalsText}`,
        `SQL: ${oneLineSql}`,
        `First ${preview.length} rows:`,
        toCsv(preview, { columns, maxCell: 300 }),
      ].join('\n');

      return {
        success: true,
        data: {
          rowCount: result.rowCount,
          capped: Boolean(result.capped),
          columns,
          totals,
          rows: preview,
          downloadUrl: url,
          expiresAt,
          artifactId,
          bytes: buffer.length,
          sql: result.sql,
          tables: result.tables,
        },
        formatted,
        formattedComplete: true,
        summary: `Exported ${result.rowCount}${result.capped ? '+' : ''} rows to ${title}.xlsx`,
        confidence: 0.95,
        source_type: 'generated_document',
        source_summary: `SQL export over ${result.tables?.join(', ')}`,
      };
    } catch (error) {
      return { success: false, error: error.message, confidence: 0 };
    }
  }
}

module.exports = ExportQueryTool;
module.exports.buildWorkbook = buildWorkbook;
module.exports.EXPORT_MAX_ROWS = EXPORT_MAX_ROWS;
module.exports.EXPORT_MAX_CELLS = EXPORT_MAX_CELLS;
