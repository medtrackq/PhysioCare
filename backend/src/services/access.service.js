/**
 * สิทธิ์ดูข้อมูลการรักษาตามผู้ป่วยที่ดูแล
 *
 *   ผู้มี emr:read_all (หัวหน้านักกายภาพ, super user) → ทุกคน (super user ถูกบันทึก audit ทุกครั้ง)
 *   นักกายภาพ (emr:read) → ผู้ป่วยในทีมผู้ดูแล, ผู้ป่วยที่มีนัดกับตน (ย้อนหลังตาม access.appointment_window_days หรือนัดที่จะถึง),
 *                         หรือที่เปิดดูฉุกเฉินไว้ (ระบุเหตุผล มีอายุ access.break_glass_hours ชั่วโมง)
 *   ไม่มีความสัมพันธ์ → 403 NO_CARE_RELATION (หน้าจอเสนอ "เปิดดูฉุกเฉิน")
 */
const db = require('../db');
const { can } = require('../middleware/auth');
const { AppError, notFound, badRequest } = require('../errors');
const { audit } = require('./audit.service');

async function settings() {
  const { rows } = await db.query("SELECT key, value FROM system_settings WHERE key LIKE 'access.%'");
  const s = Object.fromEntries(rows.map((r) => [r.key, Number(r.value)]));
  return {
    windowDays: Number.isFinite(s['access.appointment_window_days']) ? s['access.appointment_window_days'] : 180,
    breakGlassHours: Number.isFinite(s['access.break_glass_hours']) ? s['access.break_glass_hours'] : 8,
  };
}

const seesAll = (user) => can(user, 'emr:read_all');

/**
 * เงื่อนไข SQL: ผู้ป่วย (คอลัมน์ col) ที่ผู้ใช้เข้าถึงข้อมูลการรักษาได้ — ใช้กรองรายการ
 * คืน { sql, params } ต่อท้าย params เดิม (index เริ่มที่ start)
 */
async function patientFilter(user, col, start) {
  if (seesAll(user)) return { sql: 'true', params: [] };
  if (!user.staffId) return { sql: 'false', params: [] };
  const { windowDays } = await settings();
  const s = `$${start}`; const u = `$${start + 1}`; const w = `$${start + 2}`;
  return {
    sql: `(${col} IN (SELECT patient_id FROM patient_care_team WHERE staff_id = ${s} AND ended_at IS NULL)
        OR ${col} IN (SELECT patient_id FROM appointments WHERE therapist_id = ${s} AND status <> 'cancelled'
                        AND start_at >= now() - make_interval(days => ${w}))
        OR ${col} IN (SELECT patient_id FROM clinical_access_grants WHERE user_id = ${u} AND expires_at > now()))`,
    params: [user.staffId, user.id, windowDays],
  };
}

/** ความสัมพันธ์กับผู้ป่วย: 'all' | 'care_team' | 'appointment' | 'break_glass' | null */
async function relation(user, patientId) {
  if (seesAll(user)) return 'all';
  if (!can(user, 'emr:read')) return null;
  if (user.staffId) {
    const { windowDays } = await settings();
    const { rows: [r] } = await db.query(
      `SELECT EXISTS (SELECT 1 FROM patient_care_team WHERE patient_id = $1 AND staff_id = $2 AND ended_at IS NULL) AS team,
              EXISTS (SELECT 1 FROM appointments WHERE patient_id = $1 AND therapist_id = $2 AND status <> 'cancelled'
                        AND start_at >= now() - make_interval(days => $3)) AS appt`,
      [patientId, user.staffId, windowDays]);
    if (r.team) return 'care_team';
    if (r.appt) return 'appointment';
  }
  const { rows: [g] } = await db.query(
    'SELECT id FROM clinical_access_grants WHERE user_id = $1 AND patient_id = $2 AND expires_at > now() LIMIT 1', [user.id, patientId]);
  return g ? 'break_glass' : null;
}

