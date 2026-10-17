import { api } from '../api.js';
import { $, $$, esc, pageHeader, card, btn, input, modal, toast, showError, fmtTime, fmtDateTime, empty } from '../ui.js';

const ROOM_TYPE_TH = { treatment: 'ห้องรักษา', private: 'ห้องส่วนตัว', gym: 'ห้องออกกำลังกาย', pediatric: 'ห้องเด็ก', hydro: 'ธาราบำบัด', consult: 'ห้องตรวจ' };
const BED_TYPE_TH = { standard: 'เตียงมาตรฐาน', hi_lo: 'เตียงปรับระดับ', treatment_table: 'โต๊ะรักษา', mat: 'เบาะ', pediatric: 'เตียงเด็ก', bariatric: 'เตียงผู้ป่วยน้ำหนักมาก' };
const STATE = {
  free: { th: 'ว่าง', cls: 'bg-emerald-50 ring-emerald-200 text-emerald-800', dot: 'bg-emerald-500' },
  occupied: { th: 'มีผู้ป่วย', cls: 'bg-sky-50 ring-sky-300 text-sky-900', dot: 'bg-sky-500' },
  turnover: { th: 'เปลี่ยนผ้าปู', cls: 'bg-violet-50 ring-violet-200 text-violet-800', dot: 'bg-violet-500' },
  maintenance: { th: 'ปิดซ่อม', cls: 'bg-amber-50 ring-amber-200 text-amber-800', dot: 'bg-amber-500' },
  out_of_service: { th: 'งดใช้', cls: 'bg-slate-100 ring-slate-200 text-slate-500', dot: 'bg-slate-400' },
};

