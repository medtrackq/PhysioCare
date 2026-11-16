/**
 * วิดีโอคอลติดตามผล (นักกายภาพ): รายการนัด, สร้างนัด + ลิงก์/QR/LINE, ห้องคุย (WebRTC) พร้อมบันทึก
 */
import { api } from '../api.js';
import { $, esc, pageHeader, btn, input, card, empty, toast, showError, fmtDate, fmtTime, fmtDateTime, modal, bkkToday, bkkISO } from '../ui.js';
import { qrDataUrl, summaryCardHtml } from './homecare-ui.js';
import { CallClient, getMedia } from '../rtc.js';

const STATUS = {
  scheduled: ['นัดไว้', 'bg-sky-50 text-sky-700 ring-sky-200'],
  in_progress: ['กำลังคุย', 'bg-emerald-50 text-emerald-700 ring-emerald-200'],
  completed: ['เสร็จแล้ว', 'bg-slate-100 text-slate-600 ring-slate-200'],
  cancelled: ['ยกเลิก', 'bg-slate-50 text-slate-400 ring-slate-200'],
  no_show: ['ผู้ป่วยไม่เข้า', 'bg-amber-50 text-amber-700 ring-amber-200'],
};
const badge = (s) => `<span class="text-xs rounded-full px-2 py-0.5 ring-1 ring-inset ${STATUS[s][1]}">${STATUS[s][0]}</span>`;
const dot = (on, label) => `<span class="inline-flex items-center gap-1 text-xs ${on ? 'text-emerald-700' : 'text-slate-400'}"><span class="w-2 h-2 rounded-full ${on ? 'bg-emerald-500' : 'bg-slate-300'}"></span>${label}</span>`;

export async function render(root, { params, session }) {
  if (params[0]) return renderRoom(root, params[0], session);
  return renderList(root, session);
}

