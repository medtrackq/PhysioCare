/**
 * EMR & Clinical Assessment
 *  - Pre-Treatment: Pain score (NRS 0-10), ROM, ทบทวนข้อควรระวัง/red flags, vital signs
 *  - Post-Treatment Progress Note: pain หลังรักษา, การตอบสนอง, การรักษาที่ทำ (เชื่อมอุปกรณ์), home program
 *  - ลงนามแล้วแก้ไม่ได้ (DB trigger) -> ใช้ addendum
 *  - Progress: เทียบ baseline / นัดก่อนหน้า สำหรับ pain และ ROM ราย joint-movement-side
 */
const db = require('../db');
const { notFound, forbidden, conflict, unprocessable } = require('../errors');

const ASSESSMENT_FIELDS = [
  'pain_score', 'pain_location', 'pain_character', 'vitals', 'subjective', 'objective', 'assessment', 'plan',
  'precautions_reviewed', 'red_flags', 'treatment_response', 'adverse_events', 'home_program', 'next_visit_plan',
  'goals', 'functional_scores',
];
const JSON_FIELDS = new Set(['vitals', 'goals', 'functional_scores']);

async function getAppointmentAssessments(appointmentId) {
  const { rows: [appt] } = await db.query(
    `SELECT a.*, p.hn, p.first_name || ' ' || p.last_name AS patient_name,
            COALESCE((SELECT json_agg(json_build_object('id', e.id, 'name', e.name, 'asset_code', e.asset_code))
                        FROM appointment_equipment ae JOIN equipment e ON e.id = ae.equipment_id
                       WHERE ae.appointment_id = a.id), '[]') AS equipment
       FROM appointments a JOIN patients p ON p.id = a.patient_id WHERE a.id = $1`, [appointmentId]);
  if (!appt) throw notFound('นัดหมาย');
  const { rows } = await db.query(
    `SELECT ca.*,
            COALESCE((SELECT json_agg(r ORDER BY r.joint, r.movement, r.side) FROM rom_measurements r WHERE r.assessment_id = ca.id), '[]') AS rom,
            COALESCE((SELECT json_agg(json_build_object('id', t.id, 'equipment_id', t.equipment_id, 'equipment_name', e.name,
                        'intervention', t.intervention, 'body_part', t.body_part, 'parameters', t.parameters, 'duration_min', t.duration_min))
                        FROM treatment_records t LEFT JOIN equipment e ON e.id = t.equipment_id
                       WHERE t.assessment_id = ca.id), '[]') AS treatments,
            COALESCE((SELECT json_agg(x ORDER BY x.created_at) FROM assessment_addenda x WHERE x.assessment_id = ca.id), '[]') AS addenda
       FROM clinical_assessments ca WHERE ca.appointment_id = $1`, [appointmentId]);
  const precautions = (await db.query(
    `SELECT pp.id, pt.code, pt.name_th, pt.severity, pp.detail FROM patient_precautions pp
       JOIN precaution_types pt ON pt.code = pp.precaution_code
      WHERE pp.patient_id = $1 AND pp.is_active`, [appt.patient_id])).rows;
  return {
    appointment: appt,
    pre: rows.find((r) => r.phase === 'pre') || null,
    post: rows.find((r) => r.phase === 'post') || null,
    activePrecautions: precautions,
    lastVisit: await lastVisitSummary(appt.patient_id, appointmentId),
  };
}

