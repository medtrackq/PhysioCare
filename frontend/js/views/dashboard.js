import { api } from '../api.js';
import { $, esc, badge, APPT_STATUS, EQUIPMENT_STATUS, pageHeader, card, fmtTime, fmtDate, bkkToday, bkkISO, empty } from '../ui.js';

export async function render(root, { session }) {
  const today = bkkToday();
  root.innerHTML = `${pageHeader('ภาพรวมวันนี้', fmtDate(new Date()))}
    <div id="db-kpi" class="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-5"></div>
    <div class="grid xl:grid-cols-3 gap-5">
      <div class="xl:col-span-2">${card('<div class="p-4"><div class="font-semibold mb-3">นัดหมายวันนี้</div><div id="db-appts"></div></div>')}</div>
      <div class="space-y-5">
        ${card('<div class="p-4"><div class="font-semibold mb-3">สถานะอุปกรณ์ (live)</div><div id="db-eq"></div></div>')}
        ${card('<div class="p-4"><div class="font-semibold mb-3">แจ้งเตือนอุปกรณ์</div><div id="db-alerts"></div></div>')}
      </div>
    </div>`;

  const load = async () => {
    const [appts, eq, alerts] = await Promise.all([
      session.can('appointments:read_all') ? api.get(`/appointments?from=${encodeURIComponent(bkkISO(today, '00:00'))}&to=${encodeURIComponent(bkkISO(today, '23:59'))}`) : [],
      session.can('equipment:read') ? api.get('/equipment') : { counts: {} },
      api.get('/reports/equipment-alerts').catch(() => []),
    ]);
    const active = appts.filter((a) => !['cancelled', 'no_show'].includes(a.status));
    $('#db-kpi').innerHTML = [
      ['นัดทั้งหมด', active.length], ['กำลังรักษา', appts.filter((a) => a.status === 'in_progress').length],
      ['เสร็จสิ้น', appts.filter((a) => a.status === 'completed').length], ['อุปกรณ์พร้อมใช้', eq.counts.available ?? '–'],
    ].map(([l, v]) => card(`<div class="p-4"><div class="text-xs text-slate-500">${l}</div><div class="text-3xl font-bold">${v}</div></div>`)).join('');
    $('#db-appts').innerHTML = active.length ? `<ul class="divide-y divide-slate-100 text-sm">${active.map((a) => `
      <li class="py-2 flex items-center gap-3">
        <span class="w-14 font-mono text-slate-500">${fmtTime(a.start_at)}</span>
        <span class="w-2 h-2 rounded-full" style="background:${esc(a.therapist_color)}"></span>
        <span class="flex-1 min-w-0 truncate"><b>${esc(a.patient_name)}</b> <span class="text-slate-500">· ${esc(a.therapist_name)} · ${esc(a.icd10_code || '')}</span></span>
        ${badge(APPT_STATUS, a.status)}
        ${session.can('emr:read') ? `<a class="text-brand-600 text-xs hover:underline" href="#/emr/${a.id}">EMR</a>` : ''}
      </li>`).join('')}</ul>` : empty('ไม่มีนัดหมายวันนี้');
    $('#db-eq').innerHTML = Object.keys(EQUIPMENT_STATUS).map((k) => `<div class="flex justify-between py-1 text-sm">${badge(EQUIPMENT_STATUS, k)}<b>${eq.counts[k] ?? 0}</b></div>`).join('');
    $('#db-alerts').innerHTML = alerts.length ? alerts.map((a) => `<div class="text-sm py-1"><b>${esc(a.asset_code)}</b> ${esc(a.name)} <span class="text-xs ${a.alert === 'broken' ? 'text-rose-600' : 'text-amber-600'}">${esc(a.alert)}${a.next_maintenance_due ? ` · ${fmtDate(a.next_maintenance_due)}` : ''}</span></div>`).join('') : empty('ไม่มี');
  };
  const onLive = () => load();
  window.addEventListener('equipment_status', onLive);
  window.addEventListener('appointment_changed', onLive);
  await load();
  return () => { window.removeEventListener('equipment_status', onLive); window.removeEventListener('appointment_changed', onLive); };
}
