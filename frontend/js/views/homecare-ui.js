/**
 * ส่วนประกอบที่ใช้ร่วมกัน: สั่ง/แก้โปรแกรมกายภาพที่บ้าน, ลิงก์ + QR code, ใบแนะนำสำหรับพิมพ์, สรุปการทำที่บ้าน
 */
import { api } from '../api.js';
import { $, $$, esc, btn, input, modal, toast, showError, fmtDate, fmtDateTime, bkkToday } from '../ui.js';

export const REGION_TH = {
  neck: 'คอ', shoulder: 'ไหล่', back: 'หลัง', hip: 'สะโพก', knee: 'เข่า', ankle: 'ข้อเท้า', balance: 'การทรงตัว', general: 'ทั่วไป',
};
const DOW_TH = ['จ', 'อ', 'พ', 'พฤ', 'ศ', 'ส', 'อา'];
const DIFF_TH = { easy: 'ง่าย', ok: 'พอดี', hard: 'ยาก' };
export const ALERT_TH = { red_flag: 'อาการอันตราย', pain_increase: 'ปวดเพิ่มขึ้นมาก', high_pain: 'ปวดมาก (≥ 8)' };
const QR_URL = 'https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js';

/** ใช้ได้ทั้งท่าในโปรแกรม (sets/reps/…) และท่าในคลัง (default_sets/default_reps/…) */
export function doseText(i) {
  const sets = i.sets ?? i.default_sets;
  const reps = i.reps ?? i.default_reps;
  const parts = [`${sets} เซ็ต`];
  if (reps) parts.push(`× ${reps} ครั้ง`);
  const hold = i.hold_sec ?? i.holdSec ?? i.default_hold_sec;
  if (hold) parts.push(hold >= 60 ? `${Math.round(hold / 60)} นาที` : `ค้าง ${hold} วิ`);
  const perDay = i.per_day ?? i.perDay ?? i.default_per_day;
  if (perDay > 1) parts.push(`วันละ ${perDay} รอบ`);
  return parts.join(' ');
}

const pctBadge = (v) => {
  if (v === null || v === undefined) return '<span class="text-slate-400">–</span>';
  const cls = v >= 80 ? 'bg-emerald-50 text-emerald-700 ring-emerald-200' : v >= 50 ? 'bg-amber-50 text-amber-700 ring-amber-200' : 'bg-rose-50 text-rose-700 ring-rose-200';
  return `<span class="inline-flex rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ring-inset ${cls}">${v}%</span>`;
};
export { pctBadge };

// ------------------------------------------------------------------ program editor
/**
 * opts: { patient: {id, name}, appointmentId?, baselinePain?, program? (แก้ไข), onSaved(program) }
 */
