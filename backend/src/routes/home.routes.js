/**
 * โปรแกรมกายภาพที่บ้าน
 *   router        /api/home/...          นักกายภาพ (ต้อง login): คลังท่า, สั่งโปรแกรม, ลิงก์, ติดตาม, แจ้งเตือน
 *   publicRouter  /api/public/home        ผู้ป่วย/ญาติผ่านลิงก์ (header X-Home-Token — token ไม่อยู่ใน URL ของ API)
 */
const express = require('express');
const { z } = require('zod');
const db = require('../db');
const { authorize } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { rateLimit } = require('../middleware/rateLimit');
const { audit } = require('../services/audit.service');
const home = require('../services/home.service');
const { notFound } = require('../errors');

const uuid = z.string().uuid();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'รูปแบบวันที่ YYYY-MM-DD');
const itemBody = z.object({
  id: uuid.optional(),
  exerciseId: z.number().int().positive(),
  sets: z.number().int().min(1).max(10),
  reps: z.number().int().min(1).max(100).nullish(),
  holdSec: z.number().int().min(1).max(3600).nullish(),
  perDay: z.number().int().min(1).max(6).default(1),
  daysOfWeek: z.array(z.number().int().min(1).max(7)).min(1).max(7).optional(),
  notes: z.string().max(500).nullish(),
});
const programBody = z.object({
  patientId: uuid,
  appointmentId: uuid.optional(),
  therapistId: uuid.optional(),
  startDate: isoDate,
  endDate: isoDate,
  baselinePain: z.number().int().min(0).max(10).nullish(),
  painAlertIncrease: z.number().int().min(1).max(10).optional(),
  notes: z.string().max(2000).nullish(),
  consent: z.literal(true, { errorMap: () => ({ message: 'ต้องได้รับความยินยอมจากผู้ป่วยหรือผู้แทน' }) }),
  consentNote: z.string().max(500).nullish(),
  items: z.array(itemBody).min(1).max(20),
});

// ------------------------------------------------------------------ staff
const router = express.Router();

router.get('/exercises', authorize('emr:read', 'patients:read'), validate({
  query: z.object({ all: z.enum(['true', 'false']).optional() }),
}), async (req, res) => {
  res.json(await home.listExercises({ includeInactive: req.valid.query.all === 'true' }));
});

