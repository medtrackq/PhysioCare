/**
 * เชื่อมต่อระบบโรงพยาบาล (HIS) — ฟังก์ชันเสริม ไม่มีผลจนกว่าจะสร้าง connector และเปิดใช้งาน
 *
 *   inboundRouter  POST /api/integration/inbound/:code/fhir   HIS ส่งข้อมูลเข้ามา (ยืนยันตัวด้วย X-Api-Key ไม่ใช่ JWT)
 *   router         /api/integration/...                       ผู้ดูแลตั้งค่า / นำเข้า / ดึงข้อมูล / ดูคิวส่งกลับ
 */
const crypto = require('node:crypto');
const express = require('express');
const { z } = require('zod');
const db = require('../db');
const { authorize } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { rateLimit } = require('../middleware/rateLimit');
const { audit } = require('../services/audit.service');
const { badRequest, notFound, unauthorized, AppError } = require('../errors');
const sync = require('../services/integration/sync.service');
const outbox = require('../services/integration/outbox.service');
const { HIS_OWNED } = require('../services/integration/ownership');

const hashKey = (k) => crypto.createHash('sha256').update(k).digest('hex');
const newKey = () => `pchis_${crypto.randomBytes(32).toString('base64url')}`;
const bigJson = express.json({ limit: '10mb', type: ['application/json', 'application/fhir+json'] });

// ------------------------------------------------------------------ inbound (HIS → PhysioCare)
const inboundRouter = express.Router();
inboundRouter.post('/:code/fhir',
  rateLimit({ windowMs: 60_000, max: 60, key: (req) => `his:${req.params.code}:${req.ip}` }),
  bigJson,
  async (req, res) => {
    const { rows: [c] } = await db.query('SELECT * FROM integration_connectors WHERE code = $1 AND is_enabled', [req.params.code]);
    const given = String(req.headers['x-api-key'] || '');
    const ok = c?.inbound_key_hash && given
      && crypto.timingSafeEqual(Buffer.from(hashKey(given), 'hex'), Buffer.from(c.inbound_key_hash, 'hex'));
    if (!ok) throw unauthorized('API key ไม่ถูกต้อง หรือการเชื่อมต่อนี้ปิดอยู่');
    const allowed = c.settings?.allowedIps || [];
    if (allowed.length && !allowed.includes(req.ip)) throw new AppError(403, 'FORBIDDEN', `IP ${req.ip} ไม่อยู่ในรายการที่อนุญาต`);
    if (!req.body || typeof req.body !== 'object') throw badRequest('ต้องส่ง FHIR resource หรือ Bundle (JSON)');
    const result = await sync.importResources(c, req.body, { dryRun: req.query.dryRun === 'true', mode: 'push' });
    res.status(result.status === 'failed' ? 422 : 200).json({
      resourceType: 'OperationOutcome',
      issue: result.errors.length
        ? result.errors.map((e) => ({ severity: 'error', code: 'processing', diagnostics: `${e.key}: ${e.message}` }))
        : [{ severity: 'information', code: 'informational', diagnostics: `ok ${JSON.stringify(result.stats)}` }],
      runId: result.runId,
      dryRun: result.dryRun,
      stats: result.stats,
      items: result.items,
    });
  });

