const router = require('express').Router();
const { z } = require('zod');
const db = require('../db');
const { authorize, can } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { notFound, forbidden } = require('../errors');
const sched = require('../services/scheduling.service');
const { recommend } = require('../services/recommendation.service');
const { audit } = require('../services/audit.service');

const uuid = z.string().uuid();
const dt = z.string().datetime({ offset: true });
const idParam = z.object({ id: uuid });

// ------------------------------------------------------------------
// Smart scheduling helpers
// ------------------------------------------------------------------
router.get('/scheduling/recommendations', authorize('appointments:write'), validate({
  query: z.object({
    patientId: uuid,
    diagnosisIds: z.string().optional().transform((s) => (s ? s.split(',').map(Number).filter(Boolean) : undefined)),
    startAt: dt.optional(),
    durationMin: z.coerce.number().int().min(10).max(240).default(45),
  }),
}), async (req, res) => {
  res.json(await recommend(req.valid.query));
});

router.get('/scheduling/slots', authorize('appointments:write'), validate({
  query: z.object({
    date: z.string().date(),
    durationMin: z.coerce.number().int().min(10).max(240).default(45),
    patientId: uuid.optional(),
    therapistIds: z.string().optional().transform((s) => (s ? s.split(',') : undefined)),
    categoryIds: z.string().optional().transform((s) => (s ? s.split(',').map(Number).filter(Boolean) : [])),
  }),
}), async (req, res) => {
  res.json(await sched.findSlots(req.valid.query));
});

const bookingBody = z.object({
  patientId: uuid,
  therapistId: uuid,
  startAt: dt,
  endAt: dt,
  equipmentIds: z.array(uuid).max(6).default([]),
  diagnosisId: z.number().int().optional(),
  visitType: z.enum(['initial', 'follow_up', 're_evaluation']).optional(),
  notes: z.string().max(1000).optional(),
  bookedVia: z.enum(['manual', 'recommendation', 'patient_portal']).optional(),
  acknowledgeWarnings: z.boolean().optional(),
  roomId: uuid.optional(),
  bedId: uuid.optional(),
});

/** Dry-run: ตรวจความขัดแย้งโดยไม่จองจริง (ใช้แสดงผลแบบ real-time บนฟอร์มจอง) */
router.post('/scheduling/check', authorize('appointments:write'), validate({
  body: bookingBody.extend({ excludeAppointmentId: uuid.optional() }),
}), async (req, res) => {
  const input = await sched.autoAssignSpace(db, req.valid.body);
  const result = await sched.checkConflicts(db, input);
  result.space = { roomId: input.roomId || null, bedId: input.bedId || null, autoAssigned: Boolean(input.spaceAutoAssigned) };
  if (!result.ok) result.alternatives = await sched.suggestAlternatives(input, result.conflicts);
  res.json(result);
});

// ------------------------------------------------------------------
// Appointments
// ------------------------------------------------------------------
const APPT_SELECT = `
  SELECT a.*, p.hn, p.title AS patient_title, p.first_name || ' ' || p.last_name AS patient_name,
         s.title || s.first_name || ' ' || s.last_name AS therapist_name, s.color AS therapist_color,
         d.icd10_code, d.name_th AS diagnosis_name,
         rm.code AS room_code, rm.name AS room_name, bd.code AS bed_code, bd.name AS bed_name,
         COALESCE((SELECT json_agg(json_build_object('id', e.id, 'name', e.name, 'asset_code', e.asset_code,
                                     'status', e.status, 'reserved_until', ae.end_at))
                     FROM appointment_equipment ae JOIN equipment e ON e.id = ae.equipment_id
                    WHERE ae.appointment_id = a.id AND ae.is_active), '[]') AS equipment,
         EXISTS (SELECT 1 FROM clinical_assessments ca WHERE ca.appointment_id = a.id AND ca.phase = 'pre') AS has_pre,
         EXISTS (SELECT 1 FROM clinical_assessments ca WHERE ca.appointment_id = a.id AND ca.phase = 'post') AS has_post
    FROM appointments a
    JOIN patients p ON p.id = a.patient_id
    JOIN staff s ON s.id = a.therapist_id
    LEFT JOIN diagnoses d ON d.id = a.diagnosis_id
    LEFT JOIN rooms rm ON rm.id = a.room_id
    LEFT JOIN beds bd ON bd.id = a.bed_id`;

