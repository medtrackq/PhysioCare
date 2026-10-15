import { api } from '../api.js';
import {
  $, $$, esc, badge, APPT_STATUS, pageHeader, btn, input, modal, toast, showError,
  fmtTime, fmtDateTime, bkkToday, bkkISO,
} from '../ui.js';

const OPEN = 8;
const CLOSE = 20;
const ROW_PX = 28; // 30 นาที
let currentDate = bkkToday();

export async function render(root, { session }) {
  root.innerHTML = `
    ${pageHeader('ตารางนัดหมาย', 'มุมมองรายวันแยกตามนักกายภาพบำบัด',
      `<input id="sc-date" type="date" class="${input}" value="${currentDate}">
       ${session.can('appointments:write') ? btn('+ จองนัด', 'id="sc-new"') : ''}`)}
    <div id="sc-grid" class="bg-white rounded-xl border border-slate-200 overflow-x-auto"></div>`;

  const load = async () => {
    const from = bkkISO(currentDate, '00:00');
    const to = bkkISO(currentDate, '23:59');
    const [staff, appts, shifts] = await Promise.all([
      api.get('/staff?position=physiotherapist'),
      api.get(`/appointments?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`),
      api.get(`/staff/shifts?from=${currentDate}&to=${currentDate}`),
    ]);
    drawGrid(staff.filter((s) => s.is_active), appts, shifts);
  };

  const drawGrid = (staff, appts, { shifts, leaves }) => {
    const rows = (CLOSE - OPEN) * 2;
    const minuteOf = (d) => { const t = new Date(new Date(d).getTime() + 7 * 3600e3); return t.getUTCHours() * 60 + t.getUTCMinutes(); };
    const top = (d) => ((minuteOf(d) - OPEN * 60) / 30) * ROW_PX;
    const height = (s, e) => Math.max(ROW_PX - 2, ((new Date(e) - new Date(s)) / 60000 / 30) * ROW_PX - 2);
    $('#sc-grid').innerHTML = `
      <div class="grid min-w-[720px]" style="grid-template-columns: 56px repeat(${staff.length}, minmax(160px, 1fr))">
        <div class="border-b border-slate-200"></div>
        ${staff.map((s) => `<div class="border-b border-l border-slate-200 px-2 py-2 text-sm font-medium flex items-center gap-2"><span class="w-2.5 h-2.5 rounded-full" style="background:${esc(s.color)}"></span>${esc(s.title || '')}${esc(s.first_name)}
          <span class="text-xs text-slate-400 font-normal">${s.specialties.map((x) => esc(x.code)).join(', ')}</span></div>`).join('')}
        <div class="relative" style="height:${rows * ROW_PX}px">
          ${Array.from({ length: rows / 2 }, (_, i) => `<div class="absolute right-1 text-[10px] text-slate-400" style="top:${i * 2 * ROW_PX - 6}px">${String(OPEN + i).padStart(2, '0')}:00</div>`).join('')}
        </div>
        ${staff.map((s) => `
          <div class="relative border-l border-slate-200" style="height:${rows * ROW_PX}px">
            ${Array.from({ length: rows }, (_, i) => `<div class="absolute inset-x-0 border-t ${i % 2 ? 'border-slate-50' : 'border-slate-100'}" style="top:${i * ROW_PX}px"></div>`).join('')}
            ${offShiftBlocks(shifts.filter((x) => x.staff_id === s.id), top)}
            ${leaves.filter((l) => l.staff_id === s.id).map((l) => `<div class="absolute inset-x-0 bg-rose-50/80 text-[10px] text-rose-500 p-1" style="top:${Math.max(0, top(l.start_at))}px;height:${Math.min(rows * ROW_PX, height(l.start_at, l.end_at))}px">ลา (${esc(l.leave_type)})</div>`).join('')}
            ${appts.filter((a) => a.therapist_id === s.id && !['cancelled', 'no_show'].includes(a.status)).map((a) => `
              <button data-appt="${a.id}" class="absolute left-1 right-1 rounded-md text-left px-1.5 py-1 text-xs overflow-hidden ring-1 ring-inset ring-black/5 hover:shadow"
                style="top:${top(a.start_at) + 1}px;height:${height(a.start_at, a.end_at)}px;background:${esc(a.therapist_color)}22;border-left:3px solid ${esc(a.therapist_color)}">
                <div class="font-semibold truncate">${fmtTime(a.start_at)} ${esc(a.patient_name)}</div>
                <div class="truncate text-slate-500">${esc(a.icd10_code || '')} ${a.equipment.map((e) => esc(e.asset_code)).join(' ')}</div>
                <div class="mt-0.5">${badge(APPT_STATUS, a.status)}</div>
              </button>`).join('')}
          </div>`).join('')}
      </div>`;
    $$('[data-appt]').forEach((b) => b.addEventListener('click', () => openAppointment(b.dataset.appt, session, load)));
  };

  const offShiftBlocks = (shifts, top) => {
    // ระบายสีเทาช่วงที่ไม่อยู่ในกะ
    const total = (CLOSE - OPEN) * 2 * ROW_PX;
    const spans = shifts.map((s) => [Math.max(0, top(s.start_at)), Math.min(total, top(s.end_at))]).sort((a, b) => a[0] - b[0]);
    const out = [];
    let cur = 0;
    for (const [a, b] of spans) { if (a > cur) out.push([cur, a]); cur = Math.max(cur, b); }
    if (cur < total) out.push([cur, total]);
    return out.map(([a, b]) => `<div class="absolute inset-x-0 bg-slate-100/70" style="top:${a}px;height:${b - a}px" title="นอกกะ"></div>`).join('');
  };

  $('#sc-date').addEventListener('change', (e) => { currentDate = e.target.value; load(); });
  $('#sc-new')?.addEventListener('click', () => openBooking(load));

  const onLive = (e) => { if (bkkToday() === currentDate || e.detail.start_at?.startsWith?.(currentDate)) load(); };
  window.addEventListener('appointment_changed', onLive);
  await load();
  return () => window.removeEventListener('appointment_changed', onLive);
}

