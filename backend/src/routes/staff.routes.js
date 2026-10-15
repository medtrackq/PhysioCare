const router = require('express').Router();
const { z } = require('zod');
const db = require('../db');
const { authorize } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { notFound, badRequest } = require('../errors');
const { audit } = require('../services/audit.service');

const idParam = z.object({ id: z.string().uuid() });
const isoDate = z.string().date();

router.get('/specialties', authorize('staff:read'), async (_req, res) => {
  res.json((await db.query('SELECT * FROM specialties ORDER BY id')).rows);
});

router.get('/shift-templates', authorize('staff:read'), async (_req, res) => {
  res.json((await db.query('SELECT * FROM shift_templates ORDER BY start_time')).rows);
});

router.get('/', authorize('staff:read'), validate({
  query: z.object({ specialty: z.string().optional(), position: z.string().optional() }),
}), async (req, res) => {
  const { specialty, position } = req.valid.query;
  const { rows } = await db.query(
    `SELECT s.*,
            COALESCE(json_agg(json_build_object('code', sp.code, 'name', sp.name_en, 'level', ss.level))
                     FILTER (WHERE sp.id IS NOT NULL), '[]') AS specialties,
            (SELECT m.id FROM media_files m WHERE m.entity_type = 'staff' AND m.entity_id = s.id AND m.is_primary) AS photo_id
       FROM staff s
       LEFT JOIN staff_specialties ss ON ss.staff_id = s.id
       LEFT JOIN specialties sp ON sp.id = ss.specialty_id
      WHERE ($1::text IS NULL OR s.position = $1)
        AND ($2::text IS NULL OR EXISTS (SELECT 1 FROM staff_specialties x JOIN specialties y ON y.id = x.specialty_id
                                          WHERE x.staff_id = s.id AND y.code = $2))
      GROUP BY s.id ORDER BY s.employee_code`, [position ?? null, specialty ?? null]);
  res.json(rows.map((r) => ({ ...r, photo_url: r.photo_id ? `/api/media/${r.photo_id}` : null })));
});

/** ตารางกะของทุกคนในช่วงวันที่ (ใช้วาด weekly roster) */
router.get('/shifts', authorize('staff:read'), validate({
  query: z.object({ from: isoDate, to: isoDate, staffId: z.string().uuid().optional() }),
}), async (req, res) => {
  const { from, to, staffId } = req.valid.query;
  const { rows } = await db.query(
    `SELECT sh.id, sh.staff_id, sh.start_at, sh.end_at, t.code AS template, sh.note
       FROM staff_shifts sh LEFT JOIN shift_templates t ON t.id = sh.shift_template_id
      WHERE sh.period && tstzrange(($1::date)::timestamp AT TIME ZONE 'Asia/Bangkok',
                                   ($2::date + 1)::timestamp AT TIME ZONE 'Asia/Bangkok', '[)')
        AND ($3::uuid IS NULL OR sh.staff_id = $3)
      ORDER BY sh.start_at`, [from, to, staffId ?? null]);
  const leaves = (await db.query(
    `SELECT * FROM staff_leaves
      WHERE period && tstzrange(($1::date)::timestamp AT TIME ZONE 'Asia/Bangkok',
                                ($2::date + 1)::timestamp AT TIME ZONE 'Asia/Bangkok', '[)')
        AND ($3::uuid IS NULL OR staff_id = $3)`, [from, to, staffId ?? null])).rows;
  res.json({ shifts: rows, leaves });
});

router.get('/:id', authorize('staff:read'), validate({ params: idParam }), async (req, res) => {
  const { rows: [s] } = await db.query('SELECT * FROM staff WHERE id = $1', [req.valid.params.id]);
  if (!s) throw notFound('บุคลากร');
  const specialties = (await db.query(
    `SELECT sp.id, sp.code, sp.name_th, sp.name_en, ss.level, ss.certified_at
       FROM staff_specialties ss JOIN specialties sp ON sp.id = ss.specialty_id WHERE ss.staff_id = $1`, [s.id])).rows;
  res.json({ ...s, specialties });
});