// ------------------------------------------------------------------ admin
const router = express.Router();
const flags = (keys) => z.object(Object.fromEntries(keys.map((k) => [k, z.boolean().optional()]))).partial();
const settingsSchema = z.object({
  inbound: flags(['locations', 'practitioners', 'devices', 'patients', 'conditions', 'serviceRequests', 'bedStatus']),
  outbound: flags(['appointments', 'observations']),
  identifierSystems: z.object({ hn: z.string(), license: z.string(), employee: z.string(), asset: z.string(), local: z.string() }).partial(),
  deviceCategoryMap: z.record(z.string(), z.string()),
  roomTypeMap: z.record(z.string(), z.enum(['treatment', 'private', 'gym', 'pediatric', 'hydro', 'consult'])),
  practitionerPosition: z.enum(['physiotherapist', 'assistant']),
  pull: z.object({ resources: z.array(z.enum(sync.SUPPORTED)), queries: z.record(z.string(), z.string().max(500)) }).partial(),
  allowedIps: z.array(z.string().max(64)).max(50),
}).partial();
const connectorBody = z.object({
  code: z.string().regex(/^[a-z0-9_-]{2,30}$/, 'ใช้ a-z 0-9 _ - ยาว 2–30 ตัว'),
  name: z.string().min(1).max(100),
  baseUrl: z.string().url().regex(/^https?:\/\//).nullish(),
  authSecretEnv: z.string().regex(/^HIS_[A-Z0-9_]{1,60}$/, 'ต้องขึ้นต้นด้วย HIS_ (เช่น HIS_TOKEN)').nullish(),
  isEnabled: z.boolean().optional(),
  settings: settingsSchema.optional(),
});
const idParam = z.object({ id: z.coerce.number().int().positive() });

async function getConnector(id) {
  const { rows: [c] } = await db.query('SELECT * FROM integration_connectors WHERE id = $1', [id]);
  if (!c) throw notFound('การเชื่อมต่อ');
  return c;
}
const publicView = (c) => {
  const { inbound_key_hash: _h, ...rest } = c;
  return { ...rest, auth_env_present: c.auth_secret_env ? Boolean(process.env[c.auth_secret_env]) : null };
};

// ใครก็ตามที่ login: ใช้ล็อกฟิลด์ในฟอร์มของข้อมูลที่มาจาก HIS
router.get('/field-ownership', (_req, res) => {
  res.json(Object.fromEntries(Object.entries(HIS_OWNED).map(([k, v]) => [k, Object.keys(v)])));
});

// ใบสั่งส่งกายภาพจาก HIS
router.get('/referrals', authorize('appointments:read_all'), validate({
  query: z.object({ status: z.enum(['pending', 'scheduled', 'completed', 'cancelled']).optional() }),
}), async (req, res) => {
  const { rows } = await db.query(
    `SELECT r.*, p.hn, p.first_name || ' ' || p.last_name AS patient_name, d.icd10_code, d.name_th AS diagnosis_name
       FROM referrals r JOIN patients p ON p.id = r.patient_id LEFT JOIN diagnoses d ON d.id = r.diagnosis_id
      WHERE ($1::text IS NULL OR r.status = $1)
      ORDER BY (r.priority <> 'routine') DESC, r.created_at DESC LIMIT 300`, [req.valid.query.status ?? null]);
  res.json(rows);
});
router.patch('/referrals/:id', authorize('appointments:write'), validate({
  params: z.object({ id: z.string().uuid() }), body: z.object({ status: z.enum(['pending', 'scheduled', 'completed', 'cancelled']) }),
}), async (req, res) => {
  const { rows: [r] } = await db.query('UPDATE referrals SET status = $2, updated_at = now() WHERE id = $1 RETURNING *', [req.valid.params.id, req.valid.body.status]);
  if (!r) throw notFound('ใบส่งกายภาพ');
  await audit(req, 'referral.status', 'referral', r.id, req.valid.body);
  res.json(r);
});

router.use(authorize('integration:manage'));

router.get('/connectors', async (_req, res) => {
  const { rows } = await db.query(
    `SELECT c.*,
            (SELECT json_object_agg(entity_type, n) FROM (SELECT entity_type, count(*) n FROM external_refs WHERE connector_id = c.id GROUP BY 1) x) AS ref_counts,
            (SELECT json_object_agg(status, n) FROM (SELECT status, count(*) n FROM integration_outbox WHERE connector_id = c.id GROUP BY 1) y) AS outbox_counts,
            (SELECT row_to_json(r) FROM (SELECT id, mode, dry_run, status, stats, started_at, finished_at FROM integration_runs
               WHERE connector_id = c.id ORDER BY id DESC LIMIT 1) r) AS last_run
       FROM integration_connectors c ORDER BY c.id`);
  res.json(rows.map(publicView));
});

router.post('/connectors', validate({ body: connectorBody }), async (req, res) => {
  const b = req.valid.body;
  const key = newKey();
  const { rows: [c] } = await db.query(
    `INSERT INTO integration_connectors (code, name, base_url, auth_secret_env, is_enabled, settings, inbound_key_hash, inbound_key_hint)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [b.code, b.name, b.baseUrl ?? null, b.authSecretEnv ?? null, b.isEnabled ?? false, JSON.stringify(b.settings || {}), hashKey(key), key.slice(-4)]);
  await audit(req, 'integration.connector_create', 'integration_connector', null, { code: b.code });
  res.status(201).json({ ...publicView(c), inboundKey: key });
});

router.patch('/connectors/:id', validate({ params: idParam, body: connectorBody.partial() }), async (req, res) => {
  const b = req.valid.body;
  const map = { code: 'code', name: 'name', baseUrl: 'base_url', authSecretEnv: 'auth_secret_env', isEnabled: 'is_enabled', settings: 'settings' };
  const keys = Object.keys(b).filter((k) => b[k] !== undefined);
  if (!keys.length) return res.json(publicView(await getConnector(req.valid.params.id)));
  const { rows: [c] } = await db.query(
    `UPDATE integration_connectors SET ${keys.map((k, i) => `${map[k]} = $${i + 2}`).join(', ')}, updated_at = now() WHERE id = $1 RETURNING *`,
    [req.valid.params.id, ...keys.map((k) => (k === 'settings' ? JSON.stringify(b[k]) : b[k]))]);
  if (!c) throw notFound('การเชื่อมต่อ');
  await audit(req, 'integration.connector_update', 'integration_connector', null, { id: c.id, fields: keys });
  res.json(publicView(c));
});

router.post('/connectors/:id/rotate-key', validate({ params: idParam }), async (req, res) => {
  const key = newKey();
  const { rowCount } = await db.query('UPDATE integration_connectors SET inbound_key_hash = $2, inbound_key_hint = $3, updated_at = now() WHERE id = $1',
    [req.valid.params.id, hashKey(key), key.slice(-4)]);
  if (!rowCount) throw notFound('การเชื่อมต่อ');
  await audit(req, 'integration.key_rotate', 'integration_connector', null, { id: req.valid.params.id });
  res.json({ inboundKey: key });
});

// นำเข้าด้วยมือ: อัปโหลดไฟล์ FHIR Bundle (JSON) — ใช้ทดลองก่อนเปิดเชื่อมต่อจริง
router.post('/connectors/:id/import', bigJson, validate({ params: idParam, query: z.object({ dryRun: z.enum(['true', 'false']).optional() }) }), async (req, res) => {
  const c = await getConnector(req.valid.params.id);
  if (!req.body || typeof req.body !== 'object') throw badRequest('ต้องเป็นไฟล์ FHIR Bundle หรือ resource (JSON)');
  const result = await sync.importResources(c, req.body, { dryRun: req.valid.query.dryRun !== 'false', mode: 'manual', userId: req.user.id });
  await audit(req, 'integration.import', 'integration_connector', null, { id: c.id, dryRun: result.dryRun, stats: result.stats });
  res.json(result);
});

router.post('/connectors/:id/pull', validate({
  params: idParam, body: z.object({ resources: z.array(z.enum(sync.SUPPORTED)).optional(), dryRun: z.boolean().default(true) }),
}), async (req, res) => {
  const c = await getConnector(req.valid.params.id);
  try {
    const result = await sync.pull(c, { ...req.valid.body, userId: req.user.id });
    await audit(req, 'integration.pull', 'integration_connector', null, { id: c.id, dryRun: result.dryRun, stats: result.stats });
    res.json(result);
  } catch (e) {
    throw new AppError(502, 'HIS_UNREACHABLE', `ดึงข้อมูลจาก HIS ไม่สำเร็จ: ${e.message}`);
  }
});

router.post('/connectors/:id/test', validate({ params: idParam }), async (req, res) => {
  const c = await getConnector(req.valid.params.id);
  try { res.json(await sync.testConnection(c)); } catch (e) { res.json({ ok: false, error: e.message }); }
});

router.get('/connectors/:id/runs', validate({ params: idParam }), async (req, res) => {
  const { rows } = await db.query(
    `SELECT r.*, u.display_name AS started_by_name FROM integration_runs r LEFT JOIN users u ON u.id = r.started_by
      WHERE r.connector_id = $1 ORDER BY r.id DESC LIMIT 50`, [req.valid.params.id]);
  res.json(rows);
});

router.get('/outbox', validate({
  query: z.object({ status: z.enum(['pending', 'sent', 'failed', 'dead']).optional(), connectorId: z.coerce.number().int().optional() }),
}), async (req, res) => {
  const { rows } = await db.query(
    `SELECT o.*, c.code AS connector_code FROM integration_outbox o JOIN integration_connectors c ON c.id = o.connector_id
      WHERE ($1::text IS NULL OR o.status = $1) AND ($2::int IS NULL OR o.connector_id = $2)
      ORDER BY o.id DESC LIMIT 200`, [req.valid.query.status ?? null, req.valid.query.connectorId ?? null]);
  res.json(rows);
});

router.post('/outbox/:id/retry', validate({ params: idParam }), async (req, res) => {
  const { rows: [o] } = await db.query("SELECT * FROM integration_outbox WHERE id = $1 AND status IN ('failed','dead')", [req.valid.params.id]);
  if (!o) throw notFound('งานที่ส่งไม่สำเร็จ');
  // มีงานใหม่ของ record เดียวกันรออยู่แล้ว → งานนั้นจะส่งข้อมูลล่าสุดแทน
  const { rows: [newer] } = await db.query(
    "SELECT id FROM integration_outbox WHERE connector_id = $1 AND resource_type = $2 AND entity_id = $3 AND status IN ('pending','failed') AND id <> $4",
    [o.connector_id, o.resource_type, o.entity_id, o.id]);
  if (newer) {
    await db.query("UPDATE integration_outbox SET status = 'sent', last_error = 'แทนที่ด้วยงานใหม่' WHERE id = $1", [o.id]);
    await db.query('UPDATE integration_outbox SET next_attempt_at = now() WHERE id = $1', [newer.id]);
    return res.json({ id: newer.id, replaced: o.id });
  }
  const { rows: [r] } = await db.query(
    "UPDATE integration_outbox SET status = 'pending', attempts = 0, next_attempt_at = now() WHERE id = $1 RETURNING *", [o.id]);
  res.json(r);
});

router.post('/outbox/process', async (_req, res) => {
  res.json(await outbox.processOutbox({ limit: 100 }));
});

module.exports = { router, inboundRouter };