export async function render(root, { session }) {
  const canWrite = session.can('equipment:write');
  const canStatus = session.can('equipment:status');
  root.innerHTML = `
    ${pageHeader('ห้อง & เตียง', 'ผังการใช้งานแบบ real-time — อัปเดตเมื่อมีการจอง เริ่ม/จบการรักษา หรือเปลี่ยนสถานะเตียง',
      canWrite ? `${btn('+ ห้อง', 'id="fc-room"', 'ghost')}${btn('+ เตียง', 'id="fc-bed"')}` : '')}
    <div class="flex flex-wrap items-center gap-2 mb-4 text-sm">
      <span class="text-slate-500">ดูผัง ณ เวลา</span>
      <input id="fc-at" type="datetime-local" class="${input} max-w-[220px]">
      ${btn('ตอนนี้', 'id="fc-now"', 'ghost')}
    </div>
    <div id="fc-summary" class="grid grid-cols-2 sm:grid-cols-5 gap-3 mb-5"></div>
    <div id="fc-grid" class="grid gap-4 lg:grid-cols-2 2xl:grid-cols-3"></div>`;

  let rooms = [];
  const load = async () => {
    const atVal = $('#fc-at').value;
    const qs = atVal ? `?at=${encodeURIComponent(`${atVal}:00+07:00`)}` : '';
    const [board, list] = await Promise.all([api.get(`/facilities/board${qs}`), api.get('/facilities/rooms')]);
    rooms = list;
    const beds = board.rooms.flatMap((r) => r.beds);
    $('#fc-summary').innerHTML = Object.entries(STATE).map(([k, s]) => card(`
      <div class="p-3"><div class="flex items-center gap-2 text-xs text-slate-500"><span class="w-2 h-2 rounded-full ${s.dot}"></span>${s.th}</div>
      <div class="text-2xl font-bold mt-1">${beds.filter((b) => b.state === k).length}</div></div>`)).join('');
    $('#fc-grid').innerHTML = board.rooms.length ? board.rooms.map((r) => roomCard(r, list.find((x) => x.id === r.id))).join('')
      : empty('ยังไม่มีห้อง — เพิ่มห้องและเตียงเพื่อให้ระบบจัดสรรอัตโนมัติ');
    $$('[data-bed]').forEach((el) => el.addEventListener('click', () => openBed(el.dataset.bed, beds, canStatus, load)));
  };

  const roomCard = (r, meta) => {
    const pct = Math.round((r.occupancyNow / r.capacity) * 100);
    return card(`
      <div class="p-4">
        <div class="flex items-start justify-between gap-2">
          <div>
            <div class="font-semibold">${esc(r.name)} <span class="text-xs font-normal text-slate-400">${esc(r.code)}</span></div>
            <div class="text-xs text-slate-500">${esc(ROOM_TYPE_TH[r.room_type] || r.room_type)}${r.floor ? ` · ชั้น ${esc(r.floor)}` : ''} · รับพร้อมกัน ${r.capacity} คน</div>
          </div>
          <div class="text-right text-xs"><div class="font-semibold">${r.occupancyNow}/${r.capacity}</div>
            <div class="w-20 h-1.5 rounded bg-slate-100 mt-1"><div class="h-1.5 rounded ${pct >= 100 ? 'bg-rose-500' : 'bg-brand-500'}" style="width:${Math.min(100, pct)}%"></div></div></div>
        </div>
        ${r.beds.length ? `<div class="grid grid-cols-2 sm:grid-cols-3 gap-2 mt-3">${r.beds.map(bedTile).join('')}</div>` : ''}
        ${r.room_type === 'gym' ? `<div class="mt-3 text-sm">${r.current?.length ? r.current.map((a) => `<div class="flex justify-between"><span><span class="inline-block w-2 h-2 rounded-full mr-1" style="background:${esc(a.therapist_color)}"></span>${esc(a.patient_name)}</span><span class="text-xs text-slate-500">ถึง ${fmtTime(a.end_at)}</span></div>`).join('') : '<span class="text-slate-400 text-xs">ขณะนี้ไม่มีผู้ใช้</span>'}</div>` : ''}
        ${r.next?.length ? `<div class="mt-3 text-xs text-slate-500">ถัดไป: ${r.next.map((a) => `${fmtTime(a.start_at)} ${esc(a.patient_name.split(' ')[0])}`).join(' · ')}</div>` : ''}
        ${meta?.fixed_equipment?.length ? `<div class="mt-3 flex flex-wrap gap-1">${meta.fixed_equipment.map((e) => `<span class="text-[11px] rounded-full bg-slate-100 px-2 py-0.5" title="ติดตั้งประจำห้อง">🛠️ ${esc(e.name)}</span>`).join('')}</div>` : ''}
      </div>`);
  };

  const bedTile = (b) => {
    const s = STATE[b.state];
    return `<button data-bed="${b.id}" class="text-left rounded-lg ring-1 ring-inset px-2.5 py-2 ${s.cls} hover:shadow">
      <div class="flex items-center justify-between text-xs font-semibold"><span>${esc(b.name)}</span><span class="w-2 h-2 rounded-full ${s.dot}"></span></div>
      <div class="text-[11px] opacity-80">${esc(b.code)} · ${esc(BED_TYPE_TH[b.bed_type] || b.bed_type)}</div>
      <div class="text-[11px] mt-1 truncate">${b.current ? `${esc(b.current.patient_name)} · ถึง ${fmtTime(b.current.end_at)}` : b.next ? `ถัดไป ${fmtTime(b.next.start_at)}` : s.th}</div>
    </button>`;
  };

  $('#fc-room')?.addEventListener('click', () => {
    const m = modal('เพิ่มห้อง', `
      <form class="grid grid-cols-2 gap-3 text-sm">
        <label>รหัส<input name="code" required class="${input}" placeholder="R6"></label>
        <label>ชื่อห้อง<input name="name" required class="${input}"></label>
        <label>ประเภท<select name="roomType" class="${input}">${Object.entries(ROOM_TYPE_TH).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></label>
        <label>รับพร้อมกัน (คน)<input name="capacity" type="number" min="1" value="1" class="${input}"></label>
        <label>ชั้น<input name="floor" class="${input}"></label>
        <div class="col-span-2">${btn('บันทึก', 'type="submit"')}</div>
      </form>`);
    $('form', m.el).addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(e.target));
      try {
        await api.post('/facilities/rooms', { ...f, capacity: Number(f.capacity), floor: f.floor || null });
        toast('เพิ่มห้องแล้ว', 'success'); m.close(); load();
      } catch (err) { showError(err); }
    });
  });

  $('#fc-bed')?.addEventListener('click', () => {
    if (!rooms.length) { toast('เพิ่มห้องก่อน', 'warn'); return; }
    const m = modal('เพิ่มเตียง', `
      <form class="grid grid-cols-2 gap-3 text-sm">
        <label class="col-span-2">ห้อง<select name="roomId" class="${input}">${rooms.map((r) => `<option value="${r.id}">${esc(r.code)} ${esc(r.name)}</option>`).join('')}</select></label>
        <label>รหัส<input name="code" required class="${input}" placeholder="R1-B4"></label>
        <label>ชื่อ<input name="name" required class="${input}" placeholder="เตียง 4"></label>
        <label class="col-span-2">ประเภท<select name="bedType" class="${input}">${Object.entries(BED_TYPE_TH).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></label>
        <div class="col-span-2">${btn('บันทึก', 'type="submit"')}</div>
      </form>`);
    $('form', m.el).addEventListener('submit', async (e) => {
      e.preventDefault();
      try { await api.post('/facilities/beds', Object.fromEntries(new FormData(e.target))); toast('เพิ่มเตียงแล้ว', 'success'); m.close(); load(); } catch (err) { showError(err); }
    });
  });

  $('#fc-at').addEventListener('change', load);
  $('#fc-now').addEventListener('click', () => { $('#fc-at').value = ''; load(); });

  let t;
  const onLive = () => { clearTimeout(t); t = setTimeout(load, 300); };
  const timer = setInterval(load, 60_000); // เวลาเดินไป สถานะว่าง/มีผู้ป่วยเปลี่ยนแม้ไม่มี event
  ['bed_status', 'appointment_changed', 'equipment_status'].forEach((ev) => window.addEventListener(ev, onLive));
  await load();
  return () => { clearInterval(timer); ['bed_status', 'appointment_changed', 'equipment_status'].forEach((ev) => window.removeEventListener(ev, onLive)); };
}

