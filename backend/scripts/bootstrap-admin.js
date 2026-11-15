#!/usr/bin/env node
/**
 * สร้างผู้ดูแลระบบคนแรกตอนเริ่มระบบ (สำหรับแพลตฟอร์มที่ไม่สะดวกเข้า shell เช่น Railway)
 *
 * ทำงานเฉพาะเมื่อ: ตั้ง ADMIN_EMAIL + ADMIN_PASSWORD และยังไม่มีบัญชีผู้ดูแลระบบที่ใช้งานอยู่เลย
 * ถ้ามีผู้ดูแลระบบแล้วจะไม่ทำอะไร (ไม่เปลี่ยนรหัสผ่าน) — ลบตัวแปร ADMIN_PASSWORD ออกหลังใช้งานครั้งแรก
 */
const bcrypt = require('bcryptjs');
const { Client } = require('pg');

async function main() {
  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;
  if (!email || !password) return;
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const { rows: [{ n }] } = await client.query(
      `SELECT count(*)::int AS n FROM users u JOIN roles r ON r.id = u.role_id WHERE r.code = 'admin' AND u.is_active`);
    if (n > 0) {
      console.log('[bootstrap-admin] admin already exists — skipped (you can remove ADMIN_PASSWORD now)');
      return;
    }
    if (password.length < 12 || !/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/[0-9]/.test(password)) {
      console.error('[bootstrap-admin] ADMIN_PASSWORD must be at least 12 characters with upper, lower case and a digit — admin NOT created');
      return;
    }
    await client.query(
      `INSERT INTO users (email, password_hash, display_name, role_id)
       VALUES ($1, $2, $3, (SELECT id FROM roles WHERE code = 'admin'))`,
      [email, await bcrypt.hash(password, 12), process.env.ADMIN_NAME || 'ผู้ดูแลระบบ']);
    console.log(`[bootstrap-admin] created admin ${email} — remove ADMIN_PASSWORD from the environment now`);
  } finally {
    await client.end();
  }
}

// ไม่ทำให้เซิร์ฟเวอร์ล้มถ้าขั้นนี้ผิดพลาด
main().catch((e) => console.error('[bootstrap-admin]', e.message));
