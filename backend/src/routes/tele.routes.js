/**
 * วิดีโอคอลติดตามผล
 *   router        /api/tele/...          นักกายภาพ: นัด, ลิงก์, ส่ง LINE, สัญญาณ WebRTC, จบการโทร
 *   publicRouter  /api/public/tele/...   ผู้ป่วย (header X-Call-Token): ดูนัด, ยินยอม+เข้าห้อง, สัญญาณ WebRTC
 */
const express = require('express');
const { z } = require('zod');
const { authorize } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { rateLimit } = require('../middleware/rateLimit');
const { audit } = require('../services/audit.service');
const tele = require('../services/tele.service');
const access = require('../services/access.service');
const { AppError } = require('../errors');

const uuid = z.string().uuid();
const idParam = z.object({ id: uuid });
const signalBody = z.object({ type: z.enum(['offer', 'answer', 'ice', 'bye', 'state']), data: z.any().optional() })
  .refine((b) => JSON.stringify(b.data ?? null).length <= 60_000, 'ข้อมูลสัญญาณใหญ่เกินไป');

const router = express.Router();

router.get('/config', authorize('emr:read'), async (_req, res) => {
  res.json({ turnConfigured: tele.turnConfigured(), ...(await tele.settings()) });
});

router.get('/sessions', authorize('emr:read'), validate({
  query: z.object({
    from: z.string().datetime({ offset: true }).optional(), to: z.string().datetime({ offset: true }).optional(),
    mine: z.enum(['true', 'false']).optional(), patientId: uuid.optional(),
    status: z.enum(['scheduled', 'in_progress', 'completed', 'cancelled', 'no_show']).optional(),
  }),
}), async (req, res) => {
  const q = req.valid.query;
  if (q.patientId) await access.assertPatient(req, q.patientId);
  res.json(await tele.list({ ...q, therapistId: q.mine === 'true' ? req.user.staffId : null, user: req.user }));
});

const createBody = z.object({
  patientId: uuid,
  therapistId: uuid.optional(),
  programId: uuid.optional(),
  scheduledAt: z.string().datetime({ offset: true }),
  durationMin: z.number().int().min(5).max(120).optional(),
  purpose: z.string().max(200).nullish(),
});
router.post('/sessions', authorize('emr:write'), validate({ body: createBody }), async (req, res) => {
  await access.assertPatient(req, req.valid.body.patientId, { action: 'write' });
  const t = await tele.create(req.user, req.valid.body);
  await audit(req, 'tele.create', 'tele_session', t.id, { patientId: t.patient_id, scheduledAt: t.scheduled_at });
  res.status(201).json(t);
});

router.get('/sessions/:id', authorize('emr:read'), validate({ params: idParam }), access.guard('tele'), async (req, res) => {
  res.json(await tele.get(req.valid.params.id));
});

router.patch('/sessions/:id', authorize('emr:write'), validate({
  params: idParam,
  body: z.object({
    scheduledAt: z.string().datetime({ offset: true }).optional(),
    durationMin: z.number().int().min(5).max(120).optional(),
    purpose: z.string().max(200).nullish(),
    note: z.string().max(4000).nullish(),
    status: z.enum(['scheduled', 'completed', 'cancelled', 'no_show']).optional(),
  }),
}), access.guard('tele', 'id', { action: 'write' }), async (req, res) => {
  const t = await tele.update(req.valid.params.id, req.valid.body);
  await audit(req, 'tele.update', 'tele_session', t.id, { fields: Object.keys(req.valid.body), status: req.valid.body.status });
  res.json(t);
});

router.post('/sessions/:id/link', authorize('emr:write'), validate({ params: idParam }), access.guard('tele', 'id', { action: 'write' }), async (req, res) => {
  const r = await tele.newLink(req.valid.params.id);
  await audit(req, 'tele.link', 'tele_session', req.valid.params.id);
  res.status(201).json(r);
});

router.post('/sessions/:id/send-line', authorize('emr:write'), validate({ params: idParam }), access.guard('tele', 'id', { action: 'write' }), async (req, res) => {
  const r = await tele.sendLine(req.valid.params.id);
  await audit(req, 'tele.send_line', 'tele_session', req.valid.params.id);
  res.json(r);
});

router.post('/sessions/:id/end', authorize('emr:write'), validate({
  params: idParam, body: z.object({ note: z.string().max(4000).nullish(), status: z.enum(['completed', 'no_show']).default('completed') }),
}), access.guard('tele', 'id', { action: 'write' }), async (req, res) => {
  const t = await tele.end(req.valid.params.id, req.valid.body);
  await audit(req, 'tele.end', 'tele_session', t.id, { status: t.status });
  res.json(t);
});

// เข้าห้อง (นักกายภาพ): ค่า ICE + สตรีมสัญญาณ
router.post('/sessions/:id/join', authorize('emr:read'), validate({ params: idParam }), access.guard('tele'), async (req, res) => {
  const t = await tele.get(req.valid.params.id);
  if (t.status === 'cancelled') throw new AppError(409, 'TELE_CANCELLED', 'นัดนี้ถูกยกเลิกแล้ว');
  await audit(req, 'tele.join', 'tele_session', t.id);
  res.json({ iceServers: tele.iceServers(t.id), session: t });
});
router.get('/sessions/:id/signal', authorize('emr:read'), validate({ params: idParam }), access.guard('tele'), async (req, res) => {
  await tele.get(req.valid.params.id);
  tele.openStream(req.valid.params.id, 'staff', req, res);
});
router.post('/sessions/:id/signal', authorize('emr:read'), validate({ params: idParam, body: signalBody }), access.guard('tele'), async (req, res) => {
  res.json(tele.relay(req.valid.params.id, 'staff', req.valid.body));
});

// ------------------------------------------------------------------ ผู้ป่วย
const publicRouter = express.Router();
// ICE candidate ส่งถี่ช่วงเริ่มต่อสาย จึงให้โควตาสูงกว่าหน้าอื่น
publicRouter.use(rateLimit({ windowMs: 15 * 60_000, max: 600, key: (req) => `tele:${req.ip}`, message: 'ใช้งานถี่เกินไป กรุณารอสักครู่' }));
const token = (req) => String(req.headers['x-call-token'] || '');

publicRouter.get('/', async (req, res) => {
  res.json(await tele.publicView(token(req)));
});
publicRouter.post('/join', validate({ body: z.object({ consent: z.literal(true, { errorMap: () => ({ message: 'กรุณายินยอมก่อนเข้าห้อง' }) }) }) }), async (req, res) => {
  res.json(await tele.patientJoin(token(req)));
});
publicRouter.get('/signal', async (req, res) => {
  const t = await tele.resolveToken(token(req));
  const w = tele.joinWindow(t, (await tele.settings()).earlyMinutes);
  if (!w.open || !t.consent_at) throw new AppError(409, 'CALL_NOT_OPEN', 'ยังเข้าห้องไม่ได้');
  tele.openStream(t.id, 'patient', req, res);
});
publicRouter.post('/signal', validate({ body: signalBody }), async (req, res) => {
  const t = await tele.resolveToken(token(req));
  if (!t.consent_at || ['cancelled', 'completed', 'no_show'].includes(t.status)) throw new AppError(409, 'CALL_NOT_OPEN', 'ยังเข้าห้องไม่ได้');
  res.json(tele.relay(t.id, 'patient', req.valid.body));
});

module.exports = { router, publicRouter };
