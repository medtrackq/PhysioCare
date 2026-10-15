import { api } from '../api.js';
import { $, $$, esc, pageHeader, card, btn, input, modal, toast, showError, fmtDate, fmtTime, bkkToday, imgOrIcon } from '../ui.js';

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
    ${pageHeader('บุคลากร & ตารางกะ', 'ความเชี่ยวชาญเฉพาะทางใช้ในระบบแนะนำนักกายภาพอัตโนมัติ')}
    <div class="grid gap-4 sm:grid-cols-2 xl:grid-cols-5 mb-8">${staff.map((s) => `
      <div class="bg-white rounded-xl border border-slate-200 overflow-hidden">
        ${imgOrIcon(s.photo_url, '👤', 'h-28')}
        <div class="p-3 space-y-1">
          <div class="font-semibold">${esc(s.title || '')}${esc(s.first_name)} ${esc(s.last_name)}</div>
          <div class="text-xs text-slate-500">${esc(s.employee_code)} · ${esc(s.position)}${s.license_no ? ` · ${esc(s.license_no)}` : ''}</div>
          ${s.license_expiry ? `<div class="text-xs ${new Date(s.license_expiry) < new Date(Date.now() + 90 * 864e5) ? 'text-rose-600' : 'text-slate-400'}">ใบอนุญาตหมดอายุ ${fmtDate(s.license_expiry)}</div>` : ''}
          <div class="flex flex-wrap gap-1 pt-1">${s.specialties.map((x) => `<span class="text-[11px] rounded-full bg-brand-50 text-brand-700 px-2 py-0.5">${esc(x.name)} ${'●'.repeat(x.level)}${'○'.repeat(5 - x.level)}</span>`).join('')}</div>
          ${session.can('media:upload') && session.can('staff:write') ? `<label class="block text-[11px] text-slate-500 pt-1 cursor-pointer">อัปโหลดรูป<input data-photo="${s.id}" type="file" accept="image/*" class="hidden"></label>` : ''}
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
