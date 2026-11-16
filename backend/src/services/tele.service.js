/**
 * วิดีโอคอลติดตามผล (telerehab)
 *
 * ภาพ/เสียงวิ่งตรงระหว่างเบราว์เซอร์ (WebRTC, เข้ารหัส DTLS-SRTP เสมอ) — server ทำหน้าที่แค่ "ส่งต่อสัญญาณ"
 * (SDP offer/answer + ICE candidate) ระหว่างนักกายภาพกับผู้ป่วยในห้องเดียวกัน ไม่ผ่านและไม่บันทึกภาพ/เสียง
 *
 *   ผู้ป่วยเข้าห้องด้วยลิงก์ /call#t=<token> (เก็บ token แบบ hash, และแบบเข้ารหัสไว้แนบใน LINE)
 *   นักกายภาพเป็นฝ่ายเริ่มเชื่อมต่อ (สร้าง offer) ทุกครั้งที่อีกฝ่ายเข้าห้อง → เชื่อมใหม่ได้เองเมื่อหลุด
 *
 * ห้องสัญญาณเก็บในหน่วยความจำ: ใช้กับ instance เดียว (Railway ค่าเริ่มต้น) — ถ้าขยายหลาย instance ต้องเปิด sticky session
 * NAT ที่เข้มงวด (เช่น เครือข่ายมือถือบางราย) ต้องมี TURN server: ตั้ง TURN_URLS + (TURN_USERNAME/TURN_CREDENTIAL หรือ TURN_SECRET)
 */
const crypto = require('node:crypto');
const db = require('../db');
const config = require('../config');
const { badRequest, notFound, conflict, AppError } = require('../errors');

const TZ = 'Asia/Bangkok';
const hashToken = (t) => crypto.createHash('sha256').update(t).digest('hex');
const notify = () => require('./notify.service');

