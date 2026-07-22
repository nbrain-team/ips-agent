/**
 * extract-text-worker — runs document text extraction in an ISOLATED child
 * process so corrupt/huge files (esp. PDFs) can't OOM or block the API server.
 *
 * Usage: node --max-old-space-size=256 extract-text-worker.js <filename> <mimetype>
 * The file bytes are piped in on stdin; the result is JSON on stdout:
 *   { "text": "..." }  or  { "error": "..." }
 */
const { extractText } = require('../agentic/services/documentProcessor');

const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('end', async () => {
  try {
    const text = await extractText(
      Buffer.concat(chunks),
      process.argv[2] || 'file',
      process.argv[3] || ''
    );
    process.stdout.write(JSON.stringify({ text: String(text || '').slice(0, 200000) }));
  } catch (err) {
    process.stdout.write(JSON.stringify({ error: String(err.message || err).slice(0, 500) }));
  }
  process.exit(0);
});
