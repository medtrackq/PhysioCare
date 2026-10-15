const router = require('express').Router();
const { z } = require('zod');
const db = require('../db');
const { authorize, can } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { notFound, forbidden } = require('../errors');
const { audit } = require('../services/audit.service');

const idParam = z.object({ id: z.string().uuid() });

router.get('/diagnoses', async (_req, res) => {
  res.json((await db.query('SELECT * FROM diagnoses ORDER BY icd10_code')).rows);
});

router.get('/precaution-types', async (_req, res) => {
  res.json((await db.query('SELECT * FROM precaution_types ORDER BY severity DESC, code')).rows);
});

/** ผู้ป่วยดูโปรไฟล์ตัวเอง */
router.get('/me', async (req, res) => {
  if (!req.user.patientId) throw forbidden();
  const { rows: [p] } = await db.query(
    'SELECT id, hn, title, first_name, last_name, date_of_birth, phone, email FROM patients WHERE id = $1', [req.user.patientId]);
  res.json(p);
});

router.get('/', authorize('patients:read'), validate({ query: z.object({ q: z.string().max(100).optional() }) }), async (req, res) => {
  const q = req.valid.query.q ?? null;
  const { rows } = await db.query(
    `SELECT p.id, p.hn, p.title, p.first_name, p.last_name, p.date_of_birth, p.gender, p.phone,
            (SELECT json_agg(json_build_object('code', d.icd10_code, 'name', d.name_th, 'primary', pd.is_primary))
               FROM patient_diagnoses pd JOIN diagnoses d ON d.id = pd.diagnosis_id
              WHERE pd.patient_id = p.id AND pd.status = 'active') AS diagnoses,
            (SELECT json_agg(pp.precaution_code) FROM patient_precautions pp WHERE pp.patient_id = p.id AND pp.is_active) AS precautions
       FROM patients p
      WHERE $1::text IS NULL OR p.hn ILIKE '%' || $1 || '%' OR p.first_name ILIKE '%' || $1 || '%'
         OR p.last_name ILIKE '%' || $1 || '%' OR p.phone ILIKE '%' || $1 || '%'
      ORDER BY p.created_at DESC LIMIT 50`, [q]);
  res.json(rows);
});

router.get('/:id', authorize('patients:read'), validate({ params: idParam }), async (req, res) => {
  const id = req.valid.params.id;
  const { rows: [p] } = await db.query('SELECT * FROM patients WHERE id = $1', [id]);
  if (!p) throw notFound('ผู้ป่วย');
  const [dx, pc] = await Promise.all([
    db.query(
      `SELECT pd.*, d.icd10_code, d.name_th, d.name_en FROM patient_diagnoses pd
         JOIN diagnoses d ON d.id = pd.diagnosis_id WHERE pd.patient_id = $1 ORDER BY pd.status, pd.is_primary DESC`, [id]),
    db.query(
      `SELECT pp.*, pt.name_th, pt.severity FROM patient_precautions pp
         JOIN precaution_types pt ON pt.code = pp.precaution_code WHERE pp.patient_id = $1 ORDER BY pp.is_active DESC`, [id]),
  ]);
  if (can(req.user, 'emr:read')) await audit(req, 'patient.read', 'patient', id);
  res.json({ ...p, diagnoses: dx.rows, precautions: pc.rows });
});

const patientBody = z.object({
  hn: z.string().min(1),
  title: z.string().nullish(),
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  dateOfBirth: z.string().date().nullish(),
  gender: z.enum(['male', 'female', 'other']).nullish(),
  phone: z.string().nullish(),
  email: z.string().email().nullish(),
  address: z.string().nullish(),
  allergies: z.string().nullish(),
  emergencyContact: z.object({ name: z.string(), phone: z.string(), relation: z.string().optional() }).nullish(),
});
const COLS = {
  hn: 'hn', title: 'title', firstName: 'first_name', lastName: 'last_name', dateOfBirth: 'date_of_birth', gender: 'gender',
  phone: 'phone', email: 'email', address: 'address', allergies: 'allergies', emergencyContact: 'emergency_contact',
};
const toVal = (k, v) => (k === 'emergencyContact' && v ? JSON.stringify(v) : v);

