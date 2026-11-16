/**
 * โปรแกรมกายภาพที่บ้าน: สั่งโปรแกรม, ลิงก์ผู้ป่วย, บันทึกรายวัน, แจ้งเตือน, ติดตาม
 * รันกับ PostgreSQL จริง (DROP SCHEMA public แล้วสร้างใหม่)
 */
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

process.env.UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-upload-'));
const { pool } = require('../src/db');
const { createApp } = require('../src/app');

const PT_SOMCHAI = '11111111-0000-0000-0000-000000000001';
const PAT = { prasert: '22222222-0000-0000-0000-000000000001', wilai: '22222222-0000-0000-0000-000000000002' };
let server;
let base;
const tokens = {};
let ex = {};

async function api(method, url, { token, body, headers = {} } = {}) {
  const h = { ...headers };
  if (token) h.Authorization = `Bearer ${token}`;
  if (body !== undefined) h['Content-Type'] = 'application/json';
  const res = await fetch(base + url, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
const pub = (linkToken, method = 'GET', body) => api(method, `/api/public/home${method === 'PUT' ? '/log' : ''}`, { body, headers: { 'X-Home-Token': linkToken } });
const bkk = (n = 0) => new Date(Date.now() + 7 * 3600e3 + n * 864e5).toISOString().slice(0, 10);
const dow = (d) => { const x = new Date(`${d}T12:00:00Z`).getUTCDay(); return x === 0 ? 7 : x; };
const one = async (sql, p = []) => (await pool.query(sql, p)).rows[0];
const item = (code, extra = {}) => ({ exerciseId: ex[code].id, sets: 2, reps: 10, perDay: 1, ...extra });

before(async () => {
  const sql = (f) => fs.readFileSync(path.join(__dirname, '..', '..', 'db', f), 'utf8');
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  for (const f of ['001_schema.sql', '002_reference_data.sql', '003_clinical_guidelines.sql', '004_rooms_beds.sql', '005_floor_plan.sql',
    '006_integration.sql', '007_home_program.sql', '008_notifications.sql', '009_camera_telerehab.sql', 'demo/101_demo_data.sql', 'demo/103_demo_rooms_beds.sql']) {
    await pool.query(sql(f));
  }
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  for (const [k, email] of Object.entries({ admin: 'admin@physiocare.local', somchai: 'somchai@physiocare.local', front: 'front@physiocare.local' })) {
    tokens[k] = (await api('POST', '/api/auth/login', { body: { email, password: 'Passw0rd!' } })).body.token;
  }
  const list = await api('GET', '/api/home/exercises', { token: tokens.somchai });
  ex = Object.fromEntries(list.body.map((e) => [e.code, e]));
});

after(async () => {
  server?.close();
  await pool.end();
});

describe('Home exercise program', () => {
  let program;
  let link;

  test('exercise library is seeded; only therapists can add exercises', async () => {
    assert.ok(Object.keys(ex).length >= 20);
    const body = { code: 'HAM_STRETCH', nameTh: 'ยืดต้นขาด้านหลัง', bodyRegion: 'knee', instructions: 'นั่งเหยียดขา โน้มตัวไปด้านหน้า', defaultHoldSec: 30 };
    assert.equal((await api('POST', '/api/home/exercises', { token: tokens.front, body })).status, 403);
    const r = await api('POST', '/api/home/exercises', { token: tokens.somchai, body });
    assert.equal(r.status, 201);
    assert.equal((await api('POST', '/api/home/exercises', { token: tokens.somchai, body: { ...body, videoUrl: 'http://insecure.example/x' } })).status, 400, 'video must be https');
  });

  test('program needs consent, therapist permission and at least one exercise', async () => {
    const body = { patientId: PAT.prasert, startDate: bkk(-2), endDate: bkk(20), items: [item('PELVIC_TILT')] };
    assert.equal((await api('POST', '/api/home/programs', { token: tokens.somchai, body })).status, 400, 'no consent');
    assert.equal((await api('POST', '/api/home/programs', { token: tokens.front, body: { ...body, consent: true } })).status, 403);
    assert.equal((await api('POST', '/api/home/programs', { token: tokens.somchai, body: { ...body, consent: true, items: [] } })).status, 400);
    assert.equal((await api('POST', '/api/home/programs', { token: tokens.somchai, body: { ...body, consent: true, endDate: bkk(400) } })).status, 400, 'max 180 days');
  });

  test('therapist prescribes a program; a new one replaces the active one', async () => {
    const first = await api('POST', '/api/home/programs', {
      token: tokens.somchai, body: { patientId: PAT.prasert, startDate: bkk(-2), endDate: bkk(20), consent: true, items: [item('PELVIC_TILT')] },
    });
    assert.equal(first.status, 201, JSON.stringify(first.body));
    const todayDow = dow(bkk(0));
    const otherDays = [1, 2, 3, 4, 5, 6, 7].filter((d) => d !== todayDow);
    const r = await api('POST', '/api/home/programs', {
      token: tokens.somchai,
      body: {
        patientId: PAT.prasert, startDate: bkk(-2), endDate: bkk(20), consent: true, consentNote: 'ยินยอมด้วยวาจา', baselinePain: 4, notes: 'ทำเช้า-เย็น',
        items: [item('PELVIC_TILT'), item('BRIDGE'), item('KNEE_CHEST', { reps: 5, holdSec: 20 }), item('CAT_CAMEL', { daysOfWeek: otherDays })],
      },
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    program = r.body;
    assert.equal(program.therapist_id, PT_SOMCHAI, 'therapist taken from the logged-in user');
    assert.equal(program.items.length, 4);
    assert.equal((await one('SELECT status FROM home_programs WHERE id = $1', [first.body.id])).status, 'ended');
    assert.equal((await one("SELECT count(*)::int n FROM home_programs WHERE patient_id = $1 AND status = 'active'", [PAT.prasert])).n, 1);
  });

  test('patient link: token shown once, stored hashed, no clinical identifiers exposed', async () => {
    const r = await api('POST', `/api/home/programs/${program.id}/links`, { token: tokens.somchai, body: { label: 'ผู้ป่วย' } });
    assert.equal(r.status, 201);
    link = r.body;
    assert.ok(link.token.length >= 40);
    const row = await one('SELECT token_hash FROM home_access_links WHERE id = $1', [link.id]);
    assert.notEqual(row.token_hash, link.token);
    const v = await pub(link.token);
    assert.equal(v.status, 200);
    assert.equal(v.body.patientFirstName, 'ประเสริฐ');
    const text = JSON.stringify(v.body);
    const p = await one('SELECT hn, last_name FROM patients WHERE id = $1', [PAT.prasert]);
    assert.ok(!text.includes(p.hn), 'no HN');
    assert.ok(!text.includes(p.last_name), 'no last name');
    assert.ok(!/icd|M54|diagnos/i.test(text), 'no diagnosis');
    assert.deepEqual(v.body.canLogDates, [bkk(0), bkk(-1)]);
    // ท่าที่ไม่ได้กำหนดให้ทำวันนี้ยังแสดง แต่ไม่ถูกนับ
    assert.equal(v.body.items.length, 4);
  });

  test('wrong, missing and expired tokens are refused', async () => {
    assert.equal((await pub('A'.repeat(43))).status, 401);
    assert.equal((await pub('')).status, 401);
    const tmp = await api('POST', `/api/home/programs/${program.id}/links`, { token: tokens.somchai, body: { label: 'ญาติ' } });
    await pool.query("UPDATE home_access_links SET expires_at = now() - interval '1 minute' WHERE id = $1", [tmp.body.id]);
    assert.equal((await pub(tmp.body.token)).status, 401);
  });

  test('daily log counts only scheduled exercises; dates limited to today/yesterday', async () => {
    const v = (await pub(link.token)).body;
    const todays = v.items.filter((i) => i.daysOfWeek.includes(dow(bkk(0))));
    assert.equal(todays.length, 3, 'CAT_CAMEL is off today');
    const r = await pub(link.token, 'PUT', {
      items: [...todays.map((i, k) => ({ itemId: i.id, done: k < 2 })), { itemId: '00000000-0000-0000-0000-000000000000', done: true }],
      pain: 4, difficulty: 'ok',
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.advice, 'ok');
    const today = r.body.week.find((d) => d.date === bkk(0));
    assert.deepEqual([today.scheduled, today.done], [3, 2]);
    assert.equal((await pub(link.token, 'PUT', { date: bkk(-3), items: [], pain: 3 })).status, 400);
    assert.equal((await pub(link.token, 'PUT', { items: [], symptoms: ['made_up'] })).status, 400);
  });

  test('red-flag symptoms and pain increase alert the therapist and tell the patient to stop', async () => {
    const r = await pub(link.token, 'PUT', { date: bkk(-1), items: [], pain: 8, difficulty: 'hard', symptoms: ['numbness'] });
    assert.equal(r.body.advice, 'stop');
    assert.deepEqual(r.body.alerts.sort(), ['pain_increase', 'red_flag']);
    // แก้บันทึกภายหลังโดยไม่มีอาการ: การแจ้งเตือนเดิมยังอยู่
    const again = await pub(link.token, 'PUT', { date: bkk(-1), items: [], pain: 2 });
    assert.equal(again.body.advice, 'ok');
    const open = await pool.query('SELECT kind FROM home_alerts WHERE program_id = $1 AND acknowledged_at IS NULL', [program.id]);
    assert.deepEqual(open.rows.map((x) => x.kind).sort(), ['pain_increase', 'red_flag']);
  });

  test('monitor, summary and acknowledging alerts', async () => {
    const m = await api('GET', '/api/home/monitor', { token: tokens.somchai });
    assert.equal(m.status, 200);
    const row = m.body.find((x) => x.id === program.id);
    assert.equal(row.openAlerts.length, 2);
    assert.equal(row.lastLogDate, bkk(0));
    assert.ok(row.adherence7 > 0 && row.adherence7 < 100);
    assert.equal((await api('GET', '/api/home/monitor', { token: tokens.front })).status, 403, 'front desk has no EMR access');

    const s = await api('GET', `/api/home/patients/${PAT.prasert}/summary`, { token: tokens.somchai });
    assert.equal(s.body.programId, program.id);
    assert.equal(s.body.openAlerts.length, 2);
    assert.ok(Array.isArray(s.body.mostSkipped));

    const d = await api('GET', `/api/home/programs/${program.id}`, { token: tokens.somchai });
    for (const a of d.body.alerts) {
      assert.equal((await api('POST', `/api/home/alerts/${a.id}/ack`, { token: tokens.somchai, body: { note: 'โทรติดตามแล้ว' } })).status, 200);
    }
    assert.equal((await api('GET', `/api/home/patients/${PAT.prasert}/summary`, { token: tokens.somchai })).body.openAlerts.length, 0);
  });

  test('editing keeps history: removed exercises are deactivated, logs remain', async () => {
    const d = (await api('GET', `/api/home/programs/${program.id}`, { token: tokens.somchai })).body;
    const keep = d.items.filter((i) => i.code !== 'BRIDGE').map((i) => ({
      id: i.id, exerciseId: i.exercise_id, sets: i.sets, reps: i.reps, holdSec: i.hold_sec, perDay: i.per_day, daysOfWeek: i.days_of_week,
    }));
    const r = await api('PATCH', `/api/home/programs/${program.id}`, { token: tokens.somchai, body: { items: [...keep, item('SLR')], endDate: bkk(30) } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.items.filter((i) => i.is_active).length, 4);
    assert.equal(r.body.items.find((i) => i.code === 'BRIDGE').is_active, false);
    assert.ok((await one('SELECT count(*)::int n FROM home_log_items li JOIN home_program_items i ON i.id = li.item_id WHERE i.program_id = $1', [program.id])).n > 0);
    const v = (await pub(link.token)).body;
    assert.equal(v.items.some((i) => i.name === 'ยกสะโพก'), false, 'patient no longer sees removed exercise');
    assert.equal(v.endDate, bkk(30));
  });

  test('revoking a link or ending the program stops access', async () => {
    const extra = await api('POST', `/api/home/programs/${program.id}/links`, { token: tokens.somchai, body: { label: 'ญาติ' } });
    await api('POST', `/api/home/links/${extra.body.id}/revoke`, { token: tokens.somchai });
    assert.equal((await pub(extra.body.token)).status, 401);
    assert.equal((await pub(link.token)).status, 200, 'other links unaffected');
    assert.equal((await api('POST', `/api/home/programs/${program.id}/end`, { token: tokens.somchai })).status, 200);
    assert.equal((await pub(link.token)).status, 401);
    assert.equal((await api('PATCH', `/api/home/programs/${program.id}`, { token: tokens.somchai, body: { notes: 'x' } })).status, 409);
  });
});
