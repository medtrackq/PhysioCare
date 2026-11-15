import { api, hisLocked } from '../api.js';
import {
  $, $$, esc, pageHeader, card, btn, input, modal, toast, showError, fmtDate, fmtTime, bkkToday, imgOrIcon, formModal, compact,
} from '../ui.js';

const POSITION_TH = { physiotherapist: 'นักกายภาพบำบัด', assistant: 'ผู้ช่วย/เจ้าหน้าที่', admin: 'ธุรการ' };

const DAY_TH = ['จ.', 'อ.', 'พ.', 'พฤ.', 'ศ.', 'ส.', 'อา.'];

function mondayOf(date) {
  const d = new Date(`${date}T00:00:00Z`);
  const dow = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
}
const addDays = (date, n) => { const d = new Date(`${date}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const localDate = (iso) => new Date(new Date(iso).getTime() + 7 * 3600e3).toISOString().slice(0, 10);

export async function render(root, { session }) {
  let week = mondayOf(bkkToday());
  const [staff, templates] = await Promise.all([api.get('/staff'), api.get('/staff/shift-templates')]);
  root.innerHTML = `
    ${pageHeader('บุคลากร & ตารางกะ', 'ความเชี่ยวชาญเฉพาะทางใช้ในระบบแนะนำนักกายภาพอัตโนมัติ', session.can('staff:write') ? btn('+ เพิ่มบุคลากร', 'id="st-new"') : '')}
    ${staff.length ? '' : `<div class="mb-6 rounded-xl bg-amber-50 ring-1 ring-amber-200 px-4 py-3 text-sm text-amber-900">ยังไม่มีบุคลากร — เพิ่มนักกายภาพบำบัด กำหนดความเชี่ยวชาญ แล้วสร้างกะทำงาน ระบบจึงจะจองนัดได้</div>`}
    <div class="grid gap-4 sm:grid-cols-2 xl:grid-cols-5 mb-8">${staff.map((s) => `
      <div class="bg-white rounded-xl border border-slate-200 overflow-hidden">
        ${imgOrIcon(s.photo_url, '👤', 'h-28')}
        <div class="p-3 space-y-1">
          <div class="font-semibold">${esc(s.title || '')}${esc(s.first_name)} ${esc(s.last_name)}</div>
          <div class="text-xs text-slate-500">${esc(s.employee_code)} · ${esc(POSITION_TH[s.position] || s.position)}${s.license_no ? ` · ${esc(s.license_no)}` : ''}${s.is_active ? '' : ' · <span class="text-rose-600">ปิดใช้งาน</span>'}</div>
          ${s.license_expiry ? `<div class="text-xs ${new Date(s.license_expiry) < new Date(Date.now() + 90 * 864e5) ? 'text-rose-600' : 'text-slate-400'}">ใบอนุญาตหมดอายุ ${fmtDate(s.license_expiry)}</div>` : ''}
          <div class="flex flex-wrap gap-1 pt-1">${s.specialties.map((x) => `<span class="text-[11px] rounded-full bg-brand-50 text-brand-700 px-2 py-0.5">${esc(x.name)} ${'●'.repeat(x.level)}${'○'.repeat(5 - x.level)}</span>`).join('')}</div>
          ${session.can('media:upload') && session.can('staff:write') ? `<label class="block text-[11px] text-slate-500 pt-1 cursor-pointer">อัปโหลดรูป<input data-photo="${s.id}" type="file" accept="image/*" class="hidden"></label>` : ''}
          <div class="flex flex-wrap gap-1 pt-2">
            ${session.can('staff:write') ? `${btn('แก้ไข', `data-st-edit="${s.id}"`, 'ghost')}${btn('ความเชี่ยวชาญ', `data-st-skill="${s.id}"`, 'ghost')}` : ''}
            ${session.can('shifts:write') ? btn('บันทึกวันลา', `data-st-leave="${s.id}"`, 'ghost') : ''}
          </div>
        </div>
      </div>`).join('')}</div>

    <div class="flex items-center justify-between mb-3">
      <h2 class="font-semibold">ตารางกะรายสัปดาห์</h2>
      <div class="flex gap-2">${btn('‹', 'id="wk-prev"', 'ghost')}<span id="wk-label" class="text-sm self-center"></span>${btn('›', 'id="wk-next"', 'ghost')}
        ${session.can('shifts:write') ? btn('+ สร้างกะ', 'id="sh-new"') : ''}</div>
    </div>
    <div id="roster"></div>`;

  const load = async () => {
    const to = addDays(week, 6);
    $('#wk-label').textContent = `${fmtDate(week)} – ${fmtDate(to)}`;
    const { shifts, leaves } = await api.get(`/staff/shifts?from=${week}&to=${to}`);
    const days = Array.from({ length: 7 }, (_, i) => addDays(week, i));
    $('#roster').innerHTML = card(`<div class="overflow-x-auto"><table class="w-full text-sm min-w-[720px]">
      <thead><tr class="text-xs text-slate-500"><th class="text-left p-2">บุคลากร</th>${days.map((d, i) => `<th class="p-2 ${d === bkkToday() ? 'text-brand-700' : ''}">${DAY_TH[i]} ${d.slice(8)}</th>`).join('')}</tr></thead>
      <tbody class="divide-y divide-slate-100">${staff.filter((s) => s.is_active).map((s) => `<tr>
        <td class="p-2 whitespace-nowrap"><span class="inline-block w-2 h-2 rounded-full mr-1" style="background:${esc(s.color)}"></span>${esc(s.first_name)}</td>
        ${days.map((d) => {
          const sh = shifts.filter((x) => x.staff_id === s.id && localDate(x.start_at) === d);
          const lv = leaves.filter((x) => x.staff_id === s.id && localDate(x.start_at) <= d && localDate(x.end_at) >= d);
          return `<td class="p-1 text-center align-top">${sh.map((x) => `<div class="rounded bg-emerald-50 text-emerald-700 text-[11px] px-1 py-0.5 mb-0.5">${fmtTime(x.start_at)}–${fmtTime(x.end_at)}</div>`).join('')}
            ${lv.map((x) => `<div class="rounded bg-rose-50 text-rose-600 text-[11px] px-1 py-0.5">ลา ${esc(x.leave_type)}</div>`).join('')}</td>`;
        }).join('')}</tr>`).join('')}</tbody></table></div>`);
  };

  const rerender = () => render(root, { session });
  $('#st-new')?.addEventListener('click', () => openStaffForm(null, rerender));
  $$('[data-st-edit]').forEach((b) => b.addEventListener('click', async () => openStaffForm(await api.get(`/staff/${b.dataset.stEdit}`), rerender)));
  $$('[data-st-skill]').forEach((b) => b.addEventListener('click', () => openSpecialties(b.dataset.stSkill, rerender)));
  $$('[data-st-leave]').forEach((b) => b.addEventListener('click', () => openLeave(staff.find((x) => x.id === b.dataset.stLeave), load)));

  $('#wk-prev').addEventListener('click', () => { week = addDays(week, -7); load(); });
  $('#wk-next').addEventListener('click', () => { week = addDays(week, 7); load(); });
  $$('[data-photo]').forEach((i) => i.addEventListener('change', async () => {
    const fd = new FormData();
    fd.append('images', i.files[0]);
    fd.append('kind', 'avatar');
    fd.append('primary', 'true');
    try { await api.upload(`/media/staff/${i.dataset.photo}`, fd); toast('อัปโหลดแล้ว', 'success'); render(root, { session }); } catch (e) { showError(e); }
  }));
  $('#sh-new')?.addEventListener('click', () => {
    const m = modal('สร้างกะทำงาน (bulk)', `
      <form class="space-y-3 text-sm">
        <label class="block">บุคลากร<select name="staff" class="${input}">${staff.map((s) => `<option value="${s.id}">${esc(s.first_name)} ${esc(s.last_name)}</option>`).join('')}</select></label>
        <label class="block">กะ<select name="tpl" class="${input}">${templates.map((t) => `<option value="${t.code}">${esc(t.name_th)} ${t.start_time.slice(0, 5)}–${t.end_time.slice(0, 5)}</option>`).join('')}</select></label>
        <div class="grid grid-cols-2 gap-2"><label>ตั้งแต่<input name="from" type="date" class="${input}" value="${week}"></label><label>ถึง<input name="to" type="date" class="${input}" value="${addDays(week, 27)}"></label></div>
        <div class="flex flex-wrap gap-3">${DAY_TH.map((d, i) => `<label class="flex items-center gap-1"><input type="checkbox" name="wd" value="${i + 1}" ${i < 5 ? 'checked' : ''}>${d}</label>`).join('')}</div>
        <p class="text-xs text-slate-500">วันที่มีกะอยู่แล้วจะถูกข้ามอัตโนมัติ (ป้องกันกะซ้อน)</p>
        ${btn('สร้าง', 'type="submit"')}
      </form>`);
    $('form', m.el).addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      try {
        const r = await api.post(`/staff/${f.get('staff')}/shifts`, {
          templateCode: f.get('tpl'), from: f.get('from'), to: f.get('to'), weekdays: f.getAll('wd').map(Number),
        });
        toast(`สร้าง ${r.created} กะ`, 'success');
        m.close();
        load();
      } catch (err) { showError(err); }
    });
  });
  await load();
}

/** เพิ่ม/แก้ไขข้อมูลบุคลากร */
async function openStaffForm(s, done) {
  const d = (v) => (v ? String(v).slice(0, 10) : '');
  formModal(s ? `แก้ไข ${s.first_name} ${s.last_name}` : 'เพิ่มบุคลากร', [
    { name: 'employeeCode', label: 'รหัสพนักงาน', required: true, value: s?.employee_code },
    { name: 'position', label: 'ตำแหน่ง', type: 'select', required: true, value: s?.position || 'physiotherapist',
      options: Object.entries(POSITION_TH).map(([value, label]) => ({ value, label })) },
    { name: 'title', label: 'คำนำหน้า', value: s ? s.title : 'กภ.', hint: 'เช่น กภ., นาย, นางสาว' },
    { name: 'firstName', label: 'ชื่อ', required: true, value: s?.first_name },
    { name: 'lastName', label: 'นามสกุล', required: true, value: s?.last_name },
    { name: 'licenseNo', label: 'เลขใบอนุญาตประกอบวิชาชีพ', value: s?.license_no, hint: 'บังคับสำหรับนักกายภาพบำบัด' },
    { name: 'licenseExpiry', label: 'ใบอนุญาตหมดอายุ', type: 'date', value: d(s?.license_expiry) },
    { name: 'phone', label: 'โทรศัพท์', type: 'tel', value: s?.phone },
    { name: 'email', label: 'อีเมล', type: 'email', value: s?.email },
    { name: 'maxPatientsPerDay', label: 'รับผู้ป่วยสูงสุด/วัน', type: 'number', value: s?.max_patients_per_day ?? 12, attrs: 'min="1" max="40"' },
    { name: 'color', label: 'สีบนปฏิทิน', type: 'color', value: s?.color || '#0ea5e9' },
    ...(s ? [{ name: 'isActive', label: 'ใช้งานอยู่ (ปิดเมื่อลาออก — ประวัติยังอยู่)', type: 'checkbox', value: s.is_active, full: true }] : []),
  ], async (v, m) => {
    if (v.position === 'physiotherapist' && !v.licenseNo) throw new Error('นักกายภาพบำบัดต้องมีเลขใบอนุญาต');
    if (s) await api.patch(`/staff/${s.id}`, v);
    else await api.post('/staff', compact(v));
    toast(s ? 'บันทึกแล้ว' : 'เพิ่มบุคลากรแล้ว — กำหนดความเชี่ยวชาญและสร้างกะต่อได้เลย', 'success');
    m.close();
    done();
  }, { wide: true, submitLabel: s ? 'บันทึก' : 'เพิ่มบุคลากร', locked: await hisLocked('staff', s) });
}

/** กำหนดความเชี่ยวชาญ (ใช้ในระบบแนะนำนักกายภาพตามโรค) */
async function openSpecialties(id, done) {
  const [s, all] = await Promise.all([api.get(`/staff/${id}`), api.get('/staff/specialties')]);
  const has = new Map(s.specialties.map((x) => [x.id, x]));
  const certOf = (spId) => (has.get(spId)?.certified_at ? String(has.get(spId).certified_at).slice(0, 10) : '');
  const m = modal(`ความเชี่ยวชาญ · ${s.first_name} ${s.last_name}`, `
    <p class="text-sm text-slate-500 mb-3">ติ๊กสาขาที่เชี่ยวชาญ และให้ระดับ 1–5 (5 = ผู้เชี่ยวชาญ) ระบบใช้ค่านี้จัดอันดับนักกายภาพตามการวินิจฉัย</p>
    <div class="space-y-2">${all.map((sp) => `
      <div class="grid grid-cols-12 gap-2 items-center text-sm">
        <label class="col-span-6 flex items-center gap-2"><input type="checkbox" data-sp="${sp.id}" ${has.has(sp.id) ? 'checked' : ''}>${esc(sp.name_th)} <span class="text-xs text-slate-400">${esc(sp.name_en)}</span></label>
        <select data-lv="${sp.id}" class="${input} col-span-3" aria-label="ระดับ">${[1, 2, 3, 4, 5].map((n) => `<option ${(has.get(sp.id)?.level || 3) === n ? 'selected' : ''}>${n}</option>`).join('')}</select>
        <input data-cert="${sp.id}" type="date" class="${input} col-span-3" value="${certOf(sp.id)}" title="วันที่ได้รับการรับรอง">
      </div>`).join('')}</div>
    <div class="pt-4">${btn('บันทึก', 'id="sp-save"')}</div>`);
  $('#sp-save', m.el).addEventListener('click', async () => {
    const body = all.filter((sp) => $(`[data-sp="${sp.id}"]`, m.el).checked).map((sp) => ({
      specialtyId: sp.id,
      level: Number($(`[data-lv="${sp.id}"]`, m.el).value),
      certifiedAt: $(`[data-cert="${sp.id}"]`, m.el).value || null,
    }));
    try {
      await api.put(`/staff/${id}/specialties`, body);
      toast('บันทึกความเชี่ยวชาญแล้ว', 'success');
      m.close();
      done();
    } catch (err) { showError(err); }
  });
}

/** บันทึกวันลา — แจ้งจำนวนนัดที่ได้รับผลกระทบ */
function openLeave(s, done) {
  const today = bkkToday();
  formModal(`บันทึกวันลา · ${s.first_name}`, [
    { name: 'leaveType', label: 'ประเภท', type: 'select', required: true, value: 'personal',
      options: [['sick', 'ลาป่วย'], ['personal', 'ลากิจ'], ['vacation', 'ลาพักร้อน'], ['training', 'อบรม/ประชุม']].map(([value, label]) => ({ value, label })) },
    { name: 'reason', label: 'เหตุผล' },
    { name: 'fromDate', label: 'ตั้งแต่วันที่', type: 'date', required: true, value: today },
    { name: 'fromTime', label: 'เวลา', type: 'time', required: true, value: '08:00' },
    { name: 'toDate', label: 'ถึงวันที่', type: 'date', required: true, value: today },
    { name: 'toTime', label: 'เวลา', type: 'time', required: true, value: '20:00' },
  ], async (v, m) => {
    const r = await api.post(`/staff/${s.id}/leaves`, {
      leaveType: v.leaveType,
      reason: v.reason || undefined,
      startAt: `${v.fromDate}T${v.fromTime}:00+07:00`,
      endAt: `${v.toDate}T${v.toTime}:00+07:00`,
    });
    m.close();
    const n = r.affectedAppointments.length;
    toast(n ? `บันทึกแล้ว — มีนัด ${n} รายการในช่วงลาที่ต้องเลื่อน (ดูในตารางนัด)` : 'บันทึกวันลาแล้ว', n ? 'warn' : 'success');
    done();
  });
}