export async function openProgramEditor({ patient, appointmentId, baselinePain, program, onSaved }) {
  const exercises = await api.get('/home/exercises');
  const exById = new Map(exercises.map((e) => [e.id, e]));
  const today = bkkToday();
  const plus = (n) => new Date(new Date(`${today}T12:00:00Z`).getTime() + n * 864e5).toISOString().slice(0, 10);
  const items = program
    ? program.items.filter((i) => i.is_active).map((i) => ({
      id: i.id, exerciseId: i.exercise_id, sets: i.sets, reps: i.reps, holdSec: i.hold_sec, perDay: i.per_day, daysOfWeek: [...i.days_of_week], notes: i.notes || '',
    }))
    : [];
  let region = 'all';

  const m = modal(program ? `แก้ไขโปรแกรมที่บ้าน · ${patient.name}` : `สั่งโปรแกรมที่บ้าน · ${patient.name}`, `
    <div class="grid lg:grid-cols-5 gap-5 text-sm">
      <section class="lg:col-span-2 space-y-2">
        <div class="font-semibold">คลังท่า</div>
        <div class="flex flex-wrap gap-1" id="hp-regions"></div>
        <div id="hp-library" class="space-y-1 max-h-[52vh] overflow-y-auto pr-1"></div>
      </section>
      <section class="lg:col-span-3 space-y-3">
        <div class="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <label class="block">วันเริ่ม<input id="hp-start" type="date" class="${input}" value="${program?.start_date || today}"></label>
          <label class="block">วันสิ้นสุด<input id="hp-end" type="date" class="${input}" value="${program?.end_date || plus(27)}"></label>
          <label class="block">ปวดตั้งต้น (0–10)<input id="hp-base" type="number" min="0" max="10" class="${input}" value="${program?.baseline_pain ?? baselinePain ?? ''}"></label>
          <label class="block" title="แจ้งเตือนเมื่อปวดเพิ่มจากตั้งต้นเท่านี้ขึ้นไป">แจ้งเตือนเมื่อปวดเพิ่ม<input id="hp-inc" type="number" min="1" max="10" class="${input}" value="${program?.pain_alert_increase ?? 3}"></label>
        </div>
        <label class="block">คำแนะนำถึงผู้ป่วย<textarea id="hp-notes" rows="2" class="${input}" placeholder="เช่น ทำวันละ 2 รอบ เช้า-เย็น ประคบร้อนก่อนทำ">${esc(program?.notes || '')}</textarea></label>
        <div class="font-semibold">ท่าในโปรแกรม <span id="hp-count" class="text-slate-500 font-normal"></span></div>
        <div id="hp-items" class="space-y-2"></div>
        ${program ? '' : `<label class="flex gap-2 items-start rounded-lg bg-amber-50 ring-1 ring-amber-200 p-3">
          <input id="hp-consent" type="checkbox" class="mt-1">
          <span>ผู้ป่วยหรือผู้แทน<b>ยินยอม</b>ให้บันทึกข้อมูลการออกกำลังกายและอาการที่บ้านผ่านลิงก์ และให้นักกายภาพใช้ข้อมูลนี้ติดตามการรักษา (PDPA)
          <input id="hp-consent-note" class="${input} mt-2" placeholder="วิธีให้ความยินยอม เช่น ยินยอมด้วยวาจาต่อหน้า / ลงนามในแบบฟอร์ม"></span>
        </label>`}
        <p data-form-error class="text-rose-600 hidden"></p>
        <div class="flex gap-2">${btn(program ? 'บันทึกการแก้ไข' : 'สร้างโปรแกรม', 'id="hp-save"')}</div>
      </section>
    </div>`, { wide: true });

  function renderRegions() {
    const regions = ['all', ...new Set(exercises.map((e) => e.body_region))];
    $('#hp-regions', m.el).innerHTML = regions.map((r) => `<button type="button" data-region="${r}" class="rounded-full px-2.5 py-0.5 text-xs ring-1 ring-inset ${r === region ? 'bg-brand-600 text-white ring-brand-600' : 'bg-white ring-slate-300'}">${r === 'all' ? 'ทั้งหมด' : REGION_TH[r]}</button>`).join('');
  }
  function renderLibrary() {
    const chosen = new Set(items.map((i) => i.exerciseId));
    $('#hp-library', m.el).innerHTML = exercises.filter((e) => region === 'all' || e.body_region === region).map((e) => `
      <div class="flex items-start justify-between gap-2 rounded-lg ring-1 ring-slate-200 px-3 py-2 ${chosen.has(e.id) ? 'bg-slate-50 opacity-60' : 'bg-white'}">
        <div><div class="font-medium">${esc(e.name_th)}</div><div class="text-xs text-slate-500">${esc(REGION_TH[e.body_region])} · ${esc(doseText(e))}${e.video_url ? ' · มีวิดีโอ' : ''}</div></div>
        <button type="button" data-add="${e.id}" class="text-brand-700 text-xs font-semibold whitespace-nowrap" ${chosen.has(e.id) ? 'disabled' : ''}>${chosen.has(e.id) ? 'เลือกแล้ว' : '+ เพิ่ม'}</button>
      </div>`).join('');
  }
  function renderItems() {
    $('#hp-count', m.el).textContent = `(${items.length})`;
    $('#hp-items', m.el).innerHTML = items.length ? items.map((it, k) => {
      const e = exById.get(it.exerciseId);
      const num = (f, label, min, max) => `<label class="block text-xs text-slate-500">${label}<input data-f="${f}" data-k="${k}" type="number" min="${min}" max="${max}" value="${it[f] ?? ''}" class="${input} !px-2"></label>`;
      return `<div class="rounded-lg ring-1 ring-slate-200 p-3 space-y-2 bg-white">
        <div class="flex justify-between gap-2"><div class="font-medium">${k + 1}. ${esc(e?.name_th || '')}</div>
          <button type="button" data-remove="${k}" class="text-rose-600 text-xs">เอาออก</button></div>
        <div class="grid grid-cols-4 gap-2">${num('sets', 'เซ็ต', 1, 10)}${num('reps', 'ครั้ง', 1, 100)}${num('holdSec', 'ค้าง (วินาที)', 1, 3600)}${num('perDay', 'รอบ/วัน', 1, 6)}</div>
        <div class="flex flex-wrap items-center gap-1 text-xs"><span class="text-slate-500 mr-1">วันที่ทำ</span>${DOW_TH.map((d, i) => `<button type="button" data-dow="${i + 1}" data-k="${k}" class="w-8 h-7 rounded ring-1 ring-inset ${it.daysOfWeek.includes(i + 1) ? 'bg-brand-600 text-white ring-brand-600' : 'bg-white ring-slate-300'}">${d}</button>`).join('')}</div>
        <input data-f="notes" data-k="${k}" class="${input}" placeholder="หมายเหตุท่านี้ (ไม่บังคับ) เช่น ทำเฉพาะข้างซ้าย" value="${esc(it.notes || '')}">
      </div>`;
    }).join('') : '<div class="text-slate-400 rounded-lg ring-1 ring-dashed ring-slate-300 p-4 text-center">เลือกท่าจากคลังด้านซ้าย</div>';
  }
  renderRegions(); renderLibrary(); renderItems();

  m.el.addEventListener('click', (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.dataset.region) { region = t.dataset.region; renderRegions(); renderLibrary(); }
    if (t.dataset.add) {
      const ex = exById.get(Number(t.dataset.add));
      items.push({ exerciseId: ex.id, sets: ex.default_sets, reps: ex.default_reps, holdSec: ex.default_hold_sec, perDay: ex.default_per_day, daysOfWeek: [1, 2, 3, 4, 5, 6, 7], notes: '' });
      renderItems(); renderLibrary();
    }
    if (t.dataset.remove) { items.splice(Number(t.dataset.remove), 1); renderItems(); renderLibrary(); }
    if (t.dataset.dow) {
      const it = items[Number(t.dataset.k)];
      const d = Number(t.dataset.dow);
      it.daysOfWeek = it.daysOfWeek.includes(d) ? it.daysOfWeek.filter((x) => x !== d) : [...it.daysOfWeek, d].sort();
      renderItems();
    }
  });
  m.el.addEventListener('input', (e) => {
    const f = e.target.dataset.f;
    if (!f) return;
    const it = items[Number(e.target.dataset.k)];
    it[f] = f === 'notes' ? e.target.value : e.target.value === '' ? null : Number(e.target.value);
  });

  $('#hp-save', m.el).addEventListener('click', async (e) => {
    const err = $('[data-form-error]', m.el);
    err.classList.add('hidden');
    const num = (id) => ($(id, m.el).value === '' ? null : Number($(id, m.el).value));
    const body = {
      startDate: $('#hp-start', m.el).value, endDate: $('#hp-end', m.el).value,
      baselinePain: num('#hp-base'), painAlertIncrease: num('#hp-inc') ?? 3, notes: $('#hp-notes', m.el).value.trim() || null,
      items: items.map((it) => ({ ...(it.id ? { id: it.id } : {}), exerciseId: it.exerciseId, sets: it.sets, reps: it.reps || null, holdSec: it.holdSec || null, perDay: it.perDay || 1, daysOfWeek: it.daysOfWeek, notes: it.notes || null })),
    };
    try {
      if (!items.length) throw new Error('เลือกอย่างน้อย 1 ท่า');
      if (items.some((it) => !it.daysOfWeek.length)) throw new Error('ทุกท่าต้องเลือกวันที่ทำอย่างน้อย 1 วัน');
      e.target.disabled = true;
      let saved;
      if (program) saved = await api.patch(`/home/programs/${program.id}`, body);
      else {
        if (!$('#hp-consent', m.el).checked) throw new Error('ต้องได้รับความยินยอมจากผู้ป่วยหรือผู้แทนก่อน');
        saved = await api.post('/home/programs', {
          ...body, patientId: patient.id, appointmentId: appointmentId || undefined, consent: true, consentNote: $('#hp-consent-note', m.el).value.trim() || null,
        });
      }
      toast(program ? 'บันทึกโปรแกรมแล้ว' : 'สร้างโปรแกรมแล้ว — สร้างลิงก์ให้ผู้ป่วยต่อได้เลย', 'success');
      m.close();
      onSaved?.(saved);
    } catch (ex) {
      err.textContent = ex.details?.length ? `${ex.message} — ${ex.details.map((d) => d.message).join(' · ')}` : ex.message;
      err.classList.remove('hidden');
    } finally { e.target.disabled = false; }
  });
}

