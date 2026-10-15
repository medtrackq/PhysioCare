const router = require('express').Router();
const { z } = require('zod');
const db = require('../db');
const { authorize } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { notFound } = require('../errors');
const svc = require('../services/equipment.service');
const { audit } = require('../services/audit.service');

const idParam = z.object({ id: z.string().uuid() });
const STATUSES = ['available', 'in_use', 'maintenance', 'broken', 'retired'];

router.get('/categories', authorize('equipment:read'), async (_req, res) => {
  const { rows } = await db.query(
    `SELECT c.*, count(e.id)::int AS total,
            count(e.id) FILTER (WHERE e.status = 'available')::int AS available
       FROM equipment_categories c LEFT JOIN equipment e ON e.category_id = c.id AND e.status <> 'retired'
      GROUP BY c.id ORDER BY c.name_en`);
  res.json(rows);
});

router.get('/', authorize('equipment:read'), validate({
  query: z.object({
    status: z.enum(STATUSES).optional(),
    categoryId: z.coerce.number().int().optional(),
    q: z.string().max(100).optional(),
  }),
}), async (req, res) => {
  const { status, categoryId, q } = req.valid.query;
  const { rows } = await db.query(
    `SELECT v.*, e.brand, e.model, e.status_changed_at, e.current_appointment_id, e.category_id
       FROM v_equipment_overview v JOIN equipment e ON e.id = v.id
      WHERE ($1::text IS NULL OR v.status = $1)
        AND ($2::int IS NULL OR e.category_id = $2)
        AND ($3::text IS NULL OR v.name ILIKE '%' || $3 || '%' OR v.asset_code ILIKE '%' || $3 || '%')
      ORDER BY v.category_name, v.asset_code`, [status ?? null, categoryId ?? null, q ?? null]);
  const counts = STATUSES.reduce((o, s) => ({ ...o, [s]: rows.filter((r) => r.status === s).length }), {});
  res.json({ items: rows, counts });
});

router.get('/:id', authorize('equipment:read'), validate({ params: idParam }), async (req, res) => {
  const { id } = req.valid.params;
  const { rows: [eq] } = await db.query(
    `SELECT e.*, c.code AS category_code, c.name_th AS category_name, c.cleaning_buffer_minutes, c.maintenance_interval_days
       FROM equipment e JOIN equipment_categories c ON c.id = e.category_id WHERE e.id = $1`, [id]);
  if (!eq) throw notFound('อุปกรณ์');
  const [maint, logs, upcoming, images] = await Promise.all([
    db.query('SELECT * FROM equipment_maintenance WHERE equipment_id = $1 ORDER BY reported_at DESC', [id]),
    db.query(
      `SELECT l.*, u.display_name AS changed_by_name FROM equipment_status_logs l
         LEFT JOIN users u ON u.id = l.changed_by WHERE l.equipment_id = $1 ORDER BY l.changed_at DESC LIMIT 50`, [id]),
    svc.affectedAppointments(db, id),
    db.query(
      `SELECT id, caption, is_primary, created_at FROM media_files
        WHERE entity_type = 'equipment' AND entity_id = $1 ORDER BY is_primary DESC, created_at DESC`, [id]),
  ]);
  const totalCost = maint.rows.reduce((s, m) => s + Number(m.cost || 0), 0);
  res.json({
    ...eq,
    maintenance: maint.rows,
    maintenanceCostTotal: totalCost,
    statusLogs: logs.rows,
    upcomingBookings: upcoming,
    images: images.rows.map((m) => ({ ...m, url: `/api/media/${m.id}` })),
  });
});

