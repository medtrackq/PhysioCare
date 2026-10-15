/**
 * Smart Scheduling — Conflict Resolution
 *
 * ป้องกันการจองซ้อน 3 ชั้น:
 *  1) checkConflicts(): ตรวจละเอียดพร้อมข้อความภาษาไทย (กะงาน, วันลา, นัดซ้อน, สถานะอุปกรณ์,
 *     ช่วงปิดซ่อมบำรุง, ข้อห้ามใช้ตาม precaution ของผู้ป่วย)
 *  2) SELECT ... FOR UPDATE บนแถว staff / patient / equipment ตามลำดับคงที่
 *     -> คำขอจองพร้อมกันบน resource เดียวกันถูกจัดคิว ไม่เกิด race / deadlock
 *  3) EXCLUDE constraint ในฐานข้อมูล (ด่านสุดท้าย) -> error 23P01 ถูกแปลงเป็น 409
 * เมื่อชน ระบบเสนอทางเลือกอัตโนมัติ (ช่วงเวลาอื่น, นักกายภาพอื่น, เครื่องอื่นในหมวดเดียวกัน)
 */
const db = require('../db');
const { conflict, unprocessable, notFound, badRequest, AppError } = require('../errors');
const { getSettings } = require('./settings.service');
const { toLocalParts, localToDate, addMinutes } = require('../time');
const avail = require('./availability');

const ACTIVE = `status NOT IN ('cancelled','no_show')`;

const TRANSITIONS = {
  booked: ['confirmed', 'checked_in', 'cancelled', 'no_show'],
  confirmed: ['checked_in', 'cancelled', 'no_show'],
  checked_in: ['in_progress', 'cancelled'],
  in_progress: ['completed'],
  completed: [],
  cancelled: [],
  no_show: [],
};

const fmt = (d) => {
  const p = toLocalParts(new Date(d));
  return `${p.date} ${p.hhmm}`;
};