// ------------------------------------------------------------------ links + QR + handout
let qrLoaded;
function loadQr() {
  qrLoaded ||= new Promise((resolve, reject) => {
    if (window.qrcode) { resolve(window.qrcode); return; }
    const s = document.createElement('script');
    s.src = QR_URL; s.onload = () => resolve(window.qrcode); s.onerror = () => reject(new Error('โหลดตัวสร้าง QR ไม่ได้'));
    document.head.appendChild(s);
  });
  return qrLoaded;
}
async function qrDataUrl(text, cell = 6) {
  const qrcode = await loadQr();
  const q = qrcode(0, 'M');
  q.addData(text);
  q.make();
  return q.createDataURL(cell, 8);
}
const homeUrl = (token) => `${location.origin}/home#t=${token}`;

export async function openLinks(programId, onChange) {
  const p = await api.get(`/home/programs/${programId}`);
  const m = modal(`ลิงก์โปรแกรมที่บ้าน · ${p.patient_name}`, `
    <div class="space-y-4 text-sm">
      <div class="rounded-lg bg-slate-50 p-3">
        <div class="font-medium mb-2">สร้างลิงก์ใหม่</div>
        <div class="flex flex-wrap gap-2 items-center">
          <select id="ln-label" class="${input} max-w-[160px]"><option>ผู้ป่วย</option><option>ญาติ</option><option>ผู้ดูแล</option></select>
          ${btn('สร้างลิงก์ + QR', 'id="ln-new"')}
        </div>
        <p class="text-xs text-slate-500 mt-2">ลิงก์แสดงได้ครั้งเดียว ใช้ได้ถึง 7 วันหลังสิ้นสุดโปรแกรม แต่ละคนควรมีลิงก์ของตัวเองเพื่อยกเลิกแยกได้</p>
      </div>
      <div id="ln-out"></div>
      <div>
        <div class="font-medium mb-1">ลิงก์ทั้งหมด</div>
        <div id="ln-list"></div>
      </div>
    </div>`, { wide: true });

  async function renderList() {
    const d = await api.get(`/home/programs/${programId}`);
    $('#ln-list', m.el).innerHTML = d.links.length ? `<table class="w-full text-sm"><thead class="text-xs text-slate-500 text-left"><tr><th class="py-1">สำหรับ</th><th>สร้าง</th><th>ใช้ล่าสุด</th><th>หมดอายุ</th><th></th></tr></thead><tbody>
      ${d.links.map((l) => `<tr class="border-t border-slate-100"><td class="py-1.5">${esc(l.label)}</td><td>${fmtDate(l.created_at)}</td><td>${l.last_used_at ? fmtDateTime(l.last_used_at) : '<span class="text-slate-400">ยังไม่เปิด</span>'}</td>
        <td>${l.active ? fmtDate(l.expires_at) : `<span class="text-slate-400">${l.revoked_at ? 'ยกเลิกแล้ว' : 'หมดอายุ'}</span>`}</td>
        <td class="text-right">${l.active ? btn('ยกเลิก', `data-revoke="${l.id}"`, 'ghost') : ''}</td></tr>`).join('')}</tbody></table>`
      : '<div class="text-slate-400">ยังไม่มีลิงก์</div>';
  }
  await renderList();

  $('#ln-new', m.el).addEventListener('click', async () => {
    try {
      const l = await api.post(`/home/programs/${programId}/links`, { label: $('#ln-label', m.el).value });
      const url = homeUrl(l.token);
      const qr = await qrDataUrl(url).catch(() => null);
      const message = `โปรแกรมกายภาพที่บ้านของคุณ${p.patient_first_name} (${p.therapist_name})\nกดเปิดทุกวันเพื่อดูท่าและบันทึกการทำ:\n${url}\nกรุณาอย่าส่งต่อลิงก์นี้ให้ผู้อื่น`;
      $('#ln-out', m.el).innerHTML = `<div class="rounded-xl ring-1 ring-emerald-200 bg-emerald-50 p-4 grid sm:grid-cols-[auto,1fr] gap-4 items-start">
        ${qr ? `<img src="${qr}" alt="QR code ลิงก์โปรแกรม" class="w-40 h-40 bg-white rounded">` : ''}
        <div class="space-y-2 min-w-0">
          <div class="font-medium">ลิงก์สำหรับ${esc(l.label)} (คัดลอกตอนนี้ ระบบจะไม่แสดงอีก)</div>
          <input readonly class="${input} font-mono text-xs" value="${esc(url)}" id="ln-url">
          <div class="flex flex-wrap gap-2">${btn('คัดลอกลิงก์', 'id="ln-copy"', 'ghost')}${btn('คัดลอกข้อความสำหรับ LINE/SMS', 'id="ln-msg"', 'ghost')}${btn('พิมพ์ใบให้ผู้ป่วย', 'id="ln-print"')}</div>
          <p class="text-xs text-slate-600">ข้อความไม่ระบุโรคหรือข้อมูลการรักษา · ผู้ป่วยสแกน QR หรือกดลิงก์ได้เลย ไม่ต้องสมัครหรือใส่รหัสผ่าน</p>
        </div></div>`;
      const copy = async (text, ok) => { try { await navigator.clipboard.writeText(text); toast(ok, 'success'); } catch { $('#ln-url', m.el).select(); } };
      $('#ln-copy', m.el).addEventListener('click', () => copy(url, 'คัดลอกลิงก์แล้ว'));
      $('#ln-msg', m.el).addEventListener('click', () => copy(message, 'คัดลอกข้อความแล้ว วางใน LINE หรือ SMS ได้เลย'));
      $('#ln-print', m.el).addEventListener('click', () => printHandout(p, url, qr));
      await renderList();
      onChange?.();
    } catch (err) { showError(err); }
  });
  $('#ln-list', m.el).addEventListener('click', async (e) => {
    const b = e.target.closest('[data-revoke]');
    if (!b || !confirm('ยกเลิกลิงก์นี้? ผู้ที่ถือลิงก์จะเปิดไม่ได้ทันที')) return;
    try { await api.post(`/home/links/${b.dataset.revoke}/revoke`); toast('ยกเลิกลิงก์แล้ว', 'success'); await renderList(); onChange?.(); } catch (err) { showError(err); }
  });
}

