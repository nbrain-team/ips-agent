/**
 * /api/auth — cookie login/logout/session/change-password.
 */
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const requireAuthFactory = require('../middleware/requireAuth');

const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, standardHeaders: true });

const COOKIE_OPTS = {
  httpOnly: true,
  sameSite: 'lax',
  secure: process.env.NODE_ENV === 'production',
  maxAge: 7 * 24 * 60 * 60 * 1000,
};

module.exports = function authRoutes(dbPool) {
  const router = express.Router();
  const requireAuth = requireAuthFactory(dbPool);

  router.post('/login', loginLimiter, async (req, res) => {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
    const result = await dbPool.query('SELECT * FROM users WHERE LOWER(email) = LOWER($1)', [email]);
    const user = result.rows[0];
    if (!user || !user.is_active || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    const token = jwt.sign(
      { sub: user.id, role: user.role, tv: user.token_version || 0 },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );
    res.cookie('session', token, COOKIE_OPTS);
    res.json({
      user: {
        id: user.id, email: user.email, name: user.name, role: user.role,
        must_change_password: user.must_change_password,
      },
    });
  });

  router.post('/logout', (_req, res) => {
    res.clearCookie('session', { ...COOKIE_OPTS, maxAge: 0 });
    res.json({ success: true });
  });

  router.get('/session', requireAuth, (req, res) => {
    res.json({ user: req.user });
  });

  router.post('/change-password', requireAuth, async (req, res) => {
    const { current_password, new_password } = req.body || {};
    if (!new_password || new_password.length < 10) {
      return res.status(400).json({ error: 'New password must be at least 10 characters' });
    }
    const result = await dbPool.query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
    if (!(await bcrypt.compare(current_password || '', result.rows[0].password_hash))) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }
    const hash = await bcrypt.hash(new_password, 12);
    // Bump token_version so every OTHER existing session is revoked, then
    // re-issue a fresh cookie for this session so the user stays logged in.
    const updated = await dbPool.query(
      `UPDATE users SET password_hash = $1, must_change_password = false,
              token_version = token_version + 1
       WHERE id = $2 RETURNING token_version, role`,
      [hash, req.user.id]
    );
    const token = jwt.sign(
      { sub: req.user.id, role: updated.rows[0].role, tv: updated.rows[0].token_version },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );
    res.cookie('session', token, COOKIE_OPTS);
    res.json({ success: true });
  });

  return router;
};
