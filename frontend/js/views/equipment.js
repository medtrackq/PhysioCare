import { api } from '../api.js';
import {
  $, $$, esc, badge, EQUIPMENT_STATUS, pageHeader, btn, input, modal, toast, showError,
  fmtDate, fmtDateTime, fmtMoney, imgOrIcon, empty,
} from '../ui.js';

let state = { status: '', categoryId: '', q: '' };

export async function render(root, { session }) {
  const cats = await api.get('/equipment/categories');
  root.innerHTML = `
    ${pageHeader('ทะเบียนอุปกรณ์', 'สถานะอัปเดตแบบ Real-time ผ่าน Server-Sent Events')}
    <div id="eq-counts" class="grid grid-cols-2 sm:grid-cols-5 gap-3 mb-5"></div>
    <div class="flex flex-wrap gap-2 mb-5">
      <input id="eq-q" placeholder="ค้นหาชื่อ / รหัสครุภัณฑ์" class="${input} max-w-xs" value="${esc(state.q)}">
      <select id="eq-cat" class="${input} max-w-xs">
        <option value="">ทุกหมวดหมู่</option>
        ${cats.map((c) => `<option value="${c.id}" ${String(c.id) === state.categoryId ? 'selected' : ''}>${esc(c.name_th)} (${c.available}/${c.total})</option>`).join('')}
      </select>
    </div>
    <div id="eq-grid" class="grid gap-4 sm:grid-cols-2 xl:grid-cols-4"></div>`;

  const load = async () => {
    const qs = new URLSearchParams(Object.entries(state).filter(([, v]) => v)).toString();
    const data = await api.get(`/equipment?${qs}`);
    renderCounts(data.counts);
    $('#eq-grid').innerHTML = data.items.length ? data.items.map(cardHtml).join('') : empty('ไม่พบอุปกรณ์');
  };

  const renderCounts = (counts) => {
    $('#eq-counts').innerHTML = Object.entries(EQUIPMENT_STATUS).map(([k, s]) => `
      <button data-status="${k}" class="text-left bg-white rounded-xl border ${state.status === k ? 'border-brand-500 ring-2 ring-brand-100' : 'border-slate-200'} p-3">
        <div class="flex items-center gap-2 text-xs text-slate-500"><span class="w-2 h-2 rounded-full ${s.dot}"></span>${s.th}</div>
        <div class="text-2xl font-bold mt-1" data-count="${k}">${counts[k] ?? 0}</div>
      </button>`).join('');
  };

  root.addEventListener('click', (e) => {
    const st = e.target.closest('[data-status]');
    if (st) { state.status = state.status === st.dataset.status ? '' : st.dataset.status; load(); return; }
    const c = e.target.closest('[data-eq]');
    if (c) openDetail(c.dataset.eq, session, load);
  });
  $('#eq-cat').addEventListener('change', (e) => { state.categoryId = e.target.value; load(); });
  let t;
  $('#eq-q').addEventListener('input', (e) => { clearTimeout(t); t = setTimeout(() => { state.q = e.target.value.trim(); load(); }, 250); });

  // Real-time: อัปเดตเฉพาะการ์ดที่เปลี่ยน + กระพริบ
  const onLive = (e) => {
    const d = e.detail;
    const el = $(`[data-eq="${d.id}"]`);
    if (el) {
      $('[data-badge]', el).innerHTML = badge(EQUIPMENT_STATUS, d.to);
      el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
    }
    const from = $(`[data-count="${d.from}"]`);
    const to = $(`[data-count="${d.to}"]`);
    if (from) from.textContent = Math.max(0, Number(from.textContent) - 1);
    if (to) to.textContent = Number(to.textContent) + 1;
  };
  window.addEventListener('equipment_status', onLive);
  await load();
  return () => window.removeEventListener('equipment_status', onLive);
}