/** ใบแนะนำสำหรับพิมพ์ให้ผู้ป่วย: QR + ท่า + ข้อควรระวัง (ไม่ระบุโรค) */
function printHandout(p, url, qr) {
  const items = p.items.filter((i) => i.is_active);
  const days = (i) => (i.days_of_week.length === 7 ? 'ทุกวัน' : i.days_of_week.map((d) => DOW_TH[d - 1]).join(' '));
  const w = window.open('', '_blank', 'width=800,height=1000');
  if (!w) { toast('เบราว์เซอร์บล็อกหน้าต่างใหม่ — อนุญาต pop-up แล้วลองอีกครั้ง', 'warn'); return; }
  w.document.write(`<!doctype html><html lang="th"><head><meta charset="utf-8"><title>โปรแกรมกายภาพที่บ้าน</title>
    <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Thai:wght@400;600;700&display=swap" rel="stylesheet">
    <style>body{font-family:"IBM Plex Sans Thai",sans-serif;margin:24px;color:#142230;font-size:15px;line-height:1.55}
    h1{font-size:22px;margin:0}.top{display:flex;gap:20px;align-items:center;border-bottom:2px solid #1474bf;padding-bottom:12px;margin-bottom:12px}
    .ex{border:1px solid #d9e1e8;border-radius:10px;padding:10px 12px;margin:8px 0;break-inside:avoid}.dose{font-weight:600;color:#1474bf}
    .warn{background:#fdecea;border-radius:10px;padding:10px 12px;margin-top:12px;break-inside:avoid}.muted{color:#5a6977;font-size:13px}
    @page{size:A4;margin:14mm}</style></head><body>
    <div class="top">${qr ? `<img src="${qr}" width="150" height="150" alt="">` : ''}<div>
      <h1>โปรแกรมกายภาพที่บ้าน</h1><div>คุณ${esc(p.patient_first_name)} · ผู้ดูแล ${esc(p.therapist_name)}</div>
      <div>${fmtDate(p.start_date)} – ${fmtDate(p.end_date)}</div>
      <div class="muted">สแกน QR ทุกวันเพื่อดูท่าและกดบันทึกการทำ (ไม่ต้องสมัครหรือใส่รหัสผ่าน)</div></div></div>
    ${p.notes ? `<p><b>คำแนะนำ:</b> ${esc(p.notes)}</p>` : ''}
    ${items.map((i, n) => `<div class="ex"><b>${n + 1}. ${esc(i.name_th)}</b> — <span class="dose">${esc(doseText(i))}</span> · ${esc(days(i))}
      <div>${esc(i.instructions)}</div>${i.notes ? `<div><b>เพิ่มเติม:</b> ${esc(i.notes)}</div>` : ''}${i.cautions ? `<div class="muted">⚠ ${esc(i.cautions)}</div>` : ''}</div>`).join('')}
    <div class="warn"><b>หยุดออกกำลังกายและติดต่อคลินิก</b> ถ้าปวดมากขึ้นชัดเจน ชาหรืออ่อนแรงมากขึ้น เวียนศีรษะ หกล้ม หรือบวมแดงร้อน<br>
      <b>โทร 1669 ทันที</b> ถ้าเจ็บแน่นหน้าอก หายใจไม่ออก แขนขาอ่อนแรงครึ่งซีก หรือพูดไม่ชัด</div>
    <p class="muted">ลิงก์นี้เป็นของคุณ${esc(p.patient_first_name)}เท่านั้น กรุณาอย่าส่งต่อหรือโพสต์ในที่สาธารณะ</p>
    <script>window.onload=()=>setTimeout(()=>window.print(),300)<\/script></body></html>`);
  w.document.close();
}

