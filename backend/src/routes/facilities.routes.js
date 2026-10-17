/**
 * Facilities: ห้องและเตียง
 *  - ทะเบียนห้อง (ประเภท, ความจุ) และเตียง (ประเภท, สถานะ)
 *  - ผังห้อง/เตียงแบบ real-time: ใครอยู่เตียงไหน ตอนนี้ และนัดถัดไป
 *  - ปิดเตียงซ่อม -> แจ้งนัดในอนาคตที่ได้รับผลกระทบ + เตียงทดแทน
 */
const router = require('express').Router();
const { z } = require('zod');
const db = require('../db');
const { authorize } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { notFound, unprocessable } = require('../errors');
const { audit } = require('../services/audit.service');
const avail = require('../services/availability');

const uuid = z.string().uuid();
const ROOM_TYPES = ['treatment', 'private', 'gym', 'pediatric', 'hydro', 'consult'];
const BED_TYPES = ['standard', 'hi_lo', 'treatment_table', 'mat', 'pediatric', 'bariatric'];

router.get('/rooms', authorize('equipment:read', 'appointments:read_all'), async (_req, res) => {
  const { rows } = await db.query(
    `SELECT r.*,
            COALESCE((SELECT json_agg(b ORDER BY b.code) FROM beds b WHERE b.room_id = r.id), '[]') AS beds,
            COALESCE((SELECT json_agg(json_build_object('id', e.id, 'name', e.name, 'asset_code', e.asset_code, 'status', e.status) ORDER BY e.asset_code)
                        FROM equipment e WHERE e.room_id = r.id), '[]') AS fixed_equipment
       FROM rooms r ORDER BY r.code`);
  res.json(rows);
});

/** ผังห้อง/เตียง ณ เวลาที่ระบุ (ค่าเริ่มต้น = ตอนนี้) */
router.get('/board', authorize('equipment:read', 'appointments:read_all'), validate({
  query: z.object({ at: z.string().datetime({ offset: true }).optional() }),
}), async (req, res) => {
  const at = req.valid.query.at ? new Date(req.valid.query.at) : new Date();
  const [rooms, beds, appts, equipment] = await Promise.all([
    db.query('SELECT * FROM rooms WHERE is_active ORDER BY code'),
    db.query('SELECT * FROM beds WHERE is_active ORDER BY code'),
    // นัดที่กำลังอยู่ ณ เวลานั้น + นัดถัดไปของวัน
    db.query(
      `SELECT a.id, a.room_id, a.bed_id, a.start_at, a.end_at, a.bed_until, a.status,
              p.first_name || ' ' || p.last_name AS patient_name, p.hn,
              s.title || s.first_name AS therapist_name, s.color AS therapist_color
         FROM appointments a JOIN patients p ON p.id = a.patient_id JOIN staff s ON s.id = a.therapist_id
        WHERE a.room_id IS NOT NULL AND a.status NOT IN ('cancelled','no_show')
          AND COALESCE(a.bed_until, a.end_at) > $1
          AND (a.start_at AT TIME ZONE 'Asia/Bangkok')::date = ($1::timestamptz AT TIME ZONE 'Asia/Bangkok')::date
        ORDER BY a.start_at`, [at]),
    // อุปกรณ์: ตำแหน่ง ณ เวลานั้น = ห้องที่ติดตั้ง หรือห้อง/เตียงของนัดที่กำลังใช้อยู่ (อุปกรณ์เคลื่อนย้ายได้)
    db.query(
      `SELECT e.id, e.name, e.asset_code, e.status, e.room_id, e.plan_x, e.plan_z, c.code AS category_code, c.space_type,
              cur.appointment_id AS in_use_by, cur.room_id AS in_use_room_id, cur.bed_id AS in_use_bed_id
         FROM equipment e
         JOIN equipment_categories c ON c.id = e.category_id
         LEFT JOIN LATERAL (
           SELECT a.id AS appointment_id, a.room_id, a.bed_id
             FROM appointment_equipment ae JOIN appointments a ON a.id = ae.appointment_id
            WHERE ae.equipment_id = e.id AND ae.is_active AND a.status NOT IN ('cancelled','no_show')
              AND a.start_at <= $1 AND a.end_at > $1
            LIMIT 1) cur ON true
        WHERE e.status <> 'retired'
        ORDER BY e.asset_code`, [at]),
  ]);
  const now = at.getTime();
  const isCurrent = (a) => new Date(a.start_at).getTime() <= now && now < new Date(a.end_at).getTime();
  const isTurnover = (a) => a.bed_until && new Date(a.end_at).getTime() <= now && now < new Date(a.bed_until).getTime();
  const currentAppts = appts.rows.filter(isCurrent);
  res.json({
    at,
    equipment: equipment.rows,
    kpis: {
      patientsNow: currentAppts.length,
      therapistsBusy: new Set(currentAppts.map((a) => a.therapist_name)).size,
      bedsOccupied: currentAppts.filter((a) => a.bed_id).length,
      bedsTotal: beds.rows.filter((b) => b.status === 'available').length,
      equipmentInUse: equipment.rows.filter((e) => e.in_use_by).length,
      equipmentDown: equipment.rows.filter((e) => ['broken', 'maintenance'].includes(e.status)).length,
      remainingToday: appts.rows.filter((a) => new Date(a.start_at).getTime() > now).length,
    },
    rooms: rooms.rows.map((r) => {
      const inRoom = appts.rows.filter((a) => a.room_id === r.id);
      return {
        ...r,
        occupancyNow: inRoom.filter(isCurrent).length,
        current: r.room_type === 'gym' ? inRoom.filter(isCurrent) : undefined,
        next: inRoom.filter((a) => new Date(a.start_at).getTime() > now).slice(0, 3),
        beds: beds.rows.filter((b) => b.room_id === r.id).map((b) => {
          const mine = inRoom.filter((a) => a.bed_id === b.id);
          const current = mine.find(isCurrent) || null;
          const state = b.status !== 'available' ? b.status
            : current ? 'occupied' : mine.some(isTurnover) ? 'turnover' : 'free';
          return { ...b, state, current, next: mine.find((a) => new Date(a.start_at).getTime() > now) || null, todayRemaining: mine.length };
        }),
      };
    }),
  });
});

