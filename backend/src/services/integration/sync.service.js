/**
 * นำเข้าข้อมูลจาก HIS (FHIR R4) แบบไม่สร้างข้อมูลซ้ำ
 *
 * ทุกรายการผ่าน 3 ขั้น:
 *   1) เคยซิงก์แล้ว (external_refs) → อัปเดตเฉพาะฟิลด์ที่ HIS เป็นเจ้าของ / ข้ามถ้าไม่เปลี่ยน (content hash)
 *   2) ยังไม่เคยซิงก์ แต่มี record เดิมในระบบที่ตรงกัน (รหัสห้อง/เตียง, เลขใบอนุญาต, รหัสครุภัณฑ์, HN) → ผูกกัน (linked)
 *   3) ไม่พบ → สร้างใหม่ (created)
 * ทั้งชุดอยู่ใน transaction เดียว แต่ละรายการมี SAVEPOINT — รายการที่ผิดไม่ทำให้รายการอื่นล้ม
 * dry-run = ทำทุกอย่างจริงแล้ว ROLLBACK (ผลลัพธ์ตรงกับการนำเข้าจริงทุกประการ)
 */
const crypto = require('node:crypto');
const db = require('../../db');
const fhir = require('./fhir');

const ORDER = { floor: 0, room: 1, bed: 2, Practitioner: 3, Device: 4, Patient: 5, Condition: 6, ServiceRequest: 7 };
const INBOUND_FLAG = {
  Location: 'locations', Practitioner: 'practitioners', Device: 'devices', Patient: 'patients', Condition: 'conditions', ServiceRequest: 'serviceRequests',
};
const SUPPORTED = Object.keys(INBOUND_FLAG);
const sha = (o) => crypto.createHash('sha256').update(JSON.stringify(o)).digest('hex').slice(0, 32);

/** Bundle / resource เดี่ยว / array → รายการ { resource, key, fullUrl } */
function flatten(input) {
  const list = [];
  const add = (r, fullUrl) => {
    if (!r || typeof r !== 'object') return;
    if (r.resourceType === 'Bundle') { for (const e of r.entry || []) add(e.resource, e.fullUrl); return; }
    if (!r.resourceType) return;
    const key = r.id ? `${r.resourceType}/${r.id}` : fullUrl;
    list.push({ resource: r, key, fullUrl });
  };
  if (Array.isArray(input)) input.forEach((r) => add(r)); else add(input);
  return list;
}

function sortKey(item) {
  const r = item.resource;
  if (r.resourceType === 'Location') return ORDER[fhir.locationKind(r)];
  return ORDER[r.resourceType] ?? 99;
}

class ItemError extends Error {}

