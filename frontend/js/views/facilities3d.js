import { api } from '../api.js';
import { $, esc, pageHeader, btn, input, toast, showError, fmtTime, bkkToday } from '../ui.js';
import { createClinic3D, STATE_COLORS, STATE_TH } from '../three/clinic3d.js';

const THREE_URL = 'https://cdnjs.cloudflare.com/ajax/libs/three.js/0.160.0/three.module.min.js';
const OPEN_MIN = 7 * 60 + 30;
const CLOSE_MIN = 20 * 60;
const MIN = 60000;
const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(Math.floor(m % 60)).padStart(2, '0')}`;
const first = (n) => String(n || '').split(' ')[0];
const EVENT_TH = { arrive: 'มาถึงคลินิก', start: 'เริ่มรักษา', end: 'รักษาเสร็จ', no_show: 'ไม่มาตามนัด' };
const EVENT_DOT = { arrive: '#f59e0b', start: '#0ea5e9', end: '#10b981', no_show: '#ef4444' };

export async function render(root, { session }) {
  const canEdit = session.can('equipment:write');
  root.innerHTML = `
    ${pageHeader('ผังคลินิก 3 มิติ', 'จำลองเหตุการณ์ตามนัดจริง: ผู้ป่วยมาถึง นั่งรอ เดินเข้าห้อง รักษา และกลับบ้าน — ลากเพื่อหมุน, Shift/คลิกขวาเพื่อเลื่อน, ล้อเมาส์เพื่อซูม',
      `<a href="#/facilities" class="inline-flex items-center rounded-lg px-3 py-1.5 text-sm font-medium ring-1 ring-inset ring-slate-300 bg-white hover:bg-slate-50">มุมมองรายการ</a>`)}
    <div class="flex flex-wrap items-center gap-2 mb-3">
      <input id="d3-date" type="date" class="${input} max-w-[170px]" value="${bkkToday()}">
      ${btn('▶ เล่น', 'id="d3-play"', 'ghost')}
      <select id="d3-speed" class="${input} max-w-[150px]">
        <option value="1">1 นาที/วินาที</option><option value="3" selected>3 นาที/วินาที</option>
        <option value="10">10 นาที/วินาที</option><option value="30">30 นาที/วินาที</option>
      </select>
      ${btn('ตอนนี้ (สด)', 'id="d3-now"', 'ghost')}
      ${btn('มุมมองทั้งหมด', 'id="d3-frame"', 'ghost')}
      ${btn('เต็มจอ', 'id="d3-fs-top"', 'ghost')}
      <span class="flex items-center gap-3 text-sm ml-2" id="d3-labels">
        <span class="text-slate-500">ป้าย:</span>
        <label class="flex items-center gap-1"><input type="checkbox" data-lb="room"> ห้อง</label>
        <label class="flex items-center gap-1"><input type="checkbox" data-lb="bed"> เตียง</label>
        <label class="flex items-center gap-1"><input type="checkbox" data-lb="people"> ชื่อคน</label>
      </span>
      <span id="d3-live" class="hidden text-xs font-medium text-emerald-700 bg-emerald-50 rounded-full px-2 py-0.5">● สด</span>
      ${canEdit ? `<label class="ml-auto flex items-center gap-2 text-sm"><input id="d3-edit" type="checkbox"> จัดผัง (ลากห้องเพื่อย้าย)</label>` : ''}
    </div>
    <div class="flex items-center gap-3 mb-3">
      <span class="text-xs text-slate-500">${hhmm(OPEN_MIN)}</span>
      <input id="d3-time" type="range" min="${OPEN_MIN}" max="${CLOSE_MIN}" step="1" class="flex-1 accent-sky-600">
      <span class="text-xs text-slate-500">${hhmm(CLOSE_MIN)}</span>
      <span id="d3-clock" class="font-mono font-semibold text-lg w-16 text-right"></span>
    </div>
    <div id="d3-kpi" class="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-2 mb-3"></div>
    <div class="grid xl:grid-cols-4 gap-4">
      <div id="d3-view" class="xl:col-span-3 rounded-xl border border-slate-200 overflow-hidden bg-slate-100" style="height:68vh;min-height:420px">
        <div class="h-full grid place-items-center text-sm text-slate-400">กำลังโหลดมุมมอง 3 มิติ…</div>
      </div>
      <aside class="space-y-3">
        <div class="bg-white rounded-xl border border-slate-200 p-4 text-sm" id="d3-detail"><div class="text-slate-400">คลิกผู้ป่วย นักกายภาพ เตียง อุปกรณ์ หรือห้องเพื่อดูรายละเอียด</div></div>
        <div class="bg-white rounded-xl border border-slate-200 p-4 text-sm">
          <div class="font-semibold mb-2">เหตุการณ์ล่าสุด</div>
          <ul id="d3-events" class="space-y-1.5 text-xs"></ul>
        </div>
        <div class="bg-white rounded-xl border border-slate-200 p-4 text-xs space-y-1.5">
          <div class="font-semibold text-sm mb-1">สัญลักษณ์</div>
          ${Object.entries(STATE_COLORS).map(([k, c]) => `<div class="flex items-center gap-2"><span class="w-3 h-3 rounded-full" style="background:${c}"></span>วงแสงเตียง: ${STATE_TH[k]}</div>`).join('')}
          <div class="flex items-center gap-2"><span class="w-3 h-3 rounded-full" style="background:#38bdf8"></span>ไฟอุปกรณ์: กำลังใช้ · <span class="w-3 h-3 rounded-full" style="background:#22c55e"></span>พร้อม · <span class="w-3 h-3 rounded-full" style="background:#ef4444"></span>ชำรุด</div>
          <div>นักกายภาพสวมชุดสีประจำตัว · ผู้ช่วยชุดเทาเปลี่ยนผ้าปูหลังจบการรักษา</div>
        </div>
      </aside>
    </div>`;

  let THREE;
  try {
    THREE = await import(THREE_URL);
  } catch {
    $('#d3-view').innerHTML = '<div class="h-full grid place-items-center text-sm text-rose-600">โหลดไลบรารี 3D ไม่ได้ (ตรวจการเชื่อมต่อ CDN)</div>';
    return;
  }
  $('#d3-view').innerHTML = '';
  // แถบเครื่องมือบนภาพ 3D (ใช้ได้ทั้งปกติและตอนเต็มจอ)
  const overlay = document.createElement('div');
  overlay.className = 'absolute right-3 top-3 z-10 flex items-center gap-2';
  overlay.innerHTML = `
    <span id="d3-fs-clock" class="hidden font-mono font-semibold bg-white/90 rounded-lg px-2.5 py-1 ring-1 ring-slate-200"></span>
    <button id="d3-fs-play" type="button" class="hidden items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium bg-white ring-1 ring-slate-300 hover:bg-slate-50"></button>
    <button id="d3-fs" type="button" aria-pressed="false" class="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium bg-white ring-1 ring-slate-300 hover:bg-slate-50"></button>`;

  const view = createClinic3D($('#d3-view'), {
    THREE,
    onSelect: (sel) => { selected = sel; showDetail(); },
    onRoomMove: async (room, x, z) => {
      try {
        await api.patch(`/facilities/rooms/${room.id}`, { planX: x, planZ: z, planW: room.w, planD: room.d });
        toast(`ย้าย ${room.code} แล้ว`, 'success');
      } catch (err) { showError(err); }
      loadLayout();
    },
  });
  $('#d3-view').appendChild(overlay);

  // ---------- เวลาจำลอง ----------
  const dayStart = () => new Date(`${$('#d3-date').value}T00:00:00+07:00`).getTime();
  const nowMs = () => Date.now();
  let simTime = Math.min(Math.max(nowMs(), dayStart() + OPEN_MIN * MIN), dayStart() + CLOSE_MIN * MIN);
  let playing = false;
  let live = $('#d3-date').value === bkkToday();
  let lastTick = performance.now();
  view.setClock(() => {
    const now = performance.now();
    const dt = Math.min(now - lastTick, 200);
    lastTick = now;
    if (live) simTime = nowMs();
    else if (playing) {
      simTime += dt * Number($('#d3-speed').value) * 60; // n นาทีจำลองต่อ 1 วินาทีจริง
      if (simTime >= dayStart() + CLOSE_MIN * MIN) { simTime = dayStart() + CLOSE_MIN * MIN; setPlaying(false); }
    }
    return simTime;
  });

  const timeEl = $('#d3-time');
  function setPlaying(v) {
    playing = v;
    const html = v ? `<svg viewBox="0 0 24 24" class="w-3.5 h-3.5" fill="currentColor" aria-hidden="true"><path d="M6 4h4.5v16H6zM13.5 4H18v16h-4.5z"/></svg><span>หยุด</span>` : `<svg viewBox="0 0 24 24" class="w-3.5 h-3.5" fill="currentColor" aria-hidden="true"><path d="M7 4.5v15l12-7.5z"/></svg><span>เล่น</span>`;
    $('#d3-play').innerHTML = html;
    $('#d3-fs-play').innerHTML = html;
  }
  function setLive(v) {
    live = v;
    $('#d3-live').classList.toggle('hidden', !v);
  }
  setLive(live);

  // ---------- โหลดข้อมูล ----------
  async function loadLayout() {
    try { view.setLayout(await api.get('/facilities/board')); } catch (err) { showError(err); }
  }
  async function loadDay() {
    const d = $('#d3-date').value;
    const from = `${d}T00:00:00+07:00`;
    const to = new Date(new Date(from).getTime() + 864e5).toISOString();
    try {
      const appts = await api.get(`/appointments?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
      view.setDay(appts);
    } catch (err) { showError(err); }
  }

  // ---------- แผงข้อมูล (อัปเดต 4 ครั้ง/วินาที) ----------
  let selected = null;
  function renderPanel() {
    const mins = (simTime - dayStart()) / MIN;
    $('#d3-clock').textContent = hhmm(mins);
    $('#d3-fs-clock').textContent = hhmm(mins);
    if (document.activeElement !== timeEl) timeEl.value = String(Math.round(mins));
    const k = view.stats(simTime);
    const items = [
      ['ผู้ป่วยในคลินิก', k.patientsNow], ['กำลังรักษา', k.inTreatment], ['นั่งรอ', k.waiting],
      ['นักกายภาพที่ทำงานอยู่', k.therapistsBusy], ['เตียงมีผู้ป่วย', `${k.bedsOccupied}/${k.bedsTotal}`],
      ['อุปกรณ์กำลังใช้', k.equipmentInUse], ['อุปกรณ์ชำรุด/ซ่อม', k.equipmentDown], ['เสร็จแล้ว / เหลือ', `${k.completed} / ${k.remainingToday}`],
    ];
    $('#d3-kpi').innerHTML = items.map(([l, v]) => `<div class="bg-white rounded-lg border border-slate-200 px-3 py-2"><div class="text-[11px] text-slate-500 truncate">${l}</div><div class="text-xl font-bold">${v}</div></div>`).join('');
    const evs = view.events(simTime, 8);
    $('#d3-events').innerHTML = evs.length ? evs.map((e) => `
      <li class="flex gap-2"><span class="font-mono text-slate-500">${fmtTime(e.t)}</span>
        <span class="w-2 h-2 mt-1 rounded-full shrink-0" style="background:${EVENT_DOT[e.type]}"></span>
        <span>${esc(first(e.a.patient_name))} ${EVENT_TH[e.type]}${e.type === 'start' ? ` · ${esc(e.a.bed_name || e.a.room_name || '')} กับ ${esc(e.a.therapist_name)}` : ''}</span></li>`).join('')
      : '<li class="text-slate-400">ยังไม่มีเหตุการณ์ในช่วงเวลานี้</li>';
  }
  const panelTimer = setInterval(() => { renderPanel(); if (selected && selected.kind !== 'room') showDetail(); }, 250);

  function showDetail() {
    const el = $('#d3-detail');
    if (!selected) { el.innerHTML = '<div class="text-slate-400">คลิกผู้ป่วย นักกายภาพ เตียง อุปกรณ์ หรือห้องเพื่อดูรายละเอียด</div>'; return; }
    const { kind, data } = selected;
    const t = simTime;
    const phase = (a) => (a.status === 'no_show' ? 'ไม่มาตามนัด' : t < a.s - 9 * MIN ? 'ยังไม่มาถึง' : t < a.s ? 'นั่งรอ / กำลังเดินเข้าห้อง'
      : t < a.e ? 'กำลังรักษา' : 'เสร็จแล้ว');
    if (kind === 'patient') {
      el.innerHTML = `<div class="font-semibold">${esc(data.patient_name)}</div><div class="text-xs text-slate-500 mb-2">${esc(data.hn || '')} · ${esc(data.diagnosis_name || '')}</div>
        <div class="rounded-lg bg-sky-50 p-2 mb-1">${phase(data)}</div>
        <div>${fmtTime(data.start_at)}–${fmtTime(data.end_at)} · ${esc(data.therapist_name)}</div>
        <div class="text-xs text-slate-500">${esc(data.room_name || '')} ${esc(data.bed_name || '')}</div>
        ${data.equipment?.length ? `<div class="text-xs mt-1">อุปกรณ์: ${data.equipment.map((e) => esc(e.name)).join(', ')}</div>` : ''}`;
    } else if (kind === 'therapist') {
      const cur = data.appts.find((a) => t >= a.s && t < a.e);
      const next = data.appts.find((a) => a.s > t);
      el.innerHTML = `<div class="font-semibold flex items-center gap-2"><span class="w-3 h-3 rounded-full" style="background:${data.color}"></span>${esc(data.name)}</div>
        <div class="text-xs text-slate-500 mb-2">นัดวันนี้ ${data.appts.length} ราย</div>
        <div class="rounded-lg ${cur ? 'bg-sky-50' : 'bg-slate-50'} p-2 mb-1">${cur ? `กำลังรักษา ${esc(first(cur.patient_name))} · ${esc(cur.bed_name || cur.room_name || '')}` : 'ว่าง / บันทึกเวชระเบียน'}</div>
        ${next ? `<div class="text-xs">ถัดไป ${fmtTime(next.start_at)} ${esc(first(next.patient_name))}</div>` : '<div class="text-xs text-slate-500">ไม่มีนัดถัดไป</div>'}`;
    } else if (kind === 'bed') {
      el.innerHTML = `
        <div class="font-semibold">${esc(data.roomName)} · ${esc(data.name)}</div>
        <div class="text-xs text-slate-500 mb-2">${esc(data.code)}</div>
        <div class="mb-2"><span class="inline-block w-2.5 h-2.5 rounded-full mr-1" style="background:${STATE_COLORS[data.state]}"></span>${STATE_TH[data.state]}${data.notes ? ` — ${esc(data.notes)}` : ''}</div>
        ${data.current ? `<div class="rounded-lg bg-sky-50 p-2 mb-2">${esc(data.current.patient_name)} (${esc(data.current.hn)})<br><span class="text-xs">${esc(data.current.therapist_name)} · ${fmtTime(data.current.start_at)}–${fmtTime(data.current.end_at)}</span></div>` : ''}
        ${data.next ? `<div class="text-xs">ถัดไป ${fmtTime(data.next.start_at)} ${esc(first(data.next.patient_name))}</div>` : ''}`;
    } else if (kind === 'equipment') {
      const st = { in_use: 'กำลังใช้งาน', available: 'พร้อมใช้งาน', broken: 'ชำรุด', maintenance: 'ส่งซ่อม/บำรุงรักษา' }[data.state];
      el.innerHTML = `<div class="font-semibold">${esc(data.name)}</div><div class="text-xs text-slate-500 mb-2">${esc(data.asset_code)} · ${esc(data.category_code)}</div>
        <div>${st}</div><div class="text-xs text-slate-500 mt-1">${data.room_id ? 'ติดตั้งประจำห้อง' : 'เคลื่อนย้ายได้ (เก็บที่คลังอุปกรณ์)'}</div>
        <a href="#/equipment" class="text-xs text-brand-600 hover:underline">เปิดทะเบียนอุปกรณ์</a>`;
    } else {
      const active = view.stats(t).active.filter((a) => a.room_id === data.id);
      el.innerHTML = `<div class="font-semibold">${esc(data.code)} · ${esc(data.name)}</div>
        <div class="text-xs text-slate-500">${data.beds.length} เตียง · รับพร้อมกัน ${data.capacity} คน · ขนาด ${data.w}×${data.d} ม.</div>
        <div class="mt-2">ผู้ป่วยตอนนี้ ${active.length}/${data.capacity}</div>
        ${active.length ? `<div class="text-xs mt-1">${active.map((a) => esc(first(a.patient_name))).join(', ')}</div>` : ''}`;
    }
  }

  // ---------- controls ----------
  $('#d3-play').addEventListener('click', () => {
    if (playing) { setPlaying(false); return; }
    setLive(false);
    if (simTime >= dayStart() + CLOSE_MIN * MIN - MIN) simTime = dayStart() + OPEN_MIN * MIN;
    setPlaying(true);
  });
  timeEl.addEventListener('input', () => { setLive(false); simTime = dayStart() + Number(timeEl.value) * MIN; });
  $('#d3-date').addEventListener('change', async () => {
    setLive(false);
    simTime = dayStart() + 8 * 60 * MIN;
    await loadDay();
  });
  $('#d3-now').addEventListener('click', async () => {
    setPlaying(false);
    const changed = $('#d3-date').value !== bkkToday();
    $('#d3-date').value = bkkToday();
    setLive(true);
    if (changed) await loadDay();
  });
  $('#d3-frame').addEventListener('click', () => view.frame());

  // ---------- เต็มจอ (Fullscreen API; ถ้าไม่มี เช่น iPhone ใช้ขยายเต็มหน้าต่างแทน) ----------
  const vp = $('#d3-view');
  const vpStyle = vp.getAttribute('style');
  const isFs = () => document.fullscreenElement === vp || vp.dataset.pseudoFs === '1';
  function syncFs() {
    const on = isFs();
    $('#d3-fs').innerHTML = on ? `<svg viewBox="0 0 24 24" class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/></svg><span>ออกจากเต็มจอ</span>` : `<svg viewBox="0 0 24 24" class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg><span>เต็มจอ</span>`;
    $('#d3-fs').setAttribute('aria-pressed', String(on));
    setTimeout(() => view.frame(on ? 1.15 : 1), 200); // ขนาดจอเปลี่ยน → จัดกล้องใหม่
    for (const id of ['#d3-fs-clock', '#d3-fs-play']) { $(id).classList.toggle('hidden', !on); $(id).classList.toggle(id === '#d3-fs-play' ? 'inline-flex' : 'inline-block', on); }
  }
  function setPseudo(on) {
    vp.dataset.pseudoFs = on ? '1' : '';
    if (on) vp.setAttribute('style', 'position:fixed;inset:0;z-index:60;height:100dvh;border-radius:0');
    else vp.setAttribute('style', vpStyle);
    document.body.style.overflow = on ? 'hidden' : '';
  }
  async function toggleFs() {
    if (isFs()) {
      if (document.fullscreenElement) await document.exitFullscreen().catch(() => {});
      setPseudo(false);
    } else if (vp.requestFullscreen && document.fullscreenEnabled) {
      try { await vp.requestFullscreen(); } catch { setPseudo(true); }
    } else setPseudo(true);
    syncFs();
  }
  $('#d3-fs').addEventListener('click', toggleFs);
  $('#d3-fs-top').addEventListener('click', toggleFs);
  $('#d3-fs-play').addEventListener('click', () => $('#d3-play').click());
  document.addEventListener('fullscreenchange', syncFs);
  const onKey = (e) => {
    if (e.key === 'Escape' && vp.dataset.pseudoFs === '1') { setPseudo(false); syncFs(); }
    if (e.key === ' ' && isFs()) { e.preventDefault(); $('#d3-play').click(); }
  };
  document.addEventListener('keydown', onKey);
  syncFs();
  setPlaying(playing);
  // ป้ายห้อง/เตียง/ชื่อคน: จำค่าที่เลือกไว้ในเบราว์เซอร์นี้
  let labelPref = { room: true, bed: true, people: false };
  try { labelPref = { ...labelPref, ...JSON.parse(localStorage.getItem('pc.3d.labels') || '{}') }; } catch { /* ไม่มี storage */ }
  view.setLabels(labelPref);
  root.querySelectorAll('[data-lb]').forEach((cb) => {
    cb.checked = Boolean(labelPref[cb.dataset.lb]);
    cb.addEventListener('change', () => {
      labelPref[cb.dataset.lb] = cb.checked;
      view.setLabels({ [cb.dataset.lb]: cb.checked });
      try { localStorage.setItem('pc.3d.labels', JSON.stringify(labelPref)); } catch { /* ไม่มี storage */ }
    });
  });
  $('#d3-edit')?.addEventListener('change', (e) => {
    view.setEditable(e.target.checked);
    toast(e.target.checked ? 'โหมดจัดผัง: ลากพื้นห้องเพื่อย้าย ระบบบันทึกตำแหน่งอัตโนมัติ' : 'ปิดโหมดจัดผัง');
  });

  // ข้อมูลเปลี่ยนแบบ real-time (SSE) → โหลดใหม่
  let deb;
  const reload = (fn) => () => { clearTimeout(deb); deb = setTimeout(fn, 400); };
  const onAppt = reload(loadDay);
  const onLayout = reload(async () => { await loadLayout(); });
  window.addEventListener('appointment_changed', onAppt);
  window.addEventListener('bed_status', onLayout);
  window.addEventListener('equipment_status', onLayout);

  await loadLayout();
  await loadDay();
  renderPanel();
  return () => {
    clearInterval(panelTimer);
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    document.body.style.overflow = '';
    document.removeEventListener('fullscreenchange', syncFs);
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('appointment_changed', onAppt);
    window.removeEventListener('bed_status', onLayout);
    window.removeEventListener('equipment_status', onLayout);
    view.dispose();
  };
}
