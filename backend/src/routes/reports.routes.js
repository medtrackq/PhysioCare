const router = require('express').Router();
const { z } = require('zod');
const db = require('../db');
const { authorize } = require('../middleware/auth');
const { validate } = require('../middleware/validate');

const range = z.object({ from: z.string().date(), to: z.string().date() });
const BKK = (n) => `($${n}::date)::timestamp AT TIME ZONE 'Asia/Bangkok'`;
const BKK_END = (n) => `($${n}::date + 1)::timestamp AT TIME ZONE 'Asia/Bangkok'`;

router.get('/summary', authorize('reports:view'), validate({ query: range }), async (req, res) => {
  const { from, to } = req.valid.query;
  const p = [from, to];
  const [byStatus, therapist, equipment, outcome, maint, daily] = await Promise.all([
    db.query(
      `SELECT status, count(*)::int AS n FROM appointments
        WHERE start_at >= ${BKK(1)} AND start_at < ${BKK_END(2)} GROUP BY status`, p),
    // Utilization นักกายภาพ = ชั่วโมงนัด / ชั่วโมงกะ
    db.query(
      `WITH sh AS (
         SELECT staff_id, sum(extract(epoch FROM end_at - start_at)) / 3600 AS shift_h
           FROM staff_shifts WHERE start_at >= ${BKK(1)} AND start_at < ${BKK_END(2)} GROUP BY staff_id),
       ap AS (
         SELECT therapist_id, count(*) AS visits,
                sum(extract(epoch FROM end_at - start_at)) / 3600 AS booked_h
           FROM appointments WHERE status NOT IN ('cancelled','no_show')
            AND start_at >= ${BKK(1)} AND start_at < ${BKK_END(2)} GROUP BY therapist_id)
       SELECT s.id, s.title || s.first_name || ' ' || s.last_name AS name,
              COALESCE(ap.visits, 0)::int AS visits,
              round(COALESCE(ap.booked_h, 0)::numeric, 1) AS booked_hours,
              round(COALESCE(sh.shift_h, 0)::numeric, 1) AS shift_hours,
              CASE WHEN sh.shift_h > 0 THEN round((100 * COALESCE(ap.booked_h, 0) / sh.shift_h)::numeric, 1) END AS utilization_pct
         FROM staff s LEFT JOIN sh ON sh.staff_id = s.id LEFT JOIN ap ON ap.therapist_id = s.id
        WHERE s.position = 'physiotherapist' ORDER BY utilization_pct DESC NULLS LAST`, p),
    db.query(
      `SELECT c.name_th AS category, count(DISTINCT e.id)::int AS units,
              round(COALESCE(sum(extract(epoch FROM ae.end_at - ae.start_at)) / 3600, 0)::numeric, 1) AS booked_hours
         FROM equipment_categories c
         JOIN equipment e ON e.category_id = c.id AND e.status <> 'retired'
         LEFT JOIN appointment_equipment ae ON ae.equipment_id = e.id AND ae.is_active
              AND ae.start_at >= ${BKK(1)} AND ae.start_at < ${BKK_END(2)}
        GROUP BY c.id ORDER BY booked_hours DESC`, p),
    // ผลลัพธ์ทางคลินิก: pain ลดลงเฉลี่ยต่อโรค
    db.query(
      `SELECT d.icd10_code, d.name_th, count(*)::int AS sessions,
              round(avg(pre.pain_score - post.pain_score)::numeric, 2) AS avg_pain_reduction,
              round(100.0 * count(*) FILTER (WHERE post.treatment_response = 'improved') / count(*), 1) AS improved_pct
         FROM appointments a
         JOIN diagnoses d ON d.id = a.diagnosis_id
         JOIN clinical_assessments pre ON pre.appointment_id = a.id AND pre.phase = 'pre'
         JOIN clinical_assessments post ON post.appointment_id = a.id AND post.phase = 'post'
        WHERE a.start_at >= ${BKK(1)} AND a.start_at < ${BKK_END(2)}
        GROUP BY d.id ORDER BY sessions DESC`, p),
    db.query(
      `SELECT type, count(*)::int AS n, COALESCE(sum(cost), 0) AS cost,
              round(avg(extract(epoch FROM completed_at - reported_at) / 3600) FILTER (WHERE completed_at IS NOT NULL)::numeric, 1) AS avg_turnaround_hours
         FROM equipment_maintenance WHERE reported_at >= ${BKK(1)} AND reported_at < ${BKK_END(2)} GROUP BY type`, p),
    db.query(
      `SELECT (start_at AT TIME ZONE 'Asia/Bangkok')::date AS day, count(*)::int AS total,
              count(*) FILTER (WHERE status = 'completed')::int AS completed,
              count(*) FILTER (WHERE status = 'no_show')::int AS no_show
         FROM appointments WHERE start_at >= ${BKK(1)} AND start_at < ${BKK_END(2)}
        GROUP BY 1 ORDER BY 1`, p),
  ]);
  const statusMap = Object.fromEntries(byStatus.rows.map((r) => [r.status, r.n]));
  const total = byStatus.rows.reduce((s, r) => s + r.n, 0);
  const finished = (statusMap.completed || 0) + (statusMap.no_show || 0);
  res.json({
    range: { from, to },
    appointments: { total, byStatus: statusMap, noShowRatePct: finished ? Math.round((1000 * (statusMap.no_show || 0)) / finished) / 10 : 0 },
    therapistUtilization: therapist.rows,
    equipmentUtilization: equipment.rows,
    clinicalOutcomes: outcome.rows,
    maintenance: maint.rows,
    daily: daily.rows,
  });
});

router.get('/equipment-alerts', authorize('reports:view', 'equipment:read'), async (_req, res) => {
  const { rows } = await db.query(
    `SELECT id, asset_code, name, status, next_maintenance_due, category_name,
            CASE WHEN status IN ('broken','maintenance') THEN status
                 WHEN next_maintenance_due < CURRENT_DATE THEN 'maintenance_overdue'
                 ELSE 'maintenance_due_soon' END AS alert
       FROM v_equipment_overview
      WHERE status IN ('broken','maintenance') OR maintenance_due_soon
      ORDER BY next_maintenance_due NULLS FIRST`);
  res.json(rows);
});

router.get('/audit', authorize('audit:read'), validate({
  query: z.object({ entityType: z.string().optional(), entityId: z.string().uuid().optional(), limit: z.coerce.number().int().max(500).default(100) }),
}), async (req, res) => {
  const q = req.valid.query;
  const { rows } = await db.query(
    `SELECT l.*, u.display_name FROM audit_logs l LEFT JOIN users u ON u.id = l.user_id
      WHERE ($1::text IS NULL OR l.entity_type = $1) AND ($2::uuid IS NULL OR l.entity_id = $2)
      ORDER BY l.id DESC LIMIT $3`, [q.entityType ?? null, q.entityId ?? null, q.limit]);
  res.json(rows);
});

module.exports = router;
