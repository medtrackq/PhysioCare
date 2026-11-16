/**
 * ระยะที่ 3: วิดีโอคอลติดตามผล (นัด, ลิงก์ผู้ป่วย, ยินยอม, ส่งต่อสัญญาณ WebRTC, เตือนทาง LINE)
 * และบันทึกจำนวนครั้งที่กล้องนับได้ในโปรแกรมที่บ้าน
 */
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');

process.env.UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-upload-'));
process.env.LINE_CHANNEL_SECRET = 'test-channel-secret';
process.env.LINE_CHANNEL_ACCESS_TOKEN = 'test-access-token';
process.env.APP_BASE_URL = 'https://physio.example.test';
process.env.TURN_URLS = 'turn:turn.example.test:3478';
process.env.TURN_SECRET = 'turn-test-secret';
const lineLog = [];
const lineMock = http.createServer((req, res) => {
  let data = '';
  req.on('data', (c) => { data += c; });
  req.on('end', () => {
    lineLog.push({ url: req.url, body: data ? JSON.parse(data) : null });
    res.setHeader('Content-Type', 'application/json');
    res.end('{}');
  });
});

const { pool } = require('../src/db');
const { createApp } = require('../src/app');
const notify = require('../src/services/notify.service');
const home = require('../src/services/home.service');

const PAT = { prasert: '22222222-0000-0000-0000-000000000001' };
let server;
let base;
const tokens = {};

async function api(method, url, { token, body, headers = {} } = {}) {
  const h = { ...headers };
  if (token) h.Authorization = `Bearer ${token}`;
  if (body !== undefined) h['Content-Type'] = 'application/json';
  const res = await fetch(base + url, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, body: json };
}
const setSetting = (k, v) => pool.query('UPDATE system_settings SET value = $2 WHERE key = $1', [k, JSON.stringify(v)]);

/** เปิดสตรีมสัญญาณ (SSE) แล้วเก็บ event ที่ได้รับ */
function stream(url, headers) {
  const events = [];
  const waiters = [];
  let buf = '';
  const req = http.get(base + url, { headers }, (res) => {
    res.setEncoding('utf8');
    res.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const ev = /^event: (.+)$/m.exec(block)?.[1];
        const data = /^data: (.+)$/m.exec(block)?.[1];
        if (!ev) continue;
        events.push({ event: ev, data: JSON.parse(data) });
        for (const w of [...waiters]) if (w.pred(events.at(-1))) { waiters.splice(waiters.indexOf(w), 1); w.resolve(events.at(-1)); }
      }
    });
  });
  return {
    events,
    status: new Promise((r) => req.on('response', (res) => r(res.statusCode))),
    next: (pred, ms = 3000) => {
      const hit = events.find(pred);
      if (hit) return Promise.resolve(hit);
      return new Promise((resolve, reject) => {
        const w = { pred, resolve };
        waiters.push(w);
        setTimeout(() => reject(new Error(`timeout waiting for event; got ${JSON.stringify(events)}`)), ms);
      });
    },
    close: () => req.destroy(),
  };
}

before(async () => {
  await new Promise((r) => lineMock.listen(0, r));
  process.env.LINE_API_BASE = `http://127.0.0.1:${lineMock.address().port}`;
  const sql = (f) => fs.readFileSync(path.join(__dirname, '..', '..', 'db', f), 'utf8');
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  for (const f of ['001_schema.sql', '002_reference_data.sql', '003_clinical_guidelines.sql', '004_rooms_beds.sql', '005_floor_plan.sql',
    '006_integration.sql', '007_home_program.sql', '008_notifications.sql', '009_camera_telerehab.sql', '010_care_team_access.sql', 'demo/101_demo_data.sql', 'demo/103_demo_rooms_beds.sql', 'demo/106_demo_care_team.sql']) {
    await pool.query(sql(f));
  }
  await setSetting('notify.enabled', true);
  await setSetting('notify.line_basic_id', '@123abcde');
  await setSetting('notify.quiet_hours', { start: '00:00', end: '00:00' });
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  for (const [k, email] of Object.entries({ admin: 'admin@physiocare.local', somchai: 'somchai@physiocare.local', front: 'front@physiocare.local' })) {
    tokens[k] = (await api('POST', '/api/auth/login', { body: { email, password: 'Passw0rd!' } })).body.token;
  }
});

