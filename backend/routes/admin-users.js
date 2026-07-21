/**
 * /api/admin/users — user management: list, create, set role, activate,
 * reset/set password. Admin (or user_manager for non-role changes).
 */
const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const requireAdminFactory = require('../middleware/requireAdmin');
const requireUserManagerFactory = require('../middleware/requireUserManager');

module.exports = function adminUsersRoutes(dbPool) {
  const router = express.Router();
  const requireAdmin = requireAdminFactory(dbPool);
  const requireUserManager = requireUserManagerFactory(dbPool);

  router.get('/', requireUserManager, async (_req, res) => {
    const result = await dbPool.query(
      `SELECT id, email, name, role, is_active, must_change_password, created_at
       FROM users ORDER BY created_at ASC`
    );
    res.json(result.rows);
  });

  router.post('/', requireUserManager, async (req, res) => {
    const { email, name, role, password } = req.body || {};
    if (!email) return res.status(400).json({ error: 'email required' });
    // IPS rule: manually created users with NON-ipsaecorp.com addresses default
    // to admin (they can see all mailboxes). IPS-domain users default to 'user'.
    const domain = (process.env.SSO_ALLOWED_DOMAIN || 'ipsaecorp.com').toLowerCase();
    const defaultRole = email.toLowerCase().endsWith(`@${domain}`) ? 'user' : 'admin';
    const finalRole = ['user', 'user_manager', 'admin'].includes(role) ? role : defaultRole;
    if (finalRole === 'admin' && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Only admins can create admins' });
    }
    const tempPassword = password || crypto.randomBytes(9).toString('base64url');
    const hash = await bcrypt.hash(tempPassword, 12);
    try {
      const result = await dbPool.query(
        `INSERT INTO users (email, name, password_hash, role, must_change_password)
         VALUES (LOWER($1), $2, $3, $4, true)
         RETURNING id, email, name, role`,
        [email, name || null, hash, finalRole]
      );
      res.json({ user: result.rows[0], temp_password: tempPassword });
    } catch (err) {
      if (err.code === '23505') return res.status(409).json({ error: 'Email already exists' });
      throw err;
    }
  });

  router.put('/:id', requireAdmin, async (req, res) => {
    const { role, is_active, name } = req.body || {};
    const sets = [];
    const params = [];
    if (role !== undefined) { params.push(role); sets.push(`role = $${params.length}`); }
    if (is_active !== undefined) { params.push(is_active); sets.push(`is_active = $${params.length}`); }
    if (name !== undefined) { params.push(name); sets.push(`name = $${params.length}`); }
    if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
    // Role change or deactivation must revoke the user's existing sessions.
    if (role !== undefined || is_active === false) {
      sets.push('token_version = token_version + 1');
    }
    params.push(req.params.id);
    const result = await dbPool.query(
      `UPDATE users SET ${sets.join(', ')} WHERE id = $${params.length}
       RETURNING id, email, name, role, is_active`,
      params
    );
    res.json(result.rows[0]);
  });

  router.post('/:id/reset-password', requireUserManager, async (req, res) => {
    const newPassword = req.body?.password || crypto.randomBytes(9).toString('base64url');
    const hash = await bcrypt.hash(newPassword, 12);
    await dbPool.query(
      `UPDATE users SET password_hash = $1, must_change_password = true,
              token_version = token_version + 1
       WHERE id = $2`,
      [hash, req.params.id]
    );
    res.json({ success: true, temp_password: newPassword });
  });

  return router;
};
