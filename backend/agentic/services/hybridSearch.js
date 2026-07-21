/**
 * hybridSearch — vector + keyword (FTS) search over the knowledge base
 * (website_content table: ingested site pages, SOPs, safety manuals, docs).
 */
const { embedText, toVectorLiteral } = require('../utils/embeddings');

async function vectorSearch(dbPool, query, { topK = 10, minSimilarity = 0.3 } = {}) {
  const embedding = await embedText(query);
  const res = await dbPool.query(
    `SELECT id, url, title, content, category,
            1 - (embedding <=> $1::vector) AS similarity
     FROM website_content
     ORDER BY embedding <=> $1::vector
     LIMIT $2`,
    [toVectorLiteral(embedding), topK]
  );
  return res.rows.filter((r) => Number(r.similarity) >= minSimilarity);
}

async function keywordSearch(dbPool, query, { topK = 10 } = {}) {
  const res = await dbPool.query(
    `SELECT id, url, title, content, category,
            ts_rank(fts, plainto_tsquery('english', $1)) AS rank
     FROM website_content
     WHERE fts @@ plainto_tsquery('english', $1)
     ORDER BY rank DESC
     LIMIT $2`,
    [query, topK]
  );
  return res.rows;
}

/** Reciprocal-rank-fusion of vector + keyword results. */
async function hybridSearch(dbPool, query, { topK = 10 } = {}) {
  const [vec, kw] = await Promise.all([
    vectorSearch(dbPool, query, { topK }).catch(() => []),
    keywordSearch(dbPool, query, { topK }).catch(() => []),
  ]);
  const scores = new Map();
  const byId = new Map();
  vec.forEach((r, i) => {
    byId.set(r.id, r);
    scores.set(r.id, (scores.get(r.id) || 0) + 1 / (60 + i));
  });
  kw.forEach((r, i) => {
    if (!byId.has(r.id)) byId.set(r.id, r);
    scores.set(r.id, (scores.get(r.id) || 0) + 1 / (60 + i));
  });
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topK)
    .map(([id, score]) => ({ ...byId.get(id), hybrid_score: score }));
}

module.exports = { vectorSearch, keywordSearch, hybridSearch };
