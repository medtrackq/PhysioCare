/**
 * ระยะที่ 2: แจ้งเตือนทาง LINE (กับ LINE API จำลอง), แบบประเมินรายสัปดาห์, แนะนำปรับระดับท่า
 */
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const crypto = require('node:crypto');

process.env.UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-upload-'));
process.env.LINE_CHANNEL_SECRET = 'test-channel-secret';
process.env.LINE_CHANNEL_ACCESS_TOKEN = 'test-access-token';
process.env.APP_BASE_URL = 'https://physio.example.test';
const lineLog = [];
let lineStatus = 200;
const lineMock = http.createServer((req, res) => {
  let data = '';
  req.on('data', (c) => { data += c; });
  req.on('end', () => {
    lineLog.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: data ? JSON.parse(data) : null });
    if (req.url.startsWith('/v2/bot/profile/')) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ displayName: 'Prasert LINE' })); return; }
    res.statusCode = req.url === '/v2/bot/message/push' ? lineStatus : 200;
    res.setHeader('Content-Type', 'application/json');
    res.end('{}');
  });
});

const { pool } = require('../src/db');
const { createApp } = require('../src/app');
const notify = require('../src/services/notify.service');
const home = require('../src/services/home.service');

const PT_SOMCHAI = '11111111-0000-0000-0000-000000000001';
const PAT = { prasert: '22222222-0000-0000-0000-000000000001', wilai: '22222222-0000-0000-0000-000000000002' };
let server;
let base;
const tokens = {};