// ---------------------------------------------------------------------
// 1) Detailed conflict check
// ---------------------------------------------------------------------
async function checkConflicts(client, input) {
  const { therapistId, patientId, equipmentIds = [], excludeAppointmentId = null } = input;
  const startAt = new Date(input.startAt);
  const endAt = new Date(input.endAt);
  const settings = await getSettings(client);
  const conflicts = [];
  const warnings = [];
  const range = [startAt, endAt];

  if (!(endAt > startAt)) {
    return { ok: false, conflicts: [{ type: 'INVALID_RANGE', message: 'เวลาสิ้นสุดต้องอยู่หลังเวลาเริ่ม' }], warnings };
  }
  if (startAt < addMinutes(new Date(), -5) && !input.allowPast) {
    conflicts.push({ type: 'IN_THE_PAST', message: 'ไม่สามารถจองย้อนหลังได้' });
  }

  // ---- เวลาทำการ ----
  const ls = toLocalParts(startAt, settings.utcOffset);
  const le = toLocalParts(endAt, settings.utcOffset);
  const { open, close, days } = settings.hours;
  if (ls.date !== le.date || ls.hhmm < open || le.hhmm > close || !days.includes(ls.isoDow)) {
    conflicts.push({ type: 'OUTSIDE_CLINIC_HOURS', message: `นอกเวลาทำการ (${open}–${close})` });
  }

  // ---- นักกายภาพ ----
  const staff = (await client.query(
    `SELECT id, title, first_name, last_name, position, is_active, max_patients_per_day FROM staff WHERE id = $1`,
    [therapistId])).rows[0];
  if (!staff) throw notFound('นักกายภาพบำบัด');
  const staffRes = { kind: 'staff', id: staff.id, name: `${staff.title || ''}${staff.first_name} ${staff.last_name}` };
  if (!staff.is_active || staff.position !== 'physiotherapist') {
    conflicts.push({ type: 'THERAPIST_INACTIVE', resource: staffRes, message: 'บุคลากรนี้ไม่สามารถรับนัดรักษาได้' });
  }

  const [shift, leave, staffBusy, patientBusy, dayLoad] = await Promise.all([
    client.query(`SELECT 1 FROM staff_shifts WHERE staff_id = $1 AND period @> tstzrange($2, $3, '[)')`, [therapistId, ...range]),
    client.query(`SELECT leave_type, start_at, end_at FROM staff_leaves WHERE staff_id = $1 AND period && tstzrange($2, $3, '[)')`, [therapistId, ...range]),
    client.query(
      `SELECT a.id, a.start_at, a.end_at FROM appointments a
        WHERE a.therapist_id = $1 AND a.${ACTIVE} AND a.period && tstzrange($2, $3, '[)')
          AND ($4::uuid IS NULL OR a.id <> $4)`, [therapistId, ...range, excludeAppointmentId]),
    client.query(
      `SELECT a.id, a.start_at, a.end_at FROM appointments a
        WHERE a.patient_id = $1 AND a.${ACTIVE} AND a.period && tstzrange($2, $3, '[)')
          AND ($4::uuid IS NULL OR a.id <> $4)`, [patientId, ...range, excludeAppointmentId]),
    client.query(
      `SELECT count(*)::int AS n FROM appointments
        WHERE therapist_id = $1 AND ${ACTIVE} AND ($3::uuid IS NULL OR id <> $3)
          AND (start_at AT TIME ZONE 'Asia/Bangkok')::date = ($2::timestamptz AT TIME ZONE 'Asia/Bangkok')::date`,
      [therapistId, startAt, excludeAppointmentId]),
  ]);

  if (!shift.rowCount) {
    conflicts.push({ type: 'STAFF_NOT_ON_SHIFT', resource: staffRes, message: `${staffRes.name} ไม่ได้อยู่ในกะทำงานช่วงเวลานี้` });
  }
  for (const l of leave.rows) {
    conflicts.push({ type: 'STAFF_ON_LEAVE', resource: staffRes, message: `${staffRes.name} ลา (${l.leave_type}) ${fmt(l.start_at)}–${fmt(l.end_at)}` });
  }
  for (const a of staffBusy.rows) {
    conflicts.push({
      type: 'STAFF_DOUBLE_BOOKED', resource: staffRes,
      message: `${staffRes.name} มีนัดอื่นช่วง ${fmt(a.start_at)}–${fmt(a.end_at).slice(11)}`,
      conflictingWith: { appointmentId: a.id, startAt: a.start_at, endAt: a.end_at },
    });
  }
  for (const a of patientBusy.rows) {
    conflicts.push({
      type: 'PATIENT_DOUBLE_BOOKED', resource: { kind: 'patient', id: patientId },
      message: `ผู้ป่วยมีนัดอื่นช่วง ${fmt(a.start_at)}–${fmt(a.end_at).slice(11)}`,
      conflictingWith: { appointmentId: a.id, startAt: a.start_at, endAt: a.end_at },
    });
  }
  if (dayLoad.rows[0].n >= staff.max_patients_per_day) {
    warnings.push({ type: 'STAFF_DAILY_CAP', resource: staffRes, message: `${staffRes.name} มีนัดครบโควตา ${staff.max_patients_per_day} รายในวันนี้แล้ว` });
  }

  // ---- อุปกรณ์ ----
  if (equipmentIds.length) {
    const eq = (await client.query(
      `SELECT e.id, e.name, e.asset_code, e.status, c.id AS category_id, c.name_th AS category,
              c.cleaning_buffer_minutes AS buffer
         FROM equipment e JOIN equipment_categories c ON c.id = e.category_id WHERE e.id = ANY($1)`,
      [equipmentIds])).rows;
    const byId = new Map(eq.map((r) => [r.id, r]));
    const res = (r) => ({ kind: 'equipment', id: r.id, name: `${r.name} (${r.asset_code})`, categoryId: r.category_id });

    for (const id of equipmentIds) {
      if (!byId.has(id)) conflicts.push({ type: 'EQUIPMENT_NOT_FOUND', resource: { kind: 'equipment', id }, message: 'ไม่พบอุปกรณ์' });
    }
    const STATUS_TH = { maintenance: 'ส่งซ่อม/บำรุงรักษา', broken: 'ชำรุด', retired: 'จำหน่ายแล้ว' };
    for (const r of eq) {
      if (!avail.BOOKABLE_EQUIPMENT_STATUS.has(r.status)) {
        conflicts.push({ type: 'EQUIPMENT_UNAVAILABLE', resource: res(r), message: `${r.name} สถานะ "${STATUS_TH[r.status]}"` });
      }
    }

    const [booked, maint, contra] = await Promise.all([
      client.query(
        `SELECT ae.equipment_id, ae.appointment_id, ae.start_at, ae.end_at
           FROM appointment_equipment ae
           JOIN equipment e ON e.id = ae.equipment_id
           JOIN equipment_categories c ON c.id = e.category_id
          WHERE ae.is_active AND ae.equipment_id = ANY($1)
            AND ($4::uuid IS NULL OR ae.appointment_id <> $4)
            AND ae.period && tstzrange($2::timestamptz, $3::timestamptz + make_interval(mins => c.cleaning_buffer_minutes), '[)')`,
        [equipmentIds, ...range, excludeAppointmentId]),
      client.query(
        `SELECT equipment_id, type, planned_start, planned_end FROM equipment_maintenance
          WHERE equipment_id = ANY($1) AND status IN ('scheduled','in_progress')
            AND planned_period && tstzrange($2, $3, '[)')`, [equipmentIds, ...range]),
      client.query(
        `SELECT e.id AS equipment_id, pc.level, pc.note, pt.code, pt.name_th
           FROM patient_precautions pp
           JOIN precaution_contraindications pc ON pc.precaution_code = pp.precaution_code
           JOIN precaution_types pt ON pt.code = pp.precaution_code
           JOIN equipment e ON e.category_id = pc.equipment_category_id
          WHERE pp.patient_id = $1 AND pp.is_active AND e.id = ANY($2)`, [patientId, equipmentIds]),
    ]);

    for (const b of booked.rows) {
      const r = byId.get(b.equipment_id);
      conflicts.push({
        type: 'EQUIPMENT_DOUBLE_BOOKED', resource: res(r),
        message: `${r.name} ถูกจองช่วง ${fmt(b.start_at)}–${fmt(b.end_at).slice(11)} (รวมเวลาทำความสะอาด ${r.buffer} นาที)`,
        conflictingWith: { appointmentId: b.appointment_id, startAt: b.start_at, endAt: b.end_at },
      });
    }
    for (const m of maint.rows) {
      const r = byId.get(m.equipment_id);
      conflicts.push({ type: 'EQUIPMENT_MAINTENANCE_WINDOW', resource: res(r), message: `${r.name} มีกำหนดบำรุงรักษา ${fmt(m.planned_start)}–${fmt(m.planned_end)}` });
    }
    for (const c of contra.rows) {
      const r = byId.get(c.equipment_id);
      const item = {
        type: c.level === 'absolute' ? 'CONTRAINDICATED' : 'RELATIVE_CONTRAINDICATION',
        resource: res(r), precaution: c.code,
        message: `${r.category}: ${c.level === 'absolute' ? 'ห้ามใช้' : 'ใช้ด้วยความระมัดระวัง'} — ผู้ป่วย${c.name_th}${c.note ? ` (${c.note})` : ''}`,
      };
      (c.level === 'absolute' ? conflicts : warnings).push(item);
    }
  }

  return { ok: conflicts.length === 0, conflicts, warnings };
}

