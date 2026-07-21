/**
 * requireUserManager — requireAuth + role 'admin' or 'user_manager'.
 */
const requireAuthFactory = require('./requireAuth');

module.exports = function requireUserManagerFactory(dbPool) {
  const requireAuth = requireAuthFactory(dbPool);
  return function requireUserManager(req, res, next) {
    requireAuth(req, res, () => {
      if (!['admin', 'user_manager'].includes(req.user?.role)) {
        return res.status(403).json({ error: 'User-manager access required' });
      }
      next();
    });
  };
};