// ------------------------------------------------------------------ summary card (เวชระเบียน)
export function summaryCardHtml(s) {
  if (!s) return '';
  const trend = s.painFirst != null && s.painLast != null ? `ปวด ${s.painFirst} → <b>${s.painLast}</b>` : 'ยังไม่มีคะแนนปวด';
  const hard = s.difficulty.filter((d) => d === 'hard').length;
  return `<div class="p-4 space-y-2 text-sm">
    <div class="flex items-center justify-between"><div class="font-semibold">🏠 ที่บ้านตั้งแต่ ${fmtDate(s.since)}</div>${pctBadge(s.adherence)}</div>
    ${s.status !== 'active' ? '<div class="text-xs text-slate-500">โปรแกรมสิ้นสุดแล้ว</div>' : ''}
    <div class="grid grid-cols-2 gap-2">
      <div class="rounded-lg bg-slate-50 p-2"><div class="text-[11px] text-slate-500">บันทึก</div><div class="font-semibold">${s.loggedDays}/${s.days} วัน</div></div>
      <div class="rounded-lg bg-slate-50 p-2"><div class="text-[11px] text-slate-500">ความปวดที่บ้าน</div><div>${trend}</div></div>
    </div>
    ${hard ? `<div class="text-xs">รู้สึกว่ายาก ${hard} วัน</div>` : ''}
    ${s.mostSkipped.length ? `<div class="text-xs"><span class="text-slate-500">ข้ามบ่อย:</span> ${s.mostSkipped.map((i) => `${esc(i.name)} (${i.pct}%)`).join(', ')}</div>` : ''}
    ${s.openAlerts.length ? `<div class="rounded-lg bg-rose-50 ring-1 ring-rose-200 p-2 text-xs text-rose-800">⚠ ${s.openAlerts.map((a) => `${ALERT_TH[a.kind]}${a.detail?.symptoms ? `: ${esc(a.detail.symptoms.join(', '))}` : a.detail?.pain != null ? ` (ปวด ${a.detail.pain})` : ''}`).join(' · ')}</div>` : ''}
    <a href="#/homecare/${s.programId}" class="text-xs text-brand-700 hover:underline">ดูรายละเอียด →</a>
  </div>`;
}

export { DIFF_TH, DOW_TH };