const exerciseBody = z.object({
  code: z.string().regex(/^[A-Z0-9_]{2,30}$/, 'ใช้ A-Z 0-9 _ ยาว 2–30 ตัว'),
  nameTh: z.string().min(1).max(100),
  nameEn: z.string().max(100).nullish(),
  bodyRegion: z.enum(['neck', 'shoulder', 'back', 'hip', 'knee', 'ankle', 'balance', 'general']),
  instructions: z.string().min(1).max(2000),
  cautions: z.string().max(1000).nullish(),
  defaultSets: z.number().int().min(1).max(10).optional(),
  defaultReps: z.number().int().min(1).max(100).nullish(),
  defaultHoldSec: z.number().int().min(1).max(3600).nullish(),
  defaultPerDay: z.number().int().min(1).max(6).optional(),
  videoUrl: z.string().url().regex(/^https:\/\//, 'ต้องเป็นลิงก์ https').nullish(),
  isActive: z.boolean().optional(),
});
const EX_COLS = {
  code: 'code', nameTh: 'name_th', nameEn: 'name_en', bodyRegion: 'body_region', instructions: 'instructions', cautions: 'cautions',
  defaultSets: 'default_sets', defaultReps: 'default_reps', defaultHoldSec: 'default_hold_sec', defaultPerDay: 'default_per_day',
  videoUrl: 'video_url', isActive: 'is_active',
};
router.post('/exercises', authorize('emr:write'), validate({ body: exerciseBody }), async (req, res) => {
  const b = req.valid.body;
  const keys = Object.keys(b).filter((k) => b[k] !== undefined);
  const { rows: [e] } = await db.query(
    `INSERT INTO exercises (${keys.map((k) => EX_COLS[k]).join(', ')}, created_by) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}, $${keys.length + 1}) RETURNING *`,
    [...keys.map((k) => b[k]), req.user.id]);
  await audit(req, 'exercise.create', 'exercise', null, { code: e.code });
  res.status(201).json(e);
});
router.patch('/exercises/:id', authorize('emr:write'), validate({
  params: z.object({ id: z.coerce.number().int() }), body: exerciseBody.partial(),
}), async (req, res) => {
  const b = req.valid.body;
  const keys = Object.keys(b).filter((k) => b[k] !== undefined);
  if (!keys.length) return res.json({});
  const { rows: [e] } = await db.query(
    `UPDATE exercises SET ${keys.map((k, i) => `${EX_COLS[k]} = $${i + 2}`).join(', ')}, updated_at = now() WHERE id = $1 RETURNING *`,
    [req.valid.params.id, ...keys.map((k) => b[k])]);
  if (!e) throw notFound('ท่าออกกำลังกาย');
  await audit(req, 'exercise.update', 'exercise', null, { id: e.id, fields: keys });
  res.json(e);
});

router.get('/monitor', authorize('emr:read'), validate({ query: z.object({ mine: z.enum(['true', 'false']).optional() }) }), async (req, res) => {
  res.json(await home.monitor({ therapistId: req.valid.query.mine === 'true' ? req.user.staffId : null }));
});

router.get('/patients/:id/summary', authorize('emr:read'), validate({ params: z.object({ id: uuid }) }), async (req, res) => {
  res.json(await home.patientSummary(req.valid.params.id));
});

router.get('/programs', authorize('emr:read'), validate({ query: z.object({ patientId: uuid }) }), async (req, res) => {
  const { rows } = await db.query(
    `SELECT hp.id, hp.status, hp.start_date, hp.end_date, hp.created_at, s.title || s.first_name AS therapist_name,
            (SELECT count(*) FROM home_program_items i WHERE i.program_id = hp.id AND i.is_active) AS items
       FROM home_programs hp JOIN staff s ON s.id = hp.therapist_id WHERE hp.patient_id = $1 ORDER BY hp.created_at DESC`,
    [req.valid.query.patientId]);
  res.json(rows);
});

router.get('/programs/:id', authorize('emr:read'), validate({ params: z.object({ id: uuid }) }), async (req, res) => {
  const d = await home.programDetail(req.valid.params.id);
  await audit(req, 'home_program.read', 'home_program', d.id);
  res.json(d);
});

router.post('/programs', authorize('emr:write'), validate({ body: programBody }), async (req, res) => {
  const p = await home.createProgram(req.user, req.valid.body);
  await audit(req, 'home_program.create', 'home_program', p.id, { items: p.items.length, consent: true });
  res.status(201).json(p);
});

router.patch('/programs/:id', authorize('emr:write'), validate({
  params: z.object({ id: uuid }),
  body: programBody.omit({ patientId: true, appointmentId: true, therapistId: true, consent: true, consentNote: true }).partial(),
}), async (req, res) => {
  const p = await home.updateProgram(req.valid.params.id, req.valid.body);
  await audit(req, 'home_program.update', 'home_program', p.id, Object.keys(req.valid.body));
  res.json(p);
});

router.post('/programs/:id/end', authorize('emr:write'), validate({ params: z.object({ id: uuid }) }), async (req, res) => {
  await home.endProgram(req.valid.params.id);
  await audit(req, 'home_program.end', 'home_program', req.valid.params.id);
  res.json({ ok: true });
});

router.post('/programs/:id/links', authorize('emr:write'), validate({
  params: z.object({ id: uuid }), body: z.object({ label: z.string().min(1).max(40).optional() }),
}), async (req, res) => {
  const l = await home.createLink(req.valid.params.id, req.valid.body, req.user.id);
  await audit(req, 'home_link.create', 'home_program', req.valid.params.id, { label: l.label });
  res.status(201).json(l); // token แสดงครั้งเดียว
});

router.post('/links/:id/revoke', authorize('emr:write'), validate({ params: z.object({ id: uuid }) }), async (req, res) => {
  await home.revokeLink(req.valid.params.id);
  await audit(req, 'home_link.revoke', 'home_link', req.valid.params.id);
  res.json({ ok: true });
});

router.post('/alerts/:id/ack', authorize('emr:write'), validate({
  params: z.object({ id: uuid }), body: z.object({ note: z.string().max(500).optional() }),
}), async (req, res) => {
  await home.acknowledgeAlert(req.valid.params.id, req.user.id, req.valid.body.note);
  res.json({ ok: true });
});

// ------------------------------------------------------------------ public (ผู้ป่วย/ญาติ)
const publicRouter = express.Router();
publicRouter.use(rateLimit({ windowMs: 15 * 60_000, max: 120, message: 'ใช้งานถี่เกินไป กรุณารอสักครู่' }));
publicRouter.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
const token = (req) => String(req.headers['x-home-token'] || '');

publicRouter.get('/', async (req, res) => {
  res.json(await home.publicView(token(req)));
});

publicRouter.put('/log', validate({
  body: z.object({
    date: isoDate.optional(),
    items: z.array(z.object({ itemId: uuid, done: z.boolean() })).max(20),
    pain: z.number().int().min(0).max(10).nullish(),
    difficulty: z.enum(['easy', 'ok', 'hard']).nullish(),
    symptoms: z.array(z.string().max(30)).max(10).default([]),
    note: z.string().max(500).nullish(),
  }),
}), async (req, res) => {
  res.json(await home.saveLog(token(req), req.valid.body));
});

module.exports = { router, publicRouter };
