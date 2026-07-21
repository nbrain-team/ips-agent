/**
 * requireAdmin — requireAuth + role must be 'admin'.
 */
const requireAuthFactory = require('./requireAuth');

module.exports = function requireAdminFactory(dbPool) {
  const requireAuth = requireAuthFactory(dbPool);
  return function requireAdmin(req, res, next) {
    requireAuth(req, res, () => {
      if (req.user?.role !== 'admin') {
        return res.status(403).json({ error: 'Admin access required' });
      }
      next();
    });
  };
};
