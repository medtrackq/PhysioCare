/**
 * แจ้งเตือนทาง LINE
 *   webhookRouter  POST /api/line/webhook         LINE ส่ง event มา (ตรวจลายเซ็น X-Line-Signature กับ raw body)
 *   router         /api/notify/...                สถานะ, เชื่อม/ยกเลิก LINE ของผู้ป่วย, ทดสอบ, คิวข้อความ
 */
const express = require('express');
const { z } = require('zod');
const db = require('../db');
const { authorize } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { audit } = require('../services/audit.service');
const line = require('../services/line.service');
const notify = require('../services/notify.service');
const { notFound, AppError } = require('../errors');

const webhookRouter = express.Router();
webhookRouter.post('/', async (req, res) => {
  if (!line.verifySignature(req.body, req.headers['x-line-signature'])) throw new AppError(401, 'BAD_SIGNATURE', 'ลายเซ็นไม่ถูกต้อง');
  let payload;
  try { payload = JSON.parse(req.body.toString('utf8')); } catch { throw new AppError(400, 'BAD_JSON', 'JSON ไม่ถูกต้อง'); }
  await notify.handleEvents(payload.events || []);
  res.json({ ok: true });
});

const router = express.Router();
const idParam = z.object({ id: z.string().uuid() });

router.get('/status', authorize('patients:read'), async (req, res) => {
  const s = await notify.status();
  res.json({ ...s, webhookPath: '/api/line/webhook' });
});

router.get('/patients/:id', authorize('patients:read'), validate({ params: idParam }), async (req, res) => {
  res.json(await notify.contact(req.valid.params.id));
});

router.post('/patients/:id/link-code', authorize('patients:write'), validate({ params: idParam }), async (req, res) => {
  const r = await notify.createLinkCode(req.valid.params.id, req.user.id);
  await audit(req, 'line.link_code', 'patient', req.valid.params.id);
  res.status(201).json(r);
});

router.post('/patients/:id/unlink', authorize('patients:write'), validate({ params: idParam }), async (req, res) => {
  await notify.unlink(req.valid.params.id);
  await audit(req, 'line.unlink', 'patient', req.valid.params.id);
  res.json({ ok: true });
});

router.post('/patients/:id/test', authorize('patients:write'), validate({ params: idParam }), async (req, res) => {
  const r = await notify.sendTest(req.valid.params.id);
  res.json(r);
});

router.get('/queue', authorize('settings:manage'), validate({
  query: z.object({ status: z.enum(['pending', 'sent', 'failed', 'dead', 'skipped']).optional() }),
}), async (req, res) => {
  const { rows } = await db.query(
    `SELECT q.id, q.kind, q.status, q.scheduled_for, q.sent_at, q.attempts, q.last_error, q.created_at,
            p.first_name || ' ' || p.last_name AS patient_name, p.hn
       FROM notification_queue q JOIN patients p ON p.id = q.patient_id
      WHERE ($1::text IS NULL OR q.status = $1) ORDER BY q.id DESC LIMIT 200`, [req.valid.query.status ?? null]);
  res.json(rows);
});

router.post('/queue/:id/retry', authorize('settings:manage'), validate({ params: z.object({ id: z.coerce.number().int() }) }), async (req, res) => {
  const { rowCount } = await db.query(
    "UPDATE notification_queue SET status = 'pending', attempts = 0, scheduled_for = now() WHERE id = $1 AND status IN ('failed','dead')", [req.valid.params.id]);
  if (!rowCount) throw notFound('ข้อความที่ส่งไม่สำเร็จ');
  res.json({ ok: true });
});

router.post('/run', authorize('settings:manage'), async (_req, res) => {
  const scheduled = await notify.scheduleDue();
  const delivered = await notify.deliverDue({ limit: 100 });
  res.json({ scheduled, delivered });
});

module.exports = { router, webhookRouter };
