/**
 * สิทธิ์ตามผู้ป่วยที่ดูแล: ทีมผู้ดูแล, นัดด้วยกัน, เปิดดูฉุกเฉิน, หัวหน้านักกายภาพ, Super user
 */
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

process.env.UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-upload-'));
const { pool } = require('../src/db');
const { createApp } = require('../src/app');

const STAFF = { somchai: '11111111-0000-0000-0000-000000000001', supaporn: '11111111-0000-0000-0000-000000000002', front: '11111111-0000-0000-0000-000000000005' };
let server;
let base;
const tokens = {};

async function api(method, url, { token, body } = {}) {
  const h = {};
  if (token) h.Authorization = `Bearer ${token}`;
  if (body !== undefined) h['Content-Type'] = 'application/json';
  const res = await fetch(base + url, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, body: json };
}
const one = async (sql, p = []) => (await pool.query(sql, p)).rows[0];
const today = () => new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10);
const plus = (n) => new Date(Date.now() + 7 * 3600e3 + n * 864e5).toISOString().slice(0, 10);
const login = async (email) => (await api('POST', '/api/auth/login', { body: { email, password: 'Passw0rd!' } })).body.token;

before(async () => {
  const sql = (f) => fs.readFileSync(path.join(__dirname, '..', '..', 'db', f), 'utf8');
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  for (const f of ['001_schema.sql', '002_reference_data.sql', '003_clinical_guidelines.sql', '004_rooms_beds.sql', '005_floor_plan.sql',
    '006_integration.sql', '007_home_program.sql', '008_notifications.sql', '009_camera_telerehab.sql', '010_care_team_access.sql',
    'demo/101_demo_data.sql', 'demo/103_demo_rooms_beds.sql', 'demo/106_demo_care_team.sql']) {
    await pool.query(sql(f));
  }
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  for (const k of ['admin', 'somchai', 'supaporn', 'front', 'head', 'super']) tokens[k] = await login(`${k}@physiocare.local`);
});

after(async () => {
  server?.close();
  await pool.end();
});

