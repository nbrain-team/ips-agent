/**
 * outputValidators — post-answer heuristic checks (entity consistency,
 * unsupported claims, brand voice). Returns { quality, issues[] }.
 * Surfaced, never throws; flag-gated via agentFlags.
 */

const HYPE_WORDS = ['revolutionary', 'game-changing', 'game changing', 'cutting-edge', 'synergy', 'disrupt', 'world-class'];
const CLAIM_PATTERNS = [
  /\balways\b/i,
  /\bnever fails\b/i,
  /\bguaranteed\b/i,
  /\b100% (safe|accurate|certain)\b/i,
];

function validateOutput(responseText, { toolCallCount = 0, sources = [] } = {}) {
  const issues = [];
  const text = String(responseText || '');

  // Unsupported-claim heuristic: specific numbers with no tool calls behind them
  const hasNumbers = /\b\d{2,}([,.]\d+)?\b/.test(text);
  if (hasNumbers && toolCallCount === 0 && sources.length === 0 && text.length > 400) {
    issues.push({
      type: 'unsupported_claims',
      detail: 'Response contains specific figures but no tools/sources were used — verify numbers are not invented.',
    });
  }

  for (const pattern of CLAIM_PATTERNS) {
    if (pattern.test(text)) {
      issues.push({ type: 'absolute_claim', detail: `Absolute claim matched: ${pattern}` });
      break;
    }
  }

  const hype = HYPE_WORDS.filter((w) => text.toLowerCase().includes(w));
  if (hype.length) {
    issues.push({ type: 'brand_voice', detail: `Off-brand hype language: ${hype.join(', ')}` });
  }

  let quality = 'good';
  if (issues.length >= 2) quality = 'review';
  else if (issues.length === 1) quality = 'ok';

  return { quality, issues };
}

module.exports = { validateOutput };
