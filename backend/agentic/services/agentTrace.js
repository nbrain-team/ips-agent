/**
 * agentTrace — one consolidated observability row per turn in agent_traces.
 * Best-effort: failures never break chat. Viewable via /admin/traces.
 */

async function recordTrace(dbPool, trace) {
  try {
    await dbPool.query(
      `INSERT INTO agent_traces
         (session_id, user_id, mode, user_message, sub_questions, tools_used, memory_hits,
          validator_issues, confidence_score, tokens_used, latency_ms)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        trace.sessionId || null,
        trace.userId || null,
        trace.mode || 'tool_use',
        String(trace.userMessage || '').slice(0, 2000),
        JSON.stringify(trace.subQuestions || []),
        JSON.stringify(trace.toolsUsed || []),
        trace.memoryHits || 0,
        JSON.stringify(trace.validatorIssues || []),
        trace.confidenceScore ?? null,
        trace.tokensUsed || 0,
        trace.latencyMs || 0,
      ]
    );
  } catch (err) {
    console.warn('agentTrace record failed (non-fatal):', err.message);
  }
}

async function getRecentTraces(dbPool, { limit = 50 } = {}) {
  const res = await dbPool.query(
    `SELECT * FROM agent_traces ORDER BY created_at DESC LIMIT $1`,
    [limit]
  );
  return res.rows;
}

module.exports = { recordTrace, getRecentTraces };
