const router = require('express').Router();
const bcrypt = require('bcryptjs');
const { z } = require('zod');
const db = require('../db');
const config = require('../config');
const { validate } = require('../middleware/validate');
const { authenticate, signToken } = require('../middleware/auth');
const { unauthorized, AppError } = require('../errors');
const { audit } = require('../services/audit.service');

const cookieOpts = (maxAge) =>
  `Path=/api; HttpOnly; SameSite=Strict${process.env.NODE_ENV === 'production' ? '; Secure' : ''}; Max-Age=${maxAge}`;

router.post('/login', validate({ body: z.object({ email: z.string().email(), password: z.string().min(1) }) }), async (req, res) => {
  const { email, password } = req.valid.body;
  const { rows: [u] } = await db.query(
    `SELECT u.*, r.code AS role FROM users u JOIN roles r ON r.id = u.role_id WHERE lower(u.email) = lower($1)`, [email]);
  if (u?.locked_until && u.locked_until > new Date()) {
    throw new AppError(423, 'ACCOUNT_LOCKED', 'บัญชีถูกล็อกชั่วคราวจากการเข้าสู่ระบบผิดหลายครั้ง');
  }
  const ok = u && u.is_active && (await bcrypt.compare(password, u.password_hash));
  if (!ok) {
    if (u) {
      await db.query(
        `UPDATE users SET failed_logins = failed_logins + 1,
                locked_until = CASE WHEN failed_logins + 1 >= $2 THEN now() + make_interval(mins => $3) END
          WHERE id = $1`, [u.id, config.loginMaxAttempts, config.loginLockMinutes]);
    }
    await audit(req, 'auth.login_failed', 'user', u?.id, { email });
    throw unauthorized('อีเมลหรือรหัสผ่านไม่ถูกต้อง');
  }
  await db.query('UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = now() WHERE id = $1', [u.id]);
  const token = signToken(u);
  req.user = { id: u.id };
  await audit(req, 'auth.login', 'user', u.id);
  res.setHeader('Set-Cookie', `pc_token=${token}; ${cookieOpts(8 * 3600)}`);
  res.json({ token, user: { id: u.id, email: u.email, name: u.display_name, role: u.role, staffId: u.staff_id, patientId: u.patient_id } });
});

router.post('/logout', (_req, res) => {
  res.setHeader('Set-Cookie', `pc_token=; ${cookieOpts(0)}`);
  res.json({ ok: true });
});

router.get('/me', authenticate, (req, res) => {
  res.json({ ...req.user, permissions: [...req.user.permissions] });
});

module.exports = router;