// ------------------------------------------------------------------ รายการนัด
async function renderList(root, session) {
  const canWrite = session.can('emr:write');
  let tab = 'upcoming';
  let mine = Boolean(session.user?.staffId);
  const cfg = await api.get('/tele/config').catch(() => ({}));
  root.innerHTML = `
    ${pageHeader('วิดีโอคอลติดตามผล', 'คุยกับผู้ป่วยผ่านวิดีโอ ดูท่าออกกำลังกายที่บ้าน และบันทึกผล — ไม่มีการบันทึกภาพหรือเสียง', canWrite ? btn('+ นัดวิดีโอคอล', 'id="tl-new"') : '')}
    ${cfg.turnConfigured ? '' : `<div class="mb-4 rounded-lg bg-amber-50 ring-1 ring-amber-200 text-amber-800 text-sm px-3 py-2">
      ยังไม่ได้ตั้ง TURN server — ส่วนใหญ่โทรได้ตามปกติ แต่ผู้ป่วยบางเครือข่าย (เช่น 4G บางค่าย หรือ Wi-Fi องค์กร) อาจต่อไม่ติด ดูวิธีตั้งในคู่มือติดตั้ง หัวข้อวิดีโอคอล</div>`}
    <div class="flex flex-wrap items-center gap-3 mb-4">
      <div class="inline-flex rounded-lg ring-1 ring-inset ring-slate-300 bg-white overflow-hidden text-sm" id="tl-tabs">
        <button type="button" data-tab="upcoming" class="px-4 py-1.5">วันนี้และที่จะถึง</button>
        <button type="button" data-tab="past" class="px-4 py-1.5">ที่ผ่านมา</button>
      </div>
      ${session.user?.staffId ? `<label class="text-sm flex items-center gap-2"><input type="checkbox" id="tl-mine" ${mine ? 'checked' : ''}> เฉพาะผู้ป่วยของฉัน</label>` : ''}
    </div>
    <div id="tl-list"></div>`;

  async function load() {
    root.querySelectorAll('[data-tab]').forEach((b) => { b.className = `px-4 py-1.5 ${b.dataset.tab === tab ? 'bg-brand-600 text-white' : ''}`; });
    const today = `${bkkToday()}T00:00:00+07:00`;
    const q = tab === 'upcoming' ? `from=${encodeURIComponent(today)}` : `to=${encodeURIComponent(today)}`;
    let rows = await api.get(`/tele/sessions?${q}${mine ? '&mine=true' : ''}`);
    if (tab === 'past') rows = rows.reverse();
    $('#tl-list').innerHTML = rows.length ? card(`<div class="overflow-x-auto"><table class="w-full text-sm">
      <thead class="text-left text-xs text-slate-500"><tr><th class="p-3">เวลา</th><th>ผู้ป่วย</th><th>นักกายภาพ</th><th>เรื่อง</th><th>สถานะ</th><th></th></tr></thead><tbody>
      ${rows.map((t) => `<tr class="border-t border-slate-100 align-top">
        <td class="p-3 whitespace-nowrap"><div class="font-medium">${fmtDate(t.scheduled_at)}</div><div class="text-slate-500">${fmtTime(t.scheduled_at)} · ${t.duration_min} นาที</div></td>
        <td class="py-3"><div>${esc(t.patient_name)}</div><div class="text-xs text-slate-500">${esc(t.hn)}${t.line_linked ? ' · LINE ✓' : ''}</div></td>
        <td class="py-3">${esc(t.therapist_name)}</td>
        <td class="py-3 text-xs max-w-[28ch]">${esc(t.purpose || '–')}</td>
        <td class="py-3"><div>${badge(t.status)}</div>${['scheduled', 'in_progress'].includes(t.status) ? `<div class="mt-1 flex gap-2">${dot(t.online.patient, 'ผู้ป่วยอยู่ในห้อง')}</div>` : ''}</td>
        <td class="py-3 pr-3 text-right whitespace-nowrap">
          ${['scheduled', 'in_progress'].includes(t.status) ? `<a href="#/tele/${t.id}" class="inline-flex items-center rounded-lg px-3 py-1.5 text-sm font-medium bg-emerald-600 text-white hover:bg-emerald-700">📹 เข้าห้อง</a>` : `<a href="#/tele/${t.id}" class="text-brand-700 text-sm">ดูบันทึก</a>`}
          ${canWrite && t.status === 'scheduled' ? `${btn('ลิงก์ผู้ป่วย', `data-link="${t.id}"`, 'ghost')} ${btn('ยกเลิก', `data-cancel="${t.id}"`, 'ghost')}` : ''}
        </td></tr>`).join('')}</tbody></table></div>`) : card(empty(tab === 'upcoming' ? 'ยังไม่มีนัดวิดีโอคอล' : 'ไม่มีประวัติวิดีโอคอล'));
    $('#tl-list').querySelectorAll('[data-link]').forEach((b) => b.addEventListener('click', () => openLinkModal(rows.find((x) => x.id === b.dataset.link), { regenerate: true })));
    $('#tl-list').querySelectorAll('[data-cancel]').forEach((b) => b.addEventListener('click', async () => {
      if (!confirm('ยกเลิกนัดวิดีโอคอลนี้? ลิงก์ของผู้ป่วยจะใช้ไม่ได้')) return;
      try { await api.patch(`/tele/sessions/${b.dataset.cancel}`, { status: 'cancelled' }); toast('ยกเลิกแล้ว', 'success'); load(); } catch (err) { showError(err); }
    }));
  }
  $('#tl-tabs').addEventListener('click', (e) => { const b = e.target.closest('[data-tab]'); if (b) { tab = b.dataset.tab; load(); } });
  $('#tl-mine')?.addEventListener('change', (e) => { mine = e.target.checked; load(); });
  $('#tl-new')?.addEventListener('click', () => openTeleNew({ onSaved: load }));
  await load();
  const timer = setInterval(() => { if (document.visibilityState === 'visible') load().catch(() => {}); }, 20_000);
  return () => clearInterval(timer);
}

