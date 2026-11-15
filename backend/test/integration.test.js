/**
 * ทดสอบการเชื่อมต่อระบบโรงพยาบาล (HIS) — FHIR R4 ขาเข้า/ขาออก
 * รันกับ PostgreSQL จริง (DROP SCHEMA public แล้วสร้างใหม่) และ HIS จำลองด้วย http server ในเครื่อง
 */
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const os = require('node:os');

process.env.UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-upload-'));
const { pool } = require('../src/db');
const { createApp } = require('../src/app');
const outbox = require('../src/services/integration/outbox.service');

const SAMPLE = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'docs', 'integration', 'sample-bundle.json'), 'utf8'));
const clone = (o) => JSON.parse(JSON.stringify(o));
const PT_SOMCHAI = '11111111-0000-0000-0000-000000000001';
const PAT_PRASERT = '22222222-0000-0000-0000-000000000001';

let server;
let base;
let his; // HIS จำลอง
let hisBase;
const hisLog = [];
let hisStatus = 200;
const tokens = {};
let connector;
let inboundKey;

async function api(method, url, { token, body, headers = {} } = {}) {
  const h = { ...headers };
  if (token) h.Authorization = `Bearer ${token}`;
  if (body !== undefined) h['Content-Type'] ||= 'application/json';
  const res = await fetch(base + url, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
const push = (bundle, key = inboundKey, q = '') => api('POST', `/api/integration/inbound/${connector.code}/fhir${q}`, {
  body: bundle, headers: { 'X-Api-Key': key, 'Content-Type': 'application/fhir+json' },
});
const one = async (sql, p = []) => (await pool.query(sql, p)).rows[0];

function nextWorkday(n = 2) {
  const d = new Date(Date.now() + 7 * 3600_000);
  d.setUTCDate(d.getUTCDate() + n);
  while (d.getUTCDay() === 0) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

before(async () => {
  const sql = (f) => fs.readFileSync(path.join(__dirname, '..', '..', 'db', f), 'utf8');
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  for (const f of ['001_schema.sql', '002_reference_data.sql', '003_clinical_guidelines.sql', '004_rooms_beds.sql', '005_floor_plan.sql',
    '006_integration.sql', 'demo/101_demo_data.sql', 'demo/103_demo_rooms_beds.sql']) {
    await pool.query(sql(f));
  }
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  for (const [k, email] of Object.entries({ admin: 'admin@physiocare.local', somchai: 'somchai@physiocare.local', front: 'front@physiocare.local' })) {
    tokens[k] = (await api('POST', '/api/auth/login', { body: { email, password: 'Passw0rd!' } })).body.token;
  }
  his = http.createServer((req, res) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => {
      hisLog.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: data ? JSON.parse(data) : null });
      const u = new URL(req.url, 'http://x');
      if (req.method === 'GET' && u.pathname === '/fhir/metadata') { res.end(JSON.stringify({ resourceType: 'CapabilityStatement', fhirVersion: '4.0.1' })); return; }
      if (req.method === 'GET' && u.pathname === '/fhir/Location') {
        const page2 = u.searchParams.get('page') === '2';
        const loc = (id, code, name) => ({ resourceType: 'Location', id, name, status: 'active', identifier: [{ value: code }],
          physicalType: { coding: [{ code: 'ro' }] }, meta: { lastUpdated: page2 ? '2026-11-02T00:00:00Z' : '2026-11-01T00:00:00Z' } });
        res.end(JSON.stringify({
          resourceType: 'Bundle', type: 'searchset',
          entry: [{ resource: page2 ? loc('pull-2', 'PULL-2', 'ห้องดึง 2') : loc('pull-1', 'PULL-1', 'ห้องดึง 1') }],
          link: page2 ? [{ relation: 'next', url: 'http://evil.example/fhir/Location?page=3' }] : [{ relation: 'next', url: `${hisBase}/Location?page=2` }],
        }));
        return;
      }
      res.statusCode = req.method === 'PUT' ? hisStatus : 404;
      res.end(JSON.stringify({ resourceType: 'OperationOutcome' }));
    });
  }).listen(0);
  hisBase = `http://127.0.0.1:${his.address().port}/fhir`;
});

after(async () => {
  server?.close();
  his?.close();
  await pool.end();
});

