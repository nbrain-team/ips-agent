/**
 * queryAnalyzer — fast heuristic complexity classifier → token budget.
 * Deliberately NOT an LLM call (saves rate limit). Part 5.7 / Part 14.
 */

const DEEP_KEYWORDS = [
  'comprehensive', 'deep dive', 'deep-dive', 'in depth', 'in-depth', 'detailed analysis',
  'full report', 'thorough', 'exhaustive', 'end to end', 'everything you can find',
];

const DETAILED_KEYWORDS = [
  'analyze', 'analysis', 'compare', 'comparison', 'trend', 'breakdown', 'report',
  'summary of all', 'across all', 'by month', 'by job', 'by crew', 'over time', 'forecast',
];

function analyzeQuery(message) {
  const m = String(message || '').toLowerCase();
  const words = m.split(/\s+/).length;

  let complexity = 'standard';
  let tokenAllocation = 16000;
  let reasoning = 'Standard question — default budget.';

  if (DEEP_KEYWORDS.some((k) => m.includes(k))) {
    complexity = 'comprehensive';
    tokenAllocation = 32000; // hard cap — 64k streams for minutes (Part 14)
    reasoning = 'Explicit deep/comprehensive request — maximum budget.';
  } else if (DETAILED_KEYWORDS.some((k) => m.includes(k)) || words > 60) {
    complexity = 'detailed';
    tokenAllocation = 32000;
    reasoning = 'Analytical/multi-part question — detailed budget.';
  } else if (words <= 12 && !m.includes('?')) {
    complexity = 'quick';
    tokenAllocation = 4000;
    reasoning = 'Short/simple request — quick budget.';
  } else if (words <= 12) {
    complexity = 'quick';
    tokenAllocation = 4000;
    reasoning = 'Short question — quick budget.';
  }

  return { complexity, token_allocation: tokenAllocation, reasoning };
}

module.exports = { analyzeQuery };