async function importResources(connector, input, { dryRun = false, mode = 'manual', userId = null } = {}) {
  const settings = connector.settings || {};
  const items = flatten(input).sort((a, b) => sortKey(a) - sortKey(b));
  const stats = { total: items.length, created: 0, updated: 0, linked: 0, unchanged: 0, skipped: 0, failed: 0 };
  const results = [];
  const errors = [];
  const { rows: [run] } = await db.query(
    'INSERT INTO integration_runs (connector_id, mode, dry_run, started_by) VALUES ($1,$2,$3,$4) RETURNING id',
    [connector.id, mode, dryRun, userId]);

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT id FROM integration_connectors WHERE id = $1 FOR UPDATE', [connector.id]); // ทีละชุดต่อ connector
    if (userId) await client.query("SELECT set_config('app.user_id', $1, true)", [userId]);
    const ctx = await makeContext(client, connector, items);
    for (const item of items) {
      const { resource: r, key } = item;
      const flag = INBOUND_FLAG[r.resourceType];
      if (!flag) { stats.skipped++; results.push({ key, action: 'skipped', note: 'ไม่รองรับ resource นี้' }); continue; }
      if (settings.inbound?.[flag] === false) { stats.skipped++; results.push({ key, action: 'skipped', note: 'ปิดการรับข้อมูลประเภทนี้ไว้' }); continue; }
      await client.query('SAVEPOINT item');
      try {
        const res = await HANDLERS[r.resourceType](client, ctx, r, key);
        await client.query('RELEASE SAVEPOINT item');
        stats[res.action]++;
        results.push({ key, ...res });
      } catch (e) {
        await client.query('ROLLBACK TO SAVEPOINT item');
        stats.failed++;
        const message = e instanceof ItemError ? e.message : `${e.message}${e.detail ? ` (${e.detail})` : ''}`;
        errors.push({ key, message });
        results.push({ key, action: 'failed', note: message });
      }
    }
    // ห้องที่ HIS สร้าง: ความจุอย่างน้อยเท่าจำนวนเตียง (ความจุเป็นข้อมูลของระบบกายภาพ ปรับเองได้ภายหลัง)
    if (ctx.createdRooms.size) {
      await client.query(
        `UPDATE rooms r SET capacity = GREATEST(r.capacity, LEAST(100, (SELECT count(*) FROM beds b WHERE b.room_id = r.id AND b.is_active)))
          WHERE r.id = ANY($1)`, [[...ctx.createdRooms]]);
    }
    await client.query(dryRun ? 'ROLLBACK' : 'COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    await db.query("UPDATE integration_runs SET status = 'failed', finished_at = now(), errors = $2 WHERE id = $1",
      [run.id, JSON.stringify([{ message: e.message }])]);
    throw e;
  } finally {
    client.release();
  }
  const status = stats.failed === 0 ? 'success' : stats.failed === stats.total ? 'failed' : 'partial';
  await db.query('UPDATE integration_runs SET status = $2, stats = $3, errors = $4, finished_at = now() WHERE id = $1',
    [run.id, status, JSON.stringify(stats), JSON.stringify(errors.slice(0, 200))]);
  return { runId: run.id, dryRun, status, stats, errors: errors.slice(0, 200), items: results.slice(0, 500) };
}

async function makeContext(client, connector, items) {
  const [cats, dx] = await Promise.all([
    client.query('SELECT id, code, name_th, name_en FROM equipment_categories'),
    client.query('SELECT id, icd10_code FROM diagnoses'),
  ]);
  const byFullUrl = new Map(items.filter((i) => i.fullUrl).map((i) => [i.fullUrl, i.key]));
  return {
    connector,
    settings: connector.settings || {},
    categories: cats.rows,
    dxByCode: new Map(dx.rows.map((d) => [d.icd10_code, d.id])),
    knownCodes: new Set(dx.rows.map((d) => d.icd10_code)),
    byFullUrl,
    createdRooms: new Set(),
  };
}

// ------------------------------------------------------------------ helpers
async function findRef(client, ctx, entity, externalId) {
  const { rows: [r] } = await client.query(
    'SELECT local_id, content_hash, detail FROM external_refs WHERE connector_id = $1 AND entity_type = $2 AND external_id = $3',
    [ctx.connector.id, entity, externalId]);
  return r || null;
}

async function saveRef(client, ctx, entity, externalId, localId, hash, detail = null) {
  await client.query(
    `INSERT INTO external_refs (connector_id, entity_type, local_id, external_id, content_hash, detail)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (connector_id, entity_type, external_id)
     DO UPDATE SET local_id = EXCLUDED.local_id, content_hash = EXCLUDED.content_hash, detail = EXCLUDED.detail, synced_at = now()`,
    [ctx.connector.id, entity, localId, externalId, hash, detail ? JSON.stringify(detail) : null]);
}

