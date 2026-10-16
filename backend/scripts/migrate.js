#!/usr/bin/env node
/**
 * Database migration runner
 *
 *   npm run migrate                 รันไฟล์ใน db/*.sql ที่ยังไม่เคยรัน (เรียงตามชื่อ)
 *   npm run migrate -- --demo       รวม db/demo/*.sql (ข้อมูลทดลอง — ห้ามใช้ใน production)
 *   npm run migrate -- --status     แสดงสถานะ
 *   npm run migrate -- --baseline   บันทึกว่าไฟล์หลักทั้งหมดรันแล้ว (สำหรับฐานข้อมูลที่สร้างด้วยมือก่อนมีตัวรันนี้)
 *
 * แต่ละไฟล์รันใน transaction เดียว; ไฟล์ที่มี "@repeatable" ในส่วนหัวจะรันซ้ำเมื่อ checksum เปลี่ยน
 * (ใช้กับฐานความรู้แนวทางการรักษาที่ทบทวนเป็นระยะ)
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Client } = require('pg');

const DIR = path.resolve(process.env.MIGRATIONS_DIR || path.join(__dirname, '..', '..', 'db'));
const args = new Set(process.argv.slice(2));

function listFiles() {
  const pick = (dir, prefix = '') => (fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((f) => ({ name: prefix + f, file: path.join(dir, f) }))
    : []);
  const core = pick(DIR);
  return args.has('--demo') ? [...core, ...pick(path.join(DIR, 'demo'), 'demo/')] : core;
}

async function main() {
  if (args.has('--demo') && process.env.NODE_ENV === 'production' && !args.has('--force')) {
    throw new Error('Refusing to load demo data with NODE_ENV=production (use --force if you really mean it)');
  }
  const client = new Client({ connectionString: process.env.DATABASE_URL || 'postgres://postgres@localhost:5432/physiocare' });
  await client.connect();
  try {
    // กันการรันพร้อมกันหลาย instance (เช่น container หลายตัวเริ่มพร้อมกัน)
    await client.query('SELECT pg_advisory_lock(727001)');
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      filename text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
    const applied = new Map((await client.query('SELECT filename, checksum FROM schema_migrations')).rows.map((r) => [r.filename, r.checksum]));

    let ran = 0;
    for (const { name, file } of listFiles()) {
      const sql = fs.readFileSync(file, 'utf8');
      const checksum = crypto.createHash('sha256').update(sql).digest('hex');
      const repeatable = /@repeatable/.test(sql.slice(0, 2000));
      const prev = applied.get(name);
      const state = !prev ? 'pending' : prev === checksum ? 'applied' : repeatable ? 'changed' : 'modified';

      if (args.has('--status')) { console.log(`${state.padEnd(9)} ${name}`); continue; }
      if (state === 'applied') continue;
      if (state === 'modified') {
        console.warn(`! ${name} changed after it was applied — not re-running (create a new migration file instead)`);
        continue;
      }
      if (args.has('--baseline') && !name.startsWith('demo/')) {
        await client.query('INSERT INTO schema_migrations (filename, checksum) VALUES ($1,$2) ON CONFLICT (filename) DO UPDATE SET checksum = $2', [name, checksum]);
        console.log(`= baseline ${name}`);
        continue;
      }
      process.stdout.write(`→ ${state === 'changed' ? 're-applying' : 'applying'} ${name} ... `);
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query(
          `INSERT INTO schema_migrations (filename, checksum) VALUES ($1,$2)
           ON CONFLICT (filename) DO UPDATE SET checksum = EXCLUDED.checksum, applied_at = now()`, [name, checksum]);
        await client.query('COMMIT');
        console.log('ok');
        ran++;
      } catch (e) {
        await client.query('ROLLBACK');
        console.log('FAILED');
        throw new Error(`${name}: ${e.message}`);
      }
    }
    if (!args.has('--status')) console.log(ran ? `Done (${ran} file(s) applied).` : 'Database is up to date.');
  } finally {
    await client.end();
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