/** ตรวจสิทธิ์ก่อนอ่าน/เขียนข้อมูลการรักษาของผู้ป่วย (throw 403 ถ้าไม่มีความสัมพันธ์) */
async function assertPatient(req, patientId, { action = 'view' } = {}) {
  if (!patientId) throw notFound('ผู้ป่วย');
  const via = await relation(req.user, patientId);
  if (!via) {
    const { rows: [p] } = await db.query("SELECT first_name || ' ' || last_name AS name, hn FROM patients WHERE id = $1", [patientId]);
    if (!p) throw notFound('ผู้ป่วย');
    throw new AppError(403, 'NO_CARE_RELATION', `คุณไม่ได้เป็นผู้ดูแลผู้ป่วยรายนี้ (${p.hn})`, {
      patientId, patientName: p.name, hn: p.hn, canBreakGlass: can(req.user, 'emr:read'),
    });
  }
  // บันทึกการเข้าถึงที่ไม่ใช่ทีมผู้ดูแลโดยตรง: super user ทุกครั้ง, เปิดดูฉุกเฉินทุกครั้ง
  if (req.user.role === 'superuser' || via === 'break_glass') {
    await audit(req, `clinical.${action}`, 'patient', patientId, { via, path: req.originalUrl?.slice(0, 200) });
  }
  return via;
}

// หาผู้ป่วยจาก id ของสิ่งต่าง ๆ (ใช้ก่อน assertPatient)
const lookups = {
  appointment: 'SELECT patient_id FROM appointments WHERE id = $1',
  assessment: 'SELECT patient_id FROM clinical_assessments WHERE id = $1',
  program: 'SELECT patient_id FROM home_programs WHERE id = $1',
  link: 'SELECT hp.patient_id FROM home_access_links l JOIN home_programs hp ON hp.id = l.program_id WHERE l.id = $1',
  alert: 'SELECT hp.patient_id FROM home_alerts a JOIN home_programs hp ON hp.id = a.program_id WHERE a.id = $1',
  tele: 'SELECT patient_id FROM tele_sessions WHERE id = $1',
};
async function patientOf(kind, id) {
  const { rows: [r] } = await db.query(lookups[kind], [id]);
  return r?.patient_id || null;
}
async function assertVia(req, kind, id, opts) {
  const pid = await patientOf(kind, id);
  if (!pid) throw notFound();
  return assertPatient(req, pid, opts);
}

/** middleware: ตรวจจาก req.params[param] */
const guard = (kind, param = 'id', opts = {}) => async (req, _res, next) => {
  const id = req.valid?.params?.[param] ?? req.params[param];
  if (kind === 'patient') await assertPatient(req, id, opts);
  else await assertVia(req, kind, id, opts);
  next();
};

// ------------------------------------------------------------------ เปิดดูฉุกเฉิน
async function breakGlass(req, patientId, reason) {
  if (!can(req.user, 'emr:read')) throw new AppError(403, 'FORBIDDEN', 'ไม่มีสิทธิ์');
  const { rows: [p] } = await db.query('SELECT id FROM patients WHERE id = $1', [patientId]);
  if (!p) throw notFound('ผู้ป่วย');
  const r = String(reason || '').trim();
  if (r.length < 10) throw badRequest('ระบุเหตุผลอย่างน้อย 10 ตัวอักษร');
  const { breakGlassHours } = await settings();
  const { rows: [g] } = await db.query(
    `INSERT INTO clinical_access_grants (user_id, patient_id, reason, expires_at)
     VALUES ($1,$2,$3, now() + make_interval(hours => $4)) RETURNING id, expires_at`,
    [req.user.id, patientId, r, breakGlassHours]);
  await audit(req, 'clinical.break_glass', 'patient', patientId, { reason: r, grantId: g.id });
  return g;
}

async function breakGlassList({ days = 30 } = {}) {
  const { rows } = await db.query(
    `SELECT g.id, g.reason, g.created_at, g.expires_at, g.reviewed_at, u.display_name AS user_name, r.name_th AS user_role,
            p.id AS patient_id, p.hn, p.first_name || ' ' || p.last_name AS patient_name, rv.display_name AS reviewed_by_name
       FROM clinical_access_grants g
       JOIN users u ON u.id = g.user_id JOIN roles r ON r.id = u.role_id
       JOIN patients p ON p.id = g.patient_id
       LEFT JOIN users rv ON rv.id = g.reviewed_by
      WHERE g.created_at >= now() - make_interval(days => $1)
      ORDER BY g.created_at DESC LIMIT 200`, [days]);
  return rows;
}