// ------------------------------------------------------------------ นัดใหม่
export async function openTeleNew({ patient = null, onSaved } = {}) {
  const now = new Date(Date.now() + 7 * 3600e3 + 30 * 60_000);
  const hh = String(now.getUTCHours()).padStart(2, '0');
  const mm = now.getUTCMinutes() < 30 ? '30' : '00';
  const defTime = mm === '00' ? `${String((now.getUTCHours() + 1) % 24).padStart(2, '0')}:00` : `${hh}:30`;
  const m = modal('นัดวิดีโอคอล', `
    <form class="grid sm:grid-cols-2 gap-3 text-sm" id="tn-form">
      <label class="block sm:col-span-2">ผู้ป่วย
        ${patient ? `<div class="font-medium py-1.5">${esc(patient.name)}</div><input type="hidden" name="patientId" value="${patient.id}">`
    : `<input id="tn-q" class="${input}" placeholder="พิมพ์ HN / ชื่อ / เบอร์โทร แล้วเลือก" autocomplete="off"><select name="patientId" id="tn-p" class="${input} mt-1" required size="4"></select>`}
      </label>
      <label class="block">วันที่<input name="date" type="date" required class="${input}" value="${bkkToday()}" min="${bkkToday()}"></label>
      <label class="block">เวลา<input name="time" type="time" required class="${input}" value="${defTime}"></label>
      <label class="block">ระยะเวลา<select name="durationMin" class="${input}">${[15, 20, 30, 45].map((n) => `<option value="${n}" ${n === 20 ? 'selected' : ''}>${n} นาที</option>`).join('')}</select></label>
      <label class="block sm:col-span-2">เรื่องที่จะคุย (ผู้ป่วยเห็น — ไม่ต้องใส่ชื่อโรค)<input name="purpose" maxlength="200" class="${input}" placeholder="เช่น ติดตามท่าออกกำลังกายที่บ้าน ปรับโปรแกรม"></label>
      <p class="sm:col-span-2 text-xs text-slate-500">ระบบส่ง LINE เตือนพร้อมลิงก์ก่อนเวลานัดให้อัตโนมัติ (ถ้าผู้ป่วยเชื่อม LINE แล้ว) · ผู้ป่วยเข้าห้องได้ก่อนเวลา 15 นาที</p>
      <p data-form-error class="sm:col-span-2 text-rose-600 hidden"></p>
      <div class="sm:col-span-2">${btn('สร้างนัดและลิงก์', 'type="submit"')}</div>
    </form>`);
  const sel = $('#tn-p', m.el);
  if (sel) {
    const search = async () => {
      const q = $('#tn-q', m.el).value.trim();
      const list = await api.get(`/patients${q ? `?q=${encodeURIComponent(q)}` : ''}`);
      sel.innerHTML = list.slice(0, 30).map((p) => `<option value="${p.id}">${esc(p.hn)} · ${esc(p.first_name)} ${esc(p.last_name)}</option>`).join('');
      if (list.length) sel.selectedIndex = 0;
    };
    let t;
    $('#tn-q', m.el).addEventListener('input', () => { clearTimeout(t); t = setTimeout(search, 250); });
    search();
  }
  $('#tn-form', m.el).addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    const err = $('[data-form-error]', m.el);
    err.classList.add('hidden');
    try {
      if (!f.patientId) throw new Error('เลือกผู้ป่วย');
      const t = await api.post('/tele/sessions', { patientId: f.patientId, scheduledAt: bkkISO(f.date, f.time), durationMin: Number(f.durationMin), purpose: f.purpose || null });
      m.close();
      toast('สร้างนัดวิดีโอคอลแล้ว', 'success');
      onSaved?.(t);
      openLinkModal(t, { url: t.url });
    } catch (ex) { err.textContent = ex.message; err.classList.remove('hidden'); }
  });
}

