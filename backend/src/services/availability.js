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

async function loadContext(db, { from, to, staffIds = [], equipmentIds = [], patientId = null, excludeAppointmentId = null, spaces = false }) {
  const range = [from, to];
  const ctx = { staff: new Map(), equipment: new Map(), patientBusy: [], rooms: new Map(), beds: new Map(), from: ms(from), to: ms(to) };

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
        `SELECT e.id, e.status, e.category_id, e.room_id, c.space_type, c.cleaning_buffer_minutes AS buffer
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

  if (spaces) await loadSpaces(db, ctx, { from, to, excludeAppointmentId });

  if (patientId) {
    const { rows } = await db.query(
      `SELECT start_at, end_at FROM appointments
        WHERE patient_id = $1 AND ${ACTIVE_APPT_SQL} AND period && tstzrange($2, $3, '[)')
          AND ($4::uuid IS NULL OR id <> $4)`, [patientId, ...range, excludeAppointmentId]);
    ctx.patientBusy = rows.map((r) => [ms(r.start_at), ms(r.end_at)]);
  }
  return ctx;
}

/** ห้อง เตียง และการใช้งานในช่วงเวลา (ใช้จัดห้อง/เตียงอัตโนมัติ) */
async function loadSpaces(db, ctx, { from, to, excludeAppointmentId }) {
  const [rooms, beds, appts, turnover] = await Promise.all([
    db.query(`SELECT id, code, name, room_type, capacity FROM rooms WHERE is_active ORDER BY code`),
    db.query(`SELECT b.id, b.code, b.name, b.room_id, b.status FROM beds b JOIN rooms r ON r.id = b.room_id
               WHERE b.is_active AND r.is_active ORDER BY b.code`),
    db.query(
      `SELECT id, room_id, bed_id, start_at, end_at, bed_until FROM appointments
        WHERE room_id IS NOT NULL AND ${ACTIVE_APPT_SQL} AND ($3::uuid IS NULL OR id <> $3)
          AND tstzrange(start_at, COALESCE(bed_until, end_at), '[)') && tstzrange($1, $2::timestamptz + interval '1 hour', '[)')`,
      [from, to, excludeAppointmentId]),
    db.query(`SELECT value FROM system_settings WHERE key = 'scheduling.bed_turnover_minutes'`),
  ]);
  ctx.turnoverMs = Number(turnover.rows[0]?.value ?? 5) * 60000;
  rooms.rows.forEach((r) => ctx.rooms.set(r.id, { ...r, occupancy: [] }));
  beds.rows.forEach((b) => ctx.beds.set(b.id, { ...b, busy: [], bookedMinutes: 0 }));
  for (const a of appts.rows) {
    ctx.rooms.get(a.room_id)?.occupancy.push([ms(a.start_at), ms(a.end_at)]);
    const bed = a.bed_id && ctx.beds.get(a.bed_id);
    if (bed) {
      bed.busy.push([ms(a.start_at), ms(a.bed_until || a.end_at)]);
      bed.bookedMinutes += (ms(a.end_at) - ms(a.start_at)) / 60000;
    }
  }
}

const spacesConfigured = (ctx) => ctx.rooms.size > 0;

function isBedFree(ctx, bedId, s, e) {
  const bed = ctx.beds.get(bedId);
  return Boolean(bed && bed.status === 'available' && ctx.rooms.has(bed.room_id) && !anyOverlap(bed.busy, s, e + ctx.turnoverMs));
}

function roomHasCapacity(ctx, roomId, s, e) {
  const room = ctx.rooms.get(roomId);
  if (!room) return false;
  // นับจำนวนผู้ป่วยสูงสุดที่อยู่พร้อมกันในช่วง [s,e) (sweep line)
  const events = room.occupancy.filter(([a, b]) => a < e && s < b)
    .flatMap(([a, b]) => [[Math.max(a, s), 1], [Math.min(b, e), -1]])
    .sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  let cur = 0;
  let peak = 0;
  for (const [, d] of events) { cur += d; peak = Math.max(peak, cur); }
  return peak < room.capacity;
}

/**
 * ความต้องการพื้นที่จากอุปกรณ์ที่เลือก
 *  - fixedRoomIds: ห้องที่อุปกรณ์ติดตั้งอยู่ (ต้องอยู่ห้องเดียวกันทั้งหมด)
 *  - needsBed: ไม่มีอุปกรณ์ (manual therapy) หรือมีอุปกรณ์ประเภทใช้บนเตียง
 *  - gymOnly: อุปกรณ์ทั้งหมดเป็นประเภทพื้นที่ออกกำลังกาย
 */
function spaceNeeds(equipmentRows) {
  const fixedRoomIds = [...new Set(equipmentRows.map((e) => e.room_id).filter(Boolean))];
  const types = new Set(equipmentRows.map((e) => e.space_type));
  const gymOnly = equipmentRows.length > 0 && [...types].every((t) => t === 'gym' || t === 'none') && types.has('gym');
  const needsBed = !gymOnly && (equipmentRows.length === 0 || types.has('bed') || !types.has('gym'));
  return { fixedRoomIds, needsBed, gymOnly };
}

/**
 * เลือกห้อง/เตียงที่ว่าง: เคารพห้องของอุปกรณ์ที่ติดตั้งประจำ, ความจุห้อง,
 * เลือกเตียงที่ถูกใช้น้อยที่สุดในวันนั้น และให้ผู้ป่วยเด็กใช้ห้องเด็กก่อน
 * คืนค่า { roomId, bedId } หรือ null ถ้าไม่มีที่ว่าง
 */
function pickSpace(ctx, needs, s, e, { pediatric = false } = {}) {
  if (!spacesConfigured(ctx)) return { roomId: null, bedId: null };
  if (needs.fixedRoomIds.length > 1) return null;
  const fixed = needs.fixedRoomIds[0] || null;
  const roomOk = (r) => (!fixed || r.id === fixed) && roomHasCapacity(ctx, r.id, s, e);

  if (needs.gymOnly) {
    const room = [...ctx.rooms.values()].filter((r) => (fixed ? r.id === fixed : r.room_type === 'gym')).find(roomOk);
    return room ? { roomId: room.id, bedId: null } : null;
  }
  const rank = (b) => {
    const room = ctx.rooms.get(b.room_id);
    const typeScore = pediatric ? (room.room_type === 'pediatric' ? 0 : 1) : (room.room_type === 'pediatric' ? 2 : 0);
    return typeScore * 1e6 + b.bookedMinutes;
  };
  const bed = [...ctx.beds.values()]
    .filter((b) => ctx.rooms.get(b.room_id)?.room_type !== 'gym' || fixed === b.room_id)
    .filter((b) => roomOk(ctx.rooms.get(b.room_id)) && isBedFree(ctx, b.id, s, e))
    .sort((a, b) => rank(a) - rank(b))[0];
  return bed ? { roomId: bed.room_id, bedId: bed.id } : null;
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
  spacesConfigured, isBedFree, roomHasCapacity, spaceNeeds, pickSpace,
};
