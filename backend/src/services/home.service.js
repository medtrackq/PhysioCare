/**
 * โปรแกรมกายภาพที่บ้าน
 *
 * - นักกายภาพสั่งโปรแกรม (ท่า + เซ็ต/ครั้ง/ค้าง/รอบต่อวัน/วันในสัปดาห์) ผู้ป่วยมีโปรแกรมที่ใช้งานได้ครั้งละ 1 โปรแกรม
 * - ผู้ป่วย/ญาติเข้าผ่านลิงก์ (token สุ่ม 256 บิต เก็บเฉพาะ SHA-256, มีวันหมดอายุ, ยกเลิกได้) ไม่ต้องมีบัญชี
 * - บันทึกรายวัน: ท่าที่ทำ ปวด 0–10 ความยาก อาการผิดปกติ → แจ้งเตือนนักกายภาพเมื่อปวดเพิ่มมาก/มีอาการอันตราย
 * - อัตราการทำตามโปรแกรม (adherence) = ท่าที่ทำ / ท่าที่ต้องทำตามตาราง (วันที่ไม่บันทึกนับเป็น 0)
 */
const crypto = require('node:crypto');
const db = require('../db');
const { badRequest, notFound, conflict, AppError } = require('../errors');

const TZ = 'Asia/Bangkok';
const RED_FLAGS = {
  chest_pain: 'เจ็บแน่นหน้าอก / หายใจไม่ทัน',
  numbness: 'ชาหรืออ่อนแรงมากขึ้น',
  dizziness: 'เวียนศีรษะ / จะเป็นลม',
  fall: 'หกล้ม',
  swelling: 'บวม แดง ร้อนมากขึ้น',
  bladder: 'กลั้นปัสสาวะ/อุจจาระไม่ได้ หรือชารอบก้น',
};
const hashToken = (t) => crypto.createHash('sha256').update(t).digest('hex');
const DAY_MS = 86_400_000;
/** วันที่ (YYYY-MM-DD) ตามเวลากรุงเทพ */
const bkkDate = (offsetDays = 0, base = Date.now()) => new Date(base + 7 * 3_600_000 + offsetDays * DAY_MS).toISOString().slice(0, 10);
const isoDow = (ymd) => { const d = new Date(`${ymd}T12:00:00Z`).getUTCDay(); return d === 0 ? 7 : d; };
const ymd = (v) => (v instanceof Date ? `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}` : String(v).slice(0, 10));
const addDays = (d, n) => new Date(new Date(`${d}T12:00:00Z`).getTime() + n * DAY_MS).toISOString().slice(0, 10);

// ------------------------------------------------------------------ exercises
async function listExercises({ includeInactive = false } = {}) {
  const { rows } = await db.query(
    `SELECT * FROM exercises WHERE ($1 OR is_active) ORDER BY
       array_position(ARRAY['neck','shoulder','back','hip','knee','ankle','balance','general'], body_region), name_th`, [includeInactive]);
  return rows;
}

// ------------------------------------------------------------------ programs
const cleanPsfs = (a) => (a || []).map((x) => String(x).trim()).filter(Boolean).slice(0, 3);
const ITEM_COLS = 'sets, reps, hold_sec, per_day, days_of_week, notes, sort_order';

async function loadProgram(client, id) {
  const { rows: [p] } = await client.query(
    `SELECT hp.*, pt.first_name || ' ' || pt.last_name AS patient_name, pt.hn, pt.first_name AS patient_first_name,
            s.title || s.first_name || ' ' || s.last_name AS therapist_name
       FROM home_programs hp JOIN patients pt ON pt.id = hp.patient_id JOIN staff s ON s.id = hp.therapist_id
      WHERE hp.id = $1`, [id]);
  if (!p) throw notFound('โปรแกรมที่บ้าน');
  const { rows: items } = await client.query(
    `SELECT i.id, i.exercise_id, ${ITEM_COLS.split(', ').map((c) => `i.${c}`).join(', ')}, i.is_active, i.dose_changed_at,
            e.code, e.name_th, e.name_en, e.body_region, e.instructions, e.cautions, e.video_url, e.camera
       FROM home_program_items i JOIN exercises e ON e.id = i.exercise_id
      WHERE i.program_id = $1 ORDER BY i.is_active DESC, i.sort_order, e.name_th`, [id]);
  return { ...p, start_date: ymd(p.start_date), end_date: ymd(p.end_date), reminder_time: p.reminder_time ? String(p.reminder_time).slice(0, 5) : null, items };
}

