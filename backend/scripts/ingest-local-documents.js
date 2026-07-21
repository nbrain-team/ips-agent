/**
 * npm run ingest — ingest local documents (PDF/DOCX/XLSX/TXT/MD) from a
 * folder into website_content so the agent can retrieve them via
 * vector_search / hybrid_search (Part 11 pattern 4).
 *
 * Usage: node scripts/ingest-local-documents.js <folder> [category]
 */
require('dns').setDefaultResultOrder('ipv4first');
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');
const { extractText } = require('../agentic/services/documentProcessor');
const { embedText, toVectorLiteral } = require('../agentic/utils/embeddings');

const CHUNK_SIZE = 6000;

function chunkText(text) {
  const chunks = [];
  for (let i = 0; i < text.length; i += CHUNK_SIZE) {
    chunks.push(text.slice(i, i + CHUNK_SIZE));
  }
  return chunks.slice(0, 50);
}

async function main() {
  const folder = process.argv[2];
  const category = process.argv[3] || 'documentation';
  if (!folder || !fs.existsSync(folder)) {
    console.error('Usage: node scripts/ingest-local-documents.js <folder> [category]');
    process.exit(1);
  }

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false,
  });

  const exts = ['.pdf', '.docx', '.xlsx', '.xls', '.csv', '.txt', '.md'];
  const files = fs.readdirSync(folder).filter((f) => exts.includes(path.extname(f).toLowerCase()));
  let saved = 0;

  try {
    for (const file of files) {
      const full = path.join(folder, file);
      try {
        const buffer = fs.readFileSync(full);
        const text = await extractText(buffer, file);
        const chunks = chunkText(text);
        for (let i = 0; i < chunks.length; i++) {
          const chunk = chunks[i];
          if (chunk.trim().length < 100) continue;
          const hash = crypto.createHash('md5').update(chunk).digest('hex');
          const embedding = await embedText(chunk);
          await pool.query(
            `INSERT INTO website_content (url, title, content, category, source, embedding, content_hash)
             VALUES ($1, $2, $3, $4, 'document', $5::vector, $6)
             ON CONFLICT (content_hash) DO NOTHING`,
            [`file://${file}`, chunks.length > 1 ? `${file} (part ${i + 1}/${chunks.length})` : file, chunk, category, toVectorLiteral(embedding), hash]
          );
          saved++;
        }
        console.log(`✓ ${file} (${chunks.length} chunk(s))`);
      } catch (err) {
        console.warn(`✗ ${file}: ${err.message}`);
      }
    }
    console.log(`\nIngest complete: ${saved} chunks saved from ${files.length} files.`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
