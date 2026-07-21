/**
 * TableRouter — semantic discovery of which tables matter for a question.
 * Uses vectorized table metadata (agent_metadata.table_vectors) with a
 * keyword fallback when embeddings are unavailable.
 */
const { embedText, toVectorLiteral } = require('../utils/embeddings');

class TableRouter {
  /**
   * @param {Pool} metadataPool  pool holding agent_metadata.table_vectors
   * @param {string} sourceTag   'primary' | 'billing'
   */
  constructor(metadataPool, sourceTag = 'primary') {
    this.metadataPool = metadataPool;
    this.sourceTag = sourceTag;
  }

  /**
   * Returns up to `limit` relevant table metadata rows for the question,
   * ordered by semantic similarity.
   */
  async discoverRelevantTables(question, { limit = 6, hint = null } = {}) {
    try {
      const embedding = await embedText(hint ? `${question} (table hint: ${hint})` : question);
      const res = await this.metadataPool.query(
        `SELECT table_name, description, columns_json, row_count, date_range_json, sample_rows_json,
                1 - (embedding <=> $1::vector) AS similarity
         FROM agent_metadata.table_vectors
         WHERE source_tag = $2
         ORDER BY embedding <=> $1::vector
         LIMIT $3`,
        [toVectorLiteral(embedding), this.sourceTag, limit]
      );
      let rows = res.rows;
      // If a hint names a table directly, make sure it's included
      if (hint) {
        const hinted = rows.find((r) => r.table_name === hint);
        if (!hinted) {
          const h = await this.metadataPool.query(
            `SELECT table_name, description, columns_json, row_count, date_range_json, sample_rows_json, 1.0 AS similarity
             FROM agent_metadata.table_vectors WHERE source_tag = $1 AND table_name = $2`,
            [this.sourceTag, hint]
          );
          rows = [...h.rows, ...rows].slice(0, limit);
        }
      }
      return rows;
    } catch (err) {
      console.warn('TableRouter semantic discovery failed, falling back to all tables:', err.message);
      const res = await this.metadataPool.query(
        `SELECT table_name, description, columns_json, row_count, date_range_json, sample_rows_json, 0.5 AS similarity
         FROM agent_metadata.table_vectors WHERE source_tag = $1 ORDER BY row_count DESC LIMIT $2`,
        [this.sourceTag, limit]
      );
      return res.rows;
    }
  }
}

module.exports = TableRouter;
