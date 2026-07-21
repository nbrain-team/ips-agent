/**
 * ensureAdmin — idempotently provision/repair the admin account on every
 * boot so a fresh deploy always has a working admin login (Part 14).
 * Uses ADMIN_EMAIL + ADMIN_INITIAL_PASSWORD. Only sets the password when the
 * account is being created (never overwrites a changed password).
 */
const bcrypt = require('bcryptjs');

async function ensureAdmin(dbPool) {
  const email = process.env.ADMIN_EMAIL;
  const initialPassword = process.env.ADMIN_INITIAL_PASSWORD;
  if (!email || !initialPassword) {
    console.warn('⚠️  ADMIN_EMAIL / ADMIN_INITIAL_PASSWORD not set — skipping admin bootstrap');
    return;
  }

  const existing = await dbPool.query('SELECT id, role, is_active FROM users WHERE LOWER(email) = LOWER($1)', [email]);
  if (existing.rows.length === 0) {
    const hash = await bcrypt.hash(initialPassword, 12);
    await dbPool.query(
      `INSERT INTO users (email, name, password_hash, role, is_active, must_change_password)
       VALUES ($1, 'Administrator', $2, 'admin', true, true)`,
      [email.toLowerCase(), hash]
    );
    console.log(`👤 Admin account created: ${email} (must change password on first login)`);
    return;
  }

  const admin = existing.rows[0];
  if (admin.role !== 'admin' || !admin.is_active) {
    await dbPool.query(`UPDATE users SET role = 'admin', is_active = true WHERE id = $1`, [admin.id]);
    console.log(`👤 Admin account repaired: ${email}`);
  }
}

module.exports = { ensureAdmin };
