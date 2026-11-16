/**
 * แจ้งเตือนผู้ป่วยทาง LINE
 *
 * เชื่อมบัญชี: ระบบสร้างรหัส 6 ตัว + QR (ลิงก์ line.me/R/oaMessage/<OA>/?เชื่อมต่อ <รหัส>) ผู้ป่วยสแกนแล้วกดส่งในแชต
 *              → webhook ได้รับข้อความพร้อม userId → ผูกกับผู้ป่วย  (ผู้ป่วยเป็นคนส่งเอง = ยินยอมรับข้อความ)
 *              พิมพ์ "หยุด" เพื่อยกเลิกรับข้อความ, "เริ่ม" เพื่อรับใหม่, บล็อก OA = หยุดส่งทันที
 * ตัวตั้งเวลา (ทุก 1 นาที): เติมคิวเตือนนัด (ล่วงหน้าตาม notify.appointment_hours) และเตือนทำกายภาพที่บ้าน (เฉพาะวันที่ยังไม่บันทึก)
 * ตัวส่ง: สร้างข้อความจากข้อมูลล่าสุดตอนส่ง (นัดถูกยกเลิก/เลื่อน หรือบันทึกแล้ว → ข้าม) ไม่ระบุโรคหรือข้อมูลการรักษาในข้อความ
 */
const crypto = require('node:crypto');
const db = require('../db');
const line = require('./line.service');
const config = require('../config');
const { badRequest, notFound } = require('../errors');

const TZ = 'Asia/Bangkok';
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // ไม่มี 0 O 1 I ที่อ่านสับสน
const STOP_WORDS = ['หยุด', 'stop', 'ยกเลิก', 'unsubscribe'];
const START_WORDS = ['เริ่ม', 'start', 'รับข่าว'];
const MAX_ATTEMPTS = 8;

async function settings() {
  const { rows } = await db.query("SELECT key, value FROM system_settings WHERE key LIKE 'notify.%' OR key IN ('clinic.name','clinic.contact_phone')");
  const s = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return {
    enabled: s['notify.enabled'] === true,
    basicId: String(s['notify.line_basic_id'] || '').trim(),
    appointmentHours: (Array.isArray(s['notify.appointment_hours']) ? s['notify.appointment_hours'] : [24]).map(Number).filter((h) => h > 0 && h <= 168),
    homeTime: /^\d{2}:\d{2}$/.test(s['notify.home_reminder_time'] || '') ? s['notify.home_reminder_time'] : '18:00',
    quiet: s['notify.quiet_hours'] || { start: '21:00', end: '07:00' },
    clinicName: s['clinic.name'] || 'คลินิกกายภาพบำบัด',
    phone: s['clinic.contact_phone'] || '',
  };
}

async function status() {
  const s = await settings();
  const { rows: [c] } = await db.query(
    `SELECT count(*) FILTER (WHERE line_user_id IS NOT NULL AND opted_out_at IS NULL AND blocked_at IS NULL)::int AS active,
            count(*) FILTER (WHERE opted_out_at IS NOT NULL OR blocked_at IS NOT NULL)::int AS stopped FROM patient_contacts`);
  return {
    enabled: s.enabled,
    lineConfigured: line.configured(),
    basicId: s.basicId || null,
    appBaseUrl: config.appBaseUrl || null,
    linkedPatients: c.active,
    stoppedPatients: c.stopped,
    ready: s.enabled && line.configured() && Boolean(s.basicId),
  };
}

// ------------------------------------------------------------------ เชื่อมบัญชี LINE
function deepLink(basicId, code) {
  if (!basicId) return null;
  const id = basicId.startsWith('@') ? basicId : `@${basicId}`;
  return `https://line.me/R/oaMessage/${encodeURIComponent(id)}/?${encodeURIComponent(`เชื่อมต่อ ${code}`)}`;
}

async function createLinkCode(patientId, userId = null) {
  const { rows: [p] } = await db.query('SELECT id FROM patients WHERE id = $1', [patientId]);
  if (!p) throw notFound('ผู้ป่วย');
  const s = await settings();
  for (let i = 0; i < 5; i++) {
    const code = Array.from(crypto.randomBytes(6), (b) => CODE_CHARS[b % CODE_CHARS.length]).join('');
    const { rowCount } = await db.query(
      `INSERT INTO line_link_codes (code, patient_id, created_by, expires_at) VALUES ($1,$2,$3, now() + interval '7 days')
       ON CONFLICT (code) DO NOTHING`, [code, patientId, userId]);
    if (rowCount) {
      return { code, url: deepLink(s.basicId, code), basicId: s.basicId || null, expiresInDays: 7, lineReady: line.configured() && Boolean(s.basicId) };
    }
  }
  throw new Error('สร้างรหัสไม่สำเร็จ ลองใหม่อีกครั้ง');
}

