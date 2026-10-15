/**
 * Integration tests — รันกับ PostgreSQL จริง (DATABASE_URL ควรชี้ไปที่ฐานข้อมูลสำหรับทดสอบ)
 * ⚠ test จะ DROP SCHEMA public แล้วสร้างใหม่จาก db/*.sql
 */
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

process.env.UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-upload-'));
const { pool } = require('../src/db');
const { createApp } = require('../src/app');
const sse = require('../src/realtime/sse');

let server;
let base;
const tokens = {};
const eq = {};
const PT = {
  somchai: '11111111-0000-0000-0000-000000000001',
  supaporn: '11111111-0000-0000-0000-000000000002',
  nattida: '11111111-0000-0000-0000-000000000003',
  weerapong: '11111111-0000-0000-0000-000000000004',
};
const PAT = {
  prasert: '22222222-0000-0000-0000-000000000001', // LBP + frozen shoulder, metal implant
  wilai: '22222222-0000-0000-0000-000000000002', // stroke, pacemaker + fall risk
  poom: '22222222-0000-0000-0000-000000000003', // CP (child)
};

async function api(method, url, { token, body, raw } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload;
  if (raw) payload = raw;
  else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(base + url, { method, headers, body: payload });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, body: json, headers: res.headers };
}

/** วันทำการถัดไป (จันทร์–เสาร์) ตามเวลากรุงเทพ อย่างน้อย +n วัน */
function nextWorkday(n = 1) {
  const d = new Date(Date.now() + 7 * 3600_000);
  d.setUTCDate(d.getUTCDate() + n);
  while (d.getUTCDay() === 0) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
const at = (date, hhmm) => `${date}T${hhmm}:00+07:00`;
const DAY = nextWorkday(2);

before(async () => {
  const sql = (f) => fs.readFileSync(path.join(__dirname, '..', '..', 'db', f), 'utf8');
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await pool.query(sql('001_schema.sql'));
  await pool.query(sql('002_seed.sql'));
  await sse.startListener();
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}`;

  for (const [k, email] of Object.entries({
    admin: 'admin@physiocare.local', somchai: 'somchai@physiocare.local', supaporn: 'supaporn@physiocare.local',
    front: 'front@physiocare.local', patient: 'patient@physiocare.local',
  })) {
    const r = await api('POST', '/api/auth/login', { body: { email, password: 'Passw0rd!' } });
    assert.equal(r.status, 200, `login ${k}`);
    tokens[k] = r.body.token;
  }
  const list = await api('GET', '/api/equipment', { token: tokens.front });
  for (const e of list.body.items) eq[e.asset_code] = e.id;
});

after(async () => {
  server?.close();
  await sse.stopListener();
  await pool.end();
});

describe('Auth & RBAC', () => {
  test('wrong password -> 401', async () => {
    const r = await api('POST', '/api/auth/login', { body: { email: 'admin@physiocare.local', password: 'nope' } });
    assert.equal(r.status, 401);
  });

  test('no token -> 401', async () => {
    assert.equal((await api('GET', '/api/equipment')).status, 401);
  });

  test('patient cannot see equipment / other patients; sees only own appointments', async () => {
    assert.equal((await api('GET', '/api/equipment', { token: tokens.patient })).status, 403);
    assert.equal((await api('GET', '/api/patients', { token: tokens.patient })).status, 403);
    const r = await api('GET', `/api/appointments?patientId=${PAT.wilai}`, { token: tokens.patient });
    assert.equal(r.status, 200);
    assert.ok(r.body.length >= 3);
    assert.ok(r.body.every((a) => a.patient_id === undefined && a.therapist_name), 'patient view is redacted');
  });

  test('admin cannot read EMR (least privilege), front desk cannot write EMR', async () => {
    const appts = await api('GET', `/api/appointments?patientId=${PAT.prasert}`, { token: tokens.front });
    const id = appts.body[0].id;
    assert.equal((await api('GET', `/api/emr/appointments/${id}`, { token: tokens.admin })).status, 403);
    assert.equal((await api('PUT', `/api/emr/appointments/${id}/pre`, { token: tokens.front, body: { pain_score: 3 } })).status, 403);
  });

  test('only admin sees reports', async () => {
    assert.equal((await api('GET', '/api/reports/summary?from=2026-01-01&to=2030-01-01', { token: tokens.somchai })).status, 403);
    const r = await api('GET', '/api/reports/summary?from=2020-01-01&to=2030-01-01', { token: tokens.admin });
    assert.equal(r.status, 200);
    assert.ok(r.body.clinicalOutcomes.length >= 1);
  });
});

describe('Recommendation engine', () => {
  test('stroke patient with pacemaker -> neuro PT first, electrotherapy excluded', async () => {
    const r = await api('GET', `/api/scheduling/recommendations?patientId=${PAT.wilai}&startAt=${encodeURIComponent(at(DAY, '09:00'))}&durationMin=45`, { token: tokens.front });
    assert.equal(r.status, 200);
    assert.equal(r.body.therapists[0].id, PT.supaporn, 'NEURO specialist ranked first');
    const nmes = r.body.equipment.find((e) => e.category.code === 'NMES');
    assert.equal(nmes.contraindication.level, 'absolute');
    assert.equal(nmes.recommendedUnit, null);
    const parallel = r.body.equipment.find((e) => e.category.code === 'PARALLEL');
    assert.ok(parallel.recommendedUnit, 'parallel bars recommended');
    assert.equal(r.body.equipment.find((e) => e.category.code === 'TILT').contraindication.level, 'relative');
  });

  test('LBP patient -> ortho PT with continuity bonus', async () => {
    const r = await api('GET', `/api/scheduling/recommendations?patientId=${PAT.prasert}`, { token: tokens.front });
    assert.equal(r.body.therapists[0].id, PT.somchai);
    assert.ok(r.body.therapists[0].reasons.some((x) => x.includes('เคยดูแล')));
    const swd = r.body.equipment.find((e) => e.category.code === 'SWD');
    assert.equal(swd.contraindication.level, 'absolute', 'metal implant -> no SWD');
  });
});

describe('Smart scheduling & conflict resolution', () => {
  let apptA;

  test('book successfully', async () => {
    const r = await api('POST', '/api/appointments', {
      token: tokens.front,
      body: { patientId: PAT.prasert, therapistId: PT.somchai, startAt: at(DAY, '10:00'), endAt: at(DAY, '10:45'), equipmentIds: [eq['EQ-IFC-001']] },
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    apptA = r.body.appointment;
  });

  test('therapist double booking -> 409 with alternatives', async () => {
    const r = await api('POST', '/api/appointments', {
      token: tokens.front,
      body: { patientId: PAT.poom, therapistId: PT.somchai, startAt: at(DAY, '10:30'), endAt: at(DAY, '11:15') },
    });
    assert.equal(r.status, 409);
    assert.ok(r.body.error.details.conflicts.some((c) => c.type === 'STAFF_DOUBLE_BOOKED'));
    const alt = r.body.error.details.alternatives;
    assert.ok(alt.sameTherapistSlots.length > 0, 'suggests other slots');
    assert.ok(alt.otherTherapistsSameTime.some((t) => t.id === PT.supaporn), 'suggests other therapist');
  });

  test('equipment double booking incl. cleaning buffer -> 409 with substitutes list', async () => {
    const r = await api('POST', '/api/appointments', {
      token: tokens.front,
      body: { patientId: PAT.poom, therapistId: PT.supaporn, startAt: at(DAY, '10:45'), endAt: at(DAY, '11:30'), equipmentIds: [eq['EQ-IFC-001']] },
    });
    assert.equal(r.status, 409);
    assert.ok(r.body.error.details.conflicts.some((c) => c.type === 'EQUIPMENT_DOUBLE_BOOKED'));
  });

  test('absolute contraindication blocks booking; relative needs acknowledgement', async () => {
    const tens = await api('POST', '/api/appointments', {
      token: tokens.front,
      body: { patientId: PAT.wilai, therapistId: PT.supaporn, startAt: at(DAY, '13:00'), endAt: at(DAY, '13:45'), equipmentIds: [eq['EQ-TENS-001']] },
    });
    assert.equal(tens.status, 409);
    assert.ok(tens.body.error.details.conflicts.some((c) => c.type === 'CONTRAINDICATED'));

    const body = { patientId: PAT.wilai, therapistId: PT.supaporn, startAt: at(DAY, '13:00'), endAt: at(DAY, '13:45'), equipmentIds: [eq['EQ-US-001']] };
    const us = await api('POST', '/api/appointments', { token: tokens.front, body });
    assert.equal(us.status, 422);
    assert.equal(us.body.error.code, 'WARNINGS_REQUIRE_ACK');
    const ok = await api('POST', '/api/appointments', { token: tokens.front, body: { ...body, acknowledgeWarnings: true } });
    assert.equal(ok.status, 201);
  });

  test('broken equipment and off-shift therapist are rejected', async () => {
    const r = await api('POST', '/api/appointments', {
      token: tokens.front,
      body: { patientId: PAT.poom, therapistId: PT.nattida, startAt: at(DAY, '09:00'), endAt: at(DAY, '09:45'), equipmentIds: [eq['EQ-TRC-002']] },
    });
    assert.equal(r.status, 409);
    const types = r.body.error.details.conflicts.map((c) => c.type);
    assert.ok(types.includes('STAFF_NOT_ON_SHIFT'));
    assert.ok(types.includes('EQUIPMENT_UNAVAILABLE'));
  });

  test('concurrent bookings for the same slot: exactly one wins', async () => {
    const reqs = [PAT.prasert, PAT.poom, PAT.wilai, PAT.poom, PAT.prasert].map((patientId) => api('POST', '/api/appointments', {
      token: tokens.front,
      body: { patientId, therapistId: PT.weerapong, startAt: at(DAY, '15:00'), endAt: at(DAY, '15:45'), equipmentIds: [eq['EQ-ESWT-001']], acknowledgeWarnings: true },
    }));
    const results = await Promise.all(reqs);
    assert.equal(results.filter((r) => r.status === 201).length, 1, JSON.stringify(results.map((r) => r.status)));
    assert.ok(results.filter((r) => r.status !== 201).every((r) => r.status === 409));
  });

  test('slot finder returns free slots honoring shifts', async () => {
    const r = await api('GET', `/api/scheduling/slots?date=${DAY}&durationMin=45&therapistIds=${PT.somchai}&patientId=${PAT.poom}`, { token: tokens.front });
    assert.equal(r.status, 200);
    assert.ok(r.body.length > 0);
    assert.ok(!r.body.some((s) => s.startAt === new Date(at(DAY, '10:00')).toISOString()), 'busy slot excluded');
    assert.ok(r.body.every((s) => new Date(s.endAt) <= new Date(at(DAY, '16:00'))), 'within shift');
  });

  test('optimistic locking on reschedule', async () => {
    const bad = await api('PATCH', `/api/appointments/${apptA.id}/reschedule`, {
      token: tokens.front, body: { startAt: at(DAY, '11:00'), endAt: at(DAY, '11:45'), version: 99 },
    });
    assert.equal(bad.status, 409);
    assert.equal(bad.body.error.code, 'VERSION_MISMATCH');
    const ok = await api('PATCH', `/api/appointments/${apptA.id}/reschedule`, {
      token: tokens.front, body: { startAt: at(DAY, '11:00'), endAt: at(DAY, '11:45'), version: apptA.version },
    });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.appointment.version, apptA.version + 1);
    apptA = ok.body.appointment;
  });

  describe('Treatment flow + EMR + real-time equipment status', () => {
    test('cannot start without pre-assessment', async () => {
      await api('PATCH', `/api/appointments/${apptA.id}/status`, { token: tokens.front, body: { status: 'checked_in' } });
      const r = await api('PATCH', `/api/appointments/${apptA.id}/status`, { token: tokens.somchai, body: { status: 'in_progress' } });
      assert.equal(r.status, 422);
      assert.equal(r.body.error.code, 'PRE_ASSESSMENT_REQUIRED');
    });

    test('pre-assessment shows last visit for comparison', async () => {
      const r = await api('PUT', `/api/emr/appointments/${apptA.id}/pre`, {
        token: tokens.somchai,
        body: {
          pain_score: 4, pain_location: 'หลังส่วนล่าง', precautions_reviewed: true,
          vitals: { bp_sys: 128, bp_dia: 82, hr: 76 },
          rom: [{ joint: 'lumbar', movement: 'flexion', degrees: 45, normal_degrees: 60 }],
        },
      });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.pre.pain_score, 4);
      assert.equal(r.body.lastVisit.post_pain, 3);
      assert.ok(r.body.activePrecautions.some((p) => p.code === 'METAL_IMPLANT'));
    });

    test('in_progress -> equipment becomes in_use and SSE pushes the change', async () => {
      const ctrl = new AbortController();
      const stream = await fetch(`${base}/api/realtime/stream`, { headers: { Authorization: `Bearer ${tokens.front}` }, signal: ctrl.signal });
      const reader = stream.body.getReader();
      await reader.read(); // ": connected"

      const r = await api('PATCH', `/api/appointments/${apptA.id}/status`, { token: tokens.somchai, body: { status: 'in_progress' } });
      assert.equal(r.status, 200);

      let buf = '';
      const deadline = Date.now() + 3000;
      while (!buf.includes('event: equipment_status') && Date.now() < deadline) {
        const { value } = await reader.read();
        buf += new TextDecoder().decode(value);
      }
      ctrl.abort();
      assert.match(buf, /event: equipment_status/);
      assert.match(buf, /"to":"in_use"/);

      const e = await api('GET', `/api/equipment/${eq['EQ-IFC-001']}`, { token: tokens.front });
      assert.equal(e.body.status, 'in_use');
      assert.equal(e.body.statusLogs[0].to_status, 'in_use');
    });

    test('post note, sign, immutability, addendum', async () => {
      const r = await api('PUT', `/api/emr/appointments/${apptA.id}/post`, {
        token: tokens.somchai,
        body: {
          pain_score: 2, treatment_response: 'improved', home_program: 'Core stabilization',
          rom: [{ joint: 'lumbar', movement: 'flexion', degrees: 55, normal_degrees: 60 }],
          treatments: [{ equipment_id: eq['EQ-IFC-001'], intervention: 'IFC', duration_min: 20, parameters: { beat_hz: 100 } }],
        },
      });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const postId = r.body.post.id;
      assert.equal((await api('PUT', `/api/emr/appointments/${apptA.id}/post`, { token: tokens.supaporn, body: { pain_score: 1 } })).status, 403, 'only author edits draft');

      const signed = await api('POST', `/api/emr/assessments/${postId}/sign`, { token: tokens.somchai });
      assert.equal(signed.status, 200);
      const edit = await api('PUT', `/api/emr/appointments/${apptA.id}/post`, { token: tokens.somchai, body: { pain_score: 1 } });
      assert.equal(edit.status, 409);
      assert.equal(edit.body.error.code, 'EMR_LOCKED');
      // แม้แก้ตรงที่ DB ก็ถูก trigger กันไว้
      await assert.rejects(pool.query('UPDATE clinical_assessments SET pain_score = 0 WHERE id = $1', [postId]), /immutable/);
      const add = await api('POST', `/api/emr/assessments/${postId}/addenda`, { token: tokens.somchai, body: { content: 'ผู้ป่วยแจ้งอาการดีขึ้นทางโทรศัพท์' } });
      assert.equal(add.status, 201);
    });

    test('complete -> equipment returns to available', async () => {
      const r = await api('PATCH', `/api/appointments/${apptA.id}/status`, { token: tokens.somchai, body: { status: 'completed' } });
      assert.equal(r.status, 200);
      const e = await api('GET', `/api/equipment/${eq['EQ-IFC-001']}`, { token: tokens.front });
      assert.equal(e.body.status, 'available');
    });

    test('progress compares baseline vs latest', async () => {
      const r = await api('GET', `/api/emr/patients/${PAT.prasert}/progress`, { token: tokens.somchai });
      assert.equal(r.status, 200);
      const lum = r.body.romSeries.find((s) => s.joint === 'lumbar' && s.movement === 'flexion');
      assert.equal(lum.baseline, 20);
      assert.equal(lum.latest, 55);
      assert.equal(lum.changeFromBaseline, 35);
      assert.equal(r.body.summary.baselinePain, 8);
      assert.equal(r.body.summary.latestPain, 2);
    });

    test('invalid transition rejected', async () => {
      const r = await api('PATCH', `/api/appointments/${apptA.id}/status`, { token: tokens.front, body: { status: 'cancelled', reason: 'x' } });
      assert.equal(r.status, 422);
    });
  });
});

describe('Equipment master & maintenance', () => {
  test('mark broken -> lists affected bookings with substitutes + opens work order', async () => {
    const r = await api('PATCH', `/api/equipment/${eq['EQ-US-001']}/status`, { token: tokens.somchai, body: { status: 'broken', reason: 'หัว transducer ร้าว' } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.equipment.status, 'broken');
    assert.equal(r.body.affectedAppointments.length, 1);
    assert.equal(r.body.affectedAppointments[0].substitutes[0].asset_code, 'EQ-US-002');

    const d = await api('GET', `/api/equipment/${eq['EQ-US-001']}`, { token: tokens.front });
    const wo = d.body.maintenance.find((m) => m.status === 'scheduled' && m.problem === 'หัว transducer ร้าว');
    assert.ok(wo);
    const done = await api('PATCH', `/api/equipment/maintenance/${wo.id}`, { token: tokens.front, body: { status: 'completed', result: 'replaced_part', cost: 12000 } });
    assert.equal(done.status, 200);
    const after = await api('GET', `/api/equipment/${eq['EQ-US-001']}`, { token: tokens.front });
    assert.equal(after.body.status, 'available');
    assert.ok(after.body.next_maintenance_due > new Date().toISOString().slice(0, 10));
  });

  test('in_use cannot be set manually', async () => {
    const r = await api('PATCH', `/api/equipment/${eq['EQ-LSR-001']}/status`, { token: tokens.front, body: { status: 'in_use' } });
    assert.equal(r.status, 400);
  });

  test('scheduled maintenance window blocks bookings', async () => {
    const m = await api('POST', `/api/equipment/${eq['EQ-LSR-001']}/maintenance`, {
      token: tokens.front, body: { type: 'calibration', plannedStart: at(DAY, '08:00'), plannedEnd: at(DAY, '12:00') },
    });
    assert.equal(m.status, 201);
    const r = await api('POST', '/api/scheduling/check', {
      token: tokens.front,
      body: { patientId: PAT.poom, therapistId: PT.somchai, startAt: at(DAY, '08:00'), endAt: at(DAY, '08:45'), equipmentIds: [eq['EQ-LSR-001']] },
    });
    assert.equal(r.body.ok, false);
    assert.ok(r.body.conflicts.some((c) => c.type === 'EQUIPMENT_MAINTENANCE_WINDOW'));
  });
});

describe('Staff master', () => {
  test('list specialties and bulk-create shifts without overlaps', async () => {
    const s = await api('GET', '/api/staff?specialty=NEURO', { token: tokens.front });
    assert.deepEqual(s.body.map((x) => x.employee_code).sort(), ['PT002', 'PT003']);
    const from = nextWorkday(25);
    const r = await api('POST', `/api/staff/${PT.nattida}/shifts`, { token: tokens.front, body: { templateCode: 'MORNING', from, to: from, weekdays: [1, 2, 3, 4, 5, 6] } });
    assert.equal(r.status, 201);
    assert.equal(r.body.created, 1);
    const again = await api('POST', `/api/staff/${PT.nattida}/shifts`, { token: tokens.front, body: { templateCode: 'HALF_AM', from, to: from, weekdays: [1, 2, 3, 4, 5, 6] } });
    assert.equal(again.body.created, 0, 'overlapping shift skipped');
  });

  test('leave flags affected appointments and blocks new bookings', async () => {
    const leave = await api('POST', `/api/staff/${PT.supaporn}/leaves`, {
      token: tokens.front, body: { startAt: at(DAY, '12:30'), endAt: at(DAY, '16:00'), leaveType: 'sick' },
    });
    assert.equal(leave.status, 201);
    assert.equal(leave.body.affectedAppointments.length, 1, 'the 13:00 booking');
    const r = await api('POST', '/api/scheduling/check', {
      token: tokens.front, body: { patientId: PAT.poom, therapistId: PT.supaporn, startAt: at(DAY, '14:00'), endAt: at(DAY, '14:45') },
    });
    assert.ok(r.body.conflicts.some((c) => c.type === 'STAFF_ON_LEAVE'));
  });
});

describe('Media (images)', () => {
  const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

  test('upload, serve with auth, reject fake image', async () => {
    const fd = new FormData();
    fd.append('images', new Blob([PNG], { type: 'image/png' }), 'eq.png');
    fd.append('caption', 'ด้านหน้าเครื่อง');
    const up = await api('POST', `/api/media/equipment/${eq['EQ-TM-001']}`, { token: tokens.front, raw: fd });
    assert.equal(up.status, 201, JSON.stringify(up.body));
    assert.equal(up.body[0].is_primary, true);

    const img = await fetch(base + up.body[0].url, { headers: { Authorization: `Bearer ${tokens.somchai}` } });
    assert.equal(img.status, 200);
    assert.equal(img.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await img.arrayBuffer()), PNG);
    assert.equal((await fetch(base + up.body[0].url, { headers: { Authorization: `Bearer ${tokens.patient}` } })).status, 403);

    const bad = new FormData();
    bad.append('images', new Blob(['<script>alert(1)</script>'], { type: 'image/png' }), 'x.png');
    const r = await api('POST', `/api/media/equipment/${eq['EQ-TM-001']}`, { token: tokens.front, raw: bad });
    assert.equal(r.status, 400);
  });

  test('patient photo upload requires patients:write; EMR images need emr permission', async () => {
    const fd = new FormData();
    fd.append('images', new Blob([PNG], { type: 'image/png' }), 'p.png');
    const r = await api('POST', `/api/media/staff/${PT.somchai}`, { token: tokens.somchai, raw: fd });
    assert.equal(r.status, 403, 'therapist has no staff:write');
  });
});
