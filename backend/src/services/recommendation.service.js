/**
 * Diagnosis-to-Staff/Equipment Recommendation Engine
 *
 * Staff score (0..1)
 *   = 0.55 × specialtyMatch   (Σ weight(dx→specialty) × level/5, เลือกค่าสูงสุดต่อ dx; dx หลักมีน้ำหนัก ×2)
 *   + 0.15 × continuity       (เคยรักษาผู้ป่วยรายนี้ -> ต่อเนื่องของการดูแล)
 *   + 0.15 × (1 − load/cap)   (กระจายภาระงาน)
 *   + 0.15 × available        (ว่างในช่วงเวลาที่ขอ)
 *
 * Equipment: หมวดอุปกรณ์จาก diagnosis_equipment_map (weight สูงสุดต่อหมวด)
 *   - ตัดหมวดที่ "ห้ามใช้เด็ดขาด" ตาม precaution ของผู้ป่วยออก (absolute)
 *   - แจ้งเตือนหมวดที่ "ใช้ด้วยความระมัดระวัง" (relative)
 *   - เลือกเครื่องที่ว่าง ณ เวลานั้นและมีชั่วโมงใช้งาน 30 วันน้อยที่สุด (wear leveling)
 */
const db = require('../db');
const { notFound } = require('../errors');
const avail = require('./availability');
const { activeTherapistIds } = require('./scheduling.service');
const { localToDate, toLocalParts } = require('../time');
const { getSettings } = require('./settings.service');

const W = { specialty: 0.55, continuity: 0.15, load: 0.15, available: 0.15 };
const round = (n) => Math.round(n * 1000) / 1000;

async function recommend({ patientId, diagnosisIds, startAt, durationMin = 45 }) {
  const patient = (await db.query('SELECT id, hn, first_name, last_name FROM patients WHERE id = $1', [patientId])).rows[0];
  if (!patient) throw notFound('ผู้ป่วย');

  // ---- diagnoses & precautions ----
  const dxRows = diagnosisIds?.length
    ? (await db.query(
      `SELECT id, icd10_code, name_th, (row_number() OVER () = 1) AS is_primary FROM diagnoses WHERE id = ANY($1)`,
      [diagnosisIds])).rows
    : (await db.query(
      `SELECT d.id, d.icd10_code, d.name_th, pd.is_primary FROM patient_diagnoses pd
         JOIN diagnoses d ON d.id = pd.diagnosis_id
        WHERE pd.patient_id = $1 AND pd.status = 'active' ORDER BY pd.is_primary DESC`, [patientId])).rows;
  const dxIds = dxRows.map((d) => d.id);
  const precautions = (await db.query(
    `SELECT pt.code, pt.name_th, pt.severity, pp.detail FROM patient_precautions pp
       JOIN precaution_types pt ON pt.code = pp.precaution_code
      WHERE pp.patient_id = $1 AND pp.is_active`, [patientId])).rows;

  const settings = await getSettings();
  const start = startAt ? new Date(startAt) : null;
  const end = start ? new Date(start.getTime() + durationMin * 60000) : null;

  const therapists = await rankTherapists({ patientId, dxRows, start, end, settings });
  const equipment = await rankEquipment({ dxIds, precautionCodes: precautions.map((p) => p.code), start, end });

  return { patient, diagnoses: dxRows, precautions, window: start ? { startAt: start, endAt: end } : null, therapists, equipment };
}

