/**
 * Clinical knowledge base — แนวทางการรักษาตามหลักฐานเชิงประจักษ์ต่อการวินิจฉัย
 * (ใช้ทั้งในระบบแนะนำการจอง, หน้าคลังความรู้ และแถบอ้างอิงในเวชระเบียน)
 */
const router = require('express').Router();
const { z } = require('zod');
const db = require('../db');
const { authorize } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { notFound } = require('../errors');
const { guidelineInterventions, REC_RANK_SQL } = require('../services/recommendation.service');

router.use(authorize('patients:read', 'emr:read'));

router.get('/diagnoses', async (_req, res) => {
  const { rows } = await db.query(
    `SELECT d.id, d.icd10_code, d.name_th, d.name_en, d.body_region,
            (SELECT count(*)::int FROM diagnosis_interventions di WHERE di.diagnosis_id = d.id) AS interventions,
            (SELECT count(*)::int FROM diagnosis_equipment_map m WHERE m.diagnosis_id = d.id AND m.recommendation IN ('recommended','optional')) AS equipment
       FROM diagnoses d ORDER BY d.icd10_code`);
  res.json(rows);
});

router.get('/sources', async (_req, res) => {
  res.json((await db.query('SELECT * FROM clinical_sources ORDER BY organization, year DESC')).rows);
});

router.get('/diagnoses/:id', validate({ params: z.object({ id: z.coerce.number().int() }) }), async (req, res) => {
  const id = req.valid.params.id;
  const { rows: [dx] } = await db.query('SELECT * FROM diagnoses WHERE id = $1', [id]);
  if (!dx) throw notFound('การวินิจฉัย');
  const [equipment, specialties, interventions] = await Promise.all([
    db.query(
      `SELECT c.id, c.code, c.name_th, c.name_en, c.modality, m.weight, m.rationale, m.recommendation, m.grade,
              cs.code AS source_code, cs.title AS source_title, cs.organization AS source_org, cs.year AS source_year, cs.url AS source_url,
              (SELECT count(*)::int FROM equipment e WHERE e.category_id = c.id AND e.status IN ('available','in_use')) AS units_available
         FROM diagnosis_equipment_map m
         JOIN equipment_categories c ON c.id = m.equipment_category_id
         LEFT JOIN clinical_sources cs ON cs.id = m.source_id
        WHERE m.diagnosis_id = $1
        ORDER BY ${REC_RANK_SQL('m.recommendation')}, m.weight DESC`, [id]),
    db.query(
      `SELECT s.code, s.name_th, s.name_en, m.weight FROM diagnosis_specialty_map m
         JOIN specialties s ON s.id = m.specialty_id WHERE m.diagnosis_id = $1 ORDER BY m.weight DESC`, [id]),
    guidelineInterventions([id]),
  ]);
  const sources = new Map();
  for (const x of [...interventions, ...equipment.rows.map((r) => ({ source: r.source_code ? { code: r.source_code, title: r.source_title, organization: r.source_org, year: r.source_year, url: r.source_url } : null }))]) {
    if (x.source) sources.set(x.source.code, x.source);
  }
  res.json({
    ...dx,
    specialties: specialties.rows,
    interventions,
    equipment: equipment.rows.map(({ source_code: code, source_title: title, source_org: organization, source_year: year, source_url: url, ...r }) => ({
      ...r, source: code ? { code, title, organization, year, url } : null,
    })),
    sources: [...sources.values()],
  });
});

module.exports = router;
