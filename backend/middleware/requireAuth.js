/**
 * requireAuth — validates the session cookie (JWT), loads the user, attaches
 * req.user. Factory form: require('./requireAuth')(dbPool).
 */
const jwt = require('jsonwebtoken');

module.exports = function requireAuthFactory(dbPool) {
  return async function requireAuth(req, res, next) {
    try {
      const token = req.cookies?.session;
      if (!token) return res.status(401).json({ error: 'Not authenticated' });
      const payload = jwt.verify(token, process.env.JWT_SECRET);
      const result = await dbPool.query(
        'SELECT id, email, name, role, is_active, must_change_password FROM users WHERE id = $1',
        [payload.sub]
      );
      const user = result.rows[0];
      if (!user || !user.is_active) return res.status(401).json({ error: 'Account inactive' });
      req.user = user;
      next();
    } catch (_err) {
      return res.status(401).json({ error: 'Invalid or expired session' });
    }
  };
};
