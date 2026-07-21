/**
 * Retry/backoff wrapper + parameter sanitizing for every Anthropic call.
 * 429 (rate limit) and 529 (overloaded) back off and retry; transient
 * connection errors (ERR_STREAM_PREMATURE_CLOSE, ECONNRESET, ...) retry too.
 */

const RETRYABLE_CODES = new Set([
  'ERR_STREAM_PREMATURE_CLOSE',
  'ECONNRESET',
  'ETIMEDOUT',
  'ECONNREFUSED',
  'EPIPE',
  'EAI_AGAIN',
]);

function isRetryable(err) {
  const status = err?.status || err?.statusCode;
  if (status === 429 || status === 529 || status === 503 || status === 500) return true;
  if (err?.code && RETRYABLE_CODES.has(err.code)) return true;
  const msg = String(err?.message || '');
  return (
    msg.includes('Premature close') ||
    msg.includes('ECONNRESET') ||
    msg.includes('socket hang up') ||
    msg.includes('overloaded') ||
    msg.includes('Connection error')
  );
}

function retryDelayMs(err, attempt) {
  const status = err?.status || err?.statusCode;
  const retryAfter = err?.headers?.['retry-after'];
  if (retryAfter && !Number.isNaN(Number(retryAfter))) return Number(retryAfter) * 1000;
  const base = status === 429 || status === 529 ? 5000 : 1500;
  return Math.min(base * 2 ** attempt + Math.random() * 500, 45000);
}

/**
 * Clamp/clean params so we never send Anthropic something it rejects.
 */
function sanitizeAnthropicParams(params) {
  const clean = { ...params };
  if (clean.max_tokens) clean.max_tokens = Math.min(Math.max(1, clean.max_tokens), 32000);
  // Claude Opus 4.x rejects the temperature param ("deprecated for this
  // model") — never send it on Anthropic calls.
  delete clean.temperature;
  if (Array.isArray(clean.messages)) {
    clean.messages = clean.messages.filter(
      (m) => m && m.role && m.content !== undefined && m.content !== null && m.content !== ''
    );
  }
  return clean;
}

async function withRetry(fn, { maxAttempts = 4, label = 'anthropic' } = {}) {
  let lastErr;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isRetryable(err) || attempt === maxAttempts - 1) throw err;
      const delay = retryDelayMs(err, attempt);
      console.warn(`⚠️  [${label}] attempt ${attempt + 1} failed (${err.status || err.code || err.message}); retrying in ${Math.round(delay / 1000)}s`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

module.exports = { withRetry, isRetryable, sanitizeAnthropicParams, retryDelayMs };
