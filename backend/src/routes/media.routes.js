const router = require('express').Router();
const { z } = require('zod');
const upload = require('../middleware/upload');
const { authorize } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const media = require('../services/media.service');
const { audit } = require('../services/audit.service');

const ENTITY = z.enum(['equipment', 'staff', 'patient', 'assessment', 'maintenance', 'user']);

router.post('/:entityType/:entityId', authorize('media:upload'), upload.array('images', 10), validate({
  params: z.object({ entityType: ENTITY, entityId: z.string().uuid() }),
  body: z.object({
    kind: z.enum(['photo', 'posture', 'wound', 'document', 'avatar']).default('photo'),
    caption: z.string().max(300).optional(),
    primary: z.enum(['true', 'false']).optional(),
  }),
}), async (req, res) => {
  const { entityType, entityId } = req.valid.params;
  const saved = await media.saveImages(req.user, entityType, entityId, req.files, {
    kind: req.valid.body.kind, caption: req.valid.body.caption, makePrimary: req.valid.body.primary === 'true',
  });
  await audit(req, 'media.upload', entityType, entityId, { count: saved.length });
  res.status(201).json(saved);
});

router.get('/', validate({ query: z.object({ entityType: ENTITY, entityId: z.string().uuid() }) }), async (req, res) => {
  res.json(await media.list(req.user, req.valid.query.entityType, req.valid.query.entityId));
});

router.get('/:id', validate({ params: z.object({ id: z.string().uuid() }) }), async (req, res) => {
  const m = await media.getForRead(req.user, req.valid.params.id);
  if (['patient', 'assessment'].includes(m.entity_type)) await audit(req, 'media.view', m.entity_type, m.entity_id, { mediaId: m.id });
  res.setHeader('Content-Type', m.mime_type);
  res.setHeader('Content-Length', m.size_bytes);
  res.setHeader('Cache-Control', 'private, max-age=86400, immutable');
  res.setHeader('ETag', `"${m.sha256}"`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.headers['if-none-match'] === `"${m.sha256}"`) return res.status(304).end();
  media.storage.stream(m.storage_key).on('error', () => res.destroy()).pipe(res);
});

router.patch('/:id/primary', validate({ params: z.object({ id: z.string().uuid() }) }), async (req, res) => {
  await media.setPrimary(req.user, req.valid.params.id);
  res.json({ ok: true });
});

router.delete('/:id', validate({ params: z.object({ id: z.string().uuid() }) }), async (req, res) => {
  await media.remove(req.user, req.valid.params.id);
  await audit(req, 'media.delete', 'media', req.valid.params.id);
  res.status(204).end();
});

module.exports = router;
