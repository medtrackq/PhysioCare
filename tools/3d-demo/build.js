#!/usr/bin/env node
/**
 * สร้างหน้า demo 3 มิติแบบไฟล์เดียว (ไม่ต้องมีเซิร์ฟเวอร์) จากข้อมูลทดลองในระบบที่กำลังรัน
 *
 *   node tools/3d-demo/build.js --api http://localhost:3000 --date 2026-10-19 --out demo.html
 *
 * ต้องรันกับฐานข้อมูลที่โหลด `migrate --demo` เท่านั้น — สคริปต์นี้ฝังชื่อผู้ป่วยลงในไฟล์
 * จึงห้ามใช้กับข้อมูลผู้ป่วยจริง
 */
const fs = require('node:fs');
const path = require('node:path');

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : def;
};
const API = arg('api', 'http://localhost:3000');
const EMAIL = arg('email', 'front@physiocare.local');
const PASSWORD = arg('password', process.env.DEMO_PASSWORD || 'Passw0rd!');
const OUT = arg('out', path.join(__dirname, 'physiocare-3d-demo.html'));
const STEP = Number(arg('step', 10));
const DATE = arg('date', (() => {
  const d = new Date(Date.now() + 7 * 3600e3 + 2 * 864e5);
  if (d.getUTCDay() === 0) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
})());

let token;
async function get(p) {
  const r = await fetch(API + p, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`${p} → ${r.status}`);
  return r.json();
}
const first = (name) => (name || '').split(' ')[0];

// เก็บเฉพาะข้อมูลที่หน้า demo ใช้ และตัดนามสกุลผู้ป่วยออก
function slim(board) {
  const appt = (a) => a && ({
    patient_name: first(a.patient_name), therapist_name: a.therapist_name, therapist_color: a.therapist_color,
    start_at: a.start_at, end_at: a.end_at,
  });
  return {
    at: board.at,
    kpis: board.kpis,
    rooms: board.rooms.map((r) => ({
      id: r.id, code: r.code, name: r.name, room_type: r.room_type, capacity: r.capacity,
      plan_x: r.plan_x, plan_z: r.plan_z, plan_w: r.plan_w, plan_d: r.plan_d, occupancyNow: r.occupancyNow,
      current: r.current?.map(appt), next: (r.next || []).map(appt),
      beds: r.beds.map((b) => ({
        id: b.id, code: b.code, name: b.name, bed_type: b.bed_type, state: b.state, notes: b.notes,
        plan_x: b.plan_x, plan_z: b.plan_z, plan_rot: b.plan_rot, todayRemaining: b.todayRemaining,
        current: appt(b.current), next: appt(b.next),
      })),
    })),
    equipment: board.equipment.map((e) => ({
      id: e.id, name: e.name, asset_code: e.asset_code, status: e.status, room_id: e.room_id, category_code: e.category_code,
      plan_x: e.plan_x, plan_z: e.plan_z, in_use_by: e.in_use_by ? 1 : null, in_use_room_id: e.in_use_room_id, in_use_bed_id: e.in_use_bed_id,
    })),
  };
}

async function main() {
  const login = await fetch(`${API}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!login.ok) throw new Error(`login failed (${login.status})`);
  token = (await login.json()).token;

  const snapshots = [];
  for (let m = 8 * 60; m <= 20 * 60; m += STEP) {
    const hhmm = `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    const b = await get(`/api/facilities/board?at=${encodeURIComponent(`${DATE}T${hhmm}:00+07:00`)}`);
    snapshots.push({ minute: m, ...slim(b) });
  }
  const staff = (await get('/api/staff?position=physiotherapist')).map((s) => ({
    name: `${s.title || ''}${s.first_name}`, color: s.color, specialties: s.specialties.map((x) => x.name),
  }));
  const appts = await get(`/api/appointments?from=${encodeURIComponent(`${DATE}T00:00:00+07:00`)}&to=${encodeURIComponent(`${DATE}T23:59:00+07:00`)}`);
  const day = {
    date: DATE,
    total: appts.filter((a) => !['cancelled', 'no_show'].includes(a.status)).length,
    withBed: appts.filter((a) => a.bed_id).length,
    withEquipment: appts.filter((a) => a.equipment.length).length,
  };

  const renderer = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'js', 'three', 'clinic3d.js'), 'utf8')
    .replace(/^export /gm, '');
  const template = fs.readFileSync(path.join(__dirname, 'template.html'), 'utf8');
  const data = JSON.stringify({ snapshots, staff, day }).replace(/</g, '\\u003c');
  const html = template.replace('/*__RENDERER__*/', () => renderer).replace('"__DATA__"', () => data);
  fs.writeFileSync(OUT, html);
  console.log(`wrote ${OUT} (${(html.length / 1024).toFixed(0)} KB, ${snapshots.length} snapshots, ${DATE})`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