after(async () => {
  require('../src/services/tele.service').closeAll();
  server?.close();
  lineMock.close();
  await pool.end();
});

describe('Telerehab video calls', () => {
  let session;
  let callToken;

  test('therapist schedules a call; the patient link is shown once and stored only as a hash', async () => {
    const at = new Date(Date.now() + 5 * 60_000).toISOString();
    const r = await api('POST', '/api/tele/sessions', { token: tokens.somchai, body: { patientId: PAT.prasert, scheduledAt: at, durationMin: 20, purpose: 'ติดตามท่าออกกำลังกาย' } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    session = r.body;
    assert.match(session.url, /^https:\/\/physio\.example\.test\/call#t=[\w-]{43}$/);
    callToken = session.url.split('#t=')[1];
    assert.equal(session.token_hash, undefined);
    const row = (await pool.query('SELECT token_hash FROM tele_sessions WHERE id = $1', [session.id])).rows[0];
    assert.notEqual(row.token_hash, callToken);
    // front desk ไม่มีสิทธิ์เวชระเบียน → นัดวิดีโอคอลไม่ได้
    assert.equal((await api('POST', '/api/tele/sessions', { token: tokens.front, body: { patientId: PAT.prasert, scheduledAt: at } })).status, 403);
    // เวลาที่ผ่านไปแล้วนัดไม่ได้
    assert.equal((await api('POST', '/api/tele/sessions', { token: tokens.somchai, body: { patientId: PAT.prasert, scheduledAt: new Date(Date.now() - 3600e3).toISOString() } })).status, 400);
  });

  test('patient sees the appointment and must consent before joining; the room opens 15 minutes early', async () => {
    const v = await api('GET', '/api/public/tele', { headers: { 'X-Call-Token': callToken } });
    assert.equal(v.status, 200);
    assert.equal(v.body.patientFirstName, 'ประเสริฐ');
    assert.equal(v.body.window.open, true);
    assert.equal(v.body.consented, false);
    assert.equal(v.body.hn, undefined, 'no HN on the public page');
    assert.equal((await api('GET', '/api/public/tele', { headers: { 'X-Call-Token': 'x'.repeat(43) } })).status, 401);
    assert.equal((await api('POST', '/api/public/tele/join', { headers: { 'X-Call-Token': callToken }, body: { consent: false } })).status, 400);
    const s = stream('/api/public/tele/signal', { 'X-Call-Token': callToken });
    assert.equal(await s.status, 409, 'no signalling before consent');
    s.close();
    const j = await api('POST', '/api/public/tele/join', { headers: { 'X-Call-Token': callToken }, body: { consent: true } });
    assert.equal(j.status, 200);
    const turn = j.body.iceServers.find((x) => String(x.urls).startsWith('turn:'));
    assert.ok(turn && turn.username.endsWith(`:${session.id}`) && turn.credential, 'time-limited TURN credentials');

    // นัดในอีก 2 ชั่วโมง: ยังเข้าไม่ได้
    const later = await api('POST', '/api/tele/sessions', { token: tokens.somchai, body: { patientId: PAT.prasert, scheduledAt: new Date(Date.now() + 2 * 3600e3).toISOString() } });
    const lt = later.body.url.split('#t=')[1];
    const lv = await api('GET', '/api/public/tele', { headers: { 'X-Call-Token': lt } });
    assert.equal(lv.body.window.reason, 'early');
    assert.equal((await api('POST', '/api/public/tele/join', { headers: { 'X-Call-Token': lt }, body: { consent: true } })).status, 409);
  });

  test('signalling: presence, offer/answer/ICE relay between therapist and patient, and status in_progress', async () => {
    const staff = stream(`/api/tele/sessions/${session.id}/signal`, { Authorization: `Bearer ${tokens.somchai}` });
    assert.equal(await staff.status, 200);
    await staff.next((e) => e.event === 'presence' && e.data.staff && !e.data.patient);
    const patient = stream('/api/public/tele/signal', { 'X-Call-Token': callToken });
    assert.equal(await patient.status, 200);
    await staff.next((e) => e.event === 'presence' && e.data.patient);

    await api('POST', `/api/tele/sessions/${session.id}/signal`, { token: tokens.somchai, body: { type: 'offer', data: { type: 'offer', sdp: 'v=0 fake' } } });
    const offer = await patient.next((e) => e.event === 'signal' && e.data.type === 'offer');
    assert.equal(offer.data.from, 'staff');
    assert.equal(offer.data.data.sdp, 'v=0 fake');
    const r = await api('POST', '/api/public/tele/signal', { headers: { 'X-Call-Token': callToken }, body: { type: 'answer', data: { type: 'answer', sdp: 'v=0 ans' } } });
    assert.equal(r.body.delivered, true);
    await staff.next((e) => e.event === 'signal' && e.data.type === 'answer');
    await api('POST', '/api/public/tele/signal', { headers: { 'X-Call-Token': callToken }, body: { type: 'ice', data: { candidate: 'candidate:1 1 udp 1 1.2.3.4 5 typ host' } } });
    await staff.next((e) => e.event === 'signal' && e.data.type === 'ice');
    assert.equal((await api('POST', '/api/public/tele/signal', { headers: { 'X-Call-Token': callToken }, body: { type: 'hack' } })).status, 400);

    const t = await api('GET', `/api/tele/sessions/${session.id}`, { token: tokens.somchai });
    assert.equal(t.body.status, 'in_progress');
    assert.ok(t.body.started_at);
    assert.deepEqual(t.body.online, { staff: true, patient: true });

    // ผู้ป่วยเปิดอีกเครื่อง: เครื่องเดิมถูกแทนที่
    const patient2 = stream('/api/public/tele/signal', { 'X-Call-Token': callToken });
    await patient.next((e) => e.event === 'replaced');
    await patient2.status;

    // นักกายภาพจบการโทร: บันทึกโน้ต ปิดห้อง ลิงก์ใช้ต่อไม่ได้
    const end = await api('POST', `/api/tele/sessions/${session.id}/end`, { token: tokens.somchai, body: { note: 'ท่าลุกนั่งทำได้ดี ปรับเพิ่ม 2 ครั้ง' } });
    assert.equal(end.body.status, 'completed');
    await patient2.next((e) => e.event === 'closed');
    staff.close(); patient2.close();
    const v = await api('GET', '/api/public/tele', { headers: { 'X-Call-Token': callToken } });
    assert.equal(v.body.window.open, false);
    assert.equal(v.body.note, undefined, 'therapist note is not shown to the patient');
  });

  test('regenerating the link invalidates the old one', async () => {
    const s = (await api('POST', '/api/tele/sessions', { token: tokens.somchai, body: { patientId: PAT.prasert, scheduledAt: new Date(Date.now() + 600e3).toISOString() } })).body;
    const old = s.url.split('#t=')[1];
    const n = await api('POST', `/api/tele/sessions/${s.id}/link`, { token: tokens.somchai });
    assert.equal(n.status, 201);
    assert.equal((await api('GET', '/api/public/tele', { headers: { 'X-Call-Token': old } })).status, 401);
    assert.equal((await api('GET', '/api/public/tele', { headers: { 'X-Call-Token': n.body.url.split('#t=')[1] } })).status, 200);
    const c = await api('PATCH', `/api/tele/sessions/${s.id}`, { token: tokens.somchai, body: { status: 'cancelled' } });
    assert.equal(c.body.status, 'cancelled');
  });

  test('LINE reminder with the join link is queued before the call and skipped if rescheduled', async () => {
    await pool.query("INSERT INTO patient_contacts (patient_id, line_user_id, linked_at) VALUES ($1, 'U_tele', now()) ON CONFLICT (patient_id) DO UPDATE SET line_user_id = 'U_tele'", [PAT.prasert]);
    await pool.query("UPDATE tele_sessions SET status = 'cancelled' WHERE status = 'scheduled'");
    const s = (await api('POST', '/api/tele/sessions', { token: tokens.somchai, body: { patientId: PAT.prasert, scheduledAt: new Date(Date.now() + 10 * 60_000).toISOString() } })).body;
    const r = await notify.scheduleDue();
    assert.equal(r.tele, 1);
    lineLog.length = 0;
    await notify.deliverDue();
    const msg = lineLog.find((x) => x.url === '/v2/bot/message/push')?.body.messages[0].text;
    assert.match(msg, /นัดวิดีโอคอลกายภาพบำบัด/);
    assert.ok(msg.includes('https://physio.example.test/call#t='), msg);
    assert.ok(!msg.includes('HN'), 'no HN in message');
    assert.equal((await notify.scheduleDue()).tele, 0, 'deduplicated');

    // ส่งลิงก์ทันทีจากหน้าจอ
    lineLog.length = 0;
    const sl = await api('POST', `/api/tele/sessions/${s.id}/send-line`, { token: tokens.somchai });
    assert.equal(sl.body.status, 'sent', JSON.stringify(sl.body));
    // เลื่อนนัดหลังเข้าคิวแล้ว: ข้อความเตือนเดิมถูกข้าม
    const s2 = (await api('POST', '/api/tele/sessions', { token: tokens.somchai, body: { patientId: PAT.prasert, scheduledAt: new Date(Date.now() + 12 * 60_000).toISOString() } })).body;
    await notify.scheduleDue();
    await api('PATCH', `/api/tele/sessions/${s2.id}`, { token: tokens.somchai, body: { scheduledAt: new Date(Date.now() + 3 * 3600e3).toISOString() } });
    const d = await notify.deliverDue();
    assert.equal(d.skipped, 1);
  });
});

describe('Camera rep counting (home program)', () => {
  test('exercise camera settings are validated and the count is saved with the daily log', async () => {
    const ex = (await api('GET', '/api/home/exercises', { token: tokens.somchai })).body;
    assert.deepEqual(ex.find((e) => e.code === 'SIT_STAND').camera, { joint: 'knee', rest: 110, target: 155, view: 'side' });
    const bad = await api('PATCH', `/api/home/exercises/${ex[0].id}`, { token: tokens.somchai, body: { camera: { joint: 'knee', rest: 100, target: 105 } } });
    assert.equal(bad.status, 400);
    const ok = await api('PATCH', `/api/home/exercises/${ex[0].id}`, { token: tokens.somchai, body: { camera: { joint: 'elbow', rest: 160, target: 60 } } });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.camera.joint, 'elbow');

    const sitStand = ex.find((e) => e.code === 'SIT_STAND');
    const bridge = ex.find((e) => e.code === 'BRIDGE');
    const today = new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10);
    const end = new Date(Date.now() + 7 * 3600e3 + 27 * 864e5).toISOString().slice(0, 10);
    const all = [1, 2, 3, 4, 5, 6, 7];
    const pr = await api('POST', '/api/home/programs', {
      token: tokens.somchai,
      body: {
        patientId: PAT.prasert, startDate: today, endDate: end, consent: true,
        items: [{ exerciseId: sitStand.id, sets: 2, reps: 10, perDay: 1, daysOfWeek: all }, { exerciseId: bridge.id, sets: 3, reps: 10, holdSec: 3, perDay: 1, daysOfWeek: all }],
      },
    });
    assert.equal(pr.status, 201, JSON.stringify(pr.body));
    const program = pr.body;

    const tok = (await home.createLink(program.id, { label: 'ผู้ป่วย' }, null)).token;
    const v = (await api('GET', '/api/public/home', { headers: { 'X-Home-Token': tok } })).body;
    const camItem = v.items.find((i) => i.name === sitStand.name_th);
    assert.equal(camItem.camera.joint, 'knee');
    const r = await api('PUT', '/api/public/home/log', {
      headers: { 'X-Home-Token': tok },
      body: { items: v.items.map((i) => ({ itemId: i.id, done: i.id === camItem.id, repsCounted: i.id === camItem.id ? 20 : undefined })), pain: 2 },
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const after = (await api('GET', `/api/home/programs/${program.id}`, { token: tokens.somchai })).body;
    const st = after.itemStats.find((x) => x.id === camItem.id);
    assert.equal(st.cameraDays, 1);
    assert.equal(st.lastCounted, 20);
  });
});