function cardHtml(e) {
  const due = e.next_maintenance_due ? `<span class="${e.maintenance_due_soon ? 'text-amber-600 font-medium' : ''}">PM: ${fmtDate(e.next_maintenance_due)}</span>` : '';
  return `
    <button data-eq="${e.id}" class="text-left bg-white rounded-xl border border-slate-200 overflow-hidden hover:shadow-md transition">
      ${imgOrIcon(e.primary_image_id ? `/api/media/${e.primary_image_id}` : null)}
      <div class="p-3 space-y-1.5">
        <div class="flex items-start justify-between gap-2">
          <div class="font-semibold leading-tight">${esc(e.name)}</div>
          <div data-badge class="shrink-0">${badge(EQUIPMENT_STATUS, e.status)}</div>
        </div>
        <div class="text-xs text-slate-500">${esc(e.asset_code)} · ${esc(e.category_name)}</div>
        <div class="flex justify-between text-xs text-slate-500"><span>📍 ${esc(e.location || '–')}</span>${due}</div>
      </div>
    </button>`;
}

async function openDetail(id, session, reload) {
  const [e, rooms] = await Promise.all([api.get(`/equipment/${id}`), api.get('/facilities/rooms').catch(() => [])]);
  const canStatus = session.can('equipment:status');
  const canMaint = session.can('maintenance:write');
  const canUpload = session.can('media:upload') && (session.can('equipment:write') || canStatus);
  const m = modal(`${e.name} (${e.asset_code})`, `
    <div class="grid lg:grid-cols-5 gap-6">
      <div class="lg:col-span-2 space-y-3">
        <div class="grid grid-cols-3 gap-2" id="gallery">
          ${e.images.length ? e.images.map((im) => `<a href="${im.url}" target="_blank" class="block rounded-lg overflow-hidden border ${im.is_primary ? 'border-brand-500' : 'border-slate-200'}"><img src="${im.url}" alt="" class="w-full h-24 object-cover"></a>`).join('') : '<div class="col-span-3 text-xs text-slate-400">ยังไม่มีรูปภาพ</div>'}
        </div>
        ${canUpload ? `<label class="block text-xs text-slate-600">อัปโหลดรูป (JPEG/PNG/WebP ≤ 5MB)
          <input id="eq-upload" type="file" accept="image/jpeg,image/png,image/webp" multiple class="mt-1 block w-full text-xs"></label>` : ''}
        <dl class="grid grid-cols-2 gap-x-3 gap-y-2 text-sm">
          ${[
            ['สถานะ', badge(EQUIPMENT_STATUS, e.status)], ['หมวดหมู่', esc(e.category_name)],
            ['ยี่ห้อ/รุ่น', esc(`${e.brand || ''} ${e.model || ''}`)], ['Serial', esc(e.serial_no || '–')],
            ['วันที่ซื้อ', fmtDate(e.purchase_date)], ['ราคา', fmtMoney(e.purchase_price)],
            ['หมดประกัน', fmtDate(e.warranty_expiry)], ['ที่ตั้ง', esc(e.location || '–')],
            ['ห้องที่ติดตั้ง', e.room_name ? esc(e.room_name) : 'เคลื่อนย้ายได้'],
            ['ใช้พื้นที่', { bed: 'บนเตียง', gym: 'ห้องออกกำลังกาย', none: 'ไม่ระบุ' }[e.space_type] || '–'],
            ['บำรุงรักษาล่าสุด', fmtDate(e.last_maintenance_at)], ['ครบกำหนด PM', fmtDate(e.next_maintenance_due)],
            ['ค่าซ่อมสะสม', fmtMoney(e.maintenanceCostTotal)], ['Buffer ทำความสะอาด', `${e.cleaning_buffer_minutes} นาที`],
          ].map(([k, v]) => `<dt class="text-slate-500">${k}</dt><dd>${v}</dd>`).join('')}
        </dl>
        ${session.can('equipment:write') ? `
        <div class="rounded-lg bg-slate-50 p-3 space-y-2">
          <div class="text-sm font-medium">ห้องที่ติดตั้ง</div>
          <div class="flex gap-2"><select id="eq-room" class="${input}"><option value="">เคลื่อนย้ายได้ (ไม่ผูกห้อง)</option>
            ${rooms.map((r) => `<option value="${r.id}" ${r.id === e.room_id ? 'selected' : ''}>${esc(r.code)} ${esc(r.name)}</option>`).join('')}</select>
            ${btn('บันทึก', 'id="eq-room-save"', 'ghost')}</div>
          <p class="text-[11px] text-slate-500">อุปกรณ์ที่ผูกห้องจะจองได้เฉพาะนัดที่อยู่ในห้องนั้น</p>
        </div>` : ''}
        ${canStatus ? `
        <div class="rounded-lg bg-slate-50 p-3 space-y-2">
          <div class="text-sm font-medium">เปลี่ยนสถานะ</div>
          <div class="flex gap-2">
            <select id="st-new" class="${input}">${['available', 'maintenance', 'broken', 'retired'].map((s) => `<option value="${s}">${EQUIPMENT_STATUS[s].th}</option>`).join('')}</select>
            ${btn('บันทึก', 'id="st-save"')}
          </div>
          <input id="st-reason" class="${input}" placeholder="เหตุผล / อาการเสีย">
          <div id="st-result"></div>
        </div>` : ''}
      </div>
      <div class="lg:col-span-3 space-y-5">
        <section>
          <h3 class="font-semibold mb-2">การจองที่กำลังจะถึง</h3>
          ${e.upcomingBookings.length ? `<ul class="text-sm divide-y divide-slate-100">${e.upcomingBookings.map((a) => `<li class="py-1.5 flex justify-between"><span>${fmtDateTime(a.start_at)} · ${esc(a.patient_name)}</span><span class="text-slate-500">${esc(a.therapist)}</span></li>`).join('')}</ul>` : '<p class="text-sm text-slate-400">ไม่มี</p>'}
        </section>
        <section>
          <div class="flex items-center justify-between mb-2"><h3 class="font-semibold">ประวัติการบำรุงรักษา</h3>${canMaint ? btn('+ เพิ่มรายการ', 'id="mt-add"', 'ghost') : ''}</div>
          <div id="mt-form"></div>
          <div class="overflow-x-auto"><table class="w-full text-sm">
            <thead class="text-left text-xs text-slate-500"><tr><th class="py-1">วันที่แจ้ง</th><th>ประเภท</th><th>ปัญหา/การดำเนินการ</th><th>สถานะ</th><th class="text-right">ค่าใช้จ่าย</th><th></th></tr></thead>
            <tbody class="divide-y divide-slate-100">
            ${e.maintenance.map((x) => `<tr>
              <td class="py-1.5 whitespace-nowrap">${fmtDate(x.reported_at)}</td><td>${esc(x.type)}</td>
              <td>${esc(x.problem || '')}${x.action_taken ? `<div class="text-xs text-slate-500">→ ${esc(x.action_taken)}</div>` : ''}</td>
              <td>${esc(x.status)}${x.result ? ` <span class="text-xs text-slate-500">(${esc(x.result)})</span>` : ''}</td>
              <td class="text-right">${fmtMoney(x.cost)}</td>
              <td class="text-right">${canMaint && !['completed', 'cancelled'].includes(x.status) ? btn('ปิดงาน', `data-close-mt="${x.id}"`, 'ghost') : ''}</td>
            </tr>`).join('') || '<tr><td colspan="6" class="py-3 text-slate-400">ยังไม่มีประวัติ</td></tr>'}
            </tbody></table></div>
        </section>
        <section>
          <h3 class="font-semibold mb-2">Timeline สถานะ</h3>
          <ol class="text-sm space-y-1 max-h-48 overflow-y-auto">
            ${e.statusLogs.map((l) => `<li class="flex gap-2"><span class="text-slate-400 w-32 shrink-0">${fmtDateTime(l.changed_at)}</span>${badge(EQUIPMENT_STATUS, l.to_status)}<span class="text-slate-500 truncate">${esc(l.reason || '')} ${l.changed_by_name ? `· ${esc(l.changed_by_name)}` : ''}</span></li>`).join('') || '<li class="text-slate-400">–</li>'}
          </ol>
        </section>
      </div>
    </div>`, { wide: true });

  const refresh = () => { m.close(); reload(); openDetail(id, session, reload); };

  $('#eq-upload', m.el)?.addEventListener('change', async (ev) => {
    const fd = new FormData();
    [...ev.target.files].forEach((f) => fd.append('images', f));
    try { await api.upload(`/media/equipment/${id}`, fd); toast('อัปโหลดสำเร็จ', 'success'); refresh(); } catch (err) { showError(err); }
  });

  $('#eq-room-save', m.el)?.addEventListener('click', async () => {
    try { await api.patch(`/equipment/${id}`, { roomId: $('#eq-room', m.el).value || null }); toast('บันทึกห้องแล้ว', 'success'); refresh(); } catch (err) { showError(err); }
  });

  $('#st-save', m.el)?.addEventListener('click', async () => {
    try {
      const r = await api.patch(`/equipment/${id}/status`, { status: $('#st-new', m.el).value, reason: $('#st-reason', m.el).value || undefined });
      toast('เปลี่ยนสถานะแล้ว', 'success');
      reload();
      // แสดงนัดที่ได้รับผลกระทบ + เครื่องทดแทน
      $('#st-result', m.el).innerHTML = r.affectedAppointments.length ? `
        <div class="mt-2 text-sm rounded-lg bg-amber-50 ring-1 ring-amber-200 p-2">
          <div class="font-medium text-amber-800">นัดที่ได้รับผลกระทบ ${r.affectedAppointments.length} รายการ</div>
          <ul class="mt-1 space-y-1">${r.affectedAppointments.map((a) => `<li>${fmtDateTime(a.start_at)} ${esc(a.patient_name)} →
            ${a.substitutes.length ? `ใช้แทนได้: ${a.substitutes.map((s) => esc(s.asset_code)).join(', ')}` : '<span class="text-rose-600">ไม่มีเครื่องทดแทน ต้องเลื่อนนัด</span>'}</li>`).join('')}</ul>
        </div>` : '';
    } catch (err) { showError(err); }
  });

  $('#mt-add', m.el)?.addEventListener('click', () => {
    $('#mt-form', m.el).innerHTML = `
      <form class="grid sm:grid-cols-2 gap-2 mb-3 p-3 rounded-lg bg-slate-50">
        <select name="type" class="${input}"><option value="preventive">Preventive (PM)</option><option value="corrective">Corrective (ซ่อม)</option><option value="calibration">Calibration</option><option value="inspection">Inspection</option></select>
        <select name="status" class="${input}"><option value="scheduled">นัดหมายไว้</option><option value="in_progress">เริ่มดำเนินการ (ปิดเครื่อง)</option></select>
        <label class="text-xs">ปิดเครื่องตั้งแต่<input name="plannedStart" type="datetime-local" class="${input}"></label>
        <label class="text-xs">ถึง<input name="plannedEnd" type="datetime-local" class="${input}"></label>
        <input name="problem" class="${input} sm:col-span-2" placeholder="รายละเอียด / อาการ">
        <input name="vendor" class="${input}" placeholder="ผู้ให้บริการ">
        <input name="cost" type="number" min="0" class="${input}" placeholder="ค่าใช้จ่าย (บาท)">
        <div class="sm:col-span-2">${btn('บันทึก', 'type="submit"')}</div>
      </form>`;
    $('#mt-form form', m.el).addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const f = Object.fromEntries(new FormData(ev.target));
      const toIso = (v) => (v ? `${v}:00+07:00` : undefined);
      try {
        await api.post(`/equipment/${id}/maintenance`, {
          type: f.type, status: f.status, problem: f.problem || undefined, vendor: f.vendor || undefined,
          cost: f.cost ? Number(f.cost) : undefined, plannedStart: toIso(f.plannedStart), plannedEnd: toIso(f.plannedEnd),
        });
        toast('บันทึกแล้ว', 'success');
        refresh();
      } catch (err) { showError(err); }
    });
  });

  $$('[data-close-mt]', m.el).forEach((b) => b.addEventListener('click', async () => {
    const result = prompt('ผลการดำเนินการ: pass / fail / repaired / replaced_part', 'repaired');
    if (!result) return;
    const action = prompt('การดำเนินการที่ทำ', '') || undefined;
    try {
      await api.patch(`/equipment/maintenance/${b.dataset.closeMt}`, { status: 'completed', result, actionTaken: action });
      toast('ปิดงานซ่อมแล้ว', 'success');
      refresh();
    } catch (err) { showError(err); }
  }));
}
