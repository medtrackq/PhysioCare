import { api } from '../api.js';
import { $, $$, esc, pageHeader, card, btn, input, modal, toast, showError, fmtDateTime, bkkToday, empty } from '../ui.js';

const ROLE_TH = { admin: 'ผู้ดูแลระบบ', therapist: 'นักกายภาพ', staff: 'เจ้าหน้าที่', patient: 'ผู้ป่วย' };

export async function render(root, ctx) {
  return ctx.route === 'reports' ? renderReports(root) : renderAdmin(root, ctx);
}

async function renderAdmin(root, { session }) {
  const [users, roles, settings] = await Promise.all([
    session.can('users:manage') ? api.get('/users') : [],
    session.can('users:manage') ? api.get('/users/roles') : [],
    api.get('/settings'),
  ]);
  const allPerms = [...new Set(roles.flatMap((r) => r.permissions.filter(Boolean)))].sort();
  root.innerHTML = `
    ${pageHeader('ผู้ใช้ & ตั้งค่าระบบ', '', session.can('users:manage') ? btn('+ เพิ่มผู้ใช้', 'id="u-new"') : '')}
    <div class="space-y-6">
      ${card(`<div class="p-4 overflow-x-auto"><h2 class="font-semibold mb-3">บัญชีผู้ใช้</h2>
        <table class="w-full text-sm"><thead class="text-left text-xs text-slate-500"><tr><th class="py-1">ชื่อ</th><th>อีเมล</th><th>บทบาท</th><th>เข้าระบบล่าสุด</th><th>สถานะ</th><th></th></tr></thead>
        <tbody class="divide-y divide-slate-100">${users.map((u) => `<tr>
          <td class="py-2">${esc(u.display_name)}</td><td>${esc(u.email)}</td><td>${esc(ROLE_TH[u.role])}</td>
          <td>${fmtDateTime(u.last_login_at)}</td>
          <td>${u.is_active ? '<span class="text-emerald-600">ใช้งาน</span>' : '<span class="text-slate-400">ปิด</span>'}${u.locked_until && new Date(u.locked_until) > new Date() ? ' <span class="text-rose-600">🔒</span>' : ''}</td>
          <td class="text-right">${btn(u.is_active ? 'ปิดบัญชี' : 'เปิดบัญชี', `data-toggle="${u.id}" data-active="${u.is_active}"`, 'ghost')}</td>
        </tr>`).join('')}</tbody></table></div>`)}

      ${roles.length ? card(`<div class="p-4 overflow-x-auto"><h2 class="font-semibold mb-3">สิทธิ์ตามบทบาท (RBAC Matrix)</h2>
        <table class="text-xs"><thead><tr><th class="text-left p-1">Permission</th>${roles.map((r) => `<th class="p-1">${esc(r.name_th)}</th>`).join('')}</tr></thead>
        <tbody>${allPerms.map((p) => `<tr class="border-t border-slate-100"><td class="p-1 font-mono">${esc(p)}</td>${roles.map((r) => `<td class="text-center">${r.permissions.includes(p) ? '✅' : ''}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`) : ''}

      ${card(`<div class="p-4"><h2 class="font-semibold mb-3">ตั้งค่าระบบ</h2>
        <div class="space-y-3">${settings.map((s) => `
          <div class="grid md:grid-cols-3 gap-2 items-center">
            <div><div class="font-mono text-sm">${esc(s.key)}</div><div class="text-xs text-slate-500">${esc(s.description || '')}</div></div>
            <input data-setting="${esc(s.key)}" class="${input} font-mono md:col-span-1" value="${esc(JSON.stringify(s.value))}" ${session.can('settings:manage') ? '' : 'disabled'}>
            <div>${session.can('settings:manage') ? btn('บันทึก', `data-save-setting="${esc(s.key)}"`, 'ghost') : ''}</div>
          </div>`).join('')}</div></div>`)}
    </div>`;

  $$('[data-save-setting]').forEach((b) => b.addEventListener('click', async () => {
    const key = b.dataset.saveSetting;
    let value;
    try { value = JSON.parse($(`[data-setting="${CSS.escape(key)}"]`).value); } catch { toast('รูปแบบ JSON ไม่ถูกต้อง', 'error'); return; }
    try { await api.put(`/settings/${encodeURIComponent(key)}`, { value }); toast('บันทึกแล้ว', 'success'); } catch (e) { showError(e); }
  }));
  $$('[data-toggle]').forEach((b) => b.addEventListener('click', async () => {
    try { await api.patch(`/users/${b.dataset.toggle}`, { isActive: b.dataset.active !== 'true' }); renderAdmin(root, { session }); } catch (e) { showError(e); }
  }));
  $('#u-new')?.addEventListener('click', async () => {
    const [staff, patients] = await Promise.all([api.get('/staff'), api.get('/patients')]);
    const m = modal('เพิ่มผู้ใช้', `
      <form class="space-y-3 text-sm">
        <label class="block">ชื่อที่แสดง<input name="displayName" required class="${input}"></label>
        <label class="block">อีเมล<input name="email" type="email" required class="${input}"></label>
        <label class="block">รหัสผ่าน (≥8 ตัว มีตัวใหญ่และตัวเลข)<input name="password" type="password" required minlength="8" class="${input}"></label>
        <label class="block">บทบาท<select name="role" class="${input}">${Object.entries(ROLE_TH).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></label>
        <label class="block" data-for="staff">ผูกกับบุคลากร<select name="staffId" class="${input}"><option value="">–</option>${staff.map((s) => `<option value="${s.id}">${esc(s.employee_code)} ${esc(s.first_name)}</option>`).join('')}</select></label>
        <label class="block" data-for="patient">ผูกกับผู้ป่วย<select name="patientId" class="${input}"><option value="">–</option>${patients.map((p) => `<option value="${p.id}">${esc(p.hn)} ${esc(p.first_name)}</option>`).join('')}</select></label>
        ${btn('สร้างบัญชี', 'type="submit"')}
      </form>`);
    $('form', m.el).addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(e.target));
      try {
        await api.post('/users', { ...f, staffId: f.staffId || null, patientId: f.patientId || null });
        toast('สร้างผู้ใช้แล้ว', 'success');
        m.close();
        renderAdmin(root, { session });
      } catch (err) {
        toast(err.details?.map?.((d) => `${d.path}: ${d.message}`).join(', ') || err.message, 'error');
      }
    });
  });
}