// ------------------------------------------------------------------ ลิงก์ผู้ป่วย: QR / คัดลอก / LINE
async function openLinkModal(t, { url = null, regenerate = false } = {}) {
  const m = modal(`ลิงก์วิดีโอคอล · ${t.patient_name}`, `<div class="text-sm space-y-3" id="lk">
    <div>${fmtDateTime(t.scheduled_at)} น. · ${t.duration_min} นาที</div>
    ${url ? '' : `<p class="text-slate-600">ลิงก์แสดงครั้งเดียวตอนสร้าง (ระบบเก็บแบบเข้ารหัส) — กดสร้างลิงก์ใหม่เพื่อแสดง QR อีกครั้ง <b>ลิงก์เดิมจะใช้ไม่ได้</b></p>
      ${btn('สร้างลิงก์ใหม่', 'id="lk-new"', 'ghost')}`}
    <div id="lk-out"></div>
    <div class="flex flex-wrap gap-2">${btn(t.line_linked ? '💬 ส่งลิงก์ทาง LINE ตอนนี้' : 'ผู้ป่วยยังไม่เชื่อม LINE', `id="lk-line" ${t.line_linked ? '' : 'disabled'}`, t.line_linked ? 'primary' : 'ghost')}</div>
  </div>`);
  const show = async (u) => {
    const full = u.startsWith('http') ? u : `${location.origin}${u}`;
    const qr = await qrDataUrl(full, 5).catch(() => null);
    $('#lk-out', m.el).innerHTML = `<div class="grid sm:grid-cols-[auto,1fr] gap-3 items-start rounded-lg bg-slate-50 p-3">
      ${qr ? `<img src="${qr}" alt="QR เข้าห้องวิดีโอคอล" class="w-36 h-36 bg-white rounded">` : ''}
      <div class="space-y-2"><input id="lk-url" readonly class="${input} font-mono text-xs" value="${esc(full)}">
        ${btn('คัดลอกข้อความสำหรับส่ง', 'id="lk-copy"', 'ghost')}
        <div class="text-xs text-slate-500">ข้อความไม่มีชื่อโรคหรือข้อมูลการรักษา · ลิงก์นี้ใช้ได้เฉพาะนัดนี้</div></div></div>`;
    $('#lk-copy', m.el).addEventListener('click', async () => {
      const text = `นัดวิดีโอคอลกายภาพบำบัด ${fmtDateTime(t.scheduled_at)} น.\nกดลิงก์เพื่อเข้าห้อง (เข้าได้ก่อนเวลา 15 นาที ไม่ต้องลงแอป):\n${full}`;
      try { await navigator.clipboard.writeText(text); toast('คัดลอกแล้ว', 'success'); } catch { $('#lk-url', m.el).select(); }
    });
  };
  if (url) await show(url);
  $('#lk-new', m.el)?.addEventListener('click', async (e) => {
    if (!regenerate || !confirm('สร้างลิงก์ใหม่? ลิงก์เดิมที่ส่งให้ผู้ป่วยแล้วจะใช้ไม่ได้')) return;
    try { const r = await api.post(`/tele/sessions/${t.id}/link`); e.target.remove(); await show(r.url); } catch (err) { showError(err); }
  });
  $('#lk-line', m.el).addEventListener('click', async (e) => {
    if (!t.line_linked) return;
    e.target.disabled = true;
    try {
      const r = await api.post(`/tele/sessions/${t.id}/send-line`);
      toast(r.status === 'sent' ? 'ส่งลิงก์ทาง LINE แล้ว' : `ยังส่งไม่ได้: ${r.error || 'ตรวจการตั้งค่า LINE'}`, r.status === 'sent' ? 'success' : 'warn');
    } catch (err) { showError(err); } finally { e.target.disabled = false; }
  });
}