function validateItems(items) {
  if (!items.length) throw badRequest('ต้องมีอย่างน้อย 1 ท่า');
  for (const it of items) if (!it.reps && !it.holdSec) throw badRequest('แต่ละท่าต้องระบุจำนวนครั้งหรือเวลาค้าง');
}

async function upsertItems(client, programId, items) {
  const keep = [];
  for (const [i, it] of items.entries()) {
    const vals = [it.sets, it.reps ?? null, it.holdSec ?? null, it.perDay ?? 1, it.daysOfWeek ?? [1, 2, 3, 4, 5, 6, 7], it.notes ?? null, i];
    if (it.id) {
      const { rowCount } = await client.query(
        `UPDATE home_program_items SET
            dose_changed_at = CASE WHEN (sets, reps, hold_sec) IS DISTINCT FROM ($3::int, $4::int, $5::int) THEN now() ELSE dose_changed_at END,
            sets=$3, reps=$4, hold_sec=$5, per_day=$6, days_of_week=$7, notes=$8, sort_order=$9, is_active=true
          WHERE id = $1 AND program_id = $2`, [it.id, programId, ...vals]);
      if (!rowCount) throw badRequest('ท่าที่อ้างถึงไม่อยู่ในโปรแกรมนี้');
      keep.push(it.id);
    } else {
      const { rows: [r] } = await client.query(
        `INSERT INTO home_program_items (program_id, exercise_id, ${ITEM_COLS}) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [programId, it.exerciseId, ...vals]);
      keep.push(r.id);
    }
  }
  // ท่าที่เอาออก: ปิดไว้ (บันทึกเดิมยังอ้างถึงได้)
  await client.query('UPDATE home_program_items SET is_active = false WHERE program_id = $1 AND NOT (id = ANY($2))', [programId, keep]);
}

async function createProgram(user, b) {
  if (!b.consent) throw badRequest('ต้องได้รับความยินยอมจากผู้ป่วยหรือผู้แทนก่อนเริ่มโปรแกรมที่บ้าน');
  validateItems(b.items);
  if (b.endDate < b.startDate) throw badRequest('วันสิ้นสุดต้องไม่ก่อนวันเริ่ม');
  return db.withTx(async (c) => {
    let therapistId = b.therapistId || user.staffId;
    let baseline = b.baselinePain ?? null;
    if (b.appointmentId) {
      const { rows: [a] } = await c.query('SELECT patient_id, therapist_id FROM appointments WHERE id = $1', [b.appointmentId]);
      if (!a || a.patient_id !== b.patientId) throw badRequest('นัดหมายไม่ตรงกับผู้ป่วย');
      therapistId ||= a.therapist_id;
      if (baseline === null) {
        const { rows: [x] } = await c.query(
          "SELECT pain_score FROM clinical_assessments WHERE appointment_id = $1 AND pain_score IS NOT NULL ORDER BY (phase = 'post') DESC LIMIT 1",
          [b.appointmentId]);
        baseline = x?.pain_score ?? null;
      }
    }
    if (!therapistId) throw badRequest('ต้องระบุนักกายภาพผู้ดูแลโปรแกรม');
    await c.query("UPDATE home_programs SET status = 'ended', ended_at = now(), updated_at = now() WHERE patient_id = $1 AND status = 'active'", [b.patientId]);
    const { rows: [p] } = await c.query(
      `INSERT INTO home_programs (patient_id, therapist_id, appointment_id, start_date, end_date, baseline_pain, pain_alert_increase, notes,
                                  consent_at, consent_note, created_by, reminder_time, psfs_activities)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now(), $9, $10, $11, $12) RETURNING id`,
      [b.patientId, therapistId, b.appointmentId || null, b.startDate, b.endDate, baseline, b.painAlertIncrease ?? 3, b.notes || null,
        b.consentNote || null, user.id, b.reminderTime || null, cleanPsfs(b.psfsActivities)]);
    await upsertItems(c, p.id, b.items);
    return loadProgram(c, p.id);
  });
}

async function updateProgram(id, b) {
  return db.withTx(async (c) => {
    const cur = await loadProgram(c, id);
    if (cur.status !== 'active') throw conflict('PROGRAM_ENDED', 'โปรแกรมนี้สิ้นสุดแล้ว — สร้างโปรแกรมใหม่แทน');
    const start = b.startDate || cur.start_date;
    const end = b.endDate || cur.end_date;
    if (end < start) throw badRequest('วันสิ้นสุดต้องไม่ก่อนวันเริ่ม');
    await c.query(
      `UPDATE home_programs SET start_date=$2, end_date=$3, notes=COALESCE($4, notes), pain_alert_increase=COALESCE($5, pain_alert_increase),
              baseline_pain=COALESCE($6, baseline_pain),
              reminder_time = CASE WHEN $7 THEN $8::time ELSE reminder_time END,
              psfs_activities = COALESCE($9, psfs_activities), updated_at=now() WHERE id=$1`,
      [id, start, end, b.notes ?? null, b.painAlertIncrease ?? null, b.baselinePain ?? null,
        b.reminderTime !== undefined, b.reminderTime || null, b.psfsActivities ? cleanPsfs(b.psfsActivities) : null]);
    if (b.items) { validateItems(b.items); await upsertItems(c, id, b.items); }
    // ขยายวันสิ้นสุด → ต่ออายุลิงก์ที่ยังใช้อยู่ให้ตรงกัน
    await c.query(
      `UPDATE home_access_links SET expires_at = GREATEST(expires_at, ($2::date + (SELECT (value #>> '{}')::int FROM system_settings WHERE key = 'home.link_days_after_end') + 1)::timestamp AT TIME ZONE '${TZ}')
        WHERE program_id = $1 AND revoked_at IS NULL`, [id, end]);
    return loadProgram(c, id);
  });
}

async function endProgram(id) {
  const { rowCount } = await db.query("UPDATE home_programs SET status='ended', ended_at=now(), updated_at=now() WHERE id=$1 AND status='active'", [id]);
  if (!rowCount) throw notFound('โปรแกรมที่ใช้งานอยู่');
  await db.query('UPDATE home_access_links SET revoked_at = now() WHERE program_id = $1 AND revoked_at IS NULL', [id]);
}

// ------------------------------------------------------------------ links
async function createLink(programId, { label }, userId) {
  const { rows: [p] } = await db.query(
    `SELECT hp.status, hp.end_date, (SELECT (value #>> '{}')::int FROM system_settings WHERE key = 'home.link_days_after_end') AS extra
       FROM home_programs hp WHERE hp.id = $1`, [programId]);
  if (!p) throw notFound('โปรแกรมที่บ้าน');
  if (p.status !== 'active') throw conflict('PROGRAM_ENDED', 'โปรแกรมนี้สิ้นสุดแล้ว');
  const token = crypto.randomBytes(32).toString('base64url');
  const { rows: [l] } = await db.query(
    `INSERT INTO home_access_links (program_id, token_hash, label, created_by, expires_at)
     VALUES ($1,$2,$3,$4, ($5::date + $6::int + 1)::timestamp AT TIME ZONE '${TZ}')
     RETURNING id, label, created_at, expires_at`,
    [programId, hashToken(token), label || 'ผู้ป่วย', userId, ymd(p.end_date), p.extra ?? 7]);
  return { ...l, token };
}

async function revokeLink(id) {
  const { rowCount } = await db.query('UPDATE home_access_links SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL', [id]);
  if (!rowCount) throw notFound('ลิงก์');
}

async function resolveToken(token) {
  if (!token || token.length < 30 || token.length > 100) throw new AppError(401, 'INVALID_LINK', 'ลิงก์ไม่ถูกต้อง');
  const { rows: [l] } = await db.query(
    `UPDATE home_access_links l SET last_used_at = now()
       FROM home_programs hp
      WHERE l.token_hash = $1 AND hp.id = l.program_id AND l.revoked_at IS NULL AND l.expires_at > now()
      RETURNING l.id AS link_id, l.program_id, hp.status`, [hashToken(token)]);
  if (!l) throw new AppError(401, 'INVALID_LINK', 'ลิงก์หมดอายุหรือถูกยกเลิกแล้ว กรุณาติดต่อคลินิกเพื่อขอลิงก์ใหม่');
  return l;
}

// ------------------------------------------------------------------ adherence
/** รายวันระหว่าง from–to (ภายในช่วงโปรแกรม): ท่าที่ต้องทำ, ทำแล้ว, ปวด, ความยาก */
async function dailySeries(client, program, from, to) {
  const start = from > program.start_date ? from : program.start_date;
  const end = to < program.end_date ? to : program.end_date;
  if (end < start) return [];
  const { rows: logs } = await client.query(
    `SELECT l.id, l.log_date, l.pain, l.difficulty, l.symptoms, l.note,
            COALESCE(json_object_agg(li.item_id, li.done) FILTER (WHERE li.item_id IS NOT NULL), '{}') AS done,
            COALESCE(json_object_agg(li.item_id, li.reps_counted) FILTER (WHERE li.reps_counted IS NOT NULL), '{}') AS counted
       FROM home_logs l LEFT JOIN home_log_items li ON li.log_id = l.id
      WHERE l.program_id = $1 AND l.log_date BETWEEN $2 AND $3 GROUP BY l.id`, [program.id, start, end]);
  const byDate = new Map(logs.map((l) => [ymd(l.log_date), l]));
  const out = [];
  for (let d = start; d <= end; d = addDays(d, 1)) {
    const dow = isoDow(d);
    const scheduled = program.items.filter((i) => i.is_active && i.days_of_week.includes(dow));
    const log = byDate.get(d);
    const done = log ? scheduled.filter((i) => log.done[i.id]).length : 0;
    out.push({
      date: d, scheduled: scheduled.length, done, logged: Boolean(log),
      pain: log?.pain ?? null, difficulty: log?.difficulty ?? null, symptoms: log?.symptoms ?? [], note: log?.note ?? null,
      doneItems: log ? Object.keys(log.done).filter((k) => log.done[k]) : [],
      counted: log?.counted || {},
    });
  }
  return out;
}

const pct = (series) => {
  const s = series.reduce((a, d) => a + d.scheduled, 0);
  return s ? Math.round((series.reduce((a, d) => a + d.done, 0) / s) * 100) : null;
};

// ------------------------------------------------------------------ แบบประเมินรายสัปดาห์ (PSFS + GROC)
async function checkins(client, programId) {
  const { rows } = await client.query('SELECT checkin_date, psfs, groc FROM home_checkins WHERE program_id = $1 ORDER BY checkin_date', [programId]);
  return rows.map((r) => ({ date: ymd(r.checkin_date), psfs: r.psfs, groc: r.groc, psfsAvg: avgPsfs(r.psfs) }));
}
const avgPsfs = (list) => {
  const v = (list || []).map((x) => x.score).filter((x) => Number.isInteger(x));
  return v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 10) / 10 : null;
};
/** ถึงรอบประเมินเมื่อยังไม่เคยประเมิน หรือครั้งล่าสุดเกิน 6 วัน */
function checkinDue(list, today) {
  const last = list.at(-1);
  return !last || (new Date(`${today}T00:00:00Z`) - new Date(`${last.date}T00:00:00Z`)) / DAY_MS >= 7;
}

async function saveCheckin(token, b) {
  const link = await resolveToken(token);
  if (link.status !== 'active') throw conflict('PROGRAM_ENDED', 'โปรแกรมนี้สิ้นสุดแล้ว');
  const p = await loadProgram(db, link.program_id);
  const allowed = new Set(p.psfs_activities);
  const psfs = (b.psfs || []).filter((x) => allowed.has(x.activity)).map((x) => ({ activity: x.activity, score: x.score }));
  if (!psfs.length && b.groc == null) throw badRequest('กรุณาตอบอย่างน้อย 1 ข้อ');
  const today = bkkDate();
  await db.query(
    `INSERT INTO home_checkins (program_id, checkin_date, psfs, groc) VALUES ($1,$2,$3,$4)
     ON CONFLICT (program_id, checkin_date) DO UPDATE SET psfs = EXCLUDED.psfs, groc = EXCLUDED.groc`,
    [p.id, today, JSON.stringify(psfs), b.groc ?? null]);
  return { saved: true, checkins: await checkins(db, p.id) };
}

// ------------------------------------------------------------------ public (ผู้ป่วย/ญาติ)
async function publicView(token) {
  const link = await resolveToken(token);
  const p = await loadProgram(db, link.program_id);
  const today = bkkDate();
  const week = await dailySeries(db, p, addDays(today, -6), today);
  const todayLog = week.find((d) => d.date === today) || null;
  const { rows: [phone] } = await db.query("SELECT value #>> '{}' AS v FROM system_settings WHERE key = 'clinic.contact_phone'");
  return {
    patientFirstName: p.patient_first_name,
    therapistName: p.therapist_name,
    status: p.status,
    startDate: p.start_date,
    endDate: p.end_date,
    notes: p.notes,
    today,
    canLogDates: [today, addDays(today, -1)].filter((d) => d >= p.start_date && d <= p.end_date),
    items: p.items.filter((i) => i.is_active).map((i) => ({
      id: i.id, name: i.name_th, nameEn: i.name_en, instructions: i.instructions, cautions: i.cautions, videoUrl: i.video_url,
      sets: i.sets, reps: i.reps, holdSec: i.hold_sec, perDay: i.per_day, daysOfWeek: i.days_of_week, notes: i.notes,
      camera: i.camera || null,
    })),
    todayLog,
    week: week.map(({ date, scheduled, done, logged, pain }) => ({ date, scheduled, done, logged, pain })),
    weekAdherence: pct(week.filter((d) => d.date <= today)),
    redFlags: RED_FLAGS,
    contactPhone: phone?.v || null,
    checkin: await (async () => {
      const list = await checkins(db, p.id);
      return { activities: p.psfs_activities, due: checkinDue(list, today), last: list.at(-1) || null };
    })(),
    line: await (async () => {
      const { rows: [c] } = await db.query('SELECT line_user_id, opted_out_at, blocked_at FROM patient_contacts WHERE patient_id = $1', [p.patient_id]);
      const { rows: [n] } = await db.query("SELECT value FROM system_settings WHERE key = 'notify.enabled'");
      return { enabled: n?.value === true, linked: Boolean(c?.line_user_id && !c.opted_out_at && !c.blocked_at) };
    })(),
  };
}

/** ผู้ป่วยขอรหัสเชื่อม LINE จากหน้าโปรแกรมเอง */
async function publicLineCode(token) {
  const link = await resolveToken(token);
  const { rows: [p] } = await db.query('SELECT patient_id FROM home_programs WHERE id = $1', [link.program_id]);
  return require('./notify.service').createLinkCode(p.patient_id, null);
}

async function saveLog(token, b) {
  const link = await resolveToken(token);
  if (link.status !== 'active') throw conflict('PROGRAM_ENDED', 'โปรแกรมนี้สิ้นสุดแล้ว');
  const today = bkkDate();
  const date = b.date || today;
  if (![today, addDays(today, -1)].includes(date)) throw badRequest('บันทึกได้เฉพาะวันนี้หรือเมื่อวาน');
  for (const s of b.symptoms || []) if (!RED_FLAGS[s]) throw badRequest('อาการไม่ถูกต้อง');
  return db.withTx(async (c) => {
    const p = await loadProgram(c, link.program_id);
    if (date < p.start_date || date > p.end_date) throw badRequest('วันที่อยู่นอกช่วงโปรแกรม');
    const validItems = new Set(p.items.filter((i) => i.is_active).map((i) => i.id));
    const { rows: [log] } = await c.query(
      `INSERT INTO home_logs (program_id, log_date, pain, difficulty, symptoms, note, link_id) VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (program_id, log_date) DO UPDATE SET pain=EXCLUDED.pain, difficulty=EXCLUDED.difficulty, symptoms=EXCLUDED.symptoms,
             note=EXCLUDED.note, link_id=EXCLUDED.link_id, updated_at=now()
       RETURNING id`,
      [p.id, date, b.pain ?? null, b.difficulty ?? null, b.symptoms || [], b.note?.trim() || null, link.link_id]);
    await c.query('DELETE FROM home_log_items WHERE log_id = $1', [log.id]);
    for (const it of b.items || []) {
      if (!validItems.has(it.itemId)) continue;
      await c.query('INSERT INTO home_log_items (log_id, item_id, done, reps_counted) VALUES ($1,$2,$3,$4)', [log.id, it.itemId, Boolean(it.done), it.repsCounted ?? null]);
    }

    // แจ้งเตือน: ไม่ลบการแจ้งเตือนเดิม (แก้บันทึกภายหลังไม่ทำให้สัญญาณอันตรายหายไป) — ข้ามเฉพาะชนิดที่ยังรอรับทราบอยู่แล้ว
    const alerts = [];
    if (b.symptoms?.length) alerts.push({ kind: 'red_flag', detail: { symptoms: b.symptoms.map((s) => RED_FLAGS[s]) } });
    let baseline = p.baseline_pain;
    if (baseline === null) {
      const { rows: [f] } = await c.query(
        'SELECT pain FROM home_logs WHERE program_id = $1 AND pain IS NOT NULL AND log_date < $2 ORDER BY log_date LIMIT 1', [p.id, date]);
      baseline = f?.pain ?? null;
    }
    if (b.pain != null && baseline != null && b.pain - baseline >= p.pain_alert_increase) {
      alerts.push({ kind: 'pain_increase', detail: { pain: b.pain, baseline } });
    } else if (b.pain != null && b.pain >= 8) {
      alerts.push({ kind: 'high_pain', detail: { pain: b.pain } });
    }
    for (const a of alerts) {
      await c.query(
        `INSERT INTO home_alerts (program_id, log_id, kind, detail)
         SELECT $1,$2,$3,$4 WHERE NOT EXISTS (
           SELECT 1 FROM home_alerts WHERE log_id = $2 AND kind = $3 AND acknowledged_at IS NULL AND detail = $4::jsonb)`,
        [p.id, log.id, a.kind, JSON.stringify(a.detail)]);
    }
    const week = await dailySeries(c, p, addDays(today, -6), today);
    return {
      saved: true,
      date,
      advice: alerts.length ? 'stop' : 'ok',
      alerts: alerts.map((a) => a.kind),
      week: week.map(({ date: d, scheduled, done, logged, pain }) => ({ date: d, scheduled, done, logged, pain })),
      weekAdherence: pct(week),
    };
  });
}

// ------------------------------------------------------------------ สำหรับนักกายภาพ
async function programDetail(id, { days = 28 } = {}) {
  const p = await loadProgram(db, id);
  const today = bkkDate();
  const series = await dailySeries(db, p, addDays(today, -(days - 1)), today);
  const { rows: links } = await db.query(
    `SELECT id, label, created_at, expires_at, revoked_at, last_used_at,
            (revoked_at IS NULL AND expires_at > now()) AS active
       FROM home_access_links WHERE program_id = $1 ORDER BY created_at DESC`, [id]);
  const { rows: alerts } = await db.query(
    `SELECT a.*, l.log_date FROM home_alerts a LEFT JOIN home_logs l ON l.id = a.log_id
      WHERE a.program_id = $1 ORDER BY a.created_at DESC LIMIT 50`, [id]);
  const itemStats = p.items.filter((i) => i.is_active).map((i) => {
    const sched = series.filter((d) => i.days_of_week.includes(isoDow(d.date)));
    const done = sched.filter((d) => d.doneItems.includes(i.id)).length;
    const cam = series.filter((d) => d.counted[i.id] != null);
    return {
      id: i.id, name: i.name_th, scheduled: sched.length, done, pct: sched.length ? Math.round((done / sched.length) * 100) : null,
      cameraDays: cam.length, lastCounted: cam.length ? cam.at(-1).counted[i.id] : null,
    };
  });
  return {
    ...p, links, alerts, series, itemStats, checkins: await checkins(db, id),
    adherence7: pct(series.slice(-7)), adherenceAll: pct(series),
  };
}

/** สรุปที่บ้านของผู้ป่วย (ใช้ในหน้าเวชระเบียน/ความก้าวหน้า): ตั้งแต่นัดที่เสร็จครั้งล่าสุด หรือ 7 วันล่าสุด */
async function patientSummary(patientId) {
  const { rows: [pr] } = await db.query(
    `SELECT id FROM home_programs WHERE patient_id = $1 ORDER BY (status = 'active') DESC, created_at DESC LIMIT 1`, [patientId]);
  if (!pr) return null;
  const d = await programDetail(pr.id, { days: 56 });
  const today = bkkDate();
  const { rows: [last] } = await db.query(
    `SELECT (MAX(start_at) AT TIME ZONE '${TZ}')::date AS d FROM appointments
      WHERE patient_id = $1 AND status = 'completed' AND (start_at AT TIME ZONE '${TZ}')::date < $2`, [patientId, today]);
  const since = last?.d ? addDays(ymd(last.d), 1) : addDays(today, -6);
  const window = d.series.filter((x) => x.date >= since && x.date <= today);
  const pains = window.filter((x) => x.pain != null);
  return {
    programId: d.id,
    status: d.status,
    startDate: d.start_date,
    endDate: d.end_date,
    since,
    days: window.length,
    adherence: pct(window),
    loggedDays: window.filter((x) => x.logged).length,
    painFirst: pains[0]?.pain ?? null,
    painLast: pains.at(-1)?.pain ?? null,
    difficulty: window.filter((x) => x.difficulty).map((x) => x.difficulty),
    mostSkipped: d.itemStats.filter((i) => i.pct !== null && i.pct < 60).sort((a, b) => a.pct - b.pct).slice(0, 3),
    openAlerts: d.alerts.filter((a) => !a.acknowledged_at),
    series: d.series,
    lastLogDate: [...d.series].reverse().find((x) => x.logged)?.date || null,
    checkinFirst: d.checkins[0] || null,
    checkinLast: d.checkins.length > 1 ? d.checkins.at(-1) : null,
  };
}

async function monitor({ therapistId = null, user = null } = {}) {
  // นักกายภาพเห็นเฉพาะผู้ป่วยที่ตนดูแล/มีนัดด้วย (หัวหน้า/super user เห็นทุกคน)
  const f = user ? await require('./access.service').patientFilter(user, 'hp.patient_id', 2) : { sql: 'true', params: [] };
  const { rows } = await db.query(
    `SELECT hp.id FROM home_programs hp WHERE hp.status = 'active' AND ($1::uuid IS NULL OR hp.therapist_id = $1) AND ${f.sql} ORDER BY hp.created_at`,
    [therapistId, ...f.params]);
  const today = bkkDate();
  const list = [];
  for (const { id } of rows) {
    const d = await programDetail(id, { days: 14 });
    const lastLog = [...d.series].reverse().find((x) => x.logged);
    const started = d.start_date <= today;
    list.push({
      id: d.id, patientId: d.patient_id, patientName: d.patient_name, hn: d.hn, therapistName: d.therapist_name,
      startDate: d.start_date, endDate: d.end_date,
      adherence7: d.adherence7,
      lastLogDate: lastLog?.date || null,
      daysWithoutLog: started ? (lastLog ? Math.round((new Date(`${today}T00:00:00Z`) - new Date(`${lastLog.date}T00:00:00Z`)) / DAY_MS) : d.series.length) : 0,
      latestPain: lastLog?.pain ?? null,
      baselinePain: d.baseline_pain,
      openAlerts: d.alerts.filter((a) => !a.acknowledged_at).map((a) => ({ id: a.id, kind: a.kind, detail: a.detail, date: a.log_date })),
      activeLinks: d.links.filter((l) => l.active).length,
      week: d.series.slice(-7).map(({ date, scheduled, done, logged }) => ({ date, scheduled, done, logged })),
    });
  }
  // ต้องดูก่อน: มีแจ้งเตือน → ไม่บันทึกนาน → ทำน้อย
  return list.sort((a, b) => (b.openAlerts.length - a.openAlerts.length) || (b.daysWithoutLog - a.daysWithoutLog) || ((a.adherence7 ?? 101) - (b.adherence7 ?? 101)));
}

/**
 * แนะนำปรับระดับท่าจาก 7 วันล่าสุด
 *  เพิ่มความยาก: ทำ ≥ 80% ของวันที่กำหนด, รู้สึก "ยาก" ≤ 20% ของวันที่บันทึก, ปวดเฉลี่ยไม่สูงกว่าตั้งต้น
 *  ลดความยาก:   รู้สึก "ยาก" ≥ 50% หรือปวดเฉลี่ยสูงกว่าตั้งต้น ≥ 2 และทำได้ < 60%
 *  ทบทวน:       ทำ < 30% ทั้งที่ยังบันทึกอยู่ (อาจไม่เข้าใจท่า/เจ็บ/ไม่มีเวลา)
 */
function suggestFor(detail) {
  const win = detail.series.slice(-7);
  const loggedDays = win.filter((d) => d.logged);
  if (loggedDays.length < 3) return { basis: { loggedDays: loggedDays.length }, items: [], note: 'ข้อมูลยังไม่พอ (ต้องบันทึกอย่างน้อย 3 วันใน 7 วันล่าสุด)' };
  const hardRatio = loggedDays.filter((d) => d.difficulty === 'hard').length / loggedDays.length;
  const pains = loggedDays.map((d) => d.pain).filter((x) => x != null);
  const painAvg = pains.length ? pains.reduce((a, b) => a + b, 0) / pains.length : null;
  const baseline = detail.baseline_pain ?? (detail.series.find((d) => d.pain != null)?.pain ?? null);
  const painRise = painAvg != null && baseline != null ? painAvg - baseline : 0;
  const items = [];
  for (const it of detail.items.filter((i) => i.is_active)) {
    // นับเฉพาะวันหลังปรับขนาดท่าครั้งล่าสุด
    const since = it.dose_changed_at ? new Date(new Date(it.dose_changed_at).getTime() + 7 * 3600e3).toISOString().slice(0, 10) : null;
    const sched = win.filter((d) => it.days_of_week.includes(isoDow(d.date)) && (!since || d.date > since));
    if (sched.length < 2) continue;
    const doneRatio = sched.filter((d) => d.doneItems.includes(it.id)).length / sched.length;
    const cur = { sets: it.sets, reps: it.reps, holdSec: it.hold_sec };
    let type = null;
    let next = null;
    let reason = '';
    if (doneRatio >= 0.8 && hardRatio <= 0.2 && painRise <= 0) {
      type = 'progress';
      if (it.reps) next = { ...cur, reps: Math.min(100, Math.max(it.reps + 2, Math.round(it.reps * 1.2))) };
      else if (it.hold_sec && it.hold_sec < 3600) next = { ...cur, holdSec: Math.min(3600, it.hold_sec >= 60 ? it.hold_sec + 60 : it.hold_sec + 5) };
      else if (it.sets < 5) next = { ...cur, sets: it.sets + 1 };
      reason = `ทำได้ ${Math.round(doneRatio * 100)}% ของวันที่กำหนด ไม่รู้สึกยาก และปวดไม่เพิ่ม`;
    } else if ((hardRatio >= 0.5 || painRise >= 2) && doneRatio < 0.6) {
      type = 'regress';
      if (it.reps && it.reps > 3) next = { ...cur, reps: Math.max(3, Math.round(it.reps * 0.7)) };
      else if (it.hold_sec && it.hold_sec > 5) next = { ...cur, holdSec: Math.max(5, Math.round(it.hold_sec * 0.7)) };
      else if (it.sets > 1) next = { ...cur, sets: it.sets - 1 };
      reason = `ทำได้ ${Math.round(doneRatio * 100)}%${hardRatio >= 0.5 ? ` รู้สึกยาก ${Math.round(hardRatio * 100)}% ของวัน` : ''}${painRise >= 2 ? ` ปวดเฉลี่ยสูงกว่าตั้งต้น ${painRise.toFixed(1)}` : ''}`;
    } else if (doneRatio < 0.3) {
      type = 'review';
      reason = `ทำได้เพียง ${Math.round(doneRatio * 100)}% ควรสอบถามผู้ป่วยว่าติดปัญหาอะไร (ไม่เข้าใจท่า เจ็บ หรือไม่มีเวลา)`;
    }
    if (type) items.push({ itemId: it.id, name: it.name_th, type, current: cur, proposed: next, reason, doneRatio: Math.round(doneRatio * 100) });
  }
  return { basis: { loggedDays: loggedDays.length, hardRatio: Math.round(hardRatio * 100), painAvg: painAvg == null ? null : Math.round(painAvg * 10) / 10, baseline }, items };
}

async function suggestions(id) {
  return suggestFor(await programDetail(id, { days: 14 }));
}

async function acknowledgeAlert(id, userId, note) {
  const { rowCount } = await db.query(
    'UPDATE home_alerts SET acknowledged_by=$2, acknowledged_at=now(), ack_note=$3 WHERE id=$1 AND acknowledged_at IS NULL', [id, userId, note || null]);
  if (!rowCount) throw notFound('การแจ้งเตือน');
}

module.exports = {
  RED_FLAGS, hashToken, bkkDate, listExercises, createProgram, updateProgram, endProgram, createLink, revokeLink,
  publicView, saveLog, programDetail, patientSummary, monitor, acknowledgeAlert, loadProgram,
  saveCheckin, publicLineCode, suggestions, suggestFor,
};
