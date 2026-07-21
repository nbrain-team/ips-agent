/**
 * confidenceScoring — scores each response from tool usage + sources + text
 * signals. Logged per message; powers /api/agent-chat/confidence.
 */

function scoreResponse({ responseText, toolResults = [], sources = [] }) {
  let score = 0.5;
  const text = String(responseText || '');

  const successfulTools = toolResults.filter((t) => t.success);
  if (successfulTools.length > 0) score += 0.2;
  if (successfulTools.length > 2) score += 0.05;

  const toolConfidences = successfulTools.map((t) => t.confidence).filter((c) => typeof c === 'number');
  if (toolConfidences.length) {
    const avg = toolConfidences.reduce((a, b) => a + b, 0) / toolConfidences.length;
    score = score * 0.6 + avg * 0.4;
  }

  if (sources.length > 0) score += 0.1;

  // Hedging language lowers confidence
  if (/\b(i (am not|'m not) sure|i don't have|unable to find|no data|couldn't find)\b/i.test(text)) {
    score -= 0.2;
  }
  if (text.length < 50) score -= 0.1;

  return Math.max(0.05, Math.min(0.99, Number(score.toFixed(2))));
}

async function getDashboard(dbPool) {
  const res = await dbPool.query(`
    SELECT
      COUNT(*)::int AS total_responses,
      ROUND(AVG(confidence_score)::numeric, 2) AS avg_confidence,
      COUNT(*) FILTER (WHERE confidence_score >= 0.8)::int AS high_confidence,
      COUNT(*) FILTER (WHERE confidence_score < 0.5)::int AS low_confidence
    FROM agent_chat_messages
    WHERE role = 'assistant' AND confidence_score IS NOT NULL
      AND created_at > NOW() - INTERVAL '30 days'`);
  return res.rows[0];
}

module.exports = { scoreResponse, getDashboard };