describe('HIS integration (FHIR R4)', () => {
  test('only admins manage connectors; key returned once and stored hashed', async () => {
    assert.equal((await api('GET', '/api/integration/connectors', { token: tokens.somchai })).status, 403);
    const r = await api('POST', '/api/integration/connectors', {
      token: tokens.admin,
      body: { code: 'main-his', name: 'HIS ทดสอบ', isEnabled: true, settings: { identifierSystems: { hn: 'https://his.example-hospital.go.th/hn' } } },
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.match(r.body.inboundKey, /^pchis_/);
    assert.equal(r.body.inbound_key_hash, undefined);
    connector = r.body;
    inboundKey = r.body.inboundKey;
    const row = await one('SELECT inbound_key_hash FROM integration_connectors WHERE id = $1', [connector.id]);
    assert.notEqual(row.inbound_key_hash, inboundKey);
    const list = await api('GET', '/api/integration/connectors', { token: tokens.admin });
    assert.equal(list.body[0].inboundKey, undefined);
    assert.equal(list.body[0].inbound_key_hash, undefined);
  });

  test('inbound push needs a valid API key', async () => {
    assert.equal((await push(SAMPLE, 'pchis_wrong')).status, 401);
    assert.equal((await push(SAMPLE, '')).status, 401);
  });

  test('dry run reports changes without saving anything', async () => {
    const before = await one('SELECT (SELECT count(*) FROM rooms) r, (SELECT count(*) FROM staff) s, (SELECT count(*) FROM patients) p');
    const r = await push(SAMPLE, inboundKey, '?dryRun=true');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.dryRun, true);
    assert.equal(r.body.stats.created, 9);
    const afterRun = await one('SELECT (SELECT count(*) FROM rooms) r, (SELECT count(*) FROM staff) s, (SELECT count(*) FROM patients) p');
    assert.deepEqual(afterRun, before);
    assert.equal((await one('SELECT count(*)::int n FROM external_refs')).n, 0);
  });

  test('import creates rooms, beds, staff, equipment, patient, diagnosis and referral', async () => {
    const r = await push(SAMPLE);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.stats.created, 9, JSON.stringify(r.body.items));
    const room = await one("SELECT * FROM rooms WHERE code = 'PT-A'");
    assert.equal(room.floor, 'อาคารผู้ป่วยนอก ชั้น 3');
    assert.equal(room.managed_by, 'main-his');
    assert.equal(room.capacity, 2, 'capacity at least the number of beds');
    assert.equal((await one('SELECT count(*)::int n FROM beds WHERE room_id = $1', [room.id])).n, 2);
    const st = await one("SELECT * FROM staff WHERE license_no = 'กภ.55555'");
    assert.equal(st.position, 'physiotherapist');
    assert.equal(st.employee_code, 'EMP-1001');
    assert.equal(st.title, 'กภ.');
    const eq = await one("SELECT e.*, c.code cat FROM equipment e JOIN equipment_categories c ON c.id = e.category_id WHERE asset_code = 'ครุภัณฑ์-6515-007'");
    assert.equal(eq.cat, 'US');
    assert.equal(eq.room_id, room.id, 'fixed equipment placed in its room');
    assert.equal(Number(eq.purchase_price), 120000);
    const p = await one("SELECT * FROM patients WHERE hn = 'HN-67-007788'");
    assert.equal(p.first_name, 'บุษบา');
    const dx = await one("SELECT pd.*, d.icd10_code FROM patient_diagnoses pd JOIN diagnoses d ON d.id = pd.diagnosis_id WHERE patient_id = $1", [p.id]);
    assert.equal(dx.icd10_code, 'M54.5');
    assert.equal(dx.is_primary, true);
    const refs = await api('GET', '/api/integration/referrals?status=pending', { token: tokens.front });
    assert.equal(refs.status, 200);
    assert.equal(refs.body.length, 1);
    assert.equal(refs.body[0].priority, 'urgent');
    assert.equal(refs.body[0].sessions_requested, 6);
  });

  test('re-sending the same data changes nothing; edits update only that record', async () => {
    const again = await push(SAMPLE);
    assert.equal(again.body.stats.unchanged, 9);
    const changed = clone(SAMPLE);
    changed.entry.find((e) => e.resource.resourceType === 'Practitioner').resource.telecom = [{ system: 'phone', value: '02-999-9999' }];
    const r = await push(changed);
    assert.equal(r.body.stats.updated, 1);
    assert.equal(r.body.stats.unchanged, 8);
    assert.equal((await one("SELECT phone FROM staff WHERE license_no = 'กภ.55555'")).phone, '02-999-9999');
    assert.equal((await one("SELECT count(*)::int n FROM staff WHERE license_no = 'กภ.55555'")).n, 1);
  });

  test('existing local records are linked instead of duplicated', async () => {
    const before = (await one('SELECT count(*)::int n FROM rooms')).n;
    const bundle = {
      resourceType: 'Bundle', type: 'collection', entry: [
        { resource: { resourceType: 'Location', id: 'his-r1', name: 'ห้องรักษา 1 (HIS)', identifier: [{ value: 'R1' }], physicalType: { coding: [{ code: 'ro' }] } } },
        { resource: { resourceType: 'Patient', id: 'his-prasert', identifier: [{ type: { coding: [{ code: 'MR' }] }, value: (await one('SELECT hn FROM patients WHERE id = $1', [PAT_PRASERT])).hn }], name: [{ given: ['ประเสริฐ'], family: 'HIS' }] } },
      ],
    };
    const r = await push(bundle);
    assert.equal(r.body.stats.linked, 2, JSON.stringify(r.body.items));
    assert.equal((await one('SELECT count(*)::int n FROM rooms')).n, before);
    assert.equal((await one("SELECT managed_by FROM rooms WHERE code = 'R1'")).managed_by, 'main-his');
  });

  test('HIS-owned fields are locked in PhysioCare; local fields stay editable', async () => {
    const st = await one("SELECT * FROM staff WHERE license_no = 'กภ.55555'");
    const lock = await api('PATCH', `/api/staff/${st.id}`, { token: tokens.admin, body: { firstName: 'ชื่อใหม่' } });
    assert.equal(lock.status, 409);
    assert.equal(lock.body.error.code, 'HIS_MANAGED');
    assert.equal((await api('PATCH', `/api/staff/${st.id}`, { token: tokens.admin, body: { firstName: st.first_name, color: '#123456', maxPatientsPerDay: 10 } })).status, 200);
    const room = await one("SELECT id FROM rooms WHERE code = 'PT-A'");
    assert.equal((await api('PATCH', `/api/facilities/rooms/${room.id}`, { token: tokens.admin, body: { name: 'เปลี่ยนชื่อ' } })).status, 409);
    assert.equal((await api('PATCH', `/api/facilities/rooms/${room.id}`, { token: tokens.admin, body: { capacity: 4, planX: 3, planZ: 2 } })).status, 200);
    // record ที่สร้างในระบบเองแก้ได้ทุกฟิลด์
    assert.equal((await api('PATCH', `/api/staff/${PT_SOMCHAI}`, { token: tokens.admin, body: { phone: '099-000-0000' } })).status, 200);
  });

  test('bad items fail individually with a clear reason', async () => {
    const r = await push({
      resourceType: 'Bundle', type: 'collection', entry: [
        { resource: { resourceType: 'Device', id: 'dev-x', identifier: [{ value: 'EQ-UNKNOWN' }], type: { text: 'เครื่องชั่งน้ำหนัก' } } },
        { resource: { resourceType: 'Location', id: 'orphan-bed', name: 'เตียงลอย', physicalType: { coding: [{ code: 'bd' }] }, partOf: { reference: 'Location/none' } } },
        { resource: { resourceType: 'Location', id: 'ok-room', name: 'ห้อง OK', identifier: [{ value: 'OK-1' }], physicalType: { coding: [{ code: 'ro' }] } } },
      ],
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.stats.failed, 2);
    assert.equal(r.body.stats.created, 1);
    assert.match(r.body.issue.map((i) => i.diagnostics).join(' '), /deviceCategoryMap/);
    assert.ok(await one("SELECT 1 FROM rooms WHERE code = 'OK-1'"));
  });

  test('appointments are queued and sent back to HIS with retry', async () => {
    await api('PATCH', `/api/integration/connectors/${connector.id}`, {
      token: tokens.admin, body: { baseUrl: hisBase, settings: { ...connector.settings, outbound: { appointments: true } } },
    });
    const day = nextWorkday(3);
    const booked = await api('POST', '/api/appointments', {
      token: tokens.front,
      body: { patientId: PAT_PRASERT, therapistId: PT_SOMCHAI, startAt: `${day}T10:00:00+07:00`, endAt: `${day}T10:45:00+07:00`, acknowledgeWarnings: true },
    });
    assert.equal(booked.status, 201, JSON.stringify(booked.body));
    const apptId = booked.body.appointment.id;
    const job = await one("SELECT * FROM integration_outbox WHERE entity_id = $1 AND status = 'pending'", [apptId]);
    assert.ok(job, 'queued by trigger');

    hisStatus = 503;
    let s = await outbox.processOutbox();
    assert.equal(s.failed, 1);
    let row = await one('SELECT * FROM integration_outbox WHERE id = $1', [job.id]);
    assert.equal(row.status, 'failed');
    assert.equal(row.attempts, 1);

    hisStatus = 201;
    await pool.query('UPDATE integration_outbox SET next_attempt_at = now() WHERE id = $1', [job.id]);
    s = await outbox.processOutbox();
    assert.equal(s.sent, 1);
    row = await one('SELECT * FROM integration_outbox WHERE id = $1', [job.id]);
    assert.equal(row.status, 'sent');
    const put = hisLog.filter((x) => x.method === 'PUT').at(-1);
    assert.match(put.url, /^\/fhir\/Appointment\?identifier=urn%3Aphysiocare%3Aappointment%7C/);
    assert.equal(put.body.resourceType, 'Appointment');
    assert.equal(put.body.status, 'booked');
    assert.equal(put.body.participant[0].actor.reference, 'Patient/his-prasert', 'uses HIS id after linking');

    // ยกเลิกนัด → ส่งสถานะใหม่
    await api('PATCH', `/api/appointments/${apptId}/status`, { token: tokens.front, body: { status: 'cancelled', reason: 'ผู้ป่วยขอยกเลิก' } });
    await outbox.processOutbox();
    assert.equal(hisLog.filter((x) => x.method === 'PUT').at(-1).body.status, 'cancelled');

    // HIS ปฏิเสธข้อมูล (422) → หยุดส่ง ไม่วนลองซ้ำ
    hisStatus = 422;
    await pool.query("UPDATE appointments SET end_at = end_at + interval '15 minutes' WHERE id = $1", [apptId]);
    await outbox.processOutbox();
    assert.equal((await one("SELECT status FROM integration_outbox WHERE entity_id = $1 ORDER BY id DESC LIMIT 1", [apptId])).status, 'dead');
    hisStatus = 200;
  });

  test('pull follows paging on the same server only and keeps a cursor', async () => {
    const dry = await api('POST', `/api/integration/connectors/${connector.id}/pull`, { token: tokens.admin, body: { resources: ['Location'], dryRun: true } });
    assert.equal(dry.status, 200, JSON.stringify(dry.body));
    assert.equal(dry.body.stats.created, 2);
    assert.equal(hisLog.some((x) => x.url.includes('page=3')), false, 'next link to another host is ignored');
    assert.equal(await one('SELECT * FROM integration_cursors'), undefined, 'dry run keeps no cursor');
    const real = await api('POST', `/api/integration/connectors/${connector.id}/pull`, { token: tokens.admin, body: { resources: ['Location'], dryRun: false } });
    assert.equal(real.body.stats.created, 2);
    const cur = await one('SELECT * FROM integration_cursors');
    assert.equal(cur.last_updated.toISOString(), '2026-11-02T00:00:00.000Z');
    await api('POST', `/api/integration/connectors/${connector.id}/pull`, { token: tokens.admin, body: { resources: ['Location'], dryRun: true } });
    assert.match(hisLog.filter((x) => x.url.startsWith('/fhir/Location') && !x.url.includes('page=')).at(-1).url, /_lastUpdated=gt2026-11-02/);
  });

  test('connection test and disabled connector', async () => {
    const t = await api('POST', `/api/integration/connectors/${connector.id}/test`, { token: tokens.admin });
    assert.equal(t.body.ok, true);
    assert.equal(t.body.fhirVersion, '4.0.1');
    await api('PATCH', `/api/integration/connectors/${connector.id}`, { token: tokens.admin, body: { isEnabled: false } });
    assert.equal((await push(SAMPLE)).status, 401, 'disabled connector refuses data');
    const rotated = await api('POST', `/api/integration/connectors/${connector.id}/rotate-key`, { token: tokens.admin });
    await api('PATCH', `/api/integration/connectors/${connector.id}`, { token: tokens.admin, body: { isEnabled: true } });
    assert.equal((await push(SAMPLE, inboundKey)).status, 401, 'old key no longer works');
    assert.equal((await push(SAMPLE, rotated.body.inboundKey)).status, 200);
  });

  test('a second HIS sending the same records links them (no duplicates)', async () => {
    const c2 = (await api('POST', '/api/integration/connectors', { token: tokens.admin, body: { code: 'his-2', name: 'HIS สำรอง', isEnabled: true } })).body;
    const counts = 'SELECT (SELECT count(*) FROM rooms) r, (SELECT count(*) FROM beds) b, (SELECT count(*) FROM staff) s, (SELECT count(*) FROM equipment) e, (SELECT count(*) FROM patients) p, (SELECT count(*) FROM referrals) f';
    const before = await one(counts);
    const r = await api('POST', `/api/integration/inbound/his-2/fhir`, { body: SAMPLE, headers: { 'X-Api-Key': c2.inboundKey } });
    assert.equal(r.status, 200);
    assert.equal(r.body.stats.linked, 8, JSON.stringify(r.body.items));
    assert.deepEqual(await one(counts), before);
  });
});