// ------------------------------------------------------------------ ห้องคุย
async function renderRoom(root, id, session) {
  const canWrite = session.can('emr:write');
  let t = await api.get(`/tele/sessions/${id}`);
  const active = ['scheduled', 'in_progress'].includes(t.status);
  root.innerHTML = `
    ${pageHeader(`วิดีโอคอล · ${t.patient_name}`, `${esc(t.hn)} · ${fmtDateTime(t.scheduled_at)} น. · ${t.duration_min} นาที${t.purpose ? ` · ${esc(t.purpose)}` : ''}`,
    `<a href="#/tele" class="inline-flex items-center rounded-lg px-3 py-1.5 text-sm font-medium ring-1 ring-inset ring-slate-300 bg-white">← รายการ</a>
     ${t.program_id ? `<a href="#/homecare/${t.program_id}" target="_blank" class="inline-flex items-center rounded-lg px-3 py-1.5 text-sm font-medium ring-1 ring-inset ring-slate-300 bg-white">🏠 โปรแกรมที่บ้าน ↗</a>` : ''}`)}
    <div class="grid xl:grid-cols-3 gap-4">
      <div class="xl:col-span-2 space-y-3">
        ${active ? `<div class="relative rounded-xl overflow-hidden bg-slate-900 aspect-video" id="tr-stage">
          <video id="tr-remote" autoplay playsinline class="absolute inset-0 w-full h-full object-contain"></video>
          <video id="tr-self" autoplay playsinline muted class="absolute right-3 top-3 w-1/4 max-w-[220px] aspect-video object-cover rounded-lg ring-2 ring-white/60 bg-black" style="transform:scaleX(-1)"></video>
          <div id="tr-status" class="absolute left-3 right-3 bottom-3 text-center text-white bg-black/55 rounded-lg px-3 py-2 text-sm">กดปุ่ม "เปิดกล้องและเข้าห้อง"</div>
          <div id="tr-peer" class="absolute left-3 top-3 text-xs text-white bg-black/50 rounded px-2 py-1" hidden></div>
        </div>
        <div class="flex flex-wrap items-center gap-2">
          ${btn('📹 เปิดกล้องและเข้าห้อง', 'id="tr-join"')}
          ${btn('🎤 ปิดไมค์', 'id="tr-mic" disabled', 'ghost')}
          ${btn('📷 ปิดกล้อง', 'id="tr-cam" disabled', 'ghost')}
          ${btn('⛶ เต็มจอ', 'id="tr-full"', 'ghost')}
          <span class="text-xs text-slate-500 ml-auto" id="tr-net"></span>
        </div>
        <div class="text-xs text-slate-500">ภาพและเสียงส่งตรงระหว่างเครื่องแบบเข้ารหัส ระบบไม่บันทึกภาพหรือเสียง · ให้ผู้ป่วยวางโทรศัพท์ให้เห็นทั้งตัวเมื่อดูท่า</div>`
    : card(`<div class="p-4 text-sm">การโทรนี้ ${badge(t.status)}${t.started_at ? ` · เริ่ม ${fmtTime(t.started_at)}` : ''}${t.ended_at ? ` · จบ ${fmtTime(t.ended_at)}` : ''}${t.consent_at ? ` · ผู้ป่วยยินยอมเมื่อ ${fmtDateTime(t.consent_at)}` : ''}</div>`)}
      </div>
      <aside class="space-y-4">
        ${card(`<div class="p-4 text-sm space-y-2">
          <div class="flex items-center justify-between"><span class="font-semibold">สถานะ</span><span id="tr-badge">${badge(t.status)}</span></div>
          <div class="flex gap-3" id="tr-online">${dot(t.online.staff, 'นักกายภาพ')} ${dot(t.online.patient, 'ผู้ป่วย')}</div>
          ${t.consent_at ? `<div class="text-xs text-slate-500">ผู้ป่วยยินยอมรับบริการทางวิดีโอ ${fmtDateTime(t.consent_at)}</div>` : '<div class="text-xs text-slate-500">ผู้ป่วยยังไม่ได้กดยินยอม/เข้าห้อง</div>'}
          ${canWrite && active ? `<div class="flex flex-wrap gap-2 pt-1">${btn('ลิงก์ผู้ป่วย / QR', 'id="tr-link"', 'ghost')}</div>` : ''}
        </div>`)}
        <div id="tr-home"></div>
        ${card(`<div class="p-4 text-sm space-y-2"><div class="font-semibold">บันทึกการติดตาม</div>
          <textarea id="tr-note" rows="6" class="${input}" ${canWrite ? '' : 'disabled'} placeholder="เช่น ผู้ป่วยทำท่าลุกนั่งได้ถูกต้อง 10 ครั้ง ไม่ปวด ปรับเพิ่มเป็น 12 ครั้ง · แนะนำให้ประคบเย็นหลังทำ">${esc(t.note || '')}</textarea>
          ${canWrite ? `<div class="flex flex-wrap gap-2">
            ${active ? btn('✓ จบการโทรและบันทึก', 'id="tr-end"') : btn('บันทึก', 'id="tr-save"')}
            ${active ? btn('ผู้ป่วยไม่เข้าร่วม', 'id="tr-noshow"', 'ghost') : ''}</div>` : ''}
          <div class="text-[11px] text-slate-500">บันทึกนี้ผู้ป่วยไม่เห็น</div></div>`)}
      </aside>
    </div>`;

  api.get(`/home/patients/${t.patient_id}/summary`).then((s) => { if (s) $('#tr-home').innerHTML = card(summaryCardHtml(s)); }).catch(() => {});

  let call = null;
  let local = null;
  let netTimer = null;
  const peer = { micOff: false, camOff: false };
  const status = (txt) => { const el = $('#tr-status'); if (el) { el.hidden = !txt; el.textContent = txt || ''; } };
  const cleanup = () => {
    clearInterval(netTimer);
    call?.hangup();
    local?.getTracks().forEach((x) => x.stop());
    call = null; local = null;
  };

  $('#tr-join')?.addEventListener('click', async (e) => {
    e.target.disabled = true;
    try {
      const j = await api.post(`/tele/sessions/${id}/join`);
      local = await getMedia('user');
      $('#tr-self').srcObject = local;
      status('รอผู้ป่วยเข้าห้อง…');
      const token = sessionStorage.getItem('pc_token');
      call = new CallClient({
        role: 'staff', streamUrl: `/api/tele/sessions/${id}/signal`, signalUrl: `/api/tele/sessions/${id}/signal`,
        headers: token ? { Authorization: `Bearer ${token}` } : {}, iceServers: j.iceServers, localStream: local,
        on: {
          remote(s) { $('#tr-remote').srcObject = s; },
          presence(p) {
            $('#tr-online').innerHTML = `${dot(p.staff, 'นักกายภาพ')} ${dot(p.patient, 'ผู้ป่วย')}`;
            if (p.staff && p.patient) $('#tr-badge').innerHTML = badge('in_progress');
            if (!p.patient) status('รอผู้ป่วยเข้าห้อง… (ส่งลิงก์ให้ผู้ป่วยได้จากปุ่ม "ลิงก์ผู้ป่วย / QR")');
          },
          state(s) {
            if (s === 'connected') status('');
            else if (s === 'connecting') status('กำลังเชื่อมต่อกับผู้ป่วย…');
            else if (s === 'reconnecting' || s === 'disconnected') status('สัญญาณขาดหาย กำลังเชื่อมต่อใหม่…');
            else if (s === 'failed') status('เชื่อมต่อไม่สำเร็จ — เครือข่ายของผู้ป่วยอาจต้องใช้ TURN server หรือให้ผู้ป่วยเปลี่ยน Wi-Fi/4G แล้วเปิดลิงก์ใหม่');
          },
          peerState(st) {
            Object.assign(peer, st);
            const el = $('#tr-peer');
            const msgs = [peer.micOff ? '🔇 ผู้ป่วยปิดไมค์' : '', peer.camOff ? '📷 ผู้ป่วยปิดกล้อง' : ''].filter(Boolean);
            el.hidden = !msgs.length;
            el.textContent = msgs.join(' · ');
          },
          closed(reason) {
            if (reason === 'hangup') return;
            status(reason === 'replaced' ? 'เปิดห้องนี้จากหน้าต่างอื่นแล้ว' : 'ห้องปิดแล้ว');
            cleanup();
          },
        },
      });
      call.start();
      e.target.textContent = '● อยู่ในห้อง';
      $('#tr-mic').disabled = false;
      $('#tr-cam').disabled = !local.getVideoTracks().length;
      netTimer = setInterval(async () => {
        const st = await call?.stats().catch(() => null);
        $('#tr-net').textContent = st ? `เชื่อมต่อ${st.relayed ? 'ผ่าน TURN' : 'ตรง'}${st.rttMs != null ? ` · หน่วง ${st.rttMs} ms` : ''}` : '';
      }, 3000);
    } catch (err) {
      e.target.disabled = false;
      if (err?.name === 'NotAllowedError') toast('ต้องอนุญาตให้เบราว์เซอร์ใช้กล้องและไมค์', 'error'); else showError(err);
    }
  });
  const toggle = (b, kind, onLabel, offLabel) => {
    const tracks = kind === 'audio' ? local?.getAudioTracks() : local?.getVideoTracks();
    if (!tracks?.length) return;
    const off = tracks[0].enabled;
    tracks.forEach((x) => { x.enabled = !off; });
    b.textContent = off ? onLabel : offLabel;
  };
  $('#tr-mic')?.addEventListener('click', (e) => toggle(e.currentTarget, 'audio', '🎤 เปิดไมค์', '🎤 ปิดไมค์'));
  $('#tr-cam')?.addEventListener('click', (e) => toggle(e.currentTarget, 'video', '📷 เปิดกล้อง', '📷 ปิดกล้อง'));
  $('#tr-full')?.addEventListener('click', () => $('#tr-stage')?.requestFullscreen?.().catch(() => {}));
  $('#tr-link')?.addEventListener('click', () => openLinkModal(t, { regenerate: true }));

  const finish = async (statusVal) => {
    try {
      t = await api.post(`/tele/sessions/${id}/end`, { note: $('#tr-note').value || null, status: statusVal });
      cleanup();
      toast(statusVal === 'no_show' ? 'บันทึกว่าผู้ป่วยไม่เข้าร่วม' : 'จบการโทรและบันทึกแล้ว', 'success');
      renderRoom(root, id, session);
    } catch (err) { showError(err); }
  };
  $('#tr-end')?.addEventListener('click', () => { if (confirm('จบการโทรและบันทึก? ผู้ป่วยจะออกจากห้อง')) finish('completed'); });
  $('#tr-noshow')?.addEventListener('click', () => { if (confirm('บันทึกว่าผู้ป่วยไม่เข้าร่วม?')) finish('no_show'); });
  $('#tr-save')?.addEventListener('click', async () => {
    try { await api.patch(`/tele/sessions/${id}`, { note: $('#tr-note').value || null }); toast('บันทึกแล้ว', 'success'); } catch (err) { showError(err); }
  });
  return cleanup;
}