async function rankTherapists({ patientId, dxRows, start, end, settings }) {
  const staffIds = await activeTherapistIds();
  const dxIds = dxRows.map((d) => d.id);
  const primaryIds = new Set(dxRows.filter((d) => d.is_primary).map((d) => d.id));

  const [staffRows, skillRows, historyRows] = await Promise.all([
    db.query(
      `SELECT id, title, first_name, last_name, color, max_patients_per_day FROM staff WHERE id = ANY($1)`, [staffIds]),
    db.query(
      `SELECT ss.staff_id, ss.level, sp.code, sp.name_en, dsm.diagnosis_id, dsm.weight
         FROM staff_specialties ss
         JOIN specialties sp ON sp.id = ss.specialty_id
         LEFT JOIN diagnosis_specialty_map dsm ON dsm.specialty_id = ss.specialty_id AND dsm.diagnosis_id = ANY($2)
        WHERE ss.staff_id = ANY($1)`, [staffIds, dxIds]),
    db.query(
      `SELECT therapist_id, count(*)::int AS visits FROM appointments
        WHERE patient_id = $1 AND status = 'completed' GROUP BY therapist_id`, [patientId]),
  ]);

  // ภาระงานของวัน + ความว่าง ณ เวลาที่ขอ
  let ctx = null;
  if (start) {
    const day = toLocalParts(start, settings.utcOffset).date;
    ctx = await avail.loadContext(db, {
      from: localToDate(day, '00:00', settings.utcOffset),
      to: localToDate(day, '23:59', settings.utcOffset),
      staffIds,
    });
  }
  const visits = new Map(historyRows.rows.map((r) => [r.therapist_id, r.visits]));
  const maxVisits = Math.max(1, ...visits.values());

  return staffRows.rows.map((s) => {
    const skills = skillRows.rows.filter((r) => r.staff_id === s.id);
    const reasons = [];

    // specialty match
    let num = 0;
    let den = 0;
    for (const dx of dxRows) {
      const w = primaryIds.has(dx.id) ? 2 : 1;
      const best = skills.filter((k) => k.diagnosis_id === dx.id)
        .reduce((m, k) => Math.max(m, k.weight * (k.level / 5)), 0);
      num += w * best;
      den += w;
      const top = skills.filter((k) => k.diagnosis_id === dx.id).sort((a, b) => b.weight * b.level - a.weight * a.level)[0];
      if (top) reasons.push(`${top.name_en} ระดับ ${top.level}/5 ตรงกับ ${dx.icd10_code}`);
    }
    const specialty = den ? num / den : 0;

    const v = visits.get(s.id) || 0;
    const continuity = v / maxVisits;
    if (v) reasons.push(`เคยดูแลผู้ป่วยรายนี้ ${v} ครั้ง`);

    let available = null;
    let load = 0;
    let blockReason = null;
    if (ctx) {
      load = avail.staffLoad(ctx, s.id);
      blockReason = avail.staffBlockReason(ctx, s.id, start.getTime(), end.getTime());
      available = !blockReason;
      reasons.push(available ? 'ว่างในช่วงเวลาที่เลือก' : ({ NOT_ON_SHIFT: 'ไม่อยู่ในกะ', ON_LEAVE: 'ลางาน', BUSY: 'มีนัดอื่น' })[blockReason]);
    }
    const loadScore = 1 - Math.min(1, load / s.max_patients_per_day);
    const score = W.specialty * specialty + W.continuity * continuity + W.load * loadScore + W.available * (available === false ? 0 : 1);

    return {
      id: s.id,
      name: `${s.title || ''}${s.first_name} ${s.last_name}`,
      color: s.color,
      specialties: skills.filter((k, i, arr) => arr.findIndex((x) => x.code === k.code) === i).map((k) => ({ code: k.code, level: k.level })),
      score: round(score),
      breakdown: { specialty: round(specialty), continuity: round(continuity), load: round(loadScore) },
      todayLoad: load,
      available,
      blockReason,
      reasons,
    };
  }).sort((a, b) => (b.available !== false) - (a.available !== false) || b.score - a.score);
}

async function rankEquipment({ dxIds, precautionCodes, start, end }) {
  if (!dxIds.length) return [];
  const { rows: cats } = await db.query(
    `SELECT c.id, c.code, c.name_th, c.name_en, c.modality, c.default_session_minutes,
            max(dem.weight) AS weight, string_agg(DISTINCT dem.rationale, '; ') AS rationale
       FROM diagnosis_equipment_map dem JOIN equipment_categories c ON c.id = dem.equipment_category_id
      WHERE dem.diagnosis_id = ANY($1)
      GROUP BY c.id ORDER BY max(dem.weight) DESC`, [dxIds]);
  if (!cats.length) return [];

  const catIds = cats.map((c) => c.id);
  const [contra, units, usage] = await Promise.all([
    db.query(
      `SELECT pc.equipment_category_id, pc.level, pc.note, pt.code, pt.name_th
         FROM precaution_contraindications pc JOIN precaution_types pt ON pt.code = pc.precaution_code
        WHERE pc.precaution_code = ANY($1) AND pc.equipment_category_id = ANY($2)`, [precautionCodes, catIds]),
    db.query(
      `SELECT id, name, asset_code, status, location, category_id FROM equipment
        WHERE category_id = ANY($1) AND status <> 'retired'`, [catIds]),
    db.query(
      `SELECT ae.equipment_id, sum(extract(epoch FROM upper(ae.period) - lower(ae.period)) / 3600)::numeric(8,1) AS hours
         FROM appointment_equipment ae
        WHERE ae.is_active AND lower(ae.period) > now() - interval '30 days'
        GROUP BY ae.equipment_id`),
  ]);
  const hours = new Map(usage.rows.map((r) => [r.equipment_id, r.hours]));

  let ctx = null;
  if (start) ctx = await avail.loadContext(db, { from: start, to: end, equipmentIds: units.rows.map((u) => u.id) });

  return cats.map((c) => {
    const cc = contra.rows.filter((x) => x.equipment_category_id === c.id);
    const absolute = cc.filter((x) => x.level === 'absolute');
    const relative = cc.filter((x) => x.level === 'relative');
    const list = units.rows.filter((u) => u.category_id === c.id).map((u) => ({
      ...u,
      usageHours30d: hours.get(u.id) || 0,
      freeAtRequestedTime: ctx ? avail.isEquipmentFree(ctx, u.id, start.getTime(), end.getTime()) : avail.BOOKABLE_EQUIPMENT_STATUS.has(u.status),
    })).sort((a, b) => b.freeAtRequestedTime - a.freeAtRequestedTime || a.usageHours30d - b.usageHours30d);

    const recommended = absolute.length ? null : list.find((u) => u.freeAtRequestedTime) || null;
    return {
      category: { id: c.id, code: c.code, name_th: c.name_th, name_en: c.name_en, modality: c.modality },
      weight: c.weight,
      rationale: c.rationale,
      suggestedMinutes: c.default_session_minutes,
      contraindication: absolute.length
        ? { level: 'absolute', precautions: absolute.map((x) => x.name_th) }
        : relative.length ? { level: 'relative', precautions: relative.map((x) => `${x.name_th}${x.note ? ` (${x.note})` : ''}`) } : null,
      recommendedUnit: recommended,
      units: list,
    };
  });
}

module.exports = { recommend };
