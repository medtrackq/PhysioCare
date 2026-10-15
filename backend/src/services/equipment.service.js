/**
 * Equipment: real-time status + maintenance lifecycle
 * สถานะ: available | in_use | maintenance | broken | retired
 *  - in_use ถูกตั้ง/คืนอัตโนมัติจากสถานะนัด (DB trigger)
 *  - เปลี่ยนสถานะ -> trigger บันทึก equipment_status_logs + pg_notify -> SSE push ไปทุกหน้าจอ
 *  - แจ้งชำรุด/ส่งซ่อม -> ระบบคืนรายการนัดในอนาคตที่ได้รับผลกระทบ + เครื่องทดแทน
 */
const db = require('../db');
const { notFound, unprocessable } = require('../errors');
const { bookableUnitsByCategory } = require('./scheduling.service');
const avail = require('./availability');

const MANUAL_STATUSES = ['available', 'maintenance', 'broken', 'retired'];

async function affectedAppointments(client, equipmentId) {
  const { rows } = await client.query(
    `SELECT a.id, a.start_at, a.end_at, a.status, p.hn, p.first_name || ' ' || p.last_name AS patient_name,
            s.title || s.first_name AS therapist
       FROM appointment_equipment ae
       JOIN appointments a ON a.id = ae.appointment_id
       JOIN patients p ON p.id = a.patient_id
       JOIN staff s ON s.id = a.therapist_id
      WHERE ae.equipment_id = $1 AND ae.is_active AND a.status IN ('booked','confirmed','checked_in')
        AND a.end_at > now()
      ORDER BY a.start_at`, [equipmentId]);
  return rows;
}

async function substitutesFor(equipment, appointments) {
  const units = (await bookableUnitsByCategory([equipment.category_id])).get(equipment.category_id) || [];
  const others = units.filter((id) => id !== equipment.id);
  if (!others.length || !appointments.length) return appointments.map((a) => ({ ...a, substitutes: [] }));
  const from = appointments[0].start_at;
  const to = appointments.at(-1).end_at;
  const ctx = await avail.loadContext(db, { from, to, equipmentIds: others });
  const names = new Map((await db.query('SELECT id, name, asset_code FROM equipment WHERE id = ANY($1)', [others])).rows.map((r) => [r.id, r]));
  return appointments.map((a) => ({
    ...a,
    substitutes: others.filter((id) => avail.isEquipmentFree(ctx, id, new Date(a.start_at).getTime(), new Date(a.end_at).getTime()))
      .map((id) => names.get(id)),
  }));
}

async function changeStatus(user, id, { status, reason }) {
  if (!MANUAL_STATUSES.includes(status)) {
    throw unprocessable('INVALID_STATUS', 'สถานะ in_use ถูกจัดการอัตโนมัติจากการเริ่ม/จบการรักษา');
  }
  const result = await db.withTx(async (c) => {
    const { rows: [eq] } = await c.query('SELECT * FROM equipment WHERE id = $1 FOR UPDATE', [id]);
    if (!eq) throw notFound('อุปกรณ์');
    if (eq.status === 'in_use' && status !== 'broken') {
      throw unprocessable('EQUIPMENT_IN_USE', 'อุปกรณ์กำลังใช้งาน เปลี่ยนสถานะได้หลังจบการรักษา (ยกเว้นแจ้งชำรุดฉุกเฉิน)');
    }
    const { rows: [updated] } = await c.query('UPDATE equipment SET status = $2 WHERE id = $1 RETURNING *', [id, status]);
    // แจ้งชำรุด -> เปิดใบแจ้งซ่อมอัตโนมัติ
    if (status === 'broken') {
      await c.query(
        `INSERT INTO equipment_maintenance (equipment_id, type, status, problem, created_by)
         VALUES ($1, 'corrective', 'scheduled', $2, $3)`, [id, reason || 'แจ้งชำรุด', user.id]);
    }
    const affected = ['maintenance', 'broken', 'retired'].includes(status) ? await affectedAppointments(c, id) : [];
    return { equipment: updated, affected };
  }, { userId: user.id, statusReason: reason || null });

  return {
    equipment: result.equipment,
    affectedAppointments: await substitutesFor(result.equipment, result.affected),
  };
}

async function createMaintenance(user, equipmentId, body) {
  return db.withTx(async (c) => {
    const { rows: [eq] } = await c.query('SELECT * FROM equipment WHERE id = $1 FOR UPDATE', [equipmentId]);
    if (!eq) throw notFound('อุปกรณ์');
    const { rows: [m] } = await c.query(
      `INSERT INTO equipment_maintenance (equipment_id, type, status, planned_start, planned_end, problem, vendor, technician, cost, created_by, started_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, CASE WHEN $3 = 'in_progress' THEN now() END) RETURNING *`,
      [equipmentId, body.type, body.status || 'scheduled', body.plannedStart || null, body.plannedEnd || null,
        body.problem || null, body.vendor || null, body.technician || null, body.cost || 0, user.id]);
    if (m.status === 'in_progress' && eq.status === 'available') {
      await c.query(`UPDATE equipment SET status = 'maintenance' WHERE id = $1`, [equipmentId]);
    }
    return m;
  }, { userId: user.id, statusReason: `maintenance: ${body.type}` });
}

async function updateMaintenance(user, maintenanceId, body) {
  return db.withTx(async (c) => {
    const { rows: [m] } = await c.query('SELECT * FROM equipment_maintenance WHERE id = $1 FOR UPDATE', [maintenanceId]);
    if (!m) throw notFound('รายการบำรุงรักษา');
    if (['completed', 'cancelled'].includes(m.status)) throw unprocessable('MAINTENANCE_CLOSED', 'รายการนี้ปิดแล้ว');
    const { rows: [u] } = await c.query(
      `UPDATE equipment_maintenance SET
          status = $2,
          action_taken = COALESCE($3, action_taken),
          result = COALESCE($4, result),
          cost = COALESCE($5, cost),
          technician = COALESCE($6, technician),
          vendor = COALESCE($7, vendor),
          started_at = CASE WHEN $2 = 'in_progress' AND started_at IS NULL THEN now() ELSE started_at END,
          completed_at = CASE WHEN $2 = 'completed' THEN now() ELSE completed_at END
        WHERE id = $1 RETURNING *`,
      [maintenanceId, body.status, body.actionTaken ?? null, body.result ?? null, body.cost ?? null, body.technician ?? null, body.vendor ?? null]);

    if (body.status === 'in_progress') {
      await c.query(`UPDATE equipment SET status = 'maintenance' WHERE id = $1 AND status IN ('available','broken')`, [m.equipment_id]);
    }
    if (body.status === 'completed') {
      const back = body.result === 'fail' ? 'broken' : 'available';
      await c.query(
        `UPDATE equipment e SET status = $2,
                last_maintenance_at = CURRENT_DATE,
                next_maintenance_due = CURRENT_DATE + c.maintenance_interval_days
           FROM equipment_categories c
          WHERE e.id = $1 AND c.id = e.category_id`, [m.equipment_id, back]);
    }
    return u;
  }, { userId: user.id, statusReason: `maintenance ${body.status}` });
}

module.exports = { changeStatus, createMaintenance, updateMaintenance, affectedAppointments };
