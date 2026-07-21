/**
 * Embedding helper — OpenAI text-embedding-3-small (1536 dims), used by
 * pgvector storage everywhere (table metadata, knowledge base, memories).
 */
const OpenAI = require('openai');
const { llmHttpsAgent } = require('./httpAgent');

let client = null;
function getClient() {
  if (!client) {
    client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, httpAgent: llmHttpsAgent, maxRetries: 3 });
  }
  return client;
}

const EMBEDDING_MODEL = 'text-embedding-3-small';
const EMBEDDING_DIMS = 1536;

async function embedText(text) {
  const input = String(text || '').slice(0, 30000);
  const res = await getClient().embeddings.create({ model: EMBEDDING_MODEL, input });
  return res.data[0].embedding;
}

async function embedBatch(texts) {
  const inputs = texts.map((t) => String(t || '').slice(0, 30000));
  const res = await getClient().embeddings.create({ model: EMBEDDING_MODEL, input: inputs });
  return res.data.map((d) => d.embedding);
}

/** Format a JS array as a pgvector literal. */
function toVectorLiteral(embedding) {
  return `[${embedding.join(',')}]`;
}

module.exports = { embedText, embedBatch, toVectorLiteral, EMBEDDING_MODEL, EMBEDDING_DIMS };
