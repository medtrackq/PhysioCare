#!/usr/bin/env node
/**
 * เติมข้อมูลทดลองให้ "วันที่คลินิกแน่น" สำหรับหน้า demo 3 มิติ
 *
 *   node tools/3d-demo/seed-busy-day.js --api http://localhost:3000 --date 2026-11-19
 *
 * จองผ่าน API จริงทั้งหมด (คำแนะนำนักกายภาพ/อุปกรณ์ + จัดห้อง/เตียงอัตโนมัติ + กันการจองชน)
 * ใช้กับฐานข้อมูลที่โหลด `migrate --demo` เท่านั้น — สคริปต์เพิ่มบุคลากรและผู้ป่วยสมมติ (รหัส SIM-*)
 * รันซ้ำได้: บุคลากร/ผู้ป่วยที่มีอยู่แล้วจะถูกใช้ซ้ำ
 */
const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : def;
};
const API = arg('api', 'http://localhost:3000');
const EMAIL = arg('email', 'admin@physiocare.local');
const PASSWORD = arg('password', process.env.DEMO_PASSWORD || 'Passw0rd!');
const DATE = arg('date');
const PER_SLOT = Number(arg('per-slot', 3));       // จำนวนนัดใหม่ที่พยายามจองต่อช่วง 15 นาที
const EXTRA_PT = Number(arg('therapists', 6));
const EXTRA_PATIENTS = Number(arg('patients', 60));
if (!DATE) { console.error('ต้องระบุ --date YYYY-MM-DD'); process.exit(1); }

