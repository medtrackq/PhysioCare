/**
 * Availability Context — โหลดข้อมูลตารางทั้งหมดในช่วงเวลาที่สนใจมาไว้ในหน่วยความจำครั้งเดียว
 * แล้วตอบคำถาม "ว่างไหม" แบบ O(n) ต่อ resource โดยไม่ต้อง query ซ้ำ
 * ใช้กับ: ค้นหาช่องว่าง (slot finder), ระบบแนะนำ, การเสนอทางเลือกเมื่อจองชน
 *
 * หมายเหตุ: การตัดสินใจ "จองจริง" ยังต้องผ่าน checkConflicts() ภายใน transaction
 * ที่ lock แถวแล้ว + EXCLUDE constraint ในฐานข้อมูลเสมอ
 */
const BOOKABLE_EQUIPMENT_STATUS = new Set(['available', 'in_use']);
const ACTIVE_APPT_SQL = `status NOT IN ('cancelled','no_show')`;

const ms = (d) => new Date(d).getTime();
const anyOverlap = (list, s, e) => list.some(([a, b]) => a < e && s < b);

async function loadContext(db, { from, to, staffIds = [], equipmentIds = [], patientId = null, excludeAppointmentId = null }) {
  const range = [from, to];
  const ctx = { staff: new Map(), equipment: new Map(), patientBusy: [], from: ms(from), to: ms(to) };

  if (staffIds.length) {
    for (const id of staffIds) ctx.staff.set(id, { shifts: [], leaves: [], busy: [] });
    const [shifts, leaves, appts] = await Promise.all([
      db.query(
        `SELECT staff_id, start_at, end_at FROM staff_shifts
          WHERE staff_id = ANY($1) AND period && tstzrange($2, $3, '[)')`, [staffIds, ...range]),
      db.query(
        `SELECT staff_id, start_at, end_at FROM staff_leaves
          WHERE staff_id = ANY($1) AND period && tstzrange($2, $3, '[)')`, [staffIds, ...range]),
      db.query(
        `SELECT id, therapist_id, start_at, end_at FROM appointments
          WHERE therapist_id = ANY($1) AND ${ACTIVE_APPT_SQL}
            AND period && tstzrange($2, $3, '[)') AND ($4::uuid IS NULL OR id <> $4)`,
        [staffIds, ...range, excludeAppointmentId]),
    ]);
    shifts.rows.forEach((r) => ctx.staff.get(r.staff_id).shifts.push([ms(r.start_at), ms(r.end_at)]));
    leaves.rows.forEach((r) => ctx.staff.get(r.staff_id).leaves.push([ms(r.start_at), ms(r.end_at)]));
    appts.rows.forEach((r) => ctx.staff.get(r.therapist_id).busy.push([ms(r.start_at), ms(r.end_at), r.id]));
  }

  if (equipmentIds.length) {
    const [eq, bookings, maint] = await Promise.all([
      db.query(
        `SELECT e.id, e.status, e.category_id, c.cleaning_buffer_minutes AS buffer
           FROM equipment e JOIN equipment_categories c ON c.id = e.category_id
          WHERE e.id = ANY($1)`, [equipmentIds]),
      db.query(
        `SELECT equipment_id, start_at, end_at FROM appointment_equipment
          WHERE is_active AND equipment_id = ANY($1) AND period && tstzrange($2, $3, '[)')
            AND ($4::uuid IS NULL OR appointment_id <> $4)`,
        [equipmentIds, from, new Date(ms(to) + 60 * 60000), excludeAppointmentId]),
      db.query(
        `SELECT equipment_id, planned_start, planned_end FROM equipment_maintenance
          WHERE equipment_id = ANY($1) AND status IN ('scheduled','in_progress')
            AND planned_period && tstzrange($2, $3, '[)')`, [equipmentIds, ...range]),
    ]);
    eq.rows.forEach((r) => ctx.equipment.set(r.id, { ...r, busy: [], blocks: [], bookedMinutes: 0 }));
    bookings.rows.forEach((r) => {
      const e = ctx.equipment.get(r.equipment_id);
      e.busy.push([ms(r.start_at), ms(r.end_at)]);
      e.bookedMinutes += (ms(r.end_at) - ms(r.start_at)) / 60000;
    });
    maint.rows.forEach((r) => ctx.equipment.get(r.equipment_id).blocks.push([ms(r.planned_start), ms(r.planned_end)]));
  }

  if (patientId) {
    const { rows } = await db.query(
      `SELECT start_at, end_at FROM appointments
        WHERE patient_id = $1 AND ${ACTIVE_APPT_SQL} AND period && tstzrange($2, $3, '[)')
          AND ($4::uuid IS NULL OR id <> $4)`, [patientId, ...range, excludeAppointmentId]);
    ctx.patientBusy = rows.map((r) => [ms(r.start_at), ms(r.end_at)]);
  }
  return ctx;
}

/** เหตุผลที่ไม่ว่าง (null = ว่าง) */
function staffBlockReason(ctx, staffId, s, e) {
  const st = ctx.staff.get(staffId);
  if (!st) return 'UNKNOWN';
  if (!st.shifts.some(([a, b]) => a <= s && e <= b)) return 'NOT_ON_SHIFT';
  if (anyOverlap(st.leaves, s, e)) return 'ON_LEAVE';
  if (anyOverlap(st.busy, s, e)) return 'BUSY';
  return null;
}

function isEquipmentFree(ctx, equipmentId, s, e) {
  const eq = ctx.equipment.get(equipmentId);
  if (!eq || !BOOKABLE_EQUIPMENT_STATUS.has(eq.status)) return false;
  const eWithBuffer = e + eq.buffer * 60000;
  return !anyOverlap(eq.busy, s, eWithBuffer) && !anyOverlap(eq.blocks, s, eWithBuffer);
}

const isPatientFree = (ctx, s, e) => !anyOverlap(ctx.patientBusy, s, e);

const staffLoad = (ctx, staffId) => ctx.staff.get(staffId)?.busy.length || 0;

module.exports = {
  loadContext, staffBlockReason, isEquipmentFree, isPatientFree, staffLoad, BOOKABLE_EQUIPMENT_STATUS,
};
