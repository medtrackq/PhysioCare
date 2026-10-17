const router = require('express').Router();
const { authenticate, authorize } = require('../middleware/auth');
const sse = require('../realtime/sse');

router.get('/health', (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));
router.use('/auth', require('./auth.routes'));

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
router.use('/', require('./scheduling.routes'));

module.exports = router;
