const router = require('express').Router();
const bcrypt = require('bcryptjs');
const { z } = require('zod');
const db = require('../db');
const { authorize } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { badRequest, notFound } = require('../errors');
const { audit } = require('../services/audit.service');

router.use(authorize('users:manage'));

const strongPassword = z.string().min(8).regex(/[A-Z]/, 'ต้องมีตัวพิมพ์ใหญ่').regex(/[0-9]/, 'ต้องมีตัวเลข');

router.get('/', async (_req, res) => {
  const { rows } = await db.query(
    `SELECT u.id, u.email, u.display_name, r.code AS role, u.staff_id, u.patient_id, u.is_active, u.last_login_at, u.locked_until
       FROM users u JOIN roles r ON r.id = u.role_id ORDER BY r.id, u.display_name`);
  res.json(rows);
});

router.get('/roles', async (_req, res) => {
  const { rows } = await db.query(
    `SELECT r.code, r.name_th, r.description, array_agg(rp.permission_code ORDER BY rp.permission_code) AS permissions
       FROM roles r LEFT JOIN role_permissions rp ON rp.role_id = r.id GROUP BY r.id ORDER BY r.id`);
  res.json(rows);
});

const userBody = z.object({
  email: z.string().email(),
  password: strongPassword,
  displayName: z.string().min(1),
  role: z.enum(['admin', 'therapist', 'staff', 'patient']),
  staffId: z.string().uuid().nullish(),
  patientId: z.string().uuid().nullish(),
});

router.post('/', validate({ body: userBody }), async (req, res) => {
  const b = req.valid.body;
  if (['therapist', 'staff'].includes(b.role) && !b.staffId) throw badRequest('บัญชีบุคลากรต้องผูกกับ staffId');
  if (b.role === 'patient' && !b.patientId) throw badRequest('บัญชีผู้ป่วยต้องผูกกับ patientId');
  const { rows: [u] } = await db.query(
    `INSERT INTO users (email, password_hash, display_name, role_id, staff_id, patient_id)
     VALUES ($1, $2, $3, (SELECT id FROM roles WHERE code = $4), $5, $6)
     RETURNING id, email, display_name, staff_id, patient_id, is_active`,
    [b.email, await bcrypt.hash(b.password, 10), b.displayName, b.role, b.staffId || null, b.patientId || null]);
  await audit(req, 'user.create', 'user', u.id, { role: b.role });
  res.status(201).json(u);
});

router.patch('/:id', validate({
  params: z.object({ id: z.string().uuid() }),
  body: z.object({
    displayName: z.string().min(1).optional(),
    role: z.enum(['admin', 'therapist', 'staff', 'patient']).optional(),
    isActive: z.boolean().optional(),
    password: strongPassword.optional(),
  }),
}), async (req, res) => {
  const b = req.valid.body;
  const { rows: [u] } = await db.query(
    `UPDATE users SET
        display_name = COALESCE($2, display_name),
        role_id = COALESCE((SELECT id FROM roles WHERE code = $3), role_id),
        is_active = COALESCE($4, is_active),
        password_hash = COALESCE($5, password_hash),
        failed_logins = CASE WHEN $5 IS NOT NULL THEN 0 ELSE failed_logins END,
        locked_until = CASE WHEN $5 IS NOT NULL THEN NULL ELSE locked_until END
      WHERE id = $1 RETURNING id, email, display_name, is_active`,
    [req.valid.params.id, b.displayName ?? null, b.role ?? null, b.isActive ?? null, b.password ? await bcrypt.hash(b.password, 10) : null]);
  if (!u) throw notFound('ผู้ใช้');
  await audit(req, 'user.update', 'user', u.id, { ...b, password: b.password ? '***' : undefined });
  res.json(u);
});

module.exports = router;