async function contact(patientId) {
  const { rows: [c] } = await db.query('SELECT * FROM patient_contacts WHERE patient_id = $1', [patientId]);
  const state = !c?.line_user_id ? 'not_linked' : c.blocked_at ? 'blocked' : c.opted_out_at ? 'opted_out' : 'active';
  return { state, lineName: c?.line_name || null, linkedAt: c?.linked_at || null, optedOutAt: c?.opted_out_at || null, blockedAt: c?.blocked_at || null };
}

async function unlink(patientId) {
  await db.query('UPDATE patient_contacts SET line_user_id = NULL, line_name = NULL, linked_at = NULL, updated_at = now() WHERE patient_id = $1', [patientId]);
}

async function safeReply(replyToken, texts) {
  if (!replyToken || !line.configured()) return;
  try { await line.reply(replyToken, texts); } catch (e) { console.error('[line] reply', e.message); }
}

/** รับ event จาก webhook (ตรวจลายเซ็นแล้ว) */
async function handleEvents(events) {
  const s = await settings();
  const help = `ช่องทางนี้ใช้ส่งการแจ้งเตือนนัดและโปรแกรมกายภาพอัตโนมัติ${s.phone ? ` · ติดต่อ${s.clinicName} โทร ${s.phone}` : ''}`;
  for (const ev of events || []) {
    const userId = ev.source?.userId;
    if (!userId || ev.source?.type !== 'user') continue;
    if (ev.type === 'unfollow') {
      await db.query('UPDATE patient_contacts SET blocked_at = now(), updated_at = now() WHERE line_user_id = $1', [userId]);
      continue;
    }
    if (ev.type === 'follow') {
      await db.query('UPDATE patient_contacts SET blocked_at = NULL, updated_at = now() WHERE line_user_id = $1', [userId]);
      const { rows: [linked] } = await db.query('SELECT 1 FROM patient_contacts WHERE line_user_id = $1', [userId]);
      await safeReply(ev.replyToken, linked
        ? `ยินดีต้อนรับกลับสู่${s.clinicName} คุณจะได้รับการแจ้งเตือนนัดและโปรแกรมกายภาพตามเดิม`
        : `ยินดีต้อนรับสู่${s.clinicName} ส่งรหัส 6 ตัวที่ได้จากคลินิกเพื่อรับการแจ้งเตือนนัดและโปรแกรมกายภาพ`);
      continue;
    }
    if (ev.type !== 'message' || ev.message?.type !== 'text') continue;
    const text = String(ev.message.text || '').trim();
    const lower = text.toLowerCase();
    if (STOP_WORDS.includes(lower)) {
      const { rowCount } = await db.query('UPDATE patient_contacts SET opted_out_at = now(), updated_at = now() WHERE line_user_id = $1', [userId]);
      await safeReply(ev.replyToken, rowCount ? 'หยุดส่งการแจ้งเตือนแล้ว พิมพ์ "เริ่ม" เมื่อต้องการรับอีกครั้ง' : help);
      continue;
    }
    if (START_WORDS.includes(lower)) {
      const { rowCount } = await db.query('UPDATE patient_contacts SET opted_out_at = NULL, updated_at = now() WHERE line_user_id = $1', [userId]);
      await safeReply(ev.replyToken, rowCount ? 'เปิดรับการแจ้งเตือนแล้ว' : help);
      continue;
    }
    const code = text.toUpperCase().match(/\b([A-Z0-9]{6})\b/)?.[1];
    if (code) {
      const linked = await db.withTx(async (c) => {
        const { rows: [lc] } = await c.query(
          'SELECT * FROM line_link_codes WHERE code = $1 AND used_at IS NULL AND expires_at > now() FOR UPDATE', [code]);
        if (!lc) return null;
        await c.query('UPDATE line_link_codes SET used_at = now() WHERE code = $1', [code]);
        // บัญชี LINE หนึ่งผูกได้กับผู้ป่วยคนเดียว (ย้ายมาผูกคนใหม่ถ้าเคยผูกคนอื่น)
        await c.query('UPDATE patient_contacts SET line_user_id = NULL, line_name = NULL, linked_at = NULL WHERE line_user_id = $1 AND patient_id <> $2', [userId, lc.patient_id]);
        await c.query(
          `INSERT INTO patient_contacts (patient_id, line_user_id, linked_at) VALUES ($1,$2, now())
           ON CONFLICT (patient_id) DO UPDATE SET line_user_id = EXCLUDED.line_user_id, linked_at = now(), opted_out_at = NULL, blocked_at = NULL, updated_at = now()`,
          [lc.patient_id, userId]);
        const { rows: [p] } = await c.query('SELECT first_name FROM patients WHERE id = $1', [lc.patient_id]);
        return { patientId: lc.patient_id, firstName: p.first_name };
      });
      if (linked) {
        const prof = line.configured() ? await line.profile(userId) : null;
        if (prof?.displayName) await db.query('UPDATE patient_contacts SET line_name = $2 WHERE patient_id = $1', [linked.patientId, prof.displayName.slice(0, 100)]);
        await safeReply(ev.replyToken, `เชื่อมต่อเรียบร้อย คุณ${linked.firstName} จะได้รับการแจ้งเตือนนัดและโปรแกรมกายภาพจาก${s.clinicName}\nพิมพ์ "หยุด" เมื่อไม่ต้องการรับข้อความ`);
      } else {
        await safeReply(ev.replyToken, 'รหัสไม่ถูกต้องหรือหมดอายุแล้ว กรุณาขอรหัสใหม่จากคลินิก');
      }
      continue;
    }
    await safeReply(ev.replyToken, help);
  }
}

