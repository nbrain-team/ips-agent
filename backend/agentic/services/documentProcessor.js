/**
 * DocumentProcessor — server-side text extraction for in-chat uploads.
 * PDFs (pdf-parse), DOCX (mammoth), XLSX/CSV (xlsx), plain text.
 * Images are handled separately as native vision blocks.
 */
const path = require('path');

async function extractText(buffer, filename, mimetype) {
  const ext = path.extname(filename || '').toLowerCase();

  if (mimetype === 'application/pdf' || ext === '.pdf') {
    const pdfParse = require('pdf-parse');
    const data = await pdfParse(buffer);
    return data.text;
  }

  if (ext === '.docx' || mimetype?.includes('officedocument.wordprocessingml')) {
    const mammoth = require('mammoth');
    const result = await mammoth.extractRawText({ buffer });
    return result.value;
  }

  if (['.xlsx', '.xls', '.csv'].includes(ext) || mimetype?.includes('spreadsheet') || mimetype === 'text/csv') {
    const XLSX = require('xlsx');
    const wb = XLSX.read(buffer, { type: 'buffer' });
    const parts = [];
    for (const sheetName of wb.SheetNames.slice(0, 10)) {
      const csv = XLSX.utils.sheet_to_csv(wb.Sheets[sheetName]);
      parts.push(`=== Sheet: ${sheetName} ===\n${csv.slice(0, 50000)}`);
    }
    return parts.join('\n\n');
  }

  if (ext === '.pptx' || mimetype?.includes('presentationml')) {
    return '[PPTX uploaded — text extraction for PPTX is not yet enabled; ask the user to paste key content]';
  }

  // Plain text / markdown / json / everything else utf8-ish
  return buffer.toString('utf8');
}

const IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
function isImage(mimetype) {
  return IMAGE_MIMES.includes(mimetype);
}

/**
 * Extract text in an ISOLATED child process with a hard memory cap + timeout.
 * Malformed PDFs can make pdf.js spin/balloon ("Indexing all PDF objects…"),
 * which — run in-process — blocks the event loop, fails the platform health
 * check, and crash-loops the whole API. A bad file now just kills the worker.
 * Resolves to { text } or { error } — never rejects.
 */
function extractTextIsolated(buffer, filename, mimetype, timeoutMs = 30000) {
  const { spawn } = require('child_process');
  return new Promise((resolve) => {
    const proc = spawn(
      process.execPath,
      [
        '--max-old-space-size=256',
        path.join(__dirname, '..', '..', 'scripts', 'extract-text-worker.js'),
        filename || 'file',
        mimetype || '',
      ],
      { stdio: ['pipe', 'pipe', 'ignore'] }
    );
    let out = '';
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      finish({ error: `extraction timed out after ${timeoutMs / 1000}s` });
    }, timeoutMs);
    proc.stdout.on('data', (c) => { out += c; });
    proc.on('error', (err) => finish({ error: String(err.message) }));
    proc.on('close', () => {
      try {
        finish(JSON.parse(out));
      } catch (_e) {
        finish({ error: 'extraction worker crashed (likely corrupt or oversized file)' });
      }
    });
    proc.stdin.end(buffer);
  });
}

module.exports = { extractText, extractTextIsolated, isImage, IMAGE_MIMES };