let token;
async function call(method, p, body) {
  const r = await fetch(API + p, {
    method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, data };
}
const get = async (p) => { const r = await call('GET', p); if (!r.ok) throw new Error(`${p} → ${r.status}`); return r.data; };

const THERAPISTS = [
  ['กภ.', 'ธนพร', 'ศรีวงศ์', '#e11d48', ['ORTHO', 'SPORTS'], 'MORNING'],
  ['กภ.', 'ณัฐวุฒิ', 'แก้วมณี', '#16a34a', ['NEURO', 'GERI'], 'MORNING'],
  ['กภ.', 'พิมพ์ลดา', 'ทองดี', '#d97706', ['PEDS', 'NEURO'], 'AFTERNOON'],
  ['กภ.', 'อรรถพล', 'บุญมา', '#7c3aed', ['SPORTS', 'ORTHO'], 'AFTERNOON'],
  ['กภ.', 'กมลชนก', 'สายใจ', '#0891b2', ['ORTHO', 'GERI'], 'MORNING'],
  ['กภ.', 'ศุภชัย', 'พรหมมา', '#be185d', ['CARDIO', 'ORTHO'], 'AFTERNOON'],
  ['กภ.', 'จิราพร', 'นาคสุข', '#65a30d', ['NEURO', 'PEDS'], 'MORNING'],
  ['กภ.', 'ปิยะวัฒน์', 'ใจงาม', '#ea580c', ['SPORTS', 'CARDIO'], 'AFTERNOON'],
];
const FIRST = ['สมพร', 'วิไล', 'ประยูร', 'สุดา', 'บุญเรือน', 'ชัยวัฒน์', 'นภา', 'อำนาจ', 'รัตนา', 'ไพโรจน์', 'กาญจนา', 'สมบัติ',
  'มาลี', 'ธีระ', 'อรุณี', 'วีระ', 'ศิริพร', 'เกษม', 'จันทร์เพ็ญ', 'สุรพล', 'ปราณี', 'อนันต์', 'ลำดวน', 'ทวีศักดิ์', 'พรทิพย์',
  'ณรงค์', 'สายสุนีย์', 'บุญชัย', 'วันเพ็ญ', 'ประเสริฐศักดิ์', 'นิภา', 'สมเกียรติ', 'ดวงใจ', 'เอกชัย', 'ยุพิน', 'สุเมธ'];
const KIDS = ['น้องภูมิ', 'น้องข้าวหอม', 'น้องตะวัน', 'น้องใบเตย', 'น้องกันต์', 'น้องมะปราง', 'น้องธาม', 'น้องพลอย'];
const LAST = ['สุขใจ', 'มั่นคง', 'ศรีสุข', 'ทองคำ', 'แสงทอง', 'ใจดี', 'บุญมี', 'พูลผล', 'รุ่งเรือง', 'วงศ์ใหญ่'];
const ADULT_DX = ['M54.5', 'M54.2', 'M75.0', 'M75.1', 'M77.1', 'M17.1', 'S83.5', 'Z96.65', 'M72.2', 'S93.4', 'I63.9', 'G20'];

async function main() {
  const login = await fetch(`${API}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!login.ok) throw new Error(`login failed (${login.status}) — ใช้กับฐานข้อมูล demo เท่านั้น`);
  token = (await login.json()).token;

  // ---------- นักกายภาพเพิ่ม ----------
  const specialties = await get('/api/staff/specialties');
  const spId = Object.fromEntries(specialties.map((s) => [s.code, s.id]));
  const staffNow = await get('/api/staff');
  let made = 0;
  for (const [i, [title, firstName, lastName, color, sps, shift]] of THERAPISTS.slice(0, EXTRA_PT).entries()) {
    const code = `SIM-PT${String(i + 1).padStart(2, '0')}`;
    let s = staffNow.find((x) => x.employee_code === code);
    if (!s) {
      const r = await call('POST', '/api/staff', { employeeCode: code, title, firstName, lastName, position: 'physiotherapist', color, licenseNo: `กภ.${90000 + i}` });
      if (!r.ok) throw new Error(`create staff ${code}: ${r.status} ${JSON.stringify(r.data)}`);
      s = r.data;
      await call('PUT', `/api/staff/${s.id}/specialties`, sps.map((c, k) => ({ specialtyId: spId[c], level: 5 - k })));
      made++;
    }
    await call('POST', `/api/staff/${s.id}/shifts`, { templateCode: shift, from: DATE, to: DATE, weekdays: [1, 2, 3, 4, 5, 6, 7] });
  }
  console.log(`therapists: +${made} new, ${EXTRA_PT} on shift ${DATE}`);

  // ---------- ผู้ป่วยเพิ่ม ----------
  const dx = await get('/api/patients/diagnoses');
  const dxId = Object.fromEntries(dx.map((d) => [d.icd10_code, d.id]));
  const patients = [];
  const existing = await get('/api/patients?q=SIM-').catch(() => []);
  const list = Array.isArray(existing) ? existing : existing.rows || existing.items || [];
  let newPatients = 0;
  for (let i = 0; i < EXTRA_PATIENTS; i++) {
    const hn = `SIM-${String(i + 1).padStart(4, '0')}`;
    const kid = i % 9 === 4;
    let p = list.find((x) => x.hn === hn);
    if (!p) {
      const firstName = kid ? KIDS[i % KIDS.length] : FIRST[i % FIRST.length];
      const year = kid ? 2018 + (i % 5) : 1950 + ((i * 7) % 50);
      const r = await call('POST', '/api/patients', {
        hn, firstName, lastName: LAST[(i * 3) % LAST.length], dateOfBirth: `${year}-0${1 + (i % 9)}-1${i % 9}`,
        gender: i % 2 ? 'female' : 'male',
      });
      if (!r.ok) throw new Error(`create patient ${hn}: ${r.status} ${JSON.stringify(r.data)}`);
      p = r.data;
      const code = kid ? 'G80.9' : ADULT_DX[i % ADULT_DX.length];
      await call('POST', `/api/patients/${p.id}/diagnoses`, { diagnosisId: dxId[code], isPrimary: true });
      newPatients++;
    }
    patients.push(p);
  }
  console.log(`patients: +${newPatients} new (${patients.length} SIM patients)`);

  // ---------- จองนัดตลอดวัน ----------
  const from = `${DATE}T00:00:00+07:00`;
  const to = `${DATE}T23:59:00+07:00`;
  const booked = new Set((await get(`/api/appointments?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`))
    .filter((a) => a.status !== 'cancelled').map((a) => a.patient_id));
  const queue = patients.filter((p) => !booked.has(p.id));
  let ok = 0;
  let failed = 0;
  for (let m = 8 * 60; m <= 18 * 60 && queue.length; m += 15) {
    for (let k = 0; k < PER_SLOT && queue.length; k++) {
      const p = queue.shift();
      const dur = [45, 30, 60, 45][(ok + k) % 4];
      const start = new Date(`${DATE}T${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}:00+07:00`);
      const end = new Date(start.getTime() + dur * 60000);
      const rec = await get(`/api/scheduling/recommendations?patientId=${p.id}&startAt=${encodeURIComponent(start.toISOString())}&durationMin=${dur}`);
      const equipment = rec.equipment
        .filter((e) => e.guideline?.recommendation === 'recommended' && e.recommendedUnit && e.contraindication?.level !== 'absolute')
        .slice(0, 2).map((e) => e.recommendedUnit.id);
      const candidates = rec.therapists.filter((t) => t.available !== false).slice(0, 4);
      let done = false;
      for (const t of candidates) {
        for (const eq of [equipment, []]) {
          const r = await call('POST', '/api/appointments', {
            patientId: p.id, therapistId: t.id, startAt: start.toISOString(), endAt: end.toISOString(),
            equipmentIds: eq, diagnosisId: rec.diagnoses?.[0]?.id, bookedVia: 'recommendation', acknowledgeWarnings: true,
          });
          if (r.ok) { done = true; break; }
        }
        if (done) break;
      }
      if (done) ok++;
      else { failed++; if (m < 17 * 60) queue.push(p); } // ลองใหม่ช่วงถัดไป
    }
  }
  console.log(`appointments: +${ok} booked, ${failed} attempts rejected by conflict rules`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