/** สร้าง/แก้ไขแบบร่าง (draft) ของ assessment — upsert ตาม (appointment, phase) */
async function upsertAssessment(user, appointmentId, phase, body) {
  if (!user.staffId) throw forbidden('เฉพาะบุคลากรที่ผูกกับข้อมูลพนักงานเท่านั้นที่บันทึกเวชระเบียนได้');
  return db.withTx(async (c) => {
    const { rows: [appt] } = await c.query('SELECT * FROM appointments WHERE id = $1 FOR UPDATE', [appointmentId]);
    if (!appt) throw notFound('นัดหมาย');
    if (['cancelled', 'no_show'].includes(appt.status)) throw unprocessable('APPOINTMENT_CLOSED', 'นัดนี้ถูกยกเลิก/ไม่มาตามนัด');
    if (phase === 'post' && !['in_progress', 'completed'].includes(appt.status)) {
      throw unprocessable('NOT_STARTED', 'บันทึก Post-Treatment ได้หลังเริ่มการรักษาแล้ว');
    }

    const { rows: [existing] } = await c.query(
      'SELECT * FROM clinical_assessments WHERE appointment_id = $1 AND phase = $2', [appointmentId, phase]);
    if (existing?.signed_at) throw conflict('EMR_LOCKED', 'เวชระเบียนลงนามแล้ว แก้ไขไม่ได้ (ใช้ Addendum)');
    if (existing && existing.created_by !== user.id) throw forbidden('แก้ไขได้เฉพาะผู้บันทึกเท่านั้น');

    const fields = ASSESSMENT_FIELDS.filter((f) => body[f] !== undefined);
    const vals = fields.map((f) => (JSON_FIELDS.has(f) && body[f] !== null ? JSON.stringify(body[f]) : body[f]));
    let id;
    if (existing) {
      id = existing.id;
      if (fields.length) {
        await c.query(
          `UPDATE clinical_assessments SET ${fields.map((f, i) => `${f} = $${i + 2}`).join(', ')} WHERE id = $1`,
          [id, ...vals]);
      }
    } else {
      const cols = ['appointment_id', 'patient_id', 'therapist_id', 'phase', 'created_by', ...fields];
      const { rows: [r] } = await c.query(
        `INSERT INTO clinical_assessments (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
        [appointmentId, appt.patient_id, user.staffId, phase, user.id, ...vals]);
      id = r.id;
    }

    if (Array.isArray(body.rom)) {
      await c.query('DELETE FROM rom_measurements WHERE assessment_id = $1', [id]);
      for (const r of body.rom) {
        await c.query(
          `INSERT INTO rom_measurements (assessment_id, joint, movement, side, mode, degrees, normal_degrees, pain_on_movement, end_feel)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [id, r.joint, r.movement, r.side || 'na', r.mode || 'active', r.degrees, r.normal_degrees ?? null, !!r.pain_on_movement, r.end_feel || null]);
      }
    }
    if (phase === 'post' && Array.isArray(body.treatments)) {
      await c.query('DELETE FROM treatment_records WHERE assessment_id = $1', [id]);
      for (const t of body.treatments) {
        await c.query(
          `INSERT INTO treatment_records (assessment_id, equipment_id, intervention, body_part, parameters, duration_min)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [id, t.equipment_id || null, t.intervention, t.body_part || null, t.parameters ? JSON.stringify(t.parameters) : null, t.duration_min || null]);
      }
    }
    // บันทึกข้อควรระวังใหม่ที่พบระหว่างประเมิน -> ไปอยู่ใน profile ผู้ป่วยทันที
    if (Array.isArray(body.newPrecautions)) {
      for (const p of body.newPrecautions) {
        await c.query(
          `INSERT INTO patient_precautions (patient_id, precaution_code, detail, recorded_by)
           VALUES ($1,$2,$3,$4) ON CONFLICT (patient_id, precaution_code) WHERE is_active DO UPDATE SET detail = EXCLUDED.detail`,
          [appt.patient_id, p.code, p.detail || null, user.id]);
      }
    }
    return id;
  }, { userId: user.id });
}

async function signAssessment(user, assessmentId) {
  return db.withTx(async (c) => {
    const { rows: [a] } = await c.query('SELECT * FROM clinical_assessments WHERE id = $1 FOR UPDATE', [assessmentId]);
    if (!a) throw notFound('แบบประเมิน');
    if (a.signed_at) throw conflict('ALREADY_SIGNED', 'ลงนามแล้ว');
    if (a.created_by !== user.id) throw forbidden('ผู้บันทึกเท่านั้นที่ลงนามได้');
    const missing = [];
    if (a.pain_score === null) missing.push('pain_score');
    if (a.phase === 'pre' && !a.precautions_reviewed) missing.push('precautions_reviewed');
    if (a.phase === 'post' && !a.treatment_response) missing.push('treatment_response');
    if (missing.length) throw unprocessable('INCOMPLETE_ASSESSMENT', 'ข้อมูลไม่ครบก่อนลงนาม', { missing });
    const { rows: [r] } = await c.query(
      'UPDATE clinical_assessments SET signed_by = $2, signed_at = now() WHERE id = $1 RETURNING *', [assessmentId, user.id]);
    return r;
  }, { userId: user.id });
}

async function addAddendum(user, assessmentId, content) {
  const { rows: [a] } = await db.query('SELECT id, signed_at FROM clinical_assessments WHERE id = $1', [assessmentId]);
  if (!a) throw notFound('แบบประเมิน');
  if (!a.signed_at) throw unprocessable('NOT_SIGNED', 'ยังไม่ลงนาม — แก้ไขแบบร่างได้โดยตรง');
  const { rows: [r] } = await db.query(
    'INSERT INTO assessment_addenda (assessment_id, content, author_id) VALUES ($1,$2,$3) RETURNING *',
    [assessmentId, content, user.id]);
  return r;
}

/** สรุปนัดก่อนหน้า — ใช้แสดงคู่กับฟอร์ม pre-assessment เพื่อเปรียบเทียบ */
async function lastVisitSummary(patientId, beforeAppointmentId = null) {
  const { rows: [last] } = await db.query(
    `SELECT a.id AS appointment_id, a.start_at, s.title || s.first_name AS therapist,
            pre.pain_score AS pre_pain, post.pain_score AS post_pain, post.treatment_response,
            post.plan, post.home_program, post.next_visit_plan, post.functional_scores,
            -- ROM ล่าสุดต่อ joint/movement/side/mode (ค่าหลังรักษาสำคัญกว่าก่อนรักษา)
            COALESCE((SELECT json_agg(x) FROM (
                SELECT DISTINCT ON (r.joint, r.movement, r.side, r.mode)
                       r.joint, r.movement, r.side, r.mode, r.degrees, r.normal_degrees AS normal, ca.phase
                  FROM rom_measurements r JOIN clinical_assessments ca ON ca.id = r.assessment_id
                 WHERE r.assessment_id IN (pre.id, post.id)
                 ORDER BY r.joint, r.movement, r.side, r.mode, (ca.phase = 'post') DESC) x), '[]') AS rom
       FROM appointments a
       JOIN staff s ON s.id = a.therapist_id
       LEFT JOIN clinical_assessments pre  ON pre.appointment_id = a.id AND pre.phase = 'pre'
       LEFT JOIN clinical_assessments post ON post.appointment_id = a.id AND post.phase = 'post'
      WHERE a.patient_id = $1 AND a.status = 'completed'
        AND ($2::uuid IS NULL OR a.id <> $2)
        AND ($2::uuid IS NULL OR a.start_at < (SELECT start_at FROM appointments WHERE id = $2))
      ORDER BY a.start_at DESC LIMIT 1`, [patientId, beforeAppointmentId]);
  return last || null;
}

/** Timeline ความก้าวหน้า: pain ต่อ visit และ ROM series พร้อม delta */
async function patientProgress(patientId) {
  const { rows: [patient] } = await db.query('SELECT id, hn, first_name, last_name FROM patients WHERE id = $1', [patientId]);
  if (!patient) throw notFound('ผู้ป่วย');

  const { rows: visits } = await db.query(
    `SELECT a.id AS appointment_id, a.start_at, a.status, d.icd10_code,
            pre.pain_score AS pre_pain, post.pain_score AS post_pain, post.treatment_response, post.functional_scores
       FROM appointments a
       LEFT JOIN diagnoses d ON d.id = a.diagnosis_id
       LEFT JOIN clinical_assessments pre  ON pre.appointment_id = a.id AND pre.phase = 'pre'
       LEFT JOIN clinical_assessments post ON post.appointment_id = a.id AND post.phase = 'post'
      WHERE a.patient_id = $1 AND (pre.id IS NOT NULL OR post.id IS NOT NULL)
      ORDER BY a.start_at`, [patientId]);

  visits.forEach((v, i) => {
    v.immediate_relief = v.pre_pain != null && v.post_pain != null ? v.pre_pain - v.post_pain : null;
    const prev = visits.slice(0, i).reverse().find((x) => x.pre_pain != null);
    v.pre_pain_change_vs_prev = prev && v.pre_pain != null ? v.pre_pain - prev.pre_pain : null;
  });

  const { rows: rom } = await db.query(
    `SELECT ca.appointment_id, ca.phase, a.start_at, r.joint, r.movement, r.side, r.mode, r.degrees, r.normal_degrees
       FROM rom_measurements r
       JOIN clinical_assessments ca ON ca.id = r.assessment_id
       JOIN appointments a ON a.id = ca.appointment_id
      WHERE ca.patient_id = $1
      ORDER BY a.start_at, CASE ca.phase WHEN 'pre' THEN 0 ELSE 1 END`, [patientId]);

  const series = new Map();
  for (const r of rom) {
    const key = `${r.joint}|${r.movement}|${r.side}|${r.mode}`;
    if (!series.has(key)) {
      series.set(key, { joint: r.joint, movement: r.movement, side: r.side, mode: r.mode, normal: r.normal_degrees, points: [] });
    }
    series.get(key).points.push({ appointment_id: r.appointment_id, phase: r.phase, at: r.start_at, degrees: r.degrees });
  }
  const romSeries = [...series.values()].map((s) => {
    const first = s.points[0].degrees;
    const last = s.points.at(-1).degrees;
    const prev = s.points.length > 1 ? s.points.at(-2).degrees : null;
    return {
      ...s,
      baseline: first,
      latest: last,
      changeFromBaseline: last - first,
      changeFromPrevious: prev === null ? null : last - prev,
      pctOfNormal: s.normal ? Math.round((last / s.normal) * 100) : null,
    };
  });

  const withPain = visits.filter((v) => v.pre_pain != null);
  return {
    patient,
    summary: {
      visits: visits.length,
      baselinePain: withPain[0]?.pre_pain ?? null,
      latestPain: visits.filter((v) => v.post_pain != null).at(-1)?.post_pain ?? withPain.at(-1)?.pre_pain ?? null,
      avgImmediateRelief: avg(visits.map((v) => v.immediate_relief).filter((x) => x != null)),
    },
    visits,
    romSeries,
  };
}

const avg = (a) => (a.length ? Math.round((a.reduce((s, x) => s + x, 0) / a.length) * 10) / 10 : null);

module.exports = { getAppointmentAssessments, upsertAssessment, signAssessment, addAddendum, patientProgress, lastVisitSummary };