router.post('/', authorize('patients:write'), validate({ body: patientBody }), async (req, res) => {
  const b = req.valid.body;
  const keys = Object.keys(b).filter((k) => b[k] !== undefined);
  const { rows: [p] } = await db.query(
    `INSERT INTO patients (${keys.map((k) => COLS[k]).join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
    keys.map((k) => toVal(k, b[k])));
  await audit(req, 'patient.create', 'patient', p.id);
  res.status(201).json(p);
});

router.patch('/:id', authorize('patients:write'), validate({ params: idParam, body: patientBody.partial() }), async (req, res) => {
  const b = req.valid.body;
  const keys = Object.keys(b).filter((k) => b[k] !== undefined);
  if (!keys.length) return res.json({});
  const { rows: [p] } = await db.query(
    `UPDATE patients SET ${keys.map((k, i) => `${COLS[k]} = $${i + 2}`).join(', ')} WHERE id = $1 RETURNING *`,
    [req.valid.params.id, ...keys.map((k) => toVal(k, b[k]))]);
  if (!p) throw notFound('ผู้ป่วย');
  await audit(req, 'patient.update', 'patient', p.id, Object.keys(b));
  res.json(p);
});

router.post('/:id/diagnoses', authorize('patients:write'), validate({
  params: idParam,
  body: z.object({ diagnosisId: z.number().int(), isPrimary: z.boolean().default(false), onsetDate: z.string().date().optional(), referredBy: z.string().optional(), notes: z.string().optional() }),
}), async (req, res) => {
  const b = req.valid.body;
  const pid = req.valid.params.id;
  const row = await db.withTx(async (c) => {
    if (b.isPrimary) await c.query('UPDATE patient_diagnoses SET is_primary = false WHERE patient_id = $1', [pid]);
    return (await c.query(
      `INSERT INTO patient_diagnoses (patient_id, diagnosis_id, is_primary, onset_date, referred_by, notes)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [pid, b.diagnosisId, b.isPrimary, b.onsetDate || null, b.referredBy || null, b.notes || null])).rows[0];
  });
  await audit(req, 'patient.diagnosis_add', 'patient', pid, b);
  res.status(201).json(row);
});

router.patch('/:id/diagnoses/:dxId', authorize('patients:write'), validate({
  params: z.object({ id: z.string().uuid(), dxId: z.string().uuid() }),
  body: z.object({ status: z.enum(['active', 'resolved']) }),
}), async (req, res) => {
  const { rows: [r] } = await db.query(
    'UPDATE patient_diagnoses SET status = $3 WHERE id = $2 AND patient_id = $1 RETURNING *',
    [req.valid.params.id, req.valid.params.dxId, req.valid.body.status]);
  if (!r) throw notFound('การวินิจฉัย');
  res.json(r);
});

router.post('/:id/precautions', authorize('patients:write', 'emr:write'), validate({
  params: idParam,
  body: z.object({ code: z.string(), detail: z.string().optional() }),
}), async (req, res) => {
  const { rows: [r] } = await db.query(
    `INSERT INTO patient_precautions (patient_id, precaution_code, detail, recorded_by) VALUES ($1,$2,$3,$4)
     ON CONFLICT (patient_id, precaution_code) WHERE is_active DO UPDATE SET detail = EXCLUDED.detail RETURNING *`,
    [req.valid.params.id, req.valid.body.code, req.valid.body.detail || null, req.user.id]);
  await audit(req, 'patient.precaution_add', 'patient', req.valid.params.id, req.valid.body);
  res.status(201).json(r);
});

router.delete('/:id/precautions/:pcId', authorize('patients:write', 'emr:write'), validate({
  params: z.object({ id: z.string().uuid(), pcId: z.string().uuid() }),
}), async (req, res) => {
  // ไม่ลบจริง — ปิดสถานะเพื่อเก็บประวัติ
  await db.query('UPDATE patient_precautions SET is_active = false WHERE id = $2 AND patient_id = $1', [req.valid.params.id, req.valid.params.pcId]);
  await audit(req, 'patient.precaution_deactivate', 'patient', req.valid.params.id, { precautionId: req.valid.params.pcId });
  res.status(204).end();
});

module.exports = router;