// ------------------------------------------------------------------ ICE servers
function iceServers(sessionId) {
  const env = process.env;
  const stun = (env.TELE_STUN_URLS ?? 'stun:stun.l.google.com:19302').split(',').map((s) => s.trim()).filter(Boolean);
  const out = stun.length ? [{ urls: stun }] : [];
  const turn = (env.TURN_URLS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (turn.length) {
    if (env.TURN_SECRET) {
      // coturn "use-auth-secret": รหัสชั่วคราวอายุ 2 ชั่วโมง
      const username = `${Math.floor(Date.now() / 1000) + 2 * 3600}:${sessionId}`;
      const credential = crypto.createHmac('sha1', env.TURN_SECRET).update(username).digest('base64');
      out.push({ urls: turn, username, credential });
    } else {
      out.push({ urls: turn, username: env.TURN_USERNAME || undefined, credential: env.TURN_CREDENTIAL || undefined });
    }
  }
  return out;
}
const turnConfigured = () => Boolean(process.env.TURN_URLS);

// ------------------------------------------------------------------ settings / helpers
async function settings() {
  const { rows } = await db.query("SELECT key, value FROM system_settings WHERE key LIKE 'tele.%'");
  const s = Object.fromEntries(rows.map((r) => [r.key, Number(r.value)]));
  return {
    reminderMinutes: Number.isFinite(s['tele.reminder_minutes']) ? s['tele.reminder_minutes'] : 15,
    earlyMinutes: Number.isFinite(s['tele.join_early_minutes']) ? s['tele.join_early_minutes'] : 15,
  };
}

function urlFor(token) {
  const path = `/call#t=${token}`;
  return config.appBaseUrl ? `${config.appBaseUrl.replace(/\/+$/, '')}${path}` : path;
}

/** ลิงก์ของผู้ป่วยจาก token ที่เก็บแบบเข้ารหัส (ใช้แนบใน LINE) */
function storedUrl(row) {
  const tok = row.token_enc ? notify().decToken(row.token_enc) : null;
  return tok ? urlFor(tok) : null;
}

const SELECT = `
  SELECT t.*, p.first_name || ' ' || p.last_name AS patient_name, p.first_name AS patient_first_name, p.hn,
         s.title || s.first_name || ' ' || s.last_name AS therapist_name,
         (pc.line_user_id IS NOT NULL AND pc.opted_out_at IS NULL AND pc.blocked_at IS NULL) AS line_linked
    FROM tele_sessions t
    JOIN patients p ON p.id = t.patient_id
    JOIN staff s ON s.id = t.therapist_id
    LEFT JOIN patient_contacts pc ON pc.patient_id = t.patient_id`;

const shape = (r) => {
  if (!r) return r;
  const { token_hash: _h, token_enc: _e, ...rest } = r;
  return { ...rest, online: presence(r.id) };
};

// ------------------------------------------------------------------ CRUD (นักกายภาพ)
async function create(user, b) {
  const therapistId = b.therapistId || user.staffId;
  if (!therapistId) throw badRequest('บัญชีนี้ไม่ได้ผูกกับนักกายภาพ — เลือกนักกายภาพผู้รับผิดชอบ');
  const { rows: [p] } = await db.query('SELECT id FROM patients WHERE id = $1', [b.patientId]);
  if (!p) throw notFound('ผู้ป่วย');
  if (new Date(b.scheduledAt) < new Date(Date.now() - 10 * 60_000)) throw badRequest('เวลานัดต้องไม่ใช่เวลาที่ผ่านมาแล้ว');
  let programId = b.programId || null;
  if (!programId) {
    const { rows: [hp] } = await db.query("SELECT id FROM home_programs WHERE patient_id = $1 AND status = 'active'", [b.patientId]);
    programId = hp?.id || null;
  }
  const token = crypto.randomBytes(32).toString('base64url');
  const { rows: [t] } = await db.query(
    `INSERT INTO tele_sessions (patient_id, therapist_id, program_id, scheduled_at, duration_min, purpose, token_hash, token_enc, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [b.patientId, therapistId, programId, b.scheduledAt, b.durationMin ?? 20, b.purpose?.trim() || null, hashToken(token), notify().encToken(token), user.id]);
  return { ...(await get(t.id)), url: urlFor(token) };
}

async function list({ from, to, therapistId, patientId, status, user = null } = {}) {
  // นักกายภาพเห็นนัดของตนเอง + ผู้ป่วยที่ตนดูแล/มีนัดด้วย
  const f = user ? await require('./access.service').patientFilter(user, 't.patient_id', 6) : { sql: 'true', params: [] };
  const mineOr = user?.staffId && f.sql !== 'true' ? `(t.therapist_id = $${6 + f.params.length} OR ${f.sql})` : f.sql;
  const { rows } = await db.query(
    `${SELECT}
      WHERE ($1::timestamptz IS NULL OR t.scheduled_at >= $1) AND ($2::timestamptz IS NULL OR t.scheduled_at < $2)
        AND ($3::uuid IS NULL OR t.therapist_id = $3) AND ($4::uuid IS NULL OR t.patient_id = $4)
        AND ($5::text IS NULL OR t.status = $5) AND ${mineOr}
      ORDER BY t.scheduled_at LIMIT 300`,
    [from || null, to || null, therapistId || null, patientId || null, status || null, ...f.params, ...(mineOr !== f.sql ? [user.staffId] : [])]);
  return rows.map(shape);
}

async function get(id) {
  const { rows: [t] } = await db.query(`${SELECT} WHERE t.id = $1`, [id]);
  if (!t) throw notFound('นัดวิดีโอคอล');
  return shape(t);
}

async function update(id, b) {
  const cur = await get(id);
  if (['cancelled'].includes(cur.status) && b.status !== 'scheduled') throw conflict('TELE_CANCELLED', 'นัดนี้ถูกยกเลิกแล้ว');
  const sets = [];
  const vals = [id];
  const put = (col, v) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
  if (b.scheduledAt !== undefined) put('scheduled_at', b.scheduledAt);
  if (b.durationMin !== undefined) put('duration_min', b.durationMin);
  if (b.purpose !== undefined) put('purpose', b.purpose?.trim() || null);
  if (b.note !== undefined) put('note', b.note?.trim() || null);
  if (b.status !== undefined) {
    put('status', b.status);
    if (b.status === 'completed') sets.push('ended_at = COALESCE(ended_at, now())');
  }
  if (!sets.length) return cur;
  await db.query(`UPDATE tele_sessions SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`, vals);
  if (['cancelled', 'completed', 'no_show'].includes(b.status)) closeRoom(id, b.status);
  return get(id);
}

/** สร้างลิงก์ใหม่ (ลิงก์เดิมใช้ไม่ได้ทันที) */
async function newLink(id) {
  await get(id);
  const token = crypto.randomBytes(32).toString('base64url');
  await db.query('UPDATE tele_sessions SET token_hash = $2, token_enc = $3, updated_at = now() WHERE id = $1', [id, hashToken(token), notify().encToken(token)]);
  closeRoom(id, 'link_changed', 'patient');
  return { url: urlFor(token) };
}

/** ส่งลิงก์ทาง LINE ทันที (เข้าคิวแจ้งเตือน) */
async function sendLine(id) {
  const t = await get(id);
  if (!t.line_linked) throw badRequest('ผู้ป่วยยังไม่ได้เชื่อม LINE หรือขอหยุดรับข้อความ — คัดลอกลิงก์ส่งทางช่องทางอื่น');
  const { rows: [q] } = await db.query(
    `INSERT INTO notification_queue (patient_id, kind, dedupe_key, ref_id) VALUES ($1,'tele_reminder',$2,$3) RETURNING id`,
    [t.patient_id, `tele:${id}:manual:${Date.now()}`, id]);
  const r = await notify().deliverDue({ limit: 20 });
  const { rows: [after] } = await db.query('SELECT status, last_error FROM notification_queue WHERE id = $1', [q.id]);
  return { queued: true, status: after.status, error: after.last_error, delivered: r };
}

/** ข้อความ LINE (null = ไม่ต้องส่งแล้ว) */
async function lineMessage(job, s) {
  const { rows: [t] } = await db.query(`${SELECT} WHERE t.id = $1`, [job.ref_id]);
  if (!t || !['scheduled', 'in_progress'].includes(t.status)) return null;
  const auto = !job.dedupe_key.includes(':manual:');
  if (auto && String(new Date(t.scheduled_at).getTime()) !== job.dedupe_key.split(':').at(-1)) return null; // เลื่อนนัดแล้ว
  if (new Date(t.scheduled_at).getTime() + (t.duration_min + 30) * 60_000 < Date.now()) return null;
  const url = storedUrl(t);
  if (!url || !/^https?:\/\//.test(url)) return null; // ไม่มี APP_BASE_URL → แนบลิงก์ไม่ได้
  const when = new Date(t.scheduled_at).toLocaleString('th-TH', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
  return `📹 นัดวิดีโอคอลกายภาพบำบัด\nคุณ${t.patient_first_name}\n${when} น.\nกับ ${t.therapist_name} (${s.clinicName})\nกดเพื่อเข้าห้อง (เข้าได้ก่อนเวลาเล็กน้อย):\n${url}`;
}

/** เติมคิว LINE: เตือนก่อนเวลานัด tele.reminder_minutes นาที */
async function scheduleReminders(now = new Date()) {
  const { reminderMinutes } = await settings();
  if (reminderMinutes <= 0) return 0;
  const { rows } = await db.query(
    `SELECT t.id, t.patient_id, t.scheduled_at FROM tele_sessions t
       JOIN patient_contacts pc ON pc.patient_id = t.patient_id AND pc.line_user_id IS NOT NULL AND pc.opted_out_at IS NULL AND pc.blocked_at IS NULL
      WHERE t.status = 'scheduled' AND t.scheduled_at > $1 AND t.scheduled_at <= $1 + make_interval(mins => $2)`, [now, reminderMinutes]);
  let n = 0;
  for (const t of rows) {
    const { rowCount } = await db.query(
      `INSERT INTO notification_queue (patient_id, kind, dedupe_key, ref_id) VALUES ($1,'tele_reminder',$2,$3) ON CONFLICT (dedupe_key) DO NOTHING`,
      [t.patient_id, `tele:${t.id}:${new Date(t.scheduled_at).getTime()}`, t.id]);
    n += rowCount;
  }
  return n;
}

// ------------------------------------------------------------------ ผู้ป่วย (ลิงก์)
async function resolveToken(token) {
  if (!token || token.length < 20) throw new AppError(401, 'INVALID_LINK', 'ลิงก์ไม่ถูกต้อง');
  const { rows: [t] } = await db.query(`${SELECT} WHERE t.token_hash = $1`, [hashToken(token)]);
  if (!t) throw new AppError(401, 'INVALID_LINK', 'ลิงก์ไม่ถูกต้องหรือถูกเปลี่ยนแล้ว กรุณาติดต่อคลินิก');
  return t;
}

/** ช่วงเวลาที่ผู้ป่วยเข้าห้องได้ */
function joinWindow(t, earlyMinutes) {
  const start = new Date(t.scheduled_at).getTime();
  const opens = start - earlyMinutes * 60_000;
  const closes = start + (t.duration_min + 60) * 60_000;
  const now = Date.now();
  if (t.status === 'cancelled') return { open: false, reason: 'cancelled' };
  if (['completed', 'no_show'].includes(t.status)) return { open: false, reason: 'ended' };
  if (now < opens) return { open: false, reason: 'early', opensAt: new Date(opens).toISOString() };
  if (now > closes) return { open: false, reason: 'expired' };
  return { open: true };
}

async function publicView(token) {
  const t = await resolveToken(token);
  const { earlyMinutes } = await settings();
  const { rows: [phone] } = await db.query("SELECT value #>> '{}' AS v FROM system_settings WHERE key = 'clinic.contact_phone'");
  return {
    patientFirstName: t.patient_first_name,
    therapistName: t.therapist_name,
    scheduledAt: t.scheduled_at,
    durationMin: t.duration_min,
    purpose: t.purpose,
    status: t.status,
    consented: Boolean(t.consent_at),
    window: joinWindow(t, earlyMinutes),
    contactPhone: phone?.v || null,
    hasProgram: Boolean(t.program_id),
  };
}

async function patientJoin(token) {
  const t = await resolveToken(token);
  const w = joinWindow(t, (await settings()).earlyMinutes);
  if (!w.open) throw conflict('CALL_NOT_OPEN', w.reason === 'early' ? 'ยังไม่ถึงเวลาเข้าห้อง' : 'นัดนี้สิ้นสุดหรือถูกยกเลิกแล้ว');
  await db.query('UPDATE tele_sessions SET consent_at = COALESCE(consent_at, now()), updated_at = now() WHERE id = $1', [t.id]);
  return { ok: true, iceServers: iceServers(t.id), sessionId: t.id };
}

// ------------------------------------------------------------------ ส่งต่อสัญญาณ (signaling)
const rooms = new Map(); // sessionId → { staff: Set<res>, patient: Set<res> }
const room = (id) => {
  if (!rooms.has(id)) rooms.set(id, { staff: new Set(), patient: new Set() });
  return rooms.get(id);
};
function presence(id) {
  const r = rooms.get(id);
  return { staff: Boolean(r?.staff.size), patient: Boolean(r?.patient.size) };
}
const write = (res, event, data) => { try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* ปิดไปแล้ว */ } };
function broadcastPresence(id) {
  const r = rooms.get(id);
  if (!r) return;
  const p = presence(id);
  for (const set of [r.staff, r.patient]) for (const res of set) write(res, 'presence', p);
}

/** เปิดสตรีมสัญญาณ (SSE) ของฝ่าย role ในห้อง */
function openStream(id, role, req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 2000\n: connected\n\n');
  const r = room(id);
  // ห้องละ 1 อุปกรณ์ต่อฝ่าย: เปิดใหม่ = แทนที่ของเดิม (เช่น ผู้ป่วยรีเฟรชหน้า หรือเปลี่ยนจากมือถือเป็นแท็บเล็ต)
  if (r[role].size) {
    for (const old of r[role]) { write(old, 'replaced', {}); old.end(); }
    r[role].clear();
    broadcastPresence(id); // ให้อีกฝ่ายรู้ว่าเครื่องเดิมออกไปแล้ว → ต่อสายใหม่กับเครื่องใหม่
  }
  r[role].add(res);
  const ping = setInterval(() => res.write(': ping\n\n'), 20_000);
  broadcastPresence(id);
  const p = presence(id);
  if (p.staff && p.patient) {
    db.query(`UPDATE tele_sessions SET status = 'in_progress', started_at = COALESCE(started_at, now()), updated_at = now()
               WHERE id = $1 AND status = 'scheduled'`, [id]).catch(() => {});
  }
  req.on('close', () => {
    clearInterval(ping);
    r[role].delete(res);
    if (!r.staff.size && !r.patient.size) rooms.delete(id);
    else broadcastPresence(id);
  });
}

const SIGNAL_TYPES = new Set(['offer', 'answer', 'ice', 'bye', 'state']);
/** ส่งข้อความสัญญาณไปให้อีกฝ่าย */
function relay(id, from, msg) {
  if (!SIGNAL_TYPES.has(msg.type)) throw badRequest('ชนิดสัญญาณไม่ถูกต้อง');
  const r = rooms.get(id);
  const to = from === 'staff' ? 'patient' : 'staff';
  if (!r || !r[to].size) return { delivered: false };
  for (const res of r[to]) write(res, 'signal', { from, type: msg.type, data: msg.data ?? null });
  return { delivered: true };
}

function closeRoom(id, reason, onlyRole = null) {
  const r = rooms.get(id);
  if (!r) return;
  for (const role of onlyRole ? [onlyRole] : ['staff', 'patient']) {
    for (const res of r[role]) { write(res, 'closed', { reason }); res.end(); }
    r[role].clear();
  }
  if (!r.staff.size && !r.patient.size) rooms.delete(id);
}

function closeAll() {
  for (const id of [...rooms.keys()]) closeRoom(id, 'server_stopping');
}

/** จบการโทร (นักกายภาพ): บันทึกโน้ต + ปิดห้อง */
async function end(id, { note, status = 'completed' }) {
  const t = await update(id, { note, status });
  return t;
}

module.exports = {
  iceServers, turnConfigured, settings, urlFor, create, list, get, update, newLink, sendLine, lineMessage, scheduleReminders,
  resolveToken, publicView, patientJoin, joinWindow, openStream, relay, presence, closeRoom, closeAll, end, hashToken,
};