// ------------------------------------------------------------------ เวลา
const hm = (s) => { const [h, m] = String(s).split(':').map(Number); return h * 60 + m; };
const bkkParts = (date) => {
  const d = new Date(date.getTime() + 7 * 3_600_000);
  return { ymd: d.toISOString().slice(0, 10), minutes: d.getUTCHours() * 60 + d.getUTCMinutes() };
};
function inQuiet(date, quiet) {
  const m = bkkParts(date).minutes;
  const s = hm(quiet.start || '21:00');
  const e = hm(quiet.end || '07:00');
  return s > e ? m >= s || m < e : m >= s && m < e;
}
/** เวลาส่งที่ตกในช่วงห้ามส่ง → เลื่อนให้เร็วขึ้นเป็นเวลาเริ่มช่วงห้ามส่ง (ผู้ป่วยได้รับก่อนนัดเสมอ) */
function earlierOutOfQuiet(date, quiet) {
  let t = new Date(date);
  for (let i = 0; i < 48 && inQuiet(t, quiet); i++) t = new Date(t.getTime() - 30 * 60_000);
  return t;
}

// ------------------------------------------------------------------ เติมคิว
async function scheduleDue(now = new Date()) {
  const s = await settings();
  if (!s.enabled) return { appointments: 0, home: 0 };
  let appointments = 0;
  for (const h of s.appointmentHours) {
    const { rows } = await db.query(
      `SELECT a.id, a.patient_id, a.start_at FROM appointments a
         JOIN patient_contacts pc ON pc.patient_id = a.patient_id AND pc.line_user_id IS NOT NULL AND pc.opted_out_at IS NULL AND pc.blocked_at IS NULL
        WHERE a.status IN ('booked','confirmed')
          AND a.start_at > $1 AND a.start_at <= $1 + make_interval(hours => $2)
          AND a.created_at <= a.start_at - make_interval(hours => $2)`, [now, h]);
    for (const a of rows) {
      const when = earlierOutOfQuiet(new Date(a.start_at.getTime() - h * 3_600_000), s.quiet);
      const { rowCount } = await db.query(
        `INSERT INTO notification_queue (patient_id, kind, dedupe_key, ref_id, scheduled_for) VALUES ($1,'appointment_reminder',$2,$3,$4)
         ON CONFLICT (dedupe_key) DO NOTHING`,
        [a.patient_id, `appt:${a.id}:${h}h:${a.start_at.getTime()}`, a.id, when < now ? now : when]);
      appointments += rowCount;
    }
  }
  // เตือนทำกายภาพที่บ้าน: ถึงเวลาเตือนแล้ว + วันนี้มีท่าต้องทำ + ยังไม่บันทึก + ยังไม่ถึงช่วงห้ามส่ง
  let home = 0;
  const { ymd, minutes } = bkkParts(now);
  if (!inQuiet(now, s.quiet)) {
    const { rows } = await db.query(
      `SELECT hp.id, hp.patient_id, COALESCE(to_char(hp.reminder_time, 'HH24:MI'), $2) AS at
         FROM home_programs hp
         JOIN patient_contacts pc ON pc.patient_id = hp.patient_id AND pc.line_user_id IS NOT NULL AND pc.opted_out_at IS NULL AND pc.blocked_at IS NULL
        WHERE hp.status = 'active' AND $1::date BETWEEN hp.start_date AND hp.end_date
          AND EXISTS (SELECT 1 FROM home_program_items i WHERE i.program_id = hp.id AND i.is_active AND extract(isodow FROM $1::date)::int = ANY(i.days_of_week))
          AND NOT EXISTS (SELECT 1 FROM home_logs l WHERE l.program_id = hp.id AND l.log_date = $1::date)`, [ymd, s.homeTime]);
    for (const p of rows) {
      if (minutes < hm(p.at)) continue;
      const { rowCount } = await db.query(
        `INSERT INTO notification_queue (patient_id, kind, dedupe_key, ref_id) VALUES ($1,'home_reminder',$2,$3) ON CONFLICT (dedupe_key) DO NOTHING`,
        [p.patient_id, `home:${p.id}:${ymd}`, p.id]);
      home += rowCount;
    }
  }
  return { appointments, home };
}

