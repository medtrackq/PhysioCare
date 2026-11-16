const router = require('express').Router();
const { authenticate, authorize } = require('../middleware/auth');
const sse = require('../realtime/sse');

router.get('/health', (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));
router.use('/auth', require('./auth.routes'));
// HIS ส่งข้อมูลเข้า: ยืนยันตัวด้วย API key ของ connector (ไม่ใช้ JWT)
const integration = require('./integration.routes');
router.use('/integration/inbound', integration.inboundRouter);
// ผู้ป่วย/ญาติเปิดโปรแกรมที่บ้านผ่านลิงก์ (ยืนยันด้วย token ของลิงก์ ไม่ใช่ JWT)
const homeRoutes = require('./home.routes');
router.use('/public/home', homeRoutes.publicRouter);
// LINE webhook (ยืนยันด้วยลายเซ็นของ LINE)
const notifyRoutes = require('./notify.routes');
router.use('/line/webhook', notifyRoutes.webhookRouter);

// ทุก route ด้านล่างต้อง login
router.use(authenticate);
router.get('/realtime/stream', authorize('equipment:read', 'appointments:read_all'), sse.handler);
router.use('/users', require('./users.routes'));
router.use('/settings', require('./settings.routes'));
router.use('/equipment', require('./equipment.routes'));
router.use('/facilities', require('./facilities.routes'));
router.use('/staff', require('./staff.routes'));
router.use('/patients', require('./patients.routes'));
router.use('/emr', require('./emr.routes'));
router.use('/media', require('./media.routes'));
router.use('/reports', require('./reports.routes'));
router.use('/knowledge', require('./knowledge.routes'));
router.use('/integration', integration.router);
router.use('/home', homeRoutes.router);
router.use('/notify', notifyRoutes.router);
router.use('/', require('./scheduling.routes'));

module.exports = router;
