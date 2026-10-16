#!/usr/bin/env node
/**
 * สร้างบัญชีผู้ดูแลระบบคนแรก (หรือรีเซ็ตรหัสผ่าน)
 *
 *   ADMIN_EMAIL=you@clinic.co.th ADMIN_PASSWORD='...' ADMIN_NAME='ผู้ดูแลระบบ' npm run create-admin
 *   ... npm run create-admin -- --reset-password
 *
 * รับรหัสผ่านทาง environment variable เพื่อไม่ให้ค้างใน shell history ของ argument
 */
const bcrypt = require('bcryptjs');
const { Client } = require('pg');

const email = process.env.ADMIN_EMAIL;
const password = process.env.ADMIN_PASSWORD;
const name = process.env.ADMIN_NAME || 'ผู้ดูแลระบบ';
const reset = process.argv.includes('--reset-password');

async function main() {
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('ADMIN_EMAIL is required');
  if (!password || password.length < 12 || !/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/[0-9]/.test(password)) {
    throw new Error('ADMIN_PASSWORD must be at least 12 characters with upper, lower case and a digit');
  }
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const hash = await bcrypt.hash(password, 12);
    const { rows: [existing] } = await client.query('SELECT id FROM users WHERE lower(email) = lower($1)', [email]);
    if (existing) {
      if (!reset) throw new Error(`User ${email} already exists (use --reset-password to change the password)`);
      await client.query('UPDATE users SET password_hash = $2, failed_logins = 0, locked_until = NULL, is_active = true WHERE id = $1', [existing.id, hash]);
      console.log(`Password reset for ${email}`);
      return;
    }
    await client.query(
      `INSERT INTO users (email, password_hash, display_name, role_id)
       VALUES ($1, $2, $3, (SELECT id FROM roles WHERE code = 'admin'))`, [email, hash, name]);
    console.log(`Admin ${email} created`);
  } finally {
    await client.end();
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