async function api(method, url, { token, body, headers = {}, raw } = {}) {
  const h = { ...headers };
  if (token) h.Authorization = `Bearer ${token}`;
  if (body !== undefined) h['Content-Type'] = 'application/json';
  const res = await fetch(base + url, { method, headers: h, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, body: json };
}
const sign = (raw) => crypto.createHmac('sha256', process.env.LINE_CHANNEL_SECRET).update(raw).digest('base64');
async function webhook(events, { badSig = false } = {}) {
  const raw = JSON.stringify({ destination: 'U0', events });
  return api('POST', '/api/line/webhook', { raw, headers: { 'Content-Type': 'application/json', 'X-Line-Signature': badSig ? 'AAAA' : sign(raw) } });
}
const textEvent = (userId, text) => ({ type: 'message', replyToken: `r-${Math.random()}`, source: { type: 'user', userId }, message: { type: 'text', id: '1', text } });
const lastReply = () => lineLog.filter((x) => x.url === '/v2/bot/message/reply').at(-1)?.body.messages[0].text;
const setSetting = (k, v) => pool.query('UPDATE system_settings SET value = $2 WHERE key = $1', [k, JSON.stringify(v)]);
const one = async (sql, p = []) => (await pool.query(sql, p)).rows[0];
const bkk = (n = 0) => new Date(Date.now() + 7 * 3600e3 + n * 864e5).toISOString().slice(0, 10);
function nextWorkday(n) {
  const d = new Date(Date.now() + 7 * 3600_000);
  d.setUTCDate(d.getUTCDate() + n);
  while (d.getUTCDay() === 0) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

before(async () => {
  await new Promise((r) => lineMock.listen(0, r));
  process.env.LINE_API_BASE = `http://127.0.0.1:${lineMock.address().port}`;
  const sql = (f) => fs.readFileSync(path.join(__dirname, '..', '..', 'db', f), 'utf8');
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  for (const f of ['001_schema.sql', '002_reference_data.sql', '003_clinical_guidelines.sql', '004_rooms_beds.sql', '005_floor_plan.sql',
    '006_integration.sql', '007_home_program.sql', '008_notifications.sql', '009_camera_telerehab.sql', 'demo/101_demo_data.sql', 'demo/103_demo_rooms_beds.sql']) {
    await pool.query(sql(f));
  }
  await setSetting('notify.line_basic_id', '@123abcde');
  await setSetting('notify.quiet_hours', { start: '00:00', end: '00:00' }); // ไม่มีช่วงห้ามส่งระหว่างทดสอบ
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  for (const [k, email] of Object.entries({ admin: 'admin@physiocare.local', somchai: 'somchai@physiocare.local', front: 'front@physiocare.local' })) {
    tokens[k] = (await api('POST', '/api/auth/login', { body: { email, password: 'Passw0rd!' } })).body.token;
  }
});

after(async () => {
  server?.close();
  lineMock.close();
  await pool.end();
});

describe('LINE notifications', () => {
  test('webhook checks the LINE signature', async () => {
    assert.equal((await webhook([], { badSig: true })).status, 401);
    assert.equal((await webhook([])).status, 200, 'verification request from LINE console');
  });

  test('front desk links a patient: QR deep link → patient sends code → linked', async () => {
    const r = await api('POST', `/api/notify/patients/${PAT.prasert}/link-code`, { token: tokens.front });
    assert.equal(r.status, 201);
    assert.match(r.body.code, /^[A-HJ-NP-Z2-9]{6}$/);
    assert.equal(r.body.url, `https://line.me/R/oaMessage/%40123abcde/?${encodeURIComponent(`เชื่อมต่อ ${r.body.code}`)}`);
    await webhook([textEvent('U_prasert', `เชื่อมต่อ ${r.body.code}`)]);
    assert.match(lastReply(), /เชื่อมต่อเรียบร้อย คุณประเสริฐ/);
    const c = await api('GET', `/api/notify/patients/${PAT.prasert}`, { token: tokens.front });
    assert.equal(c.body.state, 'active');
    assert.equal(c.body.lineName, 'Prasert LINE');
    // ใช้รหัสซ้ำไม่ได้
    await webhook([textEvent('U_other', r.body.code)]);
    assert.match(lastReply(), /รหัสไม่ถูกต้องหรือหมดอายุ/);
    assert.equal((await one("SELECT count(*)::int n FROM patient_contacts WHERE line_user_id = 'U_other'")).n, 0);
  });

  test('patient can stop and restart messages; unfollow blocks', async () => {
    await webhook([textEvent('U_prasert', 'หยุด')]);
    assert.equal((await api('GET', `/api/notify/patients/${PAT.prasert}`, { token: tokens.front })).body.state, 'opted_out');
    await webhook([textEvent('U_prasert', 'เริ่ม')]);
    assert.equal((await api('GET', `/api/notify/patients/${PAT.prasert}`, { token: tokens.front })).body.state, 'active');
    await webhook([{ type: 'unfollow', source: { type: 'user', userId: 'U_prasert' } }]);
    assert.equal((await api('GET', `/api/notify/patients/${PAT.prasert}`, { token: tokens.front })).body.state, 'blocked');
    await webhook([{ type: 'follow', replyToken: 'r1', source: { type: 'user', userId: 'U_prasert' } }]);
    assert.equal((await api('GET', `/api/notify/patients/${PAT.prasert}`, { token: tokens.front })).body.state, 'active');
  });

  test('nothing is queued while notifications are disabled', async () => {
    const r = await notify.scheduleDue(new Date());
    assert.deepEqual(r, { appointments: 0, home: 0, tele: 0 });
  });

  test('appointment reminder: queued once, re-queued after reschedule, message has no clinical details', async () => {
    await setSetting('notify.enabled', true);
    const day = nextWorkday(3);
    const booked = await api('POST', '/api/appointments', {
      token: tokens.front,
      body: { patientId: PAT.prasert, therapistId: PT_SOMCHAI, startAt: `${day}T10:00:00+07:00`, endAt: `${day}T10:45:00+07:00`, acknowledgeWarnings: true },
    });
    assert.equal(booked.status, 201, JSON.stringify(booked.body));
    const start = new Date(`${day}T10:00:00+07:00`);
    const at = new Date(start.getTime() - 20 * 3600e3);
    assert.equal((await notify.scheduleDue(at)).appointments, 1);
    assert.equal((await notify.scheduleDue(at)).appointments, 0, 'deduplicated');

    // เลื่อนนัด → คิวเดิมถูกข้าม คิวใหม่ส่งจริง
    const appt = (await api('GET', `/api/appointments/${booked.body.appointment.id}`, { token: tokens.front })).body;
    const moved = await api('PATCH', `/api/appointments/${appt.id}/reschedule`, {
      token: tokens.front, body: { startAt: `${day}T11:00:00+07:00`, endAt: `${day}T11:45:00+07:00`, version: appt.version, acknowledgeWarnings: true },
    });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    assert.equal((await notify.scheduleDue(new Date(start.getTime() - 19 * 3600e3))).appointments, 1);
    await pool.query("UPDATE notification_queue SET scheduled_for = now() WHERE kind = 'appointment_reminder'");
    const d = await notify.deliverDue();
    assert.deepEqual([d.sent, d.skipped], [1, 1]);
    const push = lineLog.filter((x) => x.url === '/v2/bot/message/push').at(-1);
    assert.equal(push.auth, 'Bearer test-access-token');
    assert.equal(push.body.to, 'U_prasert');
    const text = push.body.messages[0].text;
    assert.match(text, /เตือนนัดกายภาพบำบัด/);
    assert.match(text, /11:00/);
    const p = await one('SELECT hn FROM patients WHERE id = $1', [PAT.prasert]);
    assert.ok(!text.includes(p.hn) && !/M54|ปวดหลัง|ICD/.test(text), 'no HN or diagnosis in LINE message');
  });

  test('quiet hours move a reminder earlier, never later', () => {
    const quiet = { start: '21:00', end: '07:00' };
    const sixAm = new Date('2026-12-01T06:00:00+07:00');
    const moved = notify.earlierOutOfQuiet(sixAm, quiet);
    assert.equal(moved.toISOString(), new Date('2026-11-30T20:30:00+07:00').toISOString());
    const noon = new Date('2026-12-01T12:00:00+07:00');
    assert.equal(notify.earlierOutOfQuiet(noon, quiet).getTime(), noon.getTime());
  });

  test('home reminder only when today is not logged, with a working link that is reused', async () => {
    const ex = Object.fromEntries((await api('GET', '/api/home/exercises', { token: tokens.somchai })).body.map((e) => [e.code, e.id]));
    const prog = await api('POST', '/api/home/programs', {
      token: tokens.somchai,
      body: {
        patientId: PAT.prasert, startDate: bkk(-6), endDate: bkk(20), consent: true, baselinePain: 4, reminderTime: '00:00',
        psfsActivities: ['เดินขึ้นบันได 1 ชั้น', 'นั่งทำงาน 1 ชั่วโมง'],
        items: [{ exerciseId: ex.PELVIC_TILT, sets: 2, reps: 10 }, { exerciseId: ex.BRIDGE, sets: 3, reps: 10 }],
      },
    });
    assert.equal(prog.status, 201, JSON.stringify(prog.body));
    assert.equal(prog.body.reminder_time, '00:00');
    assert.equal((await notify.scheduleDue(new Date())).home, 1);
    assert.equal((await notify.scheduleDue(new Date())).home, 0);
    const d = await notify.deliverDue();
    assert.equal(d.sent, 1);
    const text = lineLog.filter((x) => x.url === '/v2/bot/message/push').at(-1).body.messages[0].text;
    assert.match(text, /อย่าลืมทำกายภาพวันนี้ 2 ท่า/);
    const url = text.match(/https:\/\/physio\.example\.test\/home#t=(\S+)/);
    assert.ok(url, text);
    const pv = await api('GET', '/api/public/home', { headers: { 'X-Home-Token': url[1] } });
    assert.equal(pv.status, 200, 'link in LINE message opens the program');
    // ลิงก์เดิมถูกใช้ซ้ำ (ไม่สร้างลิงก์ใหม่ทุกวัน)
    await pool.query("DELETE FROM notification_queue WHERE kind = 'home_reminder'");
    await notify.scheduleDue(new Date());
    await notify.deliverDue();
    const text2 = lineLog.filter((x) => x.url === '/v2/bot/message/push').at(-1).body.messages[0].text;
    assert.equal(text2.match(/#t=(\S+)/)[1], url[1]);
    assert.equal((await one("SELECT count(*)::int n FROM home_access_links WHERE label = 'LINE'")).n, 1);
    // บันทึกแล้วก่อนถึงเวลาส่ง → ข้าม
    await pool.query("DELETE FROM notification_queue WHERE kind = 'home_reminder'");
    await notify.scheduleDue(new Date());
    const v = pv.body;
    await api('PUT', '/api/public/home/log', { headers: { 'X-Home-Token': url[1] }, body: { items: v.items.map((i) => ({ itemId: i.id, done: true })), pain: 3 } });
    assert.equal((await notify.deliverDue()).skipped, 1);
    assert.equal((await notify.scheduleDue(new Date())).home, 0, 'logged today → no new reminder');
  });

  test('failed sends retry with backoff; permanent errors stop', async () => {
    await api('POST', `/api/notify/patients/${PAT.prasert}/test`, { token: tokens.front }); // ส่งสำเร็จ (lineStatus 200)
    lineStatus = 500;
    await pool.query("INSERT INTO notification_queue (patient_id, kind, dedupe_key) VALUES ($1, 'test', 't-500')", [PAT.prasert]);
    await notify.deliverDue();
    let row = await one("SELECT status, attempts FROM notification_queue WHERE dedupe_key = 't-500'");
    assert.deepEqual([row.status, row.attempts], ['failed', 1]);
    lineStatus = 400;
    await pool.query("UPDATE notification_queue SET scheduled_for = now() WHERE dedupe_key = 't-500'");
    await notify.deliverDue();
    row = await one("SELECT status FROM notification_queue WHERE dedupe_key = 't-500'");
    assert.equal(row.status, 'dead');
    lineStatus = 200;
    const q = await api('GET', '/api/notify/queue?status=dead', { token: tokens.admin });
    assert.equal(q.status, 200);
    assert.equal(q.body.length, 1);
    assert.equal((await api('GET', '/api/notify/queue', { token: tokens.front })).status, 403);
  });

  test('opted-out patients get nothing', async () => {
    await webhook([textEvent('U_prasert', 'STOP')]);
    await pool.query("INSERT INTO notification_queue (patient_id, kind, dedupe_key) VALUES ($1, 'test', 't-stop')", [PAT.prasert]);
    const before = lineLog.filter((x) => x.url === '/v2/bot/message/push').length;
    const d = await notify.deliverDue();
    assert.equal(d.skipped, 1);
    assert.equal(lineLog.filter((x) => x.url === '/v2/bot/message/push').length, before);
    await webhook([textEvent('U_prasert', 'start')]);
  });

  test('patient can request a LINE code from the home page', async () => {
    const link = await one("SELECT hp.id FROM home_programs hp WHERE hp.patient_id = $1 AND status = 'active'", [PAT.prasert]);
    const created = await home.createLink(link.id, { label: 'ผู้ป่วย' }, null);
    const r = await api('POST', '/api/public/home/line-code', { headers: { 'X-Home-Token': created.token } });
    assert.equal(r.status, 200);
    assert.match(r.body.url, /^https:\/\/line\.me\/R\/oaMessage\//);
    const v = await api('GET', '/api/public/home', { headers: { 'X-Home-Token': created.token } });
    assert.deepEqual(v.body.line, { enabled: true, linked: true });
  });
});

describe('Weekly check-in and progression suggestions', () => {
  let program;
  let token;

  before(async () => {
    program = await one("SELECT * FROM home_programs WHERE patient_id = $1 AND status = 'active'", [PAT.prasert]);
    token = (await home.createLink(program.id, { label: 'ผู้ป่วย' }, null)).token;
  });

  test('PSFS + GROC check-in is due weekly and only accepts the prescribed activities', async () => {
    let v = (await api('GET', '/api/public/home', { headers: { 'X-Home-Token': token } })).body;
    assert.equal(v.checkin.due, true);
    assert.deepEqual(v.checkin.activities, ['เดินขึ้นบันได 1 ชั้น', 'นั่งทำงาน 1 ชั่วโมง']);
    const r = await api('PUT', '/api/public/home/checkin', {
      headers: { 'X-Home-Token': token },
      body: { psfs: [{ activity: 'เดินขึ้นบันได 1 ชั้น', score: 4 }, { activity: 'กิจกรรมแปลกปลอม', score: 9 }], groc: 1 },
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.checkins[0].psfs.length, 1);
    v = (await api('GET', '/api/public/home', { headers: { 'X-Home-Token': token } })).body;
    assert.equal(v.checkin.due, false);
    const s = await api('GET', `/api/home/patients/${PAT.prasert}/summary`, { token: tokens.somchai });
    assert.equal(s.body.checkinFirst.psfsAvg, 4);
    assert.equal((await api('PUT', '/api/public/home/checkin', { headers: { 'X-Home-Token': token }, body: { psfs: [] } })).status, 400);
  });

  test('suggests progressing an exercise that is done consistently and feels easy', async () => {
    const items = (await pool.query('SELECT id, reps FROM home_program_items WHERE program_id = $1 AND is_active ORDER BY sort_order', [program.id])).rows;
    await pool.query("UPDATE home_program_items SET dose_changed_at = now() - interval '30 days' WHERE program_id = $1", [program.id]);
    await pool.query('DELETE FROM home_logs WHERE program_id = $1', [program.id]);
    for (let i = 0; i < 7; i++) {
      const { rows: [l] } = await pool.query(
        "INSERT INTO home_logs (program_id, log_date, pain, difficulty) VALUES ($1, $2, 3, $3) RETURNING id", [program.id, bkk(-i), i < 6 ? 'easy' : 'ok']);
      await pool.query('INSERT INTO home_log_items (log_id, item_id, done) VALUES ($1,$2,true),($1,$3,$4)', [l.id, items[0].id, items[1].id, i < 2]);
    }
    const r = await api('GET', `/api/home/programs/${program.id}/suggestions`, { token: tokens.somchai });
    assert.equal(r.status, 200);
    const first = r.body.items.find((x) => x.itemId === items[0].id);
    assert.equal(first.type, 'progress');
    assert.equal(first.proposed.reps, 12, '10 → 12 (+20%, at least +2)');
    const second = r.body.items.find((x) => x.itemId === items[1].id);
    assert.equal(second.type, 'review', 'done only 2 of 7 days');
  });

  test('suggests easing off when it feels hard and pain rises', async () => {
    await pool.query("UPDATE home_logs SET difficulty = 'hard', pain = 7 WHERE program_id = $1", [program.id]);
    await pool.query('UPDATE home_log_items SET done = true WHERE log_id IN (SELECT id FROM home_logs WHERE program_id = $1)', [program.id]);
    await pool.query(`UPDATE home_log_items li SET done = false FROM home_logs l
      WHERE li.log_id = l.id AND l.program_id = $1 AND l.log_date >= $2`, [program.id, bkk(-4)]);
    const r = await api('GET', `/api/home/programs/${program.id}/suggestions`, { token: tokens.somchai });
    // ทำได้ 2 ใน 7 วัน + รู้สึกยากทุกวัน + ปวดเฉลี่ย 7 (ตั้งต้น 4) → ลดความยาก
    assert.ok(r.body.items.length >= 1, JSON.stringify(r.body));
    for (const it of r.body.items) {
      assert.equal(it.type, 'regress');
      assert.equal(it.proposed.reps, 7, '10 → 7 (−30%)');
    }
  });

  test('an applied change resets the evidence window so the same step is not suggested again', async () => {
    const d = (await api('GET', `/api/home/programs/${program.id}`, { token: tokens.somchai })).body;
    const active = d.items.filter((i) => i.is_active);
    const body = (patch) => ({ items: active.map((i) => ({ id: i.id, exerciseId: i.exercise_id, sets: i.sets, reps: i.reps, holdSec: i.hold_sec, perDay: i.per_day, daysOfWeek: i.days_of_week, notes: i.notes, ...(i.id === active[0].id ? patch : {}) })) });
    // แก้เฉพาะหมายเหตุ: ยังนับข้อมูลเดิม
    assert.equal((await api('PATCH', `/api/home/programs/${program.id}`, { token: tokens.somchai, body: body({ notes: 'ทำช้า ๆ' }) })).status, 200);
    let r = await api('GET', `/api/home/programs/${program.id}/suggestions`, { token: tokens.somchai });
    assert.ok(r.body.items.some((x) => x.itemId === active[0].id), 'notes-only edit keeps the suggestion');
    // ปรับจำนวนครั้ง: เริ่มนับใหม่ → ไม่มีข้อเสนอสำหรับท่านี้จนกว่าจะมีข้อมูลใหม่
    assert.equal((await api('PATCH', `/api/home/programs/${program.id}`, { token: tokens.somchai, body: body({ reps: 7 }) })).status, 200);
    r = await api('GET', `/api/home/programs/${program.id}/suggestions`, { token: tokens.somchai });
    assert.ok(!r.body.items.some((x) => x.itemId === active[0].id), JSON.stringify(r.body.items));
    assert.ok(r.body.items.some((x) => x.itemId === active[1].id), 'other exercises are unaffected');
  });
});