/** reference → key ภายนอก (รองรับ "Type/id", URL เต็ม และ urn:uuid ภายใน Bundle เดียวกัน) */
function refKey(ctx, ref) {
  if (!ref?.reference) return null;
  const s = ref.reference;
  if (ctx.byFullUrl.has(s)) return ctx.byFullUrl.get(s);
  const m = s.match(/([A-Za-z]+\/[^/]+)(\/_history\/[^/]+)?$/);
  return m ? m[1] : s;
}

async function resolveLocal(client, ctx, entity, ref) {
  const key = refKey(ctx, ref);
  if (!key) return null;
  return (await findRef(client, ctx, entity, key))?.local_id || null;
}

async function resolvePatient(client, ctx, ref) {
  if (!ref) return null;
  const viaRef = await resolveLocal(client, ctx, 'patient', ref);
  if (viaRef) return viaRef;
  const hn = ref.identifier?.value;
  if (hn) return (await client.query('SELECT id FROM patients WHERE hn = $1', [hn])).rows[0]?.id || null;
  return null;
}

/**
 * upsert กลาง: data = เฉพาะคอลัมน์ที่ HIS เป็นเจ้าของ, defaults = ค่าเริ่มต้นตอนสร้างใหม่เท่านั้น
 * match = [[คอลัมน์, ค่า], …] ใช้หา record เดิมที่ยังไม่ผูก
 */