const eqBody = z.object({
  assetCode: z.string().min(1),
  name: z.string().min(1),
  categoryId: z.number().int(),
  brand: z.string().nullish(),
  model: z.string().nullish(),
  serialNo: z.string().nullish(),
  location: z.string().nullish(),
  purchaseDate: z.string().date().nullish(),
  purchasePrice: z.number().nonnegative().nullish(),
  vendor: z.string().nullish(),
  warrantyExpiry: z.string().date().nullish(),
  notes: z.string().nullish(),
});
const COLS = {
  assetCode: 'asset_code', name: 'name', categoryId: 'category_id', brand: 'brand', model: 'model', serialNo: 'serial_no',
  location: 'location', purchaseDate: 'purchase_date', purchasePrice: 'purchase_price', vendor: 'vendor',
  warrantyExpiry: 'warranty_expiry', notes: 'notes',
};

router.post('/', authorize('equipment:write'), validate({ body: eqBody }), async (req, res) => {
  const b = req.valid.body;
  const keys = Object.keys(b).filter((k) => b[k] !== undefined);
  const { rows: [eq] } = await db.query(
    `INSERT INTO equipment (${keys.map((k) => COLS[k]).join(', ')}, next_maintenance_due)
     VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')},
             CURRENT_DATE + (SELECT maintenance_interval_days FROM equipment_categories WHERE id = $${keys.indexOf('categoryId') + 1}))
     RETURNING *`, keys.map((k) => b[k]));
  await audit(req, 'equipment.create', 'equipment', eq.id);
  res.status(201).json(eq);
});

router.patch('/:id', authorize('equipment:write'), validate({ params: idParam, body: eqBody.partial() }), async (req, res) => {
  const b = req.valid.body;
  const keys = Object.keys(b).filter((k) => b[k] !== undefined);
  if (!keys.length) return res.json({});
  const { rows: [eq] } = await db.query(
    `UPDATE equipment SET ${keys.map((k, i) => `${COLS[k]} = $${i + 2}`).join(', ')} WHERE id = $1 RETURNING *`,
    [req.valid.params.id, ...keys.map((k) => b[k])]);
  if (!eq) throw notFound('อุปกรณ์');
  await audit(req, 'equipment.update', 'equipment', eq.id, b);
  res.json(eq);
});

router.patch('/:id/status', authorize('equipment:status'), validate({
  params: idParam,
  body: z.object({ status: z.enum(['available', 'maintenance', 'broken', 'retired']), reason: z.string().max(500).optional() }),
}), async (req, res) => {
  const result = await svc.changeStatus(req.user, req.valid.params.id, req.valid.body);
  await audit(req, 'equipment.status', 'equipment', req.valid.params.id, req.valid.body);
  res.json(result);
});

router.post('/:id/maintenance', authorize('maintenance:write'), validate({
  params: idParam,
  body: z.object({
    type: z.enum(['preventive', 'corrective', 'calibration', 'inspection']),
    status: z.enum(['scheduled', 'in_progress']).optional(),
    plannedStart: z.string().datetime({ offset: true }).optional(),
    plannedEnd: z.string().datetime({ offset: true }).optional(),
    problem: z.string().optional(),
    vendor: z.string().optional(),
    technician: z.string().optional(),
    cost: z.number().nonnegative().optional(),
  }).refine((b) => !b.plannedStart === !b.plannedEnd, 'ต้องระบุ plannedStart และ plannedEnd คู่กัน'),
}), async (req, res) => {
  const m = await svc.createMaintenance(req.user, req.valid.params.id, req.valid.body);
  await audit(req, 'maintenance.create', 'equipment', req.valid.params.id, { maintenanceId: m.id });
  res.status(201).json(m);
});

router.patch('/maintenance/:id', authorize('maintenance:write'), validate({
  params: idParam,
  body: z.object({
    status: z.enum(['in_progress', 'completed', 'cancelled']),
    actionTaken: z.string().optional(),
    result: z.enum(['pass', 'fail', 'repaired', 'replaced_part', 'sent_to_vendor']).optional(),
    cost: z.number().nonnegative().optional(),
    technician: z.string().optional(),
    vendor: z.string().optional(),
  }),
}), async (req, res) => {
  const m = await svc.updateMaintenance(req.user, req.valid.params.id, req.valid.body);
  await audit(req, 'maintenance.update', 'maintenance', m.id, req.valid.body);
  res.json(m);
});

module.exports = router;
