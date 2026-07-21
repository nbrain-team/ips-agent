/**
 * deepResearch — decompose a big question into sub-questions, research each
 * with the full toolset (parallel sub-loops), synthesize a final answer.
 * Opt-in per query via strong trigger phrases; flag-gated.
 */

const TRIGGERS = [
  'deep dive', 'deep-dive', 'deep research', 'comprehensive analysis',
  'comprehensive report', 'research everything', 'full investigation',
  'thorough analysis', 'in-depth analysis', 'in depth analysis',
];

function shouldTrigger(message) {
  const m = String(message || '').toLowerCase();
  return TRIGGERS.some((t) => m.includes(t));
}

async function decompose(modelRouter, question) {
  const { text } = await modelRouter.generateText({
    taskType: 'analysis',
    maxTokens: 1000,
    temperature: 0.3,
    system:
      'Decompose the research question into 2-5 focused sub-questions that can each be answered with database queries or knowledge-base searches. Return ONLY a JSON array of strings.',
    prompt: question,
  });
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) return [question];
  try {
    const subs = JSON.parse(match[0]);
    return Array.isArray(subs) && subs.length ? subs.slice(0, 5) : [question];
  } catch (_e) {
    return [question];
  }
}

module.exports = { shouldTrigger, decompose, TRIGGERS };
