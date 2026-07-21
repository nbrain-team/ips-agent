/**
 * longTermMemory — durable, cross-session, per-user semantic memory.
 * recall() before answering (pgvector cosine similarity over agent_memories),
 * extract() after answering to persist new facts/preferences/projects/style.
 * Deduped by (user_id, md5(content)). Flag-gated + best-effort: failures must
 * never break a chat turn.
 */
const crypto = require('crypto');
const { embedText, toVectorLiteral } = require('../utils/embeddings');

class LongTermMemory {
  constructor(dbPool, modelRouter) {
    this.dbPool = dbPool;
    this.modelRouter = modelRouter;
  }

  async recall(userId, message, { limit = 5, minSimilarity = 0.55 } = {}) {
    try {
      const embedding = await embedText(message);
      const res = await this.dbPool.query(
        `SELECT content, memory_type, 1 - (embedding <=> $1::vector) AS similarity
         FROM agent_memories
         WHERE user_id = $2
         ORDER BY embedding <=> $1::vector
         LIMIT $3`,
        [toVectorLiteral(embedding), userId, limit]
      );
      return res.rows.filter((r) => Number(r.similarity) >= minSimilarity);
    } catch (err) {
      console.warn('Memory recall failed (non-fatal):', err.message);
      return [];
    }
  }

  /** Extract durable memories from a completed turn. Runs async, best-effort. */
  async extract(userId, userMessage, assistantResponse) {
    try {
      const { text } = await this.modelRouter.generateText({
        taskType: 'extraction',
        maxTokens: 800,
        temperature: 0.2,
        system:
          'You extract durable, reusable memories from a conversation turn. Return a JSON array (possibly empty) of objects: {"content": "...", "type": "fact|preference|project|style"}. Only include things worth remembering across future sessions (user preferences, standing facts about their work, active projects, formatting/style requests). No transient details. Return ONLY JSON.',
        prompt: `USER MESSAGE:\n${String(userMessage).slice(0, 3000)}\n\nASSISTANT RESPONSE (context):\n${String(assistantResponse).slice(0, 2000)}`,
      });
      const match = text.match(/\[[\s\S]*\]/);
      if (!match) return 0;
      const memories = JSON.parse(match[0]);
      let saved = 0;
      for (const mem of memories.slice(0, 5)) {
        if (!mem.content) continue;
        const hash = crypto.createHash('md5').update(mem.content).digest('hex');
        const embedding = await embedText(mem.content);
        const result = await this.dbPool.query(
          `INSERT INTO agent_memories (user_id, content, content_hash, memory_type, embedding)
           VALUES ($1, $2, $3, $4, $5::vector)
           ON CONFLICT (user_id, content_hash) DO NOTHING`,
          [userId, mem.content, hash, mem.type || 'fact', toVectorLiteral(embedding)]
        );
        saved += result.rowCount;
      }
      return saved;
    } catch (err) {
      console.warn('Memory extract failed (non-fatal):', err.message);
      return 0;
    }
  }
}

module.exports = LongTermMemory;