// ---------------------------------------------------------------------
// Appointment detail & status actions
// ---------------------------------------------------------------------
const NEXT = {
  booked: [['confirmed', 'ยืนยันนัด'], ['checked_in', 'ผู้ป่วยมาถึง'], ['no_show', 'ไม่มาตามนัด'], ['cancelled', 'ยกเลิก']],
  confirmed: [['checked_in', 'ผู้ป่วยมาถึง'], ['no_show', 'ไม่มาตามนัด'], ['cancelled', 'ยกเลิก']],
  checked_in: [['in_progress', 'เริ่มรักษา'], ['cancelled', 'ยกเลิก']],
  in_progress: [['completed', 'จบการรักษา']],
};

async function openAppointment(id, session, reload) {
  const a = await api.get(`/appointments/${id}`);
  const m = modal(`นัดหมาย · ${a.patient_name}`, `
    <dl class="grid grid-cols-3 gap-y-2 text-sm">
      <dt class="text-slate-500">HN</dt><dd class="col-span-2">${esc(a.hn)}</dd>
      <dt class="text-slate-500">เวลา</dt><dd class="col-span-2">${fmtDateTime(a.start_at)} – ${fmtTime(a.end_at)}</dd>
      <dt class="text-slate-500">นักกายภาพ</dt><dd class="col-span-2">${esc(a.therapist_name)}</dd>
      <dt class="text-slate-500">วินิจฉัย</dt><dd class="col-span-2">${esc(a.icd10_code || '–')} ${esc(a.diagnosis_name || '')}</dd>
      <dt class="text-slate-500">อุปกรณ์</dt><dd class="col-span-2">${a.equipment.map((e) => `${esc(e.name)} <span class="text-xs text-slate-400">(จองถึง ${fmtTime(e.reserved_until)} รวม buffer)</span>`).join('<br>') || '–'}</dd>
      <dt class="text-slate-500">สถานะ</dt><dd class="col-span-2">${badge(APPT_STATUS, a.status)}</dd>
      <dt class="text-slate-500">เวชระเบียน</dt><dd class="col-span-2">Pre ${a.has_pre ? '✅' : '⬜'} · Post ${a.has_post ? '✅' : '⬜'}</dd>
    </dl>
    <div class="flex flex-wrap gap-2 mt-5">
      ${session.can('appointments:write') ? (NEXT[a.status] || []).map(([s, l]) => btn(l, `data-next="${s}"`, s === 'cancelled' || s === 'no_show' ? 'ghost' : 'primary')).join('') : ''}
      ${session.can('emr:read') ? `<a href="#/emr/${a.id}" class="inline-flex items-center rounded-lg px-3 py-1.5 text-sm font-medium ring-1 ring-inset ring-slate-300 hover:bg-slate-50">📝 เปิดเวชระเบียน</a>` : ''}
    </div>`);
  $$('[data-next]', m.el).forEach((b) => b.addEventListener('click', async () => {
    const status = b.dataset.next;
    const reason = status === 'cancelled' ? prompt('เหตุผลการยกเลิก') : undefined;
    if (status === 'cancelled' && !reason) return;
    try {
      await api.patch(`/appointments/${id}/status`, { status, reason });
      toast('อัปเดตสถานะแล้ว', 'success');
      m.close();
      reload();
    } catch (err) {
      if (err.code === 'PRE_ASSESSMENT_REQUIRED') {
        toast(err.message, 'warn');
        location.hash = `#/emr/${id}`;
        m.close();
      } else showError(err);
    }
  }));
}