router.get('/appointments', authorize('appointments:read_all', 'appointments:read_own'), validate({
  query: z.object({
    from: dt.optional(),
    to: dt.optional(),
    therapistId: uuid.optional(),
    patientId: uuid.optional(),
    status: z.string().optional(),
  }),
}), async (req, res) => {
  const q = req.valid.query;
  // Row-level security: ผู้ป่วยเห็นเฉพาะนัดของตนเอง
  let patientId = q.patientId ?? null;
  if (!can(req.user, 'appointments:read_all')) {
    if (!req.user.patientId) throw forbidden();
    patientId = req.user.patientId;
  }
  const { rows } = await db.query(
    `${APPT_SELECT}
      WHERE ($1::timestamptz IS NULL OR a.end_at > $1)
        AND ($2::timestamptz IS NULL OR a.start_at < $2)
        AND ($3::uuid IS NULL OR a.therapist_id = $3)
        AND ($4::uuid IS NULL OR a.patient_id = $4)
        AND ($5::text[] IS NULL OR a.status = ANY($5))
      ORDER BY a.start_at LIMIT 500`,
    [q.from ?? null, q.to ?? null, q.therapistId ?? null, patientId, q.status ? q.status.split(',') : null]);

  if (!can(req.user, 'appointments:read_all')) {
    // ผู้ป่วยไม่ต้องเห็นข้อมูลภายใน
    return res.json(rows.map((r) => ({
      id: r.id, start_at: r.start_at, end_at: r.end_at, status: r.status, therapist_name: r.therapist_name,
      visit_type: r.visit_type, diagnosis_name: r.diagnosis_name, room_name: r.room_name,
    })));
  }
  res.json(rows);
});

router.get('/appointments/:id', authorize('appointments:read_all', 'appointments:read_own'), validate({ params: idParam }), async (req, res) => {
  const { rows: [a] } = await db.query(`${APPT_SELECT} WHERE a.id = $1`, [req.valid.params.id]);
  if (!a) throw notFound('นัดหมาย');
  if (!can(req.user, 'appointments:read_all') && a.patient_id !== req.user.patientId) throw notFound('นัดหมาย');
  res.json(a);
});

router.post('/appointments', authorize('appointments:write'), validate({ body: bookingBody }), async (req, res) => {
  const result = await sched.createAppointment(req.user, req.valid.body);
  await audit(req, 'appointment.create', 'appointment', result.appointment.id, { warningsAcknowledged: result.warnings.length });
  res.status(201).json(result);
});

router.patch('/appointments/:id/reschedule', authorize('appointments:write'), validate({
  params: idParam,
  body: z.object({
    startAt: dt, endAt: dt, version: z.number().int(), therapistId: uuid.optional(), roomId: uuid.optional(), bedId: uuid.optional(),
    equipmentIds: z.array(uuid).max(6).optional(), acknowledgeWarnings: z.boolean().optional(),
  }),
}), async (req, res) => {
  const result = await sched.rescheduleAppointment(req.user, req.valid.params.id, req.valid.body);
  await audit(req, 'appointment.reschedule', 'appointment', req.valid.params.id, req.valid.body);
  res.json(result);
});

router.patch('/appointments/:id/status', authorize('appointments:write'), validate({
  params: idParam,
  body: z.object({
    status: z.enum(['confirmed', 'checked_in', 'in_progress', 'completed', 'cancelled', 'no_show']),
    reason: z.string().max(500).optional(),
  }),
}), async (req, res) => {
  const appt = await sched.changeStatus(req.user, req.valid.params.id, req.valid.body);
  await audit(req, `appointment.${req.valid.body.status}`, 'appointment', appt.id, req.valid.body);
  res.json(appt);
});

module.exports = router;
