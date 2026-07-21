/**
 * /api/auth/microsoft — Microsoft Entra ID SSO (authorization-code flow).
 *
 * Flow: GET /api/auth/microsoft → 302 to login.microsoftonline.com →
 * GET /api/auth/microsoft/callback (proxied through the frontend domain so
 * the session cookie lands on the web origin) → session cookie → /ai-chat.
 *
 * Provisioning rules:
 *  - @ipsaecorp.com sign-ins are auto-provisioned as role 'user'.
 *  - Non-ipsaecorp addresses are NOT auto-provisioned via SSO — admins are
 *    created manually (password login) and get the 'admin' role by default.
 *  - Existing users keep their current role; we just attach ms_object_id.
 */
const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { isConfigured, GRAPH } = require('../agentic/services/msGraph');

const IPS_DOMAIN = (process.env.SSO_ALLOWED_DOMAIN || 'ipsaecorp.com').toLowerCase();

const COOKIE_OPTS = {
  httpOnly: true,
  sameSite: 'lax',
  secure: process.env.NODE_ENV === 'production',
  maxAge: 7 * 24 * 60 * 60 * 1000,
};

function frontendUrl() {
  return process.env.FRONTEND_URL || 'http://localhost:3000';
}

function redirectUri() {
  return process.env.MS_GRAPH_REDIRECT_URI || `${frontendUrl()}/api/auth/microsoft/callback`;
}

module.exports = function microsoftAuthRoutes(dbPool) {
  const router = express.Router();

  router.get('/microsoft', (_req, res) => {
    if (!isConfigured()) {
      return res.redirect(`${frontendUrl()}/login?error=sso_not_configured`);
    }
    const state = jwt.sign({ p: 'ms_oauth' }, process.env.JWT_SECRET, { expiresIn: '10m' });
    const params = new URLSearchParams({
      client_id: process.env.MS_GRAPH_CLIENT_ID,
      response_type: 'code',
      redirect_uri: redirectUri(),
      response_mode: 'query',
      scope: 'openid profile email User.Read',
      state,
    });
    res.redirect(
      `https://login.microsoftonline.com/${process.env.MS_GRAPH_TENANT_ID}/oauth2/v2.0/authorize?${params}`
    );
  });

  router.get('/microsoft/callback', async (req, res) => {
    const fail = (code) => res.redirect(`${frontendUrl()}/login?error=${code}`);
    try {
      const { code, state, error } = req.query;
      if (error) return fail('sso_denied');
      if (!code || !state) return fail('sso_failed');
      try {
        jwt.verify(state, process.env.JWT_SECRET);
      } catch (_e) {
        return fail('sso_failed');
      }

      // Exchange code for a delegated token
      const tokenRes = await fetch(
        `https://login.microsoftonline.com/${process.env.MS_GRAPH_TENANT_ID}/oauth2/v2.0/token`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: process.env.MS_GRAPH_CLIENT_ID,
            client_secret: process.env.MS_GRAPH_CLIENT_SECRET,
            grant_type: 'authorization_code',
            code: String(code),
            redirect_uri: redirectUri(),
            scope: 'openid profile email User.Read',
          }),
        }
      );
      const tokens = await tokenRes.json();
      if (!tokenRes.ok) {
        console.warn('MS token exchange failed:', tokens.error_description || tokens.error);
        return fail('sso_failed');
      }

      // Who signed in?
      const meRes = await fetch(`${GRAPH}/me?$select=id,displayName,mail,userPrincipalName`, {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      });
      const me = await meRes.json();
      if (!meRes.ok) return fail('sso_failed');
      const email = (me.mail || me.userPrincipalName || '').toLowerCase();
      if (!email) return fail('sso_failed');

      // Find or provision the local user
      const existing = await dbPool.query('SELECT * FROM users WHERE LOWER(email) = $1', [email]);
      let user = existing.rows[0];
      if (user) {
        if (!user.is_active) return fail('account_disabled');
        await dbPool.query(
          `UPDATE users SET ms_object_id = $1, auth_provider = 'microsoft', name = COALESCE(name, $2) WHERE id = $3`,
          [me.id, me.displayName || null, user.id]
        );
      } else {
        if (!email.endsWith(`@${IPS_DOMAIN}`)) {
          // Non-IPS accounts must be pre-created by an admin (they become admins)
          return fail('not_authorized');
        }
        const randomHash = await bcrypt.hash(crypto.randomBytes(24).toString('hex'), 12);
        const created = await dbPool.query(
          `INSERT INTO users (email, name, password_hash, role, is_active, must_change_password, ms_object_id, auth_provider)
           VALUES ($1, $2, $3, 'user', true, false, $4, 'microsoft') RETURNING *`,
          [email, me.displayName || null, randomHash, me.id]
        );
        user = created.rows[0];
        console.log(`👤 SSO auto-provisioned user: ${email}`);
      }

      const session = jwt.sign({ sub: user.id, role: user.role }, process.env.JWT_SECRET, {
        expiresIn: '7d',
      });
      res.cookie('session', session, COOKIE_OPTS);
      res.redirect(`${frontendUrl()}/ai-chat`);
    } catch (err) {
      console.error('MS SSO callback error:', err.message);
      fail('sso_failed');
    }
  });

  return router;
};
