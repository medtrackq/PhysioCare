const router = require('express').Router();
const { z } = require('zod');
const db = require('../db');
const { authorize } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { invalidateSettings } = require('../services/settings.service');
const { audit } = require('../services/audit.service');
const { notFound } = require('../errors');

router.get('/', async (_req, res) => {
  const { rows } = await db.query('SELECT key, value, description, updated_at FROM system_settings ORDER BY key');
  res.json(rows);
});

router.put('/:key', authorize('settings:manage'), validate({ body: z.object({ value: z.any() }) }), async (req, res) => {
  const { rows: [s] } = await db.query(
    'UPDATE system_settings SET value = $2, updated_by = $3, updated_at = now() WHERE key = $1 RETURNING *',
    [req.params.key, JSON.stringify(req.valid.body.value), req.user.id]);
  if (!s) throw notFound('การตั้งค่า');
  invalidateSettings();
  await audit(req, 'settings.update', null, null, { key: req.params.key, value: req.valid.body.value });
  res.json(s);
});

module.exports = router;
