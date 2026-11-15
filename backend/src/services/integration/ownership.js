/**
 * เจ้าของข้อมูล (field ownership) เมื่อ record มาจากระบบโรงพยาบาล (managed_by IS NOT NULL)
 *
 * ฟิลด์ในรายการนี้ HIS เป็นเจ้าของ — แก้ที่ HIS แล้วซิงก์เข้ามา แก้ในระบบนี้ไม่ได้ (ลดข้อมูลซ้ำซ้อน/ขัดแย้ง)
 * ฟิลด์อื่น (ความเชี่ยวชาญ กะงาน สถานะเครื่อง การบำรุงรักษา ผังห้อง ฯลฯ) ระบบกายภาพเป็นเจ้าของ แก้ได้ตามปกติ
 * key = ชื่อฟิลด์ใน API (camelCase), value = คอลัมน์ในฐานข้อมูล
 */
const { conflict } = require('../../errors');

const HIS_OWNED = {
  room: { code: 'code', name: 'name', floor: 'floor', isActive: 'is_active' },
  bed: { code: 'code', name: 'name', roomId: 'room_id', isActive: 'is_active' },
  staff: {
    employeeCode: 'employee_code', title: 'title', firstName: 'first_name', lastName: 'last_name', position: 'position',
    licenseNo: 'license_no', licenseExpiry: 'license_expiry', phone: 'phone', email: 'email', isActive: 'is_active',
  },
  equipment: {
    assetCode: 'asset_code', name: 'name', categoryId: 'category_id', brand: 'brand', model: 'model', serialNo: 'serial_no',
    purchaseDate: 'purchase_date', purchasePrice: 'purchase_price', vendor: 'vendor', warrantyExpiry: 'warranty_expiry',
  },
  patient: {
    hn: 'hn', title: 'title', firstName: 'first_name', lastName: 'last_name', dateOfBirth: 'date_of_birth', gender: 'gender',
    phone: 'phone', email: 'email', address: 'address',
  },
};
const TABLE = { room: 'rooms', bed: 'beds', staff: 'staff', equipment: 'equipment', patient: 'patients' };

const norm = (v) => {
  if (v === null || v === undefined || v === '') return '';
  // คอลัมน์ DATE ถูก parse เป็นเที่ยงคืนเวลาท้องถิ่น — ใช้ส่วนวันที่ท้องถิ่น
  if (v instanceof Date) return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;
  return String(v);
};

/**
 * ปฏิเสธการแก้ฟิลด์ของ HIS บน record ที่ซิงก์มาจาก HIS (ส่งค่าเดิมมาได้ ไม่ถือว่าแก้)
 * เรียกก่อน UPDATE ในทุก route ที่แก้ข้อมูลหลัก
 */
async function assertEditable(client, entity, id, body) {
  const owned = HIS_OWNED[entity];
  const keys = Object.keys(body).filter((k) => body[k] !== undefined && owned[k]);
  if (!keys.length) return;
  const { rows: [row] } = await client.query(
    `SELECT managed_by, ${keys.map((k) => owned[k]).join(', ')} FROM ${TABLE[entity]} WHERE id = $1`, [id]);
  if (!row || !row.managed_by) return;
  const changed = keys.filter((k) => norm(row[owned[k]]) !== norm(body[k]));
  if (changed.length) {
    throw conflict('HIS_MANAGED', `ข้อมูลนี้มาจากระบบโรงพยาบาล (${row.managed_by}) — แก้ที่ระบบโรงพยาบาลแล้วระบบจะซิงก์ให้`, { fields: changed });
  }
}

module.exports = { HIS_OWNED, assertEditable };