// ------------------------------------------------------------------ ลิงก์โปรแกรมสำหรับแนบในข้อความ
const linkKey = () => crypto.createHash('sha256').update(`home-link|${config.jwtSecret}`).digest();
function encToken(t) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', linkKey(), iv);
  const ct = Buffer.concat([c.update(t, 'utf8'), c.final()]);
  return `${iv.toString('base64url')}.${ct.toString('base64url')}.${c.getAuthTag().toString('base64url')}`;
}
function decToken(s) {
  try {
    const [iv, ct, tag] = s.split('.').map((x) => Buffer.from(x, 'base64url'));
    const d = crypto.createDecipheriv('aes-256-gcm', linkKey(), iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
  } catch { return null; }
}
async function lineLinkUrl(programId) {
  if (!config.appBaseUrl) return null;
  const { rows: [l] } = await db.query(
    `SELECT id, token_enc FROM home_access_links WHERE program_id = $1 AND label = 'LINE' AND revoked_at IS NULL AND expires_at > now() AND token_enc IS NOT NULL
      ORDER BY created_at DESC LIMIT 1`, [programId]);
  let tok = l ? decToken(l.token_enc) : null;
  if (!tok) {
    if (l) await db.query('UPDATE home_access_links SET revoked_at = now() WHERE id = $1', [l.id]);
    const home = require('./home.service');
    const created = await home.createLink(programId, { label: 'LINE' }, null);
    await db.query('UPDATE home_access_links SET token_enc = $2 WHERE id = $1', [created.id, encToken(created.token)]);
    tok = created.token;
  }
  return `${config.appBaseUrl.replace(/\/+$/, '')}/home#t=${tok}`;
}

// ------------------------------------------------------------------ ข้อความ
const thDateTime = (d) => new Date(d).toLocaleString('th-TH', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });

/** คืนข้อความ หรือ null = ไม่ต้องส่งแล้ว (นัดเปลี่ยน/ยกเลิก หรือบันทึกแล้ว) */
async function buildMessage(job, s) {
  if (job.kind === 'test') return `ทดสอบการแจ้งเตือนจาก${s.clinicName} — คุณจะได้รับการเตือนนัดและโปรแกรมกายภาพทางช่องทางนี้`;
  if (job.kind === 'appointment_reminder') {
    const { rows: [a] } = await db.query(
      `SELECT a.status, a.start_at, p.first_name, s.title || s.first_name AS therapist
         FROM appointments a JOIN patients p ON p.id = a.patient_id JOIN staff s ON s.id = a.therapist_id WHERE a.id = $1`, [job.ref_id]);
    const startKey = job.dedupe_key.split(':').at(-1);
    if (!a || !['booked', 'confirmed'].includes(a.status) || String(a.start_at.getTime()) !== startKey || a.start_at <= new Date()) return null;
    return `🔔 เตือนนัดกายภาพบำบัด\nคุณ${a.first_name}\n${thDateTime(a.start_at)} น.\nกับ ${a.therapist} ที่${s.clinicName}${s.phone ? `\nหากต้องการเลื่อนนัด โทร ${s.phone}` : ''}`;
  }
  if (job.kind === 'home_reminder') {
    const { ymd } = bkkParts(new Date());
    const { rows: [p] } = await db.query(
      `SELECT hp.status, p.first_name,
              (SELECT count(*) FROM home_program_items i WHERE i.program_id = hp.id AND i.is_active AND extract(isodow FROM $2::date)::int = ANY(i.days_of_week))::int AS n,
              EXISTS (SELECT 1 FROM home_logs l WHERE l.program_id = hp.id AND l.log_date = $2::date) AS logged
         FROM home_programs hp JOIN patients p ON p.id = hp.patient_id WHERE hp.id = $1`, [job.ref_id, ymd]);
    if (!p || p.status !== 'active' || p.logged || !p.n || !job.dedupe_key.endsWith(ymd)) return null;
    const url = await lineLinkUrl(job.ref_id);
    return `🏠 คุณ${p.first_name} อย่าลืมทำกายภาพวันนี้ ${p.n} ท่า\n${url ? `กดเพื่อดูท่าและบันทึก:\n${url}` : 'เปิดลิงก์โปรแกรมที่ได้รับจากคลินิกเพื่อดูท่าและบันทึก'}`;
  }
  return null;
}

