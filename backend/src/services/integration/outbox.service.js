/**
 * ส่งข้อมูลกลับ HIS จากคิว integration_outbox (เติมคิวด้วย trigger ในฐานข้อมูล)
 *
 * - สร้าง FHIR resource จากข้อมูลล่าสุด ณ เวลาส่ง (ไม่เก็บสำเนาข้อมูลผู้ป่วยในคิว)
 * - ส่งแบบ conditional update: PUT [base]/Appointment?identifier=system|id → HIS สร้างหรืออัปเดตเอง (ส่งซ้ำได้ ไม่เกิดข้อมูลซ้ำ)
 * - ล้มเหลว → ลองใหม่แบบ exponential backoff (1, 2, 4 … สูงสุด 6 ชม.) ครบ 10 ครั้ง → dead (ผู้ดูแลกดส่งใหม่ได้)
 */
const db = require('../../db');
const fhir = require('./fhir');
const { authHeaders } = require('./sync.service');

const MAX_ATTEMPTS = 10;
const LEASE_MIN = 5;

async function refsFor(connectorId, pairs) {
  const out = {};
  for (const [name, entity, id] of pairs) {
    if (!id) continue;
    const { rows: [r] } = await db.query(
      'SELECT external_id FROM external_refs WHERE connector_id = $1 AND entity_type = $2 AND local_id = $3', [connectorId, entity, id]);
    if (r) out[name] = r.external_id;
  }
  return out;
}

async function buildResource(job, connector) {
  const settings = connector.settings || {};
  if (job.resource_type === 'Appointment') {
    const { rows: [a] } = await db.query(
      `SELECT a.*, p.hn, p.first_name || ' ' || p.last_name AS patient_name,
              s.title || s.first_name || ' ' || s.last_name AS therapist_name, s.license_no,
              d.icd10_code, d.name_en AS diagnosis_name, rm.name AS room_name, bd.name AS bed_name
         FROM appointments a JOIN patients p ON p.id = a.patient_id JOIN staff s ON s.id = a.therapist_id
         LEFT JOIN diagnoses d ON d.id = a.diagnosis_id LEFT JOIN rooms rm ON rm.id = a.room_id LEFT JOIN beds bd ON bd.id = a.bed_id
        WHERE a.id = $1`, [job.entity_id]);
    if (!a) return null;
    const refs = await refsFor(connector.id, [['patient', 'patient', a.patient_id], ['staff', 'staff', a.therapist_id], ['room', 'room', a.room_id], ['bed', 'bed', a.bed_id]]);
    return { resource: fhir.buildAppointment(a, refs, settings), identifier: `${fhir.localSystem(settings, 'appointment')}|${a.id}` };
  }
  if (job.resource_type === 'Observation') {
    const { rows: [x] } = await db.query(
      `SELECT ca.id, ca.phase, ca.pain_score, ca.pain_location, ca.signed_at, ca.patient_id, ca.therapist_id,
              p.hn, p.first_name || ' ' || p.last_name AS patient_name,
              s.title || s.first_name || ' ' || s.last_name AS therapist_name, s.license_no
         FROM clinical_assessments ca JOIN patients p ON p.id = ca.patient_id JOIN staff s ON s.id = ca.therapist_id
        WHERE ca.id = $1 AND ca.signed_at IS NOT NULL`, [job.entity_id]);
    if (!x || x.pain_score === null) return null;
    const refs = await refsFor(connector.id, [['patient', 'patient', x.patient_id], ['staff', 'staff', x.therapist_id]]);
    return { resource: fhir.buildPainObservation(x, refs, settings), identifier: `${fhir.localSystem(settings, 'assessment')}|${x.id}-pain` };
  }
  return null;
}

/** จองงานที่ถึงเวลา (lease 5 นาที กันหลาย instance ส่งซ้ำ) แล้วส่งทีละงาน */
async function processOutbox({ limit = 20, connectorId = null } = {}) {
  const { rows: jobs } = await db.query(
    `UPDATE integration_outbox o SET next_attempt_at = now() + interval '${LEASE_MIN} minutes'
      WHERE o.id IN (
        SELECT o2.id FROM integration_outbox o2 JOIN integration_connectors c ON c.id = o2.connector_id
         WHERE o2.status IN ('pending','failed') AND o2.next_attempt_at <= now() AND c.is_enabled AND c.base_url IS NOT NULL
           AND ($2::smallint IS NULL OR o2.connector_id = $2)
         ORDER BY o2.id LIMIT $1 FOR UPDATE OF o2 SKIP LOCKED)
      RETURNING o.*`, [limit, connectorId]);
  const summary = { processed: jobs.length, sent: 0, failed: 0, skipped: 0 };
  const connectors = new Map();
  for (const job of jobs) {
    if (!connectors.has(job.connector_id)) {
      connectors.set(job.connector_id, (await db.query('SELECT * FROM integration_connectors WHERE id = $1', [job.connector_id])).rows[0]);
    }
    const connector = connectors.get(job.connector_id);
    try {
      const built = await buildResource(job, connector);
      if (!built) {
        await db.query("UPDATE integration_outbox SET status = 'sent', sent_at = now(), last_error = 'ไม่มีข้อมูลให้ส่ง' WHERE id = $1", [job.id]);
        summary.skipped++;
        continue;
      }
      const url = `${connector.base_url.replace(/\/+$/, '')}/${job.resource_type}?identifier=${encodeURIComponent(built.identifier)}`;
      const res = await fetch(url, {
        method: 'PUT',
        headers: { ...authHeaders(connector), 'Content-Type': 'application/fhir+json' },
        body: JSON.stringify(built.resource),
        signal: AbortSignal.timeout(20_000),
        redirect: 'error',
      });
      if (!res.ok) {
        const text = (await res.text().catch(() => '')).slice(0, 300);
        const err = new Error(`HTTP ${res.status}${text ? `: ${text}` : ''}`);
        err.status = res.status;
        throw err;
      }
      await db.query("UPDATE integration_outbox SET status = 'sent', sent_at = now(), attempts = attempts + 1, response_status = $2, last_error = NULL WHERE id = $1",
        [job.id, res.status]);
      summary.sent++;
    } catch (e) {
      const attempts = job.attempts + 1;
      const dead = attempts >= MAX_ATTEMPTS || e.status === 400 || e.status === 422; // ข้อมูลผิดรูปแบบ ส่งซ้ำก็ไม่ผ่าน
      const delayMin = Math.min(360, 2 ** (attempts - 1));
      await db.query(
        `UPDATE integration_outbox SET status = $2, attempts = $3, last_error = $4, response_status = $5,
                next_attempt_at = now() + make_interval(mins => $6) WHERE id = $1`,
        [job.id, dead ? 'dead' : 'failed', attempts, e.message.slice(0, 500), e.status || null, delayMin]);
      summary.failed++;
    }
  }
  return summary;
}

let timer = null;
function startWorker(intervalMs = 15_000) {
  if (timer) return;
  let busy = false;
  timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try { await processOutbox(); } catch (e) { console.error('[integration] outbox', e.message); } finally { busy = false; }
  }, intervalMs);
  timer.unref();
}
function stopWorker() { clearInterval(timer); timer = null; }

module.exports = { processOutbox, startWorker, stopWorker, buildResource };
