/**
 * สิทธิ์ตามผู้ป่วยที่ดูแล
 *   GET  /api/access/patients/:id/care-team        ทีมผู้ดูแล (patients:read)
 *   PUT  /api/access/patients/:id/care-team        มอบหมายผู้ดูแลหลัก + ผู้ร่วมดูแล (care_team:assign)
 *   GET  /api/access/patients/:id/relation         ผู้ใช้นี้เข้าถึงข้อมูลการรักษาได้ทางใด (emr:read)
 *   POST /api/access/patients/:id/break-glass      เปิดดูฉุกเฉิน: ระบุเหตุผล มีอายุจำกัด (emr:read)
 *   GET  /api/access/break-glass                   รายการเปิดดูฉุกเฉิน (emr:read_all — หัวหน้า/super user)
 *   POST /api/access/break-glass/:id/review        หัวหน้ารับทราบแล้ว
 *   GET  /api/access/workload                      จำนวนผู้ป่วยที่แต่ละนักกายภาพดูแล (care_team:assign)
 */
const router = require('express').Router();
const { z } = require('zod');
const db = require('../db');
const { authorize } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const access = require('../services/access.service');

const uuid = z.string().uuid();
const idParam = z.object({ id: uuid });

router.get('/patients/:id/care-team', authorize('patients:read'), validate({ params: idParam }), async (req, res) => {
  res.json(await access.careTeam(req.valid.params.id));
});

router.put('/patients/:id/care-team', authorize('care_team:assign'), validate({
  params: idParam,
  body: z.object({ primaryStaffId: uuid.nullable(), staffIds: z.array(uuid).max(10).default([]) }),
}), async (req, res) => {
  res.json(await access.setCareTeam(req, req.valid.params.id, req.valid.body));
});

router.get('/patients/:id/relation', authorize('emr:read'), validate({ params: idParam }), async (req, res) => {
  res.json({ via: await access.relation(req.user, req.valid.params.id) });
});

router.post('/patients/:id/break-glass', authorize('emr:read'), validate({
  params: idParam, body: z.object({ reason: z.string().trim().min(10, 'ระบุเหตุผลอย่างน้อย 10 ตัวอักษร').max(500) }),
}), async (req, res) => {
  res.status(201).json(await access.breakGlass(req, req.valid.params.id, req.valid.body.reason));
});

router.get('/break-glass', authorize('emr:read_all'), validate({
  query: z.object({ days: z.coerce.number().int().min(1).max(365).default(30) }),
}), async (req, res) => {
  res.json(await access.breakGlassList(req.valid.query));
});

router.post('/break-glass/:id/review', authorize('emr:read_all'), validate({ params: idParam }), async (req, res) => {
  await access.reviewBreakGlass(req, req.valid.params.id);
  res.json({ ok: true });
});

router.get('/workload', authorize('care_team:assign'), async (_req, res) => {
  const { rows } = await db.query(
    `SELECT s.id, s.title || s.first_name || ' ' || s.last_name AS name, s.employee_code,
            count(ct.id) FILTER (WHERE ct.is_primary)::int AS primary_count, count(ct.id)::int AS total
       FROM staff s LEFT JOIN patient_care_team ct ON ct.staff_id = s.id AND ct.ended_at IS NULL
      WHERE s.is_active AND s.position = 'physiotherapist'
      GROUP BY s.id ORDER BY s.first_name`);
  res.json(rows);
});

module.exports = router;