function openBed(id, beds, canStatus, reload) {
  const b = beds.find((x) => x.id === id);
  const m = modal(`${b.name} (${b.code})`, `
    <div class="space-y-3 text-sm">
      <div>สถานะ: <b>${STATE[b.state].th}</b>${b.notes ? ` <span class="text-slate-500">— ${esc(b.notes)}</span>` : ''}</div>
      ${b.current ? `<div class="rounded-lg bg-sky-50 p-2">กำลังรักษา: <b>${esc(b.current.patient_name)}</b> (${esc(b.current.hn)}) · ${esc(b.current.therapist_name)} · ${fmtTime(b.current.start_at)}–${fmtTime(b.current.end_at)}</div>` : ''}
      ${b.next ? `<div>นัดถัดไป: ${fmtDateTime(b.next.start_at)} ${esc(b.next.patient_name)}</div>` : ''}
      <div class="text-slate-500">นัดที่เหลือวันนี้: ${b.todayRemaining}</div>
      ${canStatus ? `
        <div class="rounded-lg bg-slate-50 p-3 space-y-2">
          <div class="font-medium">เปลี่ยนสถานะเตียง</div>
          <div class="flex gap-2"><select id="bd-status" class="${input}">
            <option value="available">พร้อมใช้</option><option value="maintenance">ปิดซ่อม</option><option value="out_of_service">งดใช้</option></select>
            ${btn('บันทึก', 'id="bd-save"')}</div>
          <input id="bd-reason" class="${input}" placeholder="เหตุผล">
          <div id="bd-result"></div>
        </div>` : ''}
    </div>`);
  $('#bd-save', m.el)?.addEventListener('click', async () => {
    try {
      const r = await api.patch(`/facilities/beds/${id}/status`, { status: $('#bd-status', m.el).value, reason: $('#bd-reason', m.el).value || undefined });
      toast('บันทึกแล้ว', 'success');
      reload();
      $('#bd-result', m.el).innerHTML = r.affectedAppointments.length ? `
        <div class="rounded-lg bg-amber-50 ring-1 ring-amber-200 p-2">
          <div class="font-medium text-amber-800">นัดที่ต้องย้ายเตียง ${r.affectedAppointments.length} รายการ</div>
          ${r.affectedAppointments.map((a) => `<div>${fmtDateTime(a.start_at)} ${esc(a.patient_name)} → ${a.substitutes.length ? a.substitutes.map((s) => `${esc(s.roomName)} ${esc(s.name)}`).join(', ') : '<span class="text-rose-600">ไม่มีเตียงว่าง</span>'}</div>`).join('')}
        </div>` : '';
    } catch (err) { showError(err); }
  });
}