// ------------------------------------------------------------------ ส่ง
async function deliverDue({ limit = 50 } = {}) {
  const summary = { processed: 0, sent: 0, skipped: 0, failed: 0 };
  const s = await settings();
  if (!s.enabled || !line.configured()) return summary;
  const { rows: jobs } = await db.query(
    `UPDATE notification_queue q SET scheduled_for = now() + interval '5 minutes'
      WHERE q.id IN (SELECT id FROM notification_queue WHERE status IN ('pending','failed') AND scheduled_for <= now()
                      ORDER BY scheduled_for LIMIT $1 FOR UPDATE SKIP LOCKED)
      RETURNING q.*`, [limit]);
  for (const job of jobs) {
    summary.processed++;
    const { rows: [c] } = await db.query('SELECT * FROM patient_contacts WHERE patient_id = $1', [job.patient_id]);
    const mark = (st, err = null) => db.query(
      `UPDATE notification_queue SET status = $2, last_error = $3, sent_at = CASE WHEN $2 = 'sent' THEN now() ELSE sent_at END WHERE id = $1`,
      [job.id, st, err]);
    if (!c?.line_user_id || c.opted_out_at || c.blocked_at) { await mark('skipped', 'ผู้ป่วยไม่ได้เชื่อม LINE หรือยกเลิกรับข้อความ'); summary.skipped++; continue; }
    try {
      const text = await buildMessage(job, s);
      if (!text) { await mark('skipped', 'ไม่ต้องส่งแล้ว (นัดเปลี่ยน/ยกเลิก หรือบันทึกแล้ว)'); summary.skipped++; continue; }
      await line.push(c.line_user_id, text);
      await db.query("UPDATE notification_queue SET status = 'sent', sent_at = now(), attempts = attempts + 1, last_error = NULL WHERE id = $1", [job.id]);
      summary.sent++;
    } catch (e) {
      const attempts = job.attempts + 1;
      const permanent = e.status >= 400 && e.status < 500 && e.status !== 429;
      await db.query(
        `UPDATE notification_queue SET status = $2, attempts = $3, last_error = $4, scheduled_for = now() + make_interval(mins => $5) WHERE id = $1`,
        [job.id, permanent || attempts >= MAX_ATTEMPTS ? 'dead' : 'failed', attempts, String(e.message).slice(0, 500), Math.min(240, 2 ** attempts)]);
      summary.failed++;
    }
  }
  return summary;
}

async function sendTest(patientId) {
  const c = await contact(patientId);
  if (c.state !== 'active') throw badRequest('ผู้ป่วยยังไม่ได้เชื่อม LINE หรือยกเลิกรับข้อความ');
  await db.query(
    `INSERT INTO notification_queue (patient_id, kind, dedupe_key) VALUES ($1, 'test', $2)`, [patientId, `test:${patientId}:${Date.now()}`]);
  return deliverDue({ limit: 10 });
}

let timer = null;
function startWorker(intervalMs = 60_000) {
  if (timer) return;
  let busy = false;
  timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try { await scheduleDue(); await deliverDue(); } catch (e) { console.error('[notify]', e.message); } finally { busy = false; }
  }, intervalMs);
  timer.unref();
}
const stopWorker = () => { clearInterval(timer); timer = null; };

module.exports = {
  settings, status, createLinkCode, contact, unlink, handleEvents, scheduleDue, deliverDue, sendTest, buildMessage,
  startWorker, stopWorker, inQuiet, earlierOutOfQuiet, deepLink,
};