let chart;
async function renderReports(root) {
  const to = bkkToday();
  const from = bkkToday(-30);
  root.innerHTML = `${pageHeader('รายงานสถิติ', '', `<input id="r-from" type="date" class="${input}" value="${from}"><input id="r-to" type="date" class="${input}" value="${to}">`)}<div id="r-body"></div>`;
  const load = async () => {
    const r = await api.get(`/reports/summary?from=${$('#r-from').value}&to=${$('#r-to').value}`);
    const table = (rows, cols) => (rows.length ? `<table class="w-full text-sm"><thead class="text-left text-xs text-slate-500"><tr>${cols.map(([, l]) => `<th class="py-1">${l}</th>`).join('')}</tr></thead>
      <tbody class="divide-y divide-slate-100">${rows.map((x) => `<tr>${cols.map(([k]) => `<td class="py-1.5">${esc(x[k] ?? '–')}</td>`).join('')}</tr>`).join('')}</tbody></table>` : empty('ไม่มีข้อมูล'));
    $('#r-body').innerHTML = `
      <div class="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
        ${[['นัดทั้งหมด', r.appointments.total], ['เสร็จสิ้น', r.appointments.byStatus.completed || 0], ['ยกเลิก', r.appointments.byStatus.cancelled || 0], ['No-show rate', `${r.appointments.noShowRatePct}%`]]
          .map(([l, v]) => card(`<div class="p-4"><div class="text-xs text-slate-500">${l}</div><div class="text-3xl font-bold">${v}</div></div>`)).join('')}
      </div>
      <div class="grid xl:grid-cols-2 gap-5">
        ${card('<div class="p-4"><h3 class="font-semibold mb-2">จำนวนนัดรายวัน</h3><canvas id="r-daily" height="160"></canvas></div>')}
        ${card(`<div class="p-4"><h3 class="font-semibold mb-2">อัตราการใช้งานนักกายภาพ</h3>${table(r.therapistUtilization, [['name', 'ชื่อ'], ['visits', 'Visits'], ['booked_hours', 'ชม.นัด'], ['shift_hours', 'ชม.กะ'], ['utilization_pct', '%']])}</div>`)}
        ${card(`<div class="p-4"><h3 class="font-semibold mb-2">การใช้งานอุปกรณ์ตามหมวด</h3>${table(r.equipmentUtilization, [['category', 'หมวด'], ['units', 'เครื่อง'], ['booked_hours', 'ชม.ที่จอง']])}</div>`)}
        ${card(`<div class="p-4"><h3 class="font-semibold mb-2">ผลลัพธ์ทางคลินิก</h3>${table(r.clinicalOutcomes, [['icd10_code', 'ICD-10'], ['name_th', 'โรค'], ['sessions', 'ครั้ง'], ['avg_pain_reduction', 'Pain ลดเฉลี่ย'], ['improved_pct', '% ดีขึ้น']])}</div>`)}
        ${card(`<div class="p-4"><h3 class="font-semibold mb-2">การใช้ห้อง/เตียง</h3>${table(r.roomUtilization || [], [['name', 'ห้อง'], ['beds', 'เตียง'], ['capacity', 'ความจุ'], ['visits', 'Visits'], ['booked_hours', 'ชม.ที่ใช้']])}</div>`)}
        ${card(`<div class="p-4"><h3 class="font-semibold mb-2">งานบำรุงรักษา</h3>${table(r.maintenance, [['type', 'ประเภท'], ['n', 'จำนวน'], ['cost', 'ค่าใช้จ่าย'], ['avg_turnaround_hours', 'ชม.เฉลี่ย']])}</div>`)}
      </div>`;
    chart?.destroy();
    if (window.Chart) {
      chart = new window.Chart($('#r-daily'), {
        type: 'bar',
        data: {
          labels: r.daily.map((d) => d.day.slice(5, 10)),
          datasets: [
            { label: 'เสร็จสิ้น', data: r.daily.map((d) => d.completed), backgroundColor: '#1d8fe0' },
            { label: 'No-show', data: r.daily.map((d) => d.no_show), backgroundColor: '#f59e0b' },
            { label: 'อื่น ๆ', data: r.daily.map((d) => d.total - d.completed - d.no_show), backgroundColor: '#cbd5e1' },
          ],
        },
        options: { scales: { x: { stacked: true }, y: { stacked: true, beginAtZero: true } }, plugins: { legend: { position: 'bottom' } } },
      });
    }
  };
  $('#r-from').addEventListener('change', load);
  $('#r-to').addEventListener('change', load);
  await load();
  return () => chart?.destroy();
}