// ---------------------------------------------------------------------
// 2) Transactional booking
// ---------------------------------------------------------------------
async function lockResources(client, { therapistId, patientId, equipmentIds = [] }) {
  // ลำดับคงที่: staff -> patient -> equipment (เรียงตาม id) ป้องกัน deadlock
  await client.query('SELECT id FROM staff WHERE id = $1 FOR UPDATE', [therapistId]);
  const p = await client.query('SELECT id FROM patients WHERE id = $1 FOR UPDATE', [patientId]);
  if (!p.rowCount) throw notFound('ผู้ป่วย');
  if (equipmentIds.length) {
    await client.query('SELECT id FROM equipment WHERE id = ANY($1) ORDER BY id FOR UPDATE', [equipmentIds]);
  }
}

async function insertEquipmentReservations(client, appointmentId, equipmentIds, startAt, endAt) {
  if (!equipmentIds.length) return;
  await client.query(
    `INSERT INTO appointment_equipment (appointment_id, equipment_id, start_at, end_at)
     SELECT $1, e.id, $3::timestamptz, $4::timestamptz + make_interval(mins => c.cleaning_buffer_minutes)
       FROM equipment e JOIN equipment_categories c ON c.id = e.category_id
      WHERE e.id = ANY($2)`,
    [appointmentId, equipmentIds, startAt, endAt]);
}

