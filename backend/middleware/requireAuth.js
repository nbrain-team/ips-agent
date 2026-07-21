/**
 * requireAuth — validates the session cookie (JWT), loads the user, attaches
 * req.user. Factory form: require('./requireAuth')(dbPool).
 *
 * Enforces two revocation mechanisms beyond signature/expiry:
 *  - token_version: a JWT whose `tv` claim no longer matches the user's
 *    current token_version is rejected (password change / force-logout).
 *  - must_change_password: a user flagged to reset their password can only
 *    reach /api/auth/* routes until they do.
 */
const jwt = require('jsonwebtoken');

module.exports = function requireAuthFactory(dbPool) {
  return async function requireAuth(req, res, next) {
    try {
      const token = req.cookies?.session;
      if (!token) return res.status(401).json({ error: 'Not authenticated' });
      const payload = jwt.verify(token, process.env.JWT_SECRET);
      const result = await dbPool.query(
        'SELECT id, email, name, role, is_active, must_change_password, token_version FROM users WHERE id = $1',
        [payload.sub]
      );
      const user = result.rows[0];
      if (!user || !user.is_active) return res.status(401).json({ error: 'Account inactive' });
      // Revoke tokens issued before the user's current token_version.
      if ((payload.tv || 0) !== (user.token_version || 0)) {
        return res.status(401).json({ error: 'Session expired', code: 'token_revoked' });
      }
      // Force password change: block everything except the auth endpoints
      // (login/logout/session/change-password) until the user resets.
      if (user.must_change_password && !req.originalUrl.startsWith('/api/auth')) {
        return res.status(403).json({ error: 'Password change required', code: 'must_change_password' });
      }
      req.user = user;
      next();
    } catch (_err) {
      return res.status(401).json({ error: 'Invalid or expired session' });
    }
  };
};
