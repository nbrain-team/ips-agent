/**
 * Signed, expiring download links for exported artifacts.
 *
 * The export tool is called by people who never sign in here — the Ingram
 * master calls as a federation service principal and shows the link to an
 * Ingram Brain user — so the download route cannot ask for an IPS session.
 * The link carries its own authority instead: an HMAC over the artifact id and
 * expiry. It cannot be altered to reach another artifact or to live longer.
 */
const crypto = require('crypto');

const TTL_HOURS = parseFloat(process.env.EXPORT_LINK_TTL_HOURS || '24');

function secret() {
  const s = process.env.EXPORT_LINK_SECRET || process.env.JWT_SECRET;
  if (!s) throw new Error('Export links need EXPORT_LINK_SECRET or JWT_SECRET to be set');
  return s;
}

function signature(id, exp) {
  return crypto.createHmac('sha256', secret()).update(`export:${id}:${exp}`).digest('hex');
}

function publicBaseUrl() {
  const base =
    process.env.PUBLIC_API_URL ||
    process.env.RENDER_EXTERNAL_URL ||
    `http://localhost:${process.env.PORT || 8080}`;
  return base.replace(/\/+$/, '');
}

/** { url, expiresAt } for an artifact id. */
function signedDownloadUrl(id, { ttlHours = TTL_HOURS, now = Date.now() } = {}) {
  const exp = Math.floor(now / 1000) + Math.round(ttlHours * 3600);
  const url = `${publicBaseUrl()}/api/exports/download/${id}?exp=${exp}&sig=${signature(id, exp)}`;
  return { url, expiresAt: new Date(exp * 1000).toISOString() };
}

/** 'ok' | 'expired' | 'invalid'. Constant-time on the signature. */
function verify(id, exp, sig, { now = Date.now() } = {}) {
  if (!/^\d+$/.test(String(id)) || !/^\d+$/.test(String(exp)) || !/^[0-9a-f]{64}$/.test(String(sig))) {
    return 'invalid';
  }
  const expected = Buffer.from(signature(id, exp), 'hex');
  const given = Buffer.from(String(sig), 'hex');
  if (!crypto.timingSafeEqual(expected, given)) return 'invalid';
  return Number(exp) * 1000 < now ? 'expired' : 'ok';
}

module.exports = { signedDownloadUrl, verify, TTL_HOURS };
