import { api } from '../api.js';
import { esc, badge, APPT_STATUS, pageHeader, card, fmtDateTime, fmtTime, empty } from '../ui.js';

export async function render(root) {
  const [me, appts] = await Promise.all([api.get('/patients/me'), api.get('/appointments')]);
  const now = Date.now();
  const upcoming = appts.filter((a) => new Date(a.end_at) >= now && !['cancelled', 'no_show'].includes(a.status));
  const past = appts.filter((a) => !upcoming.includes(a)).reverse();
  const list = (items) => (items.length ? `<ul class="divide-y divide-slate-100">${items.map((a) => `
    <li class="py-3 flex flex-wrap items-center justify-between gap-2 text-sm">
      <div><div class="font-medium">${fmtDateTime(a.start_at)} – ${fmtTime(a.end_at)}</div>
      <div class="text-slate-500">${esc(a.therapist_name)}${a.diagnosis_name ? ` · ${esc(a.diagnosis_name)}` : ''}${a.room_name ? ` · ${esc(a.room_name)}` : ''}</div></div>
      ${badge(APPT_STATUS, a.status)}
    </li>`).join('')}</ul>` : empty('ไม่มีรายการ'));
  root.innerHTML = `
    ${pageHeader(`สวัสดี คุณ${esc(me.first_name)}`, `HN ${esc(me.hn)}`)}
    <div class="grid lg:grid-cols-2 gap-5">
      ${card(`<div class="p-5"><h2 class="font-semibold mb-2">นัดหมายที่กำลังจะถึง</h2>${list(upcoming)}
        <p class="text-xs text-slate-400 mt-3">หากต้องการเลื่อนนัด กรุณาติดต่อเจ้าหน้าที่ล่วงหน้าอย่างน้อย 24 ชั่วโมง</p></div>`)}
      ${card(`<div class="p-5"><h2 class="font-semibold mb-2">ประวัติการมารับบริการ</h2>${list(past)}</div>`)}
    </div>`;
}