// ---------------------------------------------------------------------
// Booking wizard: ผู้ป่วย -> คำแนะนำ -> ช่องเวลา -> ตรวจ conflict -> จอง
// ---------------------------------------------------------------------
function openBooking(reload) {
  const st = { patient: null, rec: null, therapistId: null, categoryIds: new Set(), equipment: {}, date: currentDate, duration: 45, slot: null };
  const m = modal('จองนัดหมายอัจฉริยะ', `
    <div class="space-y-5">
      <section>
        <label class="text-sm font-medium">1. ค้นหาผู้ป่วย (HN / ชื่อ / โทร)</label>
        <input id="bk-q" class="${input} mt-1" placeholder="พิมพ์อย่างน้อย 2 ตัวอักษร">
        <div id="bk-results" class="mt-2 space-y-1"></div>
      </section>
      <section id="bk-rec" class="hidden"></section>
      <section id="bk-time" class="hidden">
        <div class="text-sm font-medium mb-2">3. เลือกวันและช่วงเวลาที่ว่างพร้อมกันทั้งคน–อุปกรณ์–ผู้ป่วย</div>
        <div class="flex flex-wrap gap-2 items-center">
          <input id="bk-date" type="date" class="${input} max-w-[180px]" value="${st.date}">
          <select id="bk-dur" class="${input} max-w-[140px]">${[30, 45, 60, 90].map((d) => `<option ${d === 45 ? 'selected' : ''} value="${d}">${d} นาที</option>`).join('')}</select>
          ${btn('ค้นหาช่องว่าง', 'id="bk-find"', 'ghost')}
        </div>
        <div id="bk-slots" class="mt-3 flex flex-wrap gap-2"></div>
      </section>
      <section id="bk-check"></section>
    </div>`, { wide: true });
  const el = m.el;

  // ----- 1. ค้นหาผู้ป่วย -----
  let t;
  $('#bk-q', el).addEventListener('input', (e) => {
    clearTimeout(t);
    const q = e.target.value.trim();
    if (q.length < 2) return;
    t = setTimeout(async () => {
      const list = await api.get(`/patients?q=${encodeURIComponent(q)}`);
      $('#bk-results', el).innerHTML = list.map((p) => `
        <button data-pid="${p.id}" class="w-full text-left rounded-lg px-3 py-2 ring-1 ring-inset ring-slate-200 hover:bg-brand-50 text-sm">
          <span class="font-medium">${esc(p.hn)}</span> ${esc(p.title || '')}${esc(p.first_name)} ${esc(p.last_name)}
          <span class="text-slate-500">${(p.diagnoses || []).map((d) => esc(d.code)).join(', ')}</span>
          ${(p.precautions || []).map((c) => `<span class="ml-1 rounded bg-rose-50 text-rose-700 text-[10px] px-1">${esc(c)}</span>`).join('')}
        </button>`).join('') || '<div class="text-sm text-slate-400">ไม่พบ</div>';
      $$('[data-pid]', el).forEach((b) => b.addEventListener('click', () => selectPatient(list.find((p) => p.id === b.dataset.pid))));
    }, 250);
  });

  // ----- 2. ระบบแนะนำ -----
  async function selectPatient(p) {
    st.patient = p;
    $('#bk-results', el).innerHTML = `<div class="text-sm rounded-lg bg-brand-50 px-3 py-2">ผู้ป่วย: <b>${esc(p.hn)} ${esc(p.first_name)} ${esc(p.last_name)}</b></div>`;
    st.rec = await api.get(`/scheduling/recommendations?patientId=${p.id}&durationMin=${st.duration}`);
    const r = st.rec;
    st.therapistId = r.therapists[0]?.id;
    st.categoryIds = new Set(r.equipment.filter((e) => !e.contraindication || e.contraindication.level !== 'absolute').slice(0, 2).map((e) => e.category.id));
    $('#bk-rec', el).classList.remove('hidden');
    $('#bk-rec', el).innerHTML = `
      <div class="text-sm font-medium mb-2">2. คำแนะนำจากการวินิจฉัย
        <span class="font-normal text-slate-500">${r.diagnoses.map((d) => `${esc(d.icd10_code)} ${esc(d.name_th)}`).join(' · ')}</span></div>
      ${r.precautions.length ? `<div class="mb-3 rounded-lg bg-rose-50 ring-1 ring-rose-200 px-3 py-2 text-sm text-rose-800">⚠ ข้อควรระวัง: ${r.precautions.map((x) => `<b>${esc(x.name_th)}</b>${x.detail ? ` (${esc(x.detail)})` : ''}`).join(', ')}</div>` : ''}
      <div class="grid lg:grid-cols-2 gap-4">
        <div>
          <div class="text-xs uppercase tracking-wide text-slate-500 mb-1">นักกายภาพบำบัด (เรียงตามคะแนนความเหมาะสม)</div>
          <div class="space-y-2">${r.therapists.map((th) => `
            <label class="flex gap-3 items-start rounded-lg ring-1 ring-inset ring-slate-200 p-2 cursor-pointer has-[:checked]:ring-brand-500 has-[:checked]:bg-brand-50">
              <input type="radio" name="th" value="${th.id}" ${th.id === st.therapistId ? 'checked' : ''} class="mt-1">
              <div class="flex-1 min-w-0">
                <div class="flex justify-between text-sm"><span class="font-medium">${esc(th.name)}</span><span class="text-slate-500">${Math.round(th.score * 100)}%</span></div>
                <div class="h-1.5 rounded bg-slate-100 mt-1"><div class="h-1.5 rounded bg-brand-500" style="width:${Math.round(th.score * 100)}%"></div></div>
                <div class="text-xs text-slate-500 mt-1">${th.reasons.map(esc).join(' · ') || 'ไม่มีความเชี่ยวชาญที่ตรง'}</div>
              </div>
            </label>`).join('')}</div>
        </div>
        <div>
          <div class="text-xs uppercase tracking-wide text-slate-500 mb-1">อุปกรณ์ที่แนะนำ</div>
          <div class="space-y-2">${r.equipment.map((e) => {
            const abs = e.contraindication?.level === 'absolute';
            return `
            <label class="flex gap-3 items-start rounded-lg ring-1 ring-inset p-2 ${abs ? 'ring-rose-200 bg-rose-50/50 opacity-70' : 'ring-slate-200 cursor-pointer has-[:checked]:ring-brand-500 has-[:checked]:bg-brand-50'}">
              <input type="checkbox" value="${e.category.id}" data-cat ${abs ? 'disabled' : ''} ${st.categoryIds.has(e.category.id) ? 'checked' : ''} class="mt-1">
              <div class="flex-1 text-sm">
                <div class="flex justify-between"><span class="font-medium">${esc(e.category.name_th)}</span><span class="text-xs text-slate-500">น้ำหนัก ${Math.round(e.weight * 100)}%</span></div>
                <div class="text-xs text-slate-500">${esc(e.rationale || '')}</div>
                ${e.contraindication ? `<div class="text-xs mt-0.5 ${abs ? 'text-rose-700' : 'text-amber-700'}">${abs ? '⛔ ห้ามใช้' : '⚠ ระวัง'}: ${e.contraindication.precautions.map(esc).join(', ')}</div>` : ''}
                <div class="text-xs text-slate-400">${e.units.filter((u) => ['available', 'in_use'].includes(u.status)).length}/${e.units.length} เครื่องใช้งานได้</div>
              </div>
            </label>`;
          }).join('') || '<div class="text-sm text-slate-400">ไม่มีข้อมูล mapping</div>'}</div>
        </div>
      </div>`;
    $$('input[name=th]', el).forEach((i) => i.addEventListener('change', () => { st.therapistId = i.value; findSlots(); }));
    $$('[data-cat]', el).forEach((i) => i.addEventListener('change', () => {
      i.checked ? st.categoryIds.add(Number(i.value)) : st.categoryIds.delete(Number(i.value));
      findSlots();
    }));
    $('#bk-time', el).classList.remove('hidden');
    findSlots();
  }

  // ----- 3. ช่องเวลาว่าง -----
  async function findSlots() {
    st.date = $('#bk-date', el).value;
    st.duration = Number($('#bk-dur', el).value);
    const qs = new URLSearchParams({
      date: st.date, durationMin: st.duration, patientId: st.patient.id, therapistIds: st.therapistId,
      categoryIds: [...st.categoryIds].join(','),
    });
    const slots = await api.get(`/scheduling/slots?${qs}`);
    $('#bk-slots', el).innerHTML = slots.length
      ? slots.map((s, i) => `<button data-slot="${i}" class="rounded-lg px-3 py-1.5 text-sm ring-1 ring-inset ring-slate-300 hover:bg-brand-50">${fmtTime(s.startAt)}</button>`).join('')
      : '<div class="text-sm text-slate-400">ไม่มีช่องว่างในวันนี้ — ลองเปลี่ยนวัน นักกายภาพ หรืออุปกรณ์</div>';
    $$('[data-slot]', el).forEach((b) => b.addEventListener('click', () => {
      $$('[data-slot]', el).forEach((x) => x.classList.remove('bg-brand-600', 'text-white'));
      b.classList.add('bg-brand-600', 'text-white');
      st.slot = slots[Number(b.dataset.slot)];
      st.equipment = st.slot.equipment;
      dryRun();
    }));
  }
  $('#bk-find', el).addEventListener('click', findSlots);
  $('#bk-date', el).addEventListener('change', () => st.patient && findSlots());
  $('#bk-dur', el).addEventListener('change', () => st.patient && findSlots());

  // ----- 4. ตรวจ conflict (dry-run) + ยืนยัน -----
  const payload = (extra = {}) => ({
    patientId: st.patient.id,
    therapistId: st.therapistId,
    startAt: st.slot.startAt,
    endAt: st.slot.endAt,
    equipmentIds: Object.values(st.equipment),
    diagnosisId: st.rec.diagnoses[0]?.id,
    bookedVia: 'recommendation',
    ...extra,
  });

  async function dryRun() {
    const r = await api.post('/scheduling/check', payload());
    renderCheck(r);
  }

  function renderCheck(r) {
    const eqNames = st.rec.equipment.flatMap((c) => c.units).filter((u) => Object.values(st.equipment).includes(u.id));
    $('#bk-check', el).innerHTML = `
      <div class="rounded-xl ring-1 ring-inset ${r.ok ? 'ring-emerald-200 bg-emerald-50/50' : 'ring-rose-200 bg-rose-50/50'} p-4 space-y-2 text-sm">
        <div class="font-semibold">${r.ok ? '✅ ไม่พบความขัดแย้ง' : '⛔ พบความขัดแย้ง'}</div>
        <div>${fmtDateTime(st.slot.startAt)}–${fmtTime(st.slot.endAt)} · อุปกรณ์: ${eqNames.map((u) => esc(`${u.name} (${u.asset_code})`)).join(', ') || '–'}</div>
        ${(r.conflicts || []).map((c) => `<div class="text-rose-700">• ${esc(c.message)}</div>`).join('')}
        ${(r.warnings || []).map((c) => `<div class="text-amber-700">⚠ ${esc(c.message)}</div>`).join('')}
        ${r.alternatives ? alternativesHtml(r.alternatives) : ''}
        ${r.ok ? `
          ${r.warnings.length ? '<label class="flex items-center gap-2"><input id="bk-ack" type="checkbox"> รับทราบข้อควรระวังและยืนยันการใช้อุปกรณ์</label>' : ''}
          <div>${btn('ยืนยันการจอง', 'id="bk-confirm"')}</div>` : ''}
      </div>`;
    $('#bk-confirm', el)?.addEventListener('click', confirm);
    $$('[data-alt-slot]', el).forEach((b) => b.addEventListener('click', () => {
      st.slot = { startAt: b.dataset.start, endAt: b.dataset.end, equipment: JSON.parse(b.dataset.eq) };
      st.equipment = st.slot.equipment;
      dryRun();
    }));
  }

  const alternativesHtml = (alt) => `
    <div class="pt-2 border-t border-rose-200">
      <div class="font-medium mb-1">ทางเลือกที่ระบบแนะนำ</div>
      ${alt.sameTherapistSlots.length ? `<div class="flex flex-wrap gap-1">${alt.sameTherapistSlots.map((s) => `<button data-alt-slot data-start="${s.startAt}" data-end="${s.endAt}" data-eq='${esc(JSON.stringify(s.equipment))}' class="rounded px-2 py-1 bg-white ring-1 ring-slate-300 text-xs">${fmtDateTime(s.startAt)}</button>`).join('')}</div>` : ''}
      ${alt.otherTherapistsSameTime.length ? `<div class="text-xs mt-1">นักกายภาพที่ว่างเวลาเดิม: ${alt.otherTherapistsSameTime.map((t) => esc(t.name)).join(', ')}</div>` : ''}
      ${alt.equipmentSubstitutes.map((s) => `<div class="text-xs mt-1">เครื่องทดแทน: ${s.options.map((o) => esc(o.asset_code)).join(', ')}</div>`).join('')}
    </div>`;

  async function confirm() {
    const ack = $('#bk-ack', el);
    if (ack && !ack.checked) { toast('กรุณายืนยันการรับทราบข้อควรระวัง', 'warn'); return; }
    try {
      await api.post('/appointments', payload({ acknowledgeWarnings: Boolean(ack?.checked) }));
      toast('จองนัดสำเร็จ', 'success');
      m.close();
      currentDate = st.date;
      reload();
    } catch (err) {
      // 409: มีคนจองตัดหน้า -> แสดง conflict + ทางเลือกใหม่
      if (err.code === 'SCHEDULE_CONFLICT') renderCheck({ ok: false, ...err.details });
      else showError(err);
    }
  }
}