async function upsert(client, ctx, { entity, table, key, data, defaults = {}, match = [], label, managed = true }) {
  const hash = sha(data);
  const cols = Object.keys(data);
  const existing = await findRef(client, ctx, entity, key);
  const managedSet = managed ? ', managed_by = $2' : '';
  const update = async (id) => {
    const params = [id, ctx.connector.code, ...cols.map((c) => data[c])];
    const { rowCount } = await client.query(
      `UPDATE ${table} SET ${cols.map((c, i) => `${c} = $${i + 3}`).join(', ')}${managed ? managedSet : ''} WHERE id = $1${managed ? '' : ' AND $2::text IS NOT NULL'}`,
      params);
    return rowCount;
  };
  if (existing?.local_id) {
    if (existing.content_hash === hash) return { action: 'unchanged', id: existing.local_id, label };
    if (await update(existing.local_id)) {
      await saveRef(client, ctx, entity, key, existing.local_id, hash);
      return { action: 'updated', id: existing.local_id, label };
    }
    // record ถูกลบไปแล้ว → สร้างใหม่ด้านล่าง
  }
  for (const [col, val] of match) {
    if (val === null || val === undefined || val === '') continue;
    const { rows: [hit] } = await client.query(`SELECT id FROM ${table} WHERE ${col} = $1`, [val]);
    if (!hit) continue;
    const { rows: [other] } = await client.query(
      'SELECT external_id FROM external_refs WHERE connector_id = $1 AND entity_type = $2 AND local_id = $3',
      [ctx.connector.id, entity, hit.id]);
    if (other && other.external_id !== key) throw new ItemError(`${label}: ${col} "${val}" ผูกกับ ${other.external_id} อยู่แล้ว (ข้อมูลใน HIS ซ้ำกัน?)`);
    await update(hit.id);
    await saveRef(client, ctx, entity, key, hit.id, hash);
    return { action: 'linked', id: hit.id, label, note: `ผูกกับข้อมูลเดิมด้วย ${col}` };
  }
  const all = { ...defaults, ...data, ...(managed ? { managed_by: ctx.connector.code } : {}) };
  const keys = Object.keys(all);
  const { rows: [row] } = await client.query(
    `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
    keys.map((k) => all[k]));
  await saveRef(client, ctx, entity, key, row.id, hash);
  return { action: 'created', id: row.id, label };
}

// ------------------------------------------------------------------ handlers
const HANDLERS = {
  async Location(client, ctx, r, key) {
    const m = fhir.mapLocation(r, ctx.settings);
    if (m.kind === 'floor') {
      const prev = await findRef(client, ctx, 'floor', key);
      const detail = { name: m.name };
      const hash = sha(detail);
      await saveRef(client, ctx, 'floor', key, null, hash, detail);
      return { action: prev ? (prev.content_hash === hash ? 'unchanged' : 'updated') : 'created', label: `ชั้น ${m.name}` };
    }
    if (m.kind === 'room') {
      let floor = null;
      if (m.partOf) {
        const fk = refKey(ctx, m.partOf);
        floor = (await findRef(client, ctx, 'floor', fk))?.detail?.name || m.partOf.display || null;
      }
      const res = await upsert(client, ctx, {
        entity: 'room', table: 'rooms', key, label: `ห้อง ${m.code} ${m.name}`,
        data: { code: m.code, name: m.name, floor, is_active: m.active },
        defaults: { room_type: m.roomType || 'treatment', capacity: 1 },
        match: [['code', m.code]],
      });
      if (res.action === 'created') ctx.createdRooms.add(res.id);
      return res;
    }
    // bed
    const roomId = await resolveLocal(client, ctx, 'room', m.partOf);
    if (!roomId) throw new ItemError(`เตียง ${m.code}: ไม่พบห้อง (partOf) — ส่ง Location ของห้องมาก่อนหรือในชุดเดียวกัน`);
    const data = { code: m.code, name: m.name, room_id: roomId, is_active: m.active };
    if (ctx.settings.inbound?.bedStatus) data.status = m.bedStatus;
    return upsert(client, ctx, {
      entity: 'bed', table: 'beds', key, label: `เตียง ${m.code}`, data, defaults: { bed_type: 'standard' }, match: [['code', m.code]],
    });
  },

  async Practitioner(client, ctx, r, key) {
    const d = fhir.mapPractitioner(r, ctx.settings);
    if (!d.first_name) throw new ItemError('Practitioner ไม่มีชื่อ');
    return upsert(client, ctx, {
      entity: 'staff', table: 'staff', key, label: `${d.title || ''}${d.first_name} ${d.last_name}`, data: d,
      match: [['license_no', d.license_no], ['employee_code', d.employee_code]],
    });
  },

  async Device(client, ctx, r, key) {
    const m = fhir.mapDevice(r, ctx.settings, ctx.categories);
    const ref = await findRef(client, ctx, 'equipment', key);
    if (!m.category && !ref) {
      throw new ItemError(`อุปกรณ์ ${m.data.name}: จับคู่หมวดอุปกรณ์ไม่ได้ (${r.type?.text || r.type?.coding?.[0]?.code || 'ไม่มี type'}) — ตั้งค่า deviceCategoryMap`);
    }
    const data = { ...m.data };
    if (!m.category) delete data.category_id; // record เดิม: คงหมวดที่ตั้งไว้
    const defaults = {};
    if (m.location) {
      const roomId = await resolveLocal(client, ctx, 'room', m.location);
      if (roomId) defaults.room_id = roomId; // ติดตั้งประจำห้อง (ตั้งตอนสร้างเท่านั้น ระบบกายภาพปรับต่อได้)
    }
    const res = await upsert(client, ctx, {
      entity: 'equipment', table: 'equipment', key, label: `อุปกรณ์ ${data.asset_code} ${data.name}`, data, defaults,
      match: [['asset_code', data.asset_code], ['serial_no', data.serial_no]],
    });
    // สถานะการใช้งานเป็นของระบบกายภาพ — HIS แจ้งได้เฉพาะ "ปลดระวาง"
    if (m.retired) await client.query("UPDATE equipment SET status = 'retired' WHERE id = $1 AND status <> 'in_use'", [res.id]);
    else await client.query("UPDATE equipment SET status = 'available' WHERE id = $1 AND status = 'retired'", [res.id]);
    return res;
  },

  async Patient(client, ctx, r, key) {
    const d = fhir.mapPatient(r, ctx.settings);
    if (!d.hn) throw new ItemError('Patient ไม่มี HN (identifier)');
    if (!d.first_name) throw new ItemError(`HN ${d.hn}: ไม่มีชื่อ`);
    return upsert(client, ctx, {
      entity: 'patient', table: 'patients', key, label: `ผู้ป่วย HN ${d.hn}`, data: d, match: [['hn', d.hn]],
    });
  },

  async Condition(client, ctx, r, key) {
    const m = fhir.mapCondition(r, ctx.knownCodes);
    const patientId = await resolvePatient(client, ctx, m.subject);
    if (!patientId) throw new ItemError('Condition: ไม่พบผู้ป่วย (ส่ง Patient มาก่อนหรือในชุดเดียวกัน)');
    if (!m.icd10) return { action: 'skipped', note: `รหัส ${m.rawCode || '-'} ไม่อยู่ในรายการโรคของระบบกายภาพ` };
    const diagnosisId = ctx.dxByCode.get(m.icd10);
    const { rows: [hasPrimary] } = await client.query('SELECT 1 FROM patient_diagnoses WHERE patient_id = $1 AND is_primary', [patientId]);
    const ref = await findRef(client, ctx, 'patient_diagnosis', key);
    let match = [];
    if (!ref) {
      const { rows: [same] } = await client.query('SELECT id FROM patient_diagnoses WHERE patient_id = $1 AND diagnosis_id = $2 LIMIT 1', [patientId, diagnosisId]);
      if (same) match = [['id', same.id]];
    }
    return upsert(client, ctx, {
      entity: 'patient_diagnosis', table: 'patient_diagnoses', key, label: `การวินิจฉัย ${m.icd10}`, managed: false,
      data: { patient_id: patientId, diagnosis_id: diagnosisId, status: m.status, onset_date: m.onset_date },
      defaults: { is_primary: !hasPrimary, referred_by: ctx.connector.name },
      match,
    });
  },

  async ServiceRequest(client, ctx, r, key) {
    const m = fhir.mapServiceRequest(r, ctx.knownCodes);
    const patientId = await resolvePatient(client, ctx, m.subject);
    if (!patientId) throw new ItemError('ServiceRequest: ไม่พบผู้ป่วย (ส่ง Patient มาก่อนหรือในชุดเดียวกัน)');
    let diagnosisId = m.icd10 ? ctx.dxByCode.get(m.icd10) : null;
    if (!diagnosisId && m.reasonReference) {
      const pdId = await resolveLocal(client, ctx, 'patient_diagnosis', m.reasonReference);
      if (pdId) diagnosisId = (await client.query('SELECT diagnosis_id FROM patient_diagnoses WHERE id = $1', [pdId])).rows[0]?.diagnosis_id || null;
    }
    const data = {
      patient_id: patientId, diagnosis_id: diagnosisId, requester: m.requester, priority: m.priority,
      sessions_requested: m.sessions_requested, note: m.note, authored_at: m.authored_at,
    };
    // ใบส่งเดิมที่ตรงกัน (ผู้ป่วย + เวลาสั่ง + แพทย์) → ผูกแทนการสร้างซ้ำ
    let match = [];
    if (m.authored_at && !(await findRef(client, ctx, 'referral', key))) {
      const { rows: [same] } = await client.query(
        "SELECT id FROM referrals WHERE patient_id = $1 AND authored_at = $2 AND COALESCE(requester, '') = COALESCE($3, '') LIMIT 1",
        [patientId, m.authored_at, m.requester]);
      if (same) match = [['id', same.id]];
    }
    const res = await upsert(client, ctx, { entity: 'referral', table: 'referrals', key, label: `ใบส่งกายภาพ ${m.requester || ''}`.trim(), data, match });
    // สถานะงานเป็นของระบบกายภาพ — HIS ยกเลิกได้ / ปิดงานได้
    if (m.cancelled) await client.query("UPDATE referrals SET status = 'cancelled' WHERE id = $1 AND status <> 'completed'", [res.id]);
    else if (m.completed) await client.query("UPDATE referrals SET status = 'completed' WHERE id = $1", [res.id]);
    return res;
  },
};

// ------------------------------------------------------------------ pull (PhysioCare ดึงจาก HIS)
function authHeaders(connector) {
  const h = { Accept: 'application/fhir+json, application/json' };
  const token = connector.auth_secret_env ? process.env[connector.auth_secret_env] : null;
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

async function fetchJson(connector, url) {
  const res = await fetch(url, { headers: authHeaders(connector), signal: AbortSignal.timeout(20_000), redirect: 'error' });
  if (!res.ok) throw new Error(`${new URL(url).pathname} → HTTP ${res.status}`);
  return res.json();
}

const DEFAULT_PULL = ['Location', 'Practitioner', 'Device', 'ServiceRequest'];
const DEFAULT_QUERY = { ServiceRequest: 'status=active&_include=ServiceRequest:subject' };

async function pull(connector, { resources, dryRun = false, userId = null, maxPages = 50 } = {}) {
  if (!connector.base_url) throw new Error('ยังไม่ได้ตั้ง base URL ของ HIS');
  const base = connector.base_url.replace(/\/+$/, '');
  const origin = new URL(base).origin;
  const settings = connector.settings || {};
  const types = (resources?.length ? resources : settings.pull?.resources || DEFAULT_PULL).filter((t) => SUPPORTED.includes(t));
  const collected = [];
  const newest = {};
  for (const type of types) {
    const { rows: [cur] } = await db.query('SELECT last_updated FROM integration_cursors WHERE connector_id = $1 AND resource_type = $2', [connector.id, type]);
    const q = new URLSearchParams(settings.pull?.queries?.[type] ?? DEFAULT_QUERY[type] ?? '');
    q.set('_count', '100');
    if (cur) q.set('_lastUpdated', `gt${cur.last_updated.toISOString()}`);
    let url = `${base}/${type}?${q}`;
    for (let page = 0; url && page < maxPages; page++) {
      const bundle = await fetchJson(connector, url);
      for (const e of bundle.entry || []) {
        if (!e.resource) continue;
        collected.push(e.resource);
        const lu = e.resource.meta?.lastUpdated;
        if (e.resource.resourceType === type && lu && (!newest[type] || lu > newest[type])) newest[type] = lu;
      }
      const next = (bundle.link || []).find((l) => l.relation === 'next')?.url;
      // ตามลิงก์หน้าถัดไปเฉพาะเซิร์ฟเวอร์เดียวกัน (กัน HIS ชี้ไปที่อื่น)
      url = next && new URL(next, base).origin === origin ? new URL(next, base).toString() : null;
    }
  }
  const result = await importResources(connector, collected, { dryRun, mode: 'pull', userId });
  if (!dryRun && result.status !== 'failed') {
    for (const [type, lu] of Object.entries(newest)) {
      await db.query(
        `INSERT INTO integration_cursors (connector_id, resource_type, last_updated) VALUES ($1,$2,$3)
         ON CONFLICT (connector_id, resource_type) DO UPDATE SET last_updated = GREATEST(integration_cursors.last_updated, EXCLUDED.last_updated)`,
        [connector.id, type, lu]);
    }
  }
  return { ...result, pulled: Object.fromEntries(types.map((t) => [t, collected.filter((r) => r.resourceType === t).length])) };
}

async function testConnection(connector) {
  if (!connector.base_url) throw new Error('ยังไม่ได้ตั้ง base URL ของ HIS');
  const meta = await fetchJson(connector, `${connector.base_url.replace(/\/+$/, '')}/metadata`);
  return { ok: true, fhirVersion: meta.fhirVersion || null, software: meta.software?.name || null, resourceType: meta.resourceType };
}

module.exports = { importResources, pull, testConnection, flatten, SUPPORTED, authHeaders };