const staffBody = z.object({
  employeeCode: z.string().min(1),
  title: z.string().nullish(),
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  position: z.enum(['physiotherapist', 'assistant', 'admin']),
  licenseNo: z.string().nullish(),
  licenseExpiry: isoDate.nullish(),
  phone: z.string().nullish(),
  email: z.string().email().nullish(),
  color: z.string().regex(/^#[0-9a-f]{6}$/i).nullish(),
  maxPatientsPerDay: z.number().int().min(1).max(40).optional(),
  isActive: z.boolean().optional(),
});
const COLS = {
  employeeCode: 'employee_code', title: 'title', firstName: 'first_name', lastName: 'last_name', position: 'position',
  licenseNo: 'license_no', licenseExpiry: 'license_expiry', phone: 'phone', email: 'email', color: 'color',
  maxPatientsPerDay: 'max_patients_per_day', isActive: 'is_active',
};

router.post('/', authorize('staff:write'), validate({ body: staffBody }), async (req, res) => {
  const b = req.valid.body;
  const keys = Object.keys(b).filter((k) => b[k] !== undefined);
  const { rows: [s] } = await db.query(
    `INSERT INTO staff (${keys.map((k) => COLS[k]).join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
    keys.map((k) => b[k]));
  await audit(req, 'staff.create', 'staff', s.id);
  res.status(201).json(s);
});

router.patch('/:id', authorize('staff:write'), validate({ params: idParam, body: staffBody.partial() }), async (req, res) => {
  const b = req.valid.body;
  const keys = Object.keys(b).filter((k) => b[k] !== undefined);
  if (!keys.length) return res.json({});
  const { rows: [s] } = await db.query(
    `UPDATE staff SET ${keys.map((k, i) => `${COLS[k]} = $${i + 2}`).join(', ')} WHERE id = $1 RETURNING *`,
    [req.valid.params.id, ...keys.map((k) => b[k])]);
  if (!s) throw notFound('บุคลากร');
  await audit(req, 'staff.update', 'staff', s.id, b);
  res.json(s);
});

router.put('/:id/specialties', authorize('staff:write'), validate({
  params: idParam,
  body: z.array(z.object({ specialtyId: z.number().int(), level: z.number().int().min(1).max(5), certifiedAt: isoDate.nullish() })),
}), async (req, res) => {
  const id = req.valid.params.id;
  await db.withTx(async (c) => {
    await c.query('DELETE FROM staff_specialties WHERE staff_id = $1', [id]);
    for (const s of req.valid.body) {
      await c.query('INSERT INTO staff_specialties (staff_id, specialty_id, level, certified_at) VALUES ($1,$2,$3,$4)',
        [id, s.specialtyId, s.level, s.certifiedAt || null]);
    }
  });
  await audit(req, 'staff.specialties', 'staff', id, req.valid.body);
  res.json({ ok: true });
});

/**
 * สร้างกะแบบ bulk จาก template: ช่วงวันที่ + วันในสัปดาห์ (ISO 1=จันทร์)
 * กะที่ชนกับกะเดิมจะถูกข้าม (ON CONFLICT ใช้กับ EXCLUDE ไม่ได้ จึงเช็กด้วย NOT EXISTS)
 */
router.post('/:id/shifts', authorize('shifts:write'), validate({
  params: idParam,
  body: z.object({
    templateCode: z.string(),
    from: isoDate,
    to: isoDate,
    weekdays: z.array(z.number().int().min(1).max(7)).default([1, 2, 3, 4, 5]),
  }),
}), async (req, res) => {
  const { templateCode, from, to, weekdays } = req.valid.body;
  if (to < from) throw badRequest('ช่วงวันที่ไม่ถูกต้อง');
  const { rows } = await db.query(
    `INSERT INTO staff_shifts (staff_id, shift_template_id, start_at, end_at)
     SELECT $1, t.id, (d::date + t.start_time) AT TIME ZONE 'Asia/Bangkok', (d::date + t.end_time) AT TIME ZONE 'Asia/Bangkok'
       FROM shift_templates t, generate_series($3::date, $4::date, interval '1 day') d
      WHERE t.code = $2 AND EXTRACT(ISODOW FROM d) = ANY($5::int[])
        AND NOT EXISTS (SELECT 1 FROM staff_shifts x WHERE x.staff_id = $1
                          AND x.period && tstzrange((d::date + t.start_time) AT TIME ZONE 'Asia/Bangkok',
                                                    (d::date + t.end_time) AT TIME ZONE 'Asia/Bangkok', '[)'))
     RETURNING id, start_at, end_at`, [req.valid.params.id, templateCode, from, to, weekdays]);
  await audit(req, 'shift.bulk_create', 'staff', req.valid.params.id, { templateCode, from, to, created: rows.length });
  res.status(201).json({ created: rows.length, shifts: rows });
});

router.delete('/shifts/:id', authorize('shifts:write'), validate({ params: idParam }), async (req, res) => {
  const { rows: [sh] } = await db.query('SELECT * FROM staff_shifts WHERE id = $1', [req.valid.params.id]);
  if (!sh) throw notFound('กะทำงาน');
  const { rows: inUse } = await db.query(
    `SELECT id FROM appointments WHERE therapist_id = $1 AND status NOT IN ('cancelled','no_show') AND period && $2::tstzrange`,
    [sh.staff_id, sh.period]);
  if (inUse.length) throw badRequest(`มีนัดหมาย ${inUse.length} รายการในกะนี้ — ย้ายนัดก่อนลบกะ`, { appointments: inUse.map((r) => r.id) });
  await db.query('DELETE FROM staff_shifts WHERE id = $1', [sh.id]);
  await audit(req, 'shift.delete', 'staff', sh.staff_id, { shiftId: sh.id });
  res.status(204).end();
});

router.post('/:id/leaves', authorize('shifts:write'), validate({
  params: idParam,
  body: z.object({
    startAt: z.string().datetime({ offset: true }),
    endAt: z.string().datetime({ offset: true }),
    leaveType: z.enum(['sick', 'personal', 'vacation', 'training']),
    reason: z.string().optional(),
  }),
}), async (req, res) => {
  const b = req.valid.body;
  const { rows: [l] } = await db.query(
    `INSERT INTO staff_leaves (staff_id, start_at, end_at, leave_type, reason) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [req.valid.params.id, b.startAt, b.endAt, b.leaveType, b.reason || null]);
  // นัดที่ได้รับผลกระทบ -> ต้องย้าย
  const { rows: affected } = await db.query(
    `SELECT id, start_at, end_at, patient_id FROM appointments
      WHERE therapist_id = $1 AND status IN ('booked','confirmed') AND period && $2::tstzrange ORDER BY start_at`,
    [req.valid.params.id, l.period]);
  await audit(req, 'leave.create', 'staff', req.valid.params.id, { leaveId: l.id });
  res.status(201).json({ leave: l, affectedAppointments: affected });
});

module.exports = router;