describe('Care-team based access to clinical data', () => {
  let pid;

  test('a therapist cannot open clinical data of a patient they do not care for', async () => {
    const r = await api('POST', '/api/patients', { token: tokens.front, body: { hn: 'HN-ACC-1', firstName: 'ทดสอบ', lastName: 'สิทธิ์', phone: '080-000-0001' } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    pid = r.body.id;
    const p = await api('GET', `/api/emr/patients/${pid}/progress`, { token: tokens.somchai });
    assert.equal(p.status, 403);
    assert.equal(p.body.error.code, 'NO_CARE_RELATION');
    assert.equal(p.body.error.details.canBreakGlass, true);
    assert.equal(p.body.error.details.hn, 'HN-ACC-1');
    assert.equal((await api('GET', `/api/home/patients/${pid}/summary`, { token: tokens.somchai })).status, 403);
    const prog = await api('POST', '/api/home/programs', {
      token: tokens.somchai,
      body: { patientId: pid, startDate: today(), endDate: plus(20), consent: true, items: [{ exerciseId: 1, sets: 1, reps: 5, daysOfWeek: [1, 2, 3, 4, 5, 6, 7] }] },
    });
    assert.equal(prog.status, 403);
    assert.equal((await api('POST', '/api/tele/sessions', { token: tokens.somchai, body: { patientId: pid, scheduledAt: new Date(Date.now() + 3600e3).toISOString() } })).status, 403);
    // ข้อมูลทั่วไป (สำหรับจองนัด) ยังเห็นได้
    assert.equal((await api('GET', `/api/patients/${pid}`, { token: tokens.somchai })).status, 200);
  });

  test('patient list: "mine" and "unassigned" scopes, with the primary therapist shown', async () => {
    const mine = await api('GET', '/api/patients?scope=mine', { token: tokens.somchai });
    assert.ok(!mine.body.some((p) => p.id === pid));
    assert.ok(mine.body.length > 0 && mine.body.every((p) => p.in_care === true));
    const un = await api('GET', '/api/patients?scope=unassigned', { token: tokens.front });
    assert.ok(un.body.some((p) => p.id === pid));
    const all = await api('GET', '/api/patients?q=HN-ACC-1', { token: tokens.somchai });
    assert.equal(all.body[0].in_care, false);
    assert.equal(all.body[0].primary_therapist, null);
  });

  test('front desk / head assigns the care team; therapists cannot assign', async () => {
    assert.equal((await api('PUT', `/api/access/patients/${pid}/care-team`, { token: tokens.somchai, body: { primaryStaffId: STAFF.somchai } })).status, 403);
    assert.equal((await api('PUT', `/api/access/patients/${pid}/care-team`, { token: tokens.front, body: { primaryStaffId: STAFF.front } })).status, 400, 'only physiotherapists');
    const r = await api('PUT', `/api/access/patients/${pid}/care-team`, { token: tokens.front, body: { primaryStaffId: STAFF.somchai, staffIds: [STAFF.supaporn] } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.map((x) => [x.staff_id, x.is_primary]), [[STAFF.somchai, true], [STAFF.supaporn, false]]);
    assert.equal((await api('GET', `/api/emr/patients/${pid}/progress`, { token: tokens.somchai })).status, 200);
    assert.equal((await api('GET', `/api/access/patients/${pid}/relation`, { token: tokens.supaporn })).body.via, 'care_team');
    const list = await api('GET', '/api/patients?q=HN-ACC-1', { token: tokens.somchai });
    assert.equal(list.body[0].in_care, true);
    assert.match(list.body[0].primary_therapist, /สมชาย/);
    const wl = await api('GET', '/api/access/workload', { token: tokens.head });
    assert.ok(wl.body.find((x) => x.id === STAFF.somchai).primary_count >= 1);

    // เปลี่ยนผู้ดูแล: สมชายออกจากทีม → เข้าไม่ได้อีก (ประวัติการมอบหมายยังอยู่)
    await api('PUT', `/api/access/patients/${pid}/care-team`, { token: tokens.head, body: { primaryStaffId: STAFF.supaporn, staffIds: [] } });
    assert.equal((await api('GET', `/api/emr/patients/${pid}/progress`, { token: tokens.somchai })).status, 403);
    const hist = await one('SELECT count(*)::int AS n FROM patient_care_team WHERE patient_id = $1 AND ended_at IS NOT NULL', [pid]);
    assert.equal(hist.n, 1);
  });

  test('a therapist who has an appointment with the patient can open their record', async () => {
    const row = await one(
      `SELECT a.patient_id FROM appointments a
        WHERE a.therapist_id = $1 AND a.status <> 'cancelled' AND a.start_at >= now() - interval '180 days'
          AND NOT EXISTS (SELECT 1 FROM patient_care_team ct WHERE ct.patient_id = a.patient_id AND ct.staff_id = $1 AND ct.ended_at IS NULL)
        LIMIT 1`, [STAFF.supaporn]);
    if (!row) return; // ข้อมูลทดลองไม่มีกรณีนี้
    assert.equal((await api('GET', `/api/access/patients/${row.patient_id}/relation`, { token: tokens.supaporn })).body.via, 'appointment');
    assert.equal((await api('GET', `/api/emr/patients/${row.patient_id}/progress`, { token: tokens.supaporn })).status, 200);
  });

  test('break-glass: reason required, grants temporary access, audited and listed for the head therapist', async () => {
    assert.equal((await api('POST', `/api/access/patients/${pid}/break-glass`, { token: tokens.somchai, body: { reason: 'ด่วน' } })).status, 400);
    const g = await api('POST', `/api/access/patients/${pid}/break-glass`, { token: tokens.somchai, body: { reason: 'ผู้ป่วยมาก่อนเวลานัด กภ.สุภาพรลาป่วย รักษาแทน' } });
    assert.equal(g.status, 201);
    assert.ok(new Date(g.body.expires_at) > new Date(Date.now() + 7 * 3600e3));
    assert.equal((await api('GET', `/api/emr/patients/${pid}/progress`, { token: tokens.somchai })).status, 200);
    const logs = (await pool.query("SELECT action, detail FROM audit_logs WHERE entity_id = $1 AND action LIKE 'clinical.%' ORDER BY id", [pid])).rows;
    assert.deepEqual(logs.map((l) => l.action), ['clinical.break_glass', 'clinical.view']);
    assert.equal(logs[1].detail.via, 'break_glass');
    // หัวหน้าเห็นรายการและกดรับทราบ · นักกายภาพทั่วไปดูรายการไม่ได้
    assert.equal((await api('GET', '/api/access/break-glass', { token: tokens.somchai })).status, 403);
    const list = await api('GET', '/api/access/break-glass', { token: tokens.head });
    const item = list.body.find((x) => x.patient_id === pid);
    assert.match(item.reason, /รักษาแทน/);
    assert.equal(item.reviewed_at, null);
    assert.equal((await api('POST', `/api/access/break-glass/${item.id}/review`, { token: tokens.head })).status, 200);
    // หมดอายุ → เข้าไม่ได้อีก
    await pool.query("UPDATE clinical_access_grants SET expires_at = now() - interval '1 minute' WHERE patient_id = $1", [pid]);
    assert.equal((await api('GET', `/api/emr/patients/${pid}/progress`, { token: tokens.somchai })).status, 403);
  });

  test('head therapist sees every patient; admin still has no clinical access', async () => {
    assert.equal((await api('GET', `/api/access/patients/${pid}/relation`, { token: tokens.head })).body.via, 'all');
    assert.equal((await api('GET', `/api/emr/patients/${pid}/progress`, { token: tokens.head })).status, 200);
    const a = await api('GET', `/api/emr/patients/${pid}/progress`, { token: tokens.admin });
    assert.equal(a.status, 403);
    assert.equal(a.body.error.code, 'FORBIDDEN');
  });

  test('super user sees everything and every clinical view is audited', async () => {
    const me = await api('GET', '/api/auth/me', { token: tokens.super });
    for (const p of ['emr:read_all', 'users:manage', 'settings:manage', 'care_team:assign']) assert.ok(me.body.permissions.includes(p), p);
    assert.equal((await api('GET', `/api/emr/patients/${pid}/progress`, { token: tokens.super })).status, 200);
    const l = await one("SELECT detail FROM audit_logs WHERE entity_id = $1 AND action = 'clinical.view' ORDER BY id DESC LIMIT 1", [pid]);
    assert.equal(l.detail.via, 'all');
  });

  test('a therapist who registers a patient becomes the primary therapist', async () => {
    const r = await api('POST', '/api/patients', { token: tokens.somchai, body: { hn: 'HN-ACC-2', firstName: 'ลงทะเบียน', lastName: 'เอง', phone: '080-000-0002' } });
    assert.equal(r.status, 201);
    const team = await api('GET', `/api/access/patients/${r.body.id}/care-team`, { token: tokens.front });
    assert.equal(team.body[0].staff_id, STAFF.somchai);
    assert.equal(team.body[0].is_primary, true);
  });
});

describe('Super user account protection', () => {
  test('admin cannot create another super user, touch a super user account, or change their own role', async () => {
    const r = await api('POST', '/api/users', { token: tokens.admin, body: { email: 'x@physiocare.local', password: 'Passw0rd!', displayName: 'X', role: 'superuser' } });
    assert.equal(r.status, 403);
    const su = await one("SELECT id FROM users WHERE email = 'super@physiocare.local'");
    assert.equal((await api('PATCH', `/api/users/${su.id}`, { token: tokens.admin, body: { password: 'NewPassw0rd!' } })).status, 403);
    const ad = await one("SELECT id FROM users WHERE email = 'admin@physiocare.local'");
    assert.equal((await api('PATCH', `/api/users/${ad.id}`, { token: tokens.admin, body: { role: 'superuser' } })).status, 400);
    // super user สร้าง super user เพิ่มได้
    const ok = await api('POST', '/api/users', { token: tokens.super, body: { email: 'support2@physiocare.local', password: 'Passw0rd!', displayName: 'Support 2', role: 'superuser' } });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
  });

  test('the first super user can be created by an admin when none exists', async () => {
    await pool.query("UPDATE users SET is_active = false WHERE role_id = (SELECT id FROM roles WHERE code = 'superuser')");
    const r = await api('POST', '/api/users', { token: tokens.admin, body: { email: 'first-su@physiocare.local', password: 'Passw0rd!', displayName: 'First SU', role: 'superuser' } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const h = await api('POST', '/api/users', { token: tokens.admin, body: { email: 'head2@physiocare.local', password: 'Passw0rd!', displayName: 'Head 2', role: 'head_therapist', staffId: '11111111-0000-0000-0000-000000000003' } });
    assert.equal(h.status, 201, JSON.stringify(h.body));
  });
});