const roomBody = z.object({
  code: z.string().min(1).max(20),
  name: z.string().min(1),
  roomType: z.enum(ROOM_TYPES),
  floor: z.string().nullish(),
  capacity: z.number().int().min(1).max(100),
  isActive: z.boolean().optional(),
  notes: z.string().nullish(),
  planX: z.number().min(-500).max(500).nullish(),
  planZ: z.number().min(-500).max(500).nullish(),
  planW: z.number().positive().max(200).nullish(),
  planD: z.number().positive().max(200).nullish(),
});
const ROOM_COLS = {
  code: 'code', name: 'name', roomType: 'room_type', floor: 'floor', capacity: 'capacity', isActive: 'is_active', notes: 'notes',
  planX: 'plan_x', planZ: 'plan_z', planW: 'plan_w', planD: 'plan_d',
};

router.post('/rooms', authorize('equipment:write'), validate({ body: roomBody }), async (req, res) => {
  const b = req.valid.body;
  const keys = Object.keys(b).filter((k) => b[k] !== undefined);
  const { rows: [r] } = await db.query(
    `INSERT INTO rooms (${keys.map((k) => ROOM_COLS[k]).join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
    keys.map((k) => b[k]));
  await audit(req, 'room.create', 'room', r.id);
  res.status(201).json(r);
});

router.patch('/rooms/:id', authorize('equipment:write'), validate({ params: z.object({ id: uuid }), body: roomBody.partial() }), async (req, res) => {
  const b = req.valid.body;
  const keys = Object.keys(b).filter((k) => b[k] !== undefined);
  if (!keys.length) return res.json({});
  const { rows: [r] } = await db.query(
    `UPDATE rooms SET ${keys.map((k, i) => `${ROOM_COLS[k]} = $${i + 2}`).join(', ')} WHERE id = $1 RETURNING *`,
    [req.valid.params.id, ...keys.map((k) => b[k])]);
  if (!r) throw notFound('ห้อง');
  await audit(req, 'room.update', 'room', r.id, b);
  res.json(r);
});

const bedBody = z.object({
  roomId: uuid,
  code: z.string().min(1).max(20),
  name: z.string().min(1),
  bedType: z.enum(BED_TYPES),
  isActive: z.boolean().optional(),
  notes: z.string().nullish(),
  planX: z.number().min(-200).max(200).nullish(),
  planZ: z.number().min(-200).max(200).nullish(),
  planRot: z.number().int().min(-360).max(360).optional(),
});
const BED_COLS = {
  roomId: 'room_id', code: 'code', name: 'name', bedType: 'bed_type', isActive: 'is_active', notes: 'notes',
  planX: 'plan_x', planZ: 'plan_z', planRot: 'plan_rot',
};

router.post('/beds', authorize('equipment:write'), validate({ body: bedBody }), async (req, res) => {
  const b = req.valid.body;
  const keys = Object.keys(b).filter((k) => b[k] !== undefined);
  const { rows: [r] } = await db.query(
    `INSERT INTO beds (${keys.map((k) => BED_COLS[k]).join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
    keys.map((k) => b[k]));
  await audit(req, 'bed.create', 'bed', r.id);
  res.status(201).json(r);
});

router.patch('/beds/:id', authorize('equipment:write'), validate({ params: z.object({ id: uuid }), body: bedBody.partial() }), async (req, res) => {
  const b = req.valid.body;
  const keys = Object.keys(b).filter((k) => b[k] !== undefined);
  if (!keys.length) return res.json({});
  const { rows: [r] } = await db.query(
    `UPDATE beds SET ${keys.map((k, i) => `${BED_COLS[k]} = $${i + 2}`).join(', ')} WHERE id = $1 RETURNING *`,
    [req.valid.params.id, ...keys.map((k) => b[k])]);
  if (!r) throw notFound('เตียง');
  await audit(req, 'bed.update', 'bed', r.id, b);
  res.json(r);
});

/** เปลี่ยนสถานะเตียง — ปิดซ่อม/งดใช้ จะคืนรายการนัดในอนาคตที่ต้องย้ายพร้อมเตียงทดแทน */
router.patch('/beds/:id/status', authorize('equipment:status'), validate({
  params: z.object({ id: uuid }),
  body: z.object({ status: z.enum(['available', 'maintenance', 'out_of_service']), reason: z.string().max(500).optional() }),
}), async (req, res) => {
  const { id } = req.valid.params;
  const { status, reason } = req.valid.body;
  const bed = await db.withTx(async (c) => {
    const { rows: [cur] } = await c.query('SELECT * FROM beds WHERE id = $1 FOR UPDATE', [id]);
    if (!cur) throw notFound('เตียง');
    if (status !== 'available') {
      const busy = await c.query(`SELECT 1 FROM appointments WHERE bed_id = $1 AND status = 'in_progress'`, [id]);
      if (busy.rowCount) throw unprocessable('BED_IN_USE', 'มีผู้ป่วยกำลังรักษาบนเตียงนี้ — ปิดได้หลังจบการรักษา');
    }
    const notes = reason ? `${reason}` : cur.notes;
    return (await c.query('UPDATE beds SET status = $2, notes = $3 WHERE id = $1 RETURNING *', [id, status, notes])).rows[0];
  }, { userId: req.user.id });

  let affected = [];
  if (status !== 'available') {
    const { rows } = await db.query(
      `SELECT a.id, a.start_at, a.end_at, a.room_id, p.first_name || ' ' || p.last_name AS patient_name, s.title || s.first_name AS therapist
         FROM appointments a JOIN patients p ON p.id = a.patient_id JOIN staff s ON s.id = a.therapist_id
        WHERE a.bed_id = $1 AND a.status IN ('booked','confirmed','checked_in') AND a.end_at > now() ORDER BY a.start_at`, [id]);
    if (rows.length) {
      const ctx = await avail.loadContext(db, { from: rows[0].start_at, to: rows.at(-1).end_at, spaces: true });
      affected = rows.map((a) => {
        const s = new Date(a.start_at).getTime();
        const e = new Date(a.end_at).getTime();
        const subs = [...ctx.beds.values()]
          .filter((b) => b.id !== id && avail.isBedFree(ctx, b.id, s, e) && avail.roomHasCapacity(ctx, b.room_id, s, e))
          .sort((x, y) => (x.room_id === a.room_id ? 0 : 1) - (y.room_id === a.room_id ? 0 : 1))
          .slice(0, 3)
          .map((b) => ({ bedId: b.id, code: b.code, name: b.name, roomName: ctx.rooms.get(b.room_id)?.name }));
        return { ...a, substitutes: subs };
      });
    }
  }
  await audit(req, 'bed.status', 'bed', id, { status, reason });
  res.json({ bed, affectedAppointments: affected });
});

module.exports = router;
