/**
 * Agent intelligence feature flags.
 * Goes at: backend/agentic/config/agentFlags.js  (generic — port as-is)
 *
 * Each upgrade in the "agent intelligence" batch is independently toggleable via
 * env so it can be dialed back instantly without a code change. All default ON
 * except deep research, which is also gated per-query by strong trigger phrases.
 *
 * Set FEATURE_<X>=false to disable.
 */

function flag(name, defaultValue = true) {
  const v = process.env[name];
  if (v === undefined || v === null || v === '') return defaultValue;
  return String(v).toLowerCase() === 'true' || v === '1';
}

module.exports = {
  memoryEnabled: () => flag('FEATURE_LONG_TERM_MEMORY', true),
  deepResearchEnabled: () => flag('FEATURE_DEEP_RESEARCH', true),
  validatorsEnabled: () => flag('FEATURE_OUTPUT_VALIDATORS', true),
  traceEnabled: () => flag('FEATURE_AGENT_TRACE', true),
};