async function reviewBreakGlass(req, id) {
  const { rowCount } = await db.query('UPDATE clinical_access_grants SET reviewed_by = $2, reviewed_at = now() WHERE id = $1 AND reviewed_at IS NULL', [id, req.user.id]);
  if (!rowCount) throw notFound('รายการเปิดดูฉุกเฉิน');
  await audit(req, 'clinical.break_glass_review', 'access_grant', id);
}

// ------------------------------------------------------------------ ทีมผู้ดูแล
async function careTeam(patientId) {
  const { rows } = await db.query(
    `SELECT ct.staff_id, ct.is_primary, ct.assigned_at, s.title || s.first_name || ' ' || s.last_name AS name, s.employee_code,
            u.display_name AS assigned_by_name
       FROM patient_care_team ct JOIN staff s ON s.id = ct.staff_id LEFT JOIN users u ON u.id = ct.assigned_by
      WHERE ct.patient_id = $1 AND ct.ended_at IS NULL ORDER BY ct.is_primary DESC, ct.assigned_at`, [patientId]);
  return rows;
}

/** ตั้งทีมผู้ดูแล: ผู้ดูแลหลัก 1 คน + ผู้ร่วมดูแล (คนที่เอาออกจะสิ้นสุด ประวัติยังอยู่) */
async function setCareTeam(req, patientId, { primaryStaffId, staffIds = [] }) {
  const want = [...new Set([primaryStaffId, ...staffIds].filter(Boolean))];
  return db.withTx(async (c) => {
    const { rows: [p] } = await c.query('SELECT id FROM patients WHERE id = $1 FOR UPDATE', [patientId]);
    if (!p) throw notFound('ผู้ป่วย');
    if (want.length) {
      const { rows } = await c.query(
        `SELECT s.id FROM staff s WHERE s.id = ANY($1) AND s.is_active AND s.position = 'physiotherapist'`, [want]);
      if (rows.length !== want.length) throw badRequest('เลือกได้เฉพาะนักกายภาพที่ยังทำงานอยู่');
    }
    await c.query(
      `UPDATE patient_care_team SET ended_at = now(), ended_by = $3
        WHERE patient_id = $1 AND ended_at IS NULL AND NOT (staff_id = ANY($2))`, [patientId, want, req.user.id]);
    await c.query('UPDATE patient_care_team SET is_primary = false WHERE patient_id = $1 AND ended_at IS NULL', [patientId]);
    for (const sid of want) {
      await c.query(
        `INSERT INTO patient_care_team (patient_id, staff_id, is_primary, assigned_by) VALUES ($1,$2,$3,$4)
         ON CONFLICT (patient_id, staff_id) WHERE ended_at IS NULL DO UPDATE SET is_primary = EXCLUDED.is_primary`,
        [patientId, sid, sid === primaryStaffId, req.user.id]);
    }
    await audit(req, 'care_team.set', 'patient', patientId, { primaryStaffId: primaryStaffId || null, staffIds: want }, c);
    return null;
  }).then(() => careTeam(patientId));
}

/** นักกายภาพสร้างผู้ป่วยเอง → เป็นผู้ดูแลหลัก (ถ้ายังไม่มี) */
async function autoAssign(user, patientId) {
  if (!user.staffId || seesAll(user)) return;
  await db.query(
    `INSERT INTO patient_care_team (patient_id, staff_id, is_primary, assigned_by)
     SELECT $1, $2, NOT EXISTS (SELECT 1 FROM patient_care_team WHERE patient_id = $1 AND ended_at IS NULL AND is_primary), $3
      WHERE EXISTS (SELECT 1 FROM staff WHERE id = $2 AND position = 'physiotherapist')
     ON CONFLICT DO NOTHING`, [patientId, user.staffId, user.id]);
}

module.exports = {
  settings, seesAll, patientFilter, relation, assertPatient, assertVia, patientOf, guard,
  breakGlass, breakGlassList, reviewBreakGlass, careTeam, setCareTeam, autoAssign,
};