async function withAlternatives(input, fn) {
  try {
    return await fn();
  } catch (err) {
    const isConflict = (err instanceof AppError && err.code === 'SCHEDULE_CONFLICT') || err.code === '23P01';
    if (!isConflict) throw err;
    const check = err.details || { ok: false, conflicts: [{ type: 'RACE_CONDITION', message: 'มีผู้อื่นจองช่วงเวลานี้ไปก่อนหน้าเล็กน้อย' }], warnings: [] };
    const alternatives = await suggestAlternatives(input, check.conflicts).catch(() => null);
    throw conflict('SCHEDULE_CONFLICT', 'ไม่สามารถจองได้ เนื่องจากตารางเวลาขัดแย้ง', { ...check, alternatives });
  }
}

async function createAppointment(user, input) {
  const equipmentIds = [...new Set(input.equipmentIds || [])];
  const data = { ...input, equipmentIds };
  return withAlternatives(data, () => db.withTx(async (client) => {
    await lockResources(client, data);
    const check = await checkConflicts(client, data);
    if (!check.ok) throw conflict('SCHEDULE_CONFLICT', 'conflict', check);
    if (check.warnings.length && !data.acknowledgeWarnings) {
      throw unprocessable('WARNINGS_REQUIRE_ACK', 'มีข้อควรระวังที่ต้องยืนยันก่อนจอง (acknowledgeWarnings: true)', check);
    }
    const { rows: [appt] } = await client.query(
      `INSERT INTO appointments (patient_id, therapist_id, diagnosis_id, start_at, end_at, visit_type, notes, booked_via, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [data.patientId, data.therapistId, data.diagnosisId || null, data.startAt, data.endAt,
        data.visitType || 'follow_up', data.notes || null, data.bookedVia || 'manual', user.id]);
    await insertEquipmentReservations(client, appt.id, equipmentIds, data.startAt, data.endAt);
    return { appointment: appt, warnings: check.warnings };
  }, { userId: user.id }));
}

async function rescheduleAppointment(user, id, input) {
  return db.withTx(async (client) => {
    const cur = (await client.query('SELECT * FROM appointments WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!cur) throw notFound('นัดหมาย');
    if (input.version !== cur.version) {
      throw conflict('VERSION_MISMATCH', 'นัดหมายนี้ถูกแก้ไขโดยผู้อื่นแล้ว กรุณาโหลดข้อมูลใหม่', { currentVersion: cur.version });
    }
    if (!['booked', 'confirmed'].includes(cur.status)) throw badRequest('เลื่อนได้เฉพาะนัดที่ยังไม่เริ่มรักษา');

    const curEq = (await client.query('SELECT equipment_id FROM appointment_equipment WHERE appointment_id = $1', [id])).rows.map((r) => r.equipment_id);
    const data = {
      patientId: cur.patient_id,
      therapistId: input.therapistId || cur.therapist_id,
      startAt: input.startAt,
      endAt: input.endAt,
      equipmentIds: [...new Set(input.equipmentIds || curEq)],
      excludeAppointmentId: id,
      acknowledgeWarnings: input.acknowledgeWarnings,
    };
    return withAlternatives(data, async () => {
      await lockResources(client, data);
      const check = await checkConflicts(client, data);
      if (!check.ok) throw conflict('SCHEDULE_CONFLICT', 'conflict', check);
      if (check.warnings.length && !data.acknowledgeWarnings) {
        throw unprocessable('WARNINGS_REQUIRE_ACK', 'มีข้อควรระวังที่ต้องยืนยันก่อนเลื่อนนัด', check);
      }
      await client.query('DELETE FROM appointment_equipment WHERE appointment_id = $1', [id]);
      const { rows: [appt] } = await client.query(
        `UPDATE appointments SET therapist_id = $2, start_at = $3, end_at = $4, version = version + 1
          WHERE id = $1 RETURNING *`, [id, data.therapistId, data.startAt, data.endAt]);
      await insertEquipmentReservations(client, id, data.equipmentIds, data.startAt, data.endAt);
      return { appointment: appt, warnings: check.warnings };
    });
  }, { userId: user.id });
}

async function changeStatus(user, id, { status, reason }) {
  const settings = await getSettings();
  return db.withTx(async (client) => {
    const cur = (await client.query('SELECT * FROM appointments WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!cur) throw notFound('นัดหมาย');
    if (!TRANSITIONS[cur.status].includes(status)) {
      throw unprocessable('INVALID_TRANSITION', `เปลี่ยนสถานะจาก ${cur.status} เป็น ${status} ไม่ได้`, { allowed: TRANSITIONS[cur.status] });
    }
    if (status === 'cancelled' && !reason) throw badRequest('กรุณาระบุเหตุผลการยกเลิก');
    if (status === 'in_progress' && settings.requirePreAssessment) {
      const pre = await client.query(
        `SELECT 1 FROM clinical_assessments WHERE appointment_id = $1 AND phase = 'pre'
            AND pain_score IS NOT NULL AND precautions_reviewed`, [id]);
      if (!pre.rowCount) {
        throw unprocessable('PRE_ASSESSMENT_REQUIRED', 'ต้องบันทึก Pre-Treatment Assessment (Pain score + ทบทวนข้อควรระวัง) ก่อนเริ่มรักษา');
      }
    }
    const { rows: [appt] } = await client.query(
      `UPDATE appointments SET status = $2, cancel_reason = COALESCE($3, cancel_reason), version = version + 1
        WHERE id = $1 RETURNING *`, [id, status, status === 'cancelled' ? reason : null]);
    return appt;
  }, { userId: user.id, statusReason: `appointment ${status}` });
}

// ---------------------------------------------------------------------
// 3) Slot finder & alternatives
// ---------------------------------------------------------------------
async function activeTherapistIds(client = db) {
  const { rows } = await client.query(`SELECT id FROM staff WHERE is_active AND position = 'physiotherapist'`);
  return rows.map((r) => r.id);
}

async function bookableUnitsByCategory(categoryIds, client = db) {
  if (!categoryIds.length) return new Map();
  const { rows } = await client.query(
    `SELECT id, category_id FROM equipment WHERE category_id = ANY($1) AND status IN ('available','in_use')`,
    [categoryIds]);
  const map = new Map(categoryIds.map((c) => [Number(c), []]));
  rows.forEach((r) => map.get(r.category_id).push(r.id));
  return map;
}

/**
 * ค้นหาช่องเวลาว่างในวันหนึ่ง ที่ทั้งนักกายภาพ ผู้ป่วย และอุปกรณ์ (อย่างน้อย 1 เครื่องต่อหมวดที่ต้องการ) ว่างพร้อมกัน
 */
async function findSlots({ date, durationMin, patientId = null, therapistIds, categoryIds = [], excludeAppointmentId = null, limit = 50 }) {
  const settings = await getSettings();
  const { open, close, days } = settings.hours;
  const dayStart = localToDate(date, open, settings.utcOffset);
  const dayEnd = localToDate(date, close, settings.utcOffset);
  if (!days.includes(toLocalParts(dayStart, settings.utcOffset).isoDow)) return [];

  const staffIds = therapistIds?.length ? therapistIds : await activeTherapistIds();
  const units = await bookableUnitsByCategory(categoryIds);
  const ctx = await avail.loadContext(db, {
    from: dayStart, to: dayEnd, staffIds, equipmentIds: [...units.values()].flat(), patientId, excludeAppointmentId,
  });

  const step = settings.slotMinutes * 60000;
  const dur = durationMin * 60000;
  const now = Date.now();
  const slots = [];
  for (let t = dayStart.getTime(); t + dur <= dayEnd.getTime() && slots.length < limit; t += step) {
    if (t < now) continue;
    const e = t + dur;
    if (!avail.isPatientFree(ctx, t, e)) continue;
    const freeStaff = staffIds.filter((id) => !avail.staffBlockReason(ctx, id, t, e));
    if (!freeStaff.length) continue;
    const equipment = {};
    let ok = true;
    for (const [catId, ids] of units) {
      // เลือกเครื่องที่ถูกใช้น้อยที่สุดในวันนั้น (กระจายการสึกหรอ)
      const free = ids.filter((id) => avail.isEquipmentFree(ctx, id, t, e))
        .sort((a, b) => ctx.equipment.get(a).bookedMinutes - ctx.equipment.get(b).bookedMinutes);
      if (!free.length) { ok = false; break; }
      equipment[catId] = free[0];
    }
    if (!ok) continue;
    slots.push({
      startAt: new Date(t).toISOString(),
      endAt: new Date(e).toISOString(),
      therapistIds: freeStaff.sort((a, b) => avail.staffLoad(ctx, a) - avail.staffLoad(ctx, b)),
      equipment,
    });
  }
  return slots;
}

async function suggestAlternatives(input, conflicts) {
  const start = new Date(input.startAt);
  const durationMin = Math.round((new Date(input.endAt) - start) / 60000);
  const settings = await getSettings();
  const out = { sameTherapistSlots: [], otherTherapistsSameTime: [], equipmentSubstitutes: [] };

  const eqIds = input.equipmentIds || [];
  const cats = eqIds.length
    ? (await db.query('SELECT DISTINCT category_id FROM equipment WHERE id = ANY($1)', [eqIds])).rows.map((r) => r.category_id)
    : [];

  // (a) นักกายภาพคนเดิม ช่วงเวลาอื่น — ใกล้เวลาที่ขอมากที่สุด ภายใน 7 วัน
  for (let d = 0; d < 7 && out.sameTherapistSlots.length < 5; d++) {
    const date = toLocalParts(addMinutes(start, d * 1440), settings.utcOffset).date;
    const slots = await findSlots({
      date, durationMin, patientId: input.patientId, therapistIds: [input.therapistId],
      categoryIds: cats, excludeAppointmentId: input.excludeAppointmentId, limit: 40,
    });
    slots.sort((a, b) => Math.abs(new Date(a.startAt) - start) - Math.abs(new Date(b.startAt) - start));
    out.sameTherapistSlots.push(...slots.slice(0, 5 - out.sameTherapistSlots.length));
  }

  // (b) เวลาเดิม นักกายภาพคนอื่น (ถ้าปัญหาอยู่ที่ตัวนักกายภาพ)
  const staffProblem = conflicts.some((c) => c.resource?.kind === 'staff');
  if (staffProblem) {
    const others = (await activeTherapistIds()).filter((id) => id !== input.therapistId);
    const ctx = await avail.loadContext(db, { from: start, to: new Date(input.endAt), staffIds: others });
    const free = others.filter((id) => !avail.staffBlockReason(ctx, id, start.getTime(), new Date(input.endAt).getTime()));
    if (free.length) {
      const { rows } = await db.query(
        `SELECT id, title || first_name || ' ' || last_name AS name FROM staff WHERE id = ANY($1)`, [free]);
      out.otherTherapistsSameTime = rows;
    }
  }

  // (c) เครื่องทดแทนในหมวดเดียวกัน ณ เวลาเดิม
  const badEq = [...new Set(conflicts.filter((c) => c.resource?.kind === 'equipment' && c.type !== 'CONTRAINDICATED').map((c) => c.resource.id))];
  if (badEq.length) {
    const { rows: badRows } = await db.query('SELECT id, category_id FROM equipment WHERE id = ANY($1)', [badEq]);
    const units = await bookableUnitsByCategory([...new Set(badRows.map((r) => r.category_id))]);
    const ctx = await avail.loadContext(db, {
      from: start, to: new Date(input.endAt), equipmentIds: [...units.values()].flat(),
      excludeAppointmentId: input.excludeAppointmentId,
    });
    for (const r of badRows) {
      const subs = (units.get(r.category_id) || [])
        .filter((id) => id !== r.id && !eqIds.includes(id) && avail.isEquipmentFree(ctx, id, start.getTime(), new Date(input.endAt).getTime()));
      if (subs.length) {
        const { rows } = await db.query('SELECT id, name, asset_code FROM equipment WHERE id = ANY($1)', [subs]);
        out.equipmentSubstitutes.push({ replaces: r.id, options: rows });
      }
    }
  }
  return out;
}

module.exports = {
  checkConflicts, createAppointment, rescheduleAppointment, changeStatus, findSlots, suggestAlternatives,
  activeTherapistIds, bookableUnitsByCategory, TRANSITIONS,
};
