import { api } from '../api.js';
import { $, esc, pageHeader, btn, input, toast, showError, fmtTime, bkkToday } from '../ui.js';
import { createClinic3D, STATE_COLORS, STATE_TH } from '../three/clinic3d.js';

const THREE_URL = 'https://cdnjs.cloudflare.com/ajax/libs/three.js/0.160.0/three.module.min.js';
const OPEN_MIN = 8 * 60;
const CLOSE_MIN = 20 * 60;
const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const nowMinutes = () => { const t = new Date(Date.now() + 7 * 3600e3); return t.getUTCHours() * 60 + t.getUTCMinutes(); };

export async function render(root, { session }) {
  const canEdit = session.can('equipment:write');
  root.innerHTML = `
    ${pageHeader('ผังคลินิก 3 มิติ', 'ห้อง เตียง อุปกรณ์ ผู้ป่วย และนักกายภาพ ณ เวลาที่เลือก — ลากเพื่อหมุน, Shift/คลิกขวาเพื่อเลื่อน, ล้อเมาส์เพื่อซูม',
      `<a href="#/facilities" class="inline-flex items-center rounded-lg px-3 py-1.5 text-sm font-medium ring-1 ring-inset ring-slate-300 bg-white hover:bg-slate-50">มุมมองรายการ</a>`)}
    <div class="flex flex-wrap items-center gap-2 mb-3">
      <input id="d3-date" type="date" class="${input} max-w-[170px]" value="${bkkToday()}">
      ${btn('▶ เล่นทั้งวัน', 'id="d3-play"', 'ghost')}
      <select id="d3-speed" class="${input} max-w-[120px]"><option value="5">5 นาที/วิ</option><option value="10" selected>10 นาที/วิ</option><option value="30">30 นาที/วิ</option></select>
      ${btn('ตอนนี้', 'id="d3-now"', 'ghost')}
      ${btn('มุมมองทั้งหมด', 'id="d3-frame"', 'ghost')}
      ${canEdit ? `<label class="ml-auto flex items-center gap-2 text-sm"><input id="d3-edit" type="checkbox"> จัดผัง (ลากห้องเพื่อย้าย)</label>` : ''}
    </div>
    <div class="flex items-center gap-3 mb-3">
      <span class="text-xs text-slate-500">08:00</span>
      <input id="d3-time" type="range" min="${OPEN_MIN}" max="${CLOSE_MIN}" step="5" class="flex-1 accent-sky-600">
      <span class="text-xs text-slate-500">20:00</span>
      <span id="d3-clock" class="font-mono font-semibold text-lg w-16 text-right"></span>
    </div>
    <div id="d3-kpi" class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2 mb-3"></div>
    <div class="grid xl:grid-cols-4 gap-4">
      <div id="d3-view" class="xl:col-span-3 rounded-xl border border-slate-200 overflow-hidden bg-slate-100" style="height:68vh;min-height:420px">
        <div class="h-full grid place-items-center text-sm text-slate-400">กำลังโหลดมุมมอง 3 มิติ…</div>
      </div>
      <aside class="space-y-3">
        <div class="bg-white rounded-xl border border-slate-200 p-4 text-sm" id="d3-detail"><div class="text-slate-400">คลิกเตียง อุปกรณ์ หรือห้องเพื่อดูรายละเอียด</div></div>
        <div class="bg-white rounded-xl border border-slate-200 p-4 text-xs space-y-1.5">
          <div class="font-semibold text-sm mb-1">สัญลักษณ์</div>
          ${Object.entries(STATE_COLORS).map(([k, c]) => `<div class="flex items-center gap-2"><span class="w-3 h-3 rounded" style="background:${c}"></span>เตียง: ${STATE_TH[k]}</div>`).join('')}
          <div class="flex items-center gap-2"><span class="w-3 h-3 rounded" style="background:#2563eb"></span>อุปกรณ์กำลังใช้</div>
          <div class="flex items-center gap-2"><span class="w-3 h-3 rounded" style="background:#ef4444"></span>อุปกรณ์ชำรุด</div>
          <div class="flex items-center gap-2"><span class="w-3 h-3 rounded-full" style="background:#f4c58f"></span>ผู้ป่วย · <span class="w-3 h-3 rounded-full bg-sky-500"></span>นักกายภาพ (สีประจำตัว)</div>
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

  let board = null;
  const view = createClinic3D($('#d3-view'), {
    THREE,
    onSelect: (sel) => showDetail(sel),
    onRoomMove: async (room, x, z) => {
      try {
        await api.patch(`/facilities/rooms/${room.id}`, { planX: x, planZ: z, planW: room.w, planD: room.d });
        toast(`ย้าย ${room.code} แล้ว`, 'success');
        load();
      } catch (err) { showError(err); load(); }
    },
  });

  const timeEl = $('#d3-time');
  timeEl.value = String(Math.min(CLOSE_MIN, Math.max(OPEN_MIN, nowMinutes())));
  let liveNow = true;
  let loading = false;
  let pending = false;

  const atIso = () => `${$('#d3-date').value}T${hhmm(Number(timeEl.value))}:00+07:00`;
  async function load() {
    if (loading) { pending = true; return; }
    loading = true;
    try {
      board = await api.get(`/facilities/board${liveNow ? '' : `?at=${encodeURIComponent(atIso())}`}`);
      $('#d3-clock').textContent = liveNow ? fmtTime(board.at) : hhmm(Number(timeEl.value));
      renderKpis(board.kpis);
      view.update(board);
    } catch (err) { showError(err); } finally {
      loading = false;
      if (pending) { pending = false; load(); }
    }
  }

  function renderKpis(k) {
    const items = [
      ['ผู้ป่วยในคลินิก', k.patientsNow], ['นักกายภาพที่กำลังรักษา', k.therapistsBusy], ['เตียงมีผู้ป่วย', `${k.bedsOccupied}/${k.bedsTotal}`],
      ['อุปกรณ์กำลังใช้', k.equipmentInUse], ['อุปกรณ์ชำรุด/ซ่อม', k.equipmentDown], ['นัดที่เหลือวันนี้', k.remainingToday],
    ];
    $('#d3-kpi').innerHTML = items.map(([l, v]) => `<div class="bg-white rounded-lg border border-slate-200 px-3 py-2"><div class="text-[11px] text-slate-500">${l}</div><div class="text-xl font-bold">${v}</div></div>`).join('');
  }

  function showDetail(sel) {
    const el = $('#d3-detail');
    if (!sel) { el.innerHTML = '<div class="text-slate-400">คลิกเตียง อุปกรณ์ หรือห้องเพื่อดูรายละเอียด</div>'; return; }
    const { kind, data } = sel;
    if (kind === 'bed') {
      el.innerHTML = `
        <div class="font-semibold">${esc(data.roomName)} · ${esc(data.name)}</div>
        <div class="text-xs text-slate-500 mb-2">${esc(data.code)}</div>
        <div class="mb-2"><span class="inline-block w-2.5 h-2.5 rounded-full mr-1" style="background:${STATE_COLORS[data.state]}"></span>${STATE_TH[data.state]}${data.notes ? ` — ${esc(data.notes)}` : ''}</div>
        ${data.current ? `<div class="rounded-lg bg-sky-50 p-2 mb-2">${esc(data.current.patient_name)} (${esc(data.current.hn)})<br><span class="text-xs">${esc(data.current.therapist_name)} · ${fmtTime(data.current.start_at)}–${fmtTime(data.current.end_at)}</span></div>` : ''}
        ${data.next ? `<div class="text-xs">ถัดไป ${fmtTime(data.next.start_at)} ${esc(data.next.patient_name)}</div>` : ''}
        <div class="text-xs text-slate-500 mt-1">นัดที่เหลือวันนี้ ${data.todayRemaining}</div>`;
    } else if (kind === 'equipment') {
      const st = { in_use: 'กำลังใช้งาน', available: 'พร้อมใช้งาน', broken: 'ชำรุด', maintenance: 'ส่งซ่อม/บำรุงรักษา' }[data.state];
      el.innerHTML = `<div class="font-semibold">${esc(data.name)}</div><div class="text-xs text-slate-500 mb-2">${esc(data.asset_code)} · ${esc(data.category_code)}</div>
        <div>${st}</div><div class="text-xs text-slate-500 mt-1">${data.room_id ? 'ติดตั้งประจำห้อง' : 'เคลื่อนย้ายได้'}</div>
        <a href="#/equipment" class="text-xs text-brand-600 hover:underline">เปิดทะเบียนอุปกรณ์</a>`;
    } else if (kind === 'gymPatient') {
      el.innerHTML = `<div class="font-semibold">${esc(data.patient_name)}</div><div class="text-xs text-slate-500">${esc(data.roomName)}</div>
        <div class="mt-1">${esc(data.therapist_name)} · ${fmtTime(data.start_at)}–${fmtTime(data.end_at)}</div>`;
    } else {
      el.innerHTML = `<div class="font-semibold">${esc(data.code)} · ${esc(data.name)}</div>
        <div class="text-xs text-slate-500">${data.beds.length} เตียง · รับพร้อมกัน ${data.capacity} คน · ขนาด ${data.w}×${data.d} ม.</div>
        <div class="mt-2">ผู้ป่วยตอนนี้ ${data.occupancyNow}/${data.capacity}</div>
        ${data.next?.length ? `<div class="text-xs mt-1">ถัดไป: ${data.next.map((a) => `${fmtTime(a.start_at)} ${esc(a.patient_name.split(' ')[0])}`).join(', ')}</div>` : ''}`;
    }
  }

  // ---------- controls ----------
  let playTimer = null;
  const stop = () => { clearInterval(playTimer); playTimer = null; $('#d3-play').textContent = '▶ เล่นทั้งวัน'; };
  $('#d3-play').addEventListener('click', () => {
    if (playTimer) { stop(); return; }
    liveNow = false;
    if (Number(timeEl.value) >= CLOSE_MIN) timeEl.value = String(OPEN_MIN);
    $('#d3-play').textContent = '⏸ หยุด';
    playTimer = setInterval(() => {
      const step = Number($('#d3-speed').value) / 2; // ทุก 0.5 วินาที
      const next = Math.min(CLOSE_MIN, Number(timeEl.value) + step);
      timeEl.value = String(next);
      load();
      if (next >= CLOSE_MIN) stop();
    }, 500);
  });
  timeEl.addEventListener('input', () => { liveNow = false; $('#d3-clock').textContent = hhmm(Number(timeEl.value)); load(); });
  $('#d3-date').addEventListener('change', () => { liveNow = false; load(); });
  $('#d3-now').addEventListener('click', () => {
    stop(); liveNow = true; $('#d3-date').value = bkkToday();
    timeEl.value = String(Math.min(CLOSE_MIN, Math.max(OPEN_MIN, nowMinutes()))); load();
  });
  $('#d3-frame').addEventListener('click', () => view.frame());
  $('#d3-edit')?.addEventListener('change', (e) => {
    view.setEditable(e.target.checked);
    toast(e.target.checked ? 'โหมดจัดผัง: ลากพื้นห้องเพื่อย้าย ระบบบันทึกตำแหน่งอัตโนมัติ' : 'ปิดโหมดจัดผัง');
  });

  let t;
  const onLive = () => { if (!liveNow) return; clearTimeout(t); t = setTimeout(load, 300); };
  const evs = ['bed_status', 'appointment_changed', 'equipment_status'];
  evs.forEach((ev) => window.addEventListener(ev, onLive));
  const minuteTimer = setInterval(() => liveNow && load(), 60_000);
  await load();
  return () => { stop(); clearInterval(minuteTimer); evs.forEach((ev) => window.removeEventListener(ev, onLive)); view.dispose(); };
}
