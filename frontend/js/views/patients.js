import { api, hisLocked } from '../api.js';
import {
  $, $$, esc, pageHeader, card, btn, input, modal, toast, showError, fmtDate, empty, formModal, compact,
} from '../ui.js';

const GENDER_TH = { male: 'ชาย', female: 'หญิง', other: 'อื่น ๆ' };
const SEVERITY_CLS = { high: 'bg-rose-50 text-rose-700 ring-rose-200', moderate: 'bg-amber-50 text-amber-800 ring-amber-200', low: 'bg-slate-100 text-slate-600 ring-slate-200' };
const age = (dob) => (dob ? Math.floor((Date.now() - new Date(dob)) / (365.25 * 864e5)) : null);

export async function render(root, { session }) {
  const canWrite = session.can('patients:write');
  root.innerHTML = `
    ${pageHeader('ผู้ป่วย', 'ลงทะเบียน การวินิจฉัย และข้อควรระวัง — ข้อมูลนี้ใช้ในระบบแนะนำนักกายภาพ อุปกรณ์ และตรวจข้อห้ามใช้ตอนจองนัด',
      canWrite ? btn('+ ลงทะเบียนผู้ป่วย', 'id="pt-new"') : '')}
    <input id="pt-q" class="${input} max-w-md mb-4" placeholder="ค้นหา HN / ชื่อ / นามสกุล / เบอร์โทร">
    <div id="pt-list"></div>`;

  const load = async () => {
    const q = $('#pt-q').value.trim();
    const list = await api.get(`/patients${q ? `?q=${encodeURIComponent(q)}` : ''}`);
    $('#pt-list').innerHTML = list.length ? card(`<div class="overflow-x-auto"><table class="w-full text-sm">
      <thead class="text-left text-xs text-slate-500"><tr><th class="p-3">HN</th><th>ชื่อ</th><th>อายุ</th><th>โทร</th><th>การวินิจฉัย</th><th>ข้อควรระวัง</th></tr></thead>
      <tbody class="divide-y divide-slate-100">${list.map((p) => `
        <tr data-pt="${p.id}" class="cursor-pointer hover:bg-slate-50">
          <td class="p-3 font-mono">${esc(p.hn)}</td>
          <td>${esc(p.title || '')}${esc(p.first_name)} ${esc(p.last_name)}</td>
          <td>${age(p.date_of_birth) ?? '–'}</td>
          <td>${esc(p.phone || '–')}</td>
          <td>${(p.diagnoses || []).map((d) => `<span class="text-xs ${d.primary ? 'font-semibold' : ''}">${esc(d.code)}</span>`).join(', ') || '<span class="text-xs text-amber-600">ยังไม่ระบุ</span>'}</td>
          <td>${(p.precautions || []).map((c) => `<span class="text-[11px] rounded bg-rose-50 text-rose-700 px-1">${esc(c)}</span>`).join(' ')}</td>
        </tr>`).join('')}</tbody></table></div>`)
      : empty(q ? 'ไม่พบผู้ป่วยที่ค้นหา' : 'ยังไม่มีผู้ป่วย — กด "ลงทะเบียนผู้ป่วย" เพื่อเริ่ม');
    $$('[data-pt]').forEach((tr) => tr.addEventListener('click', () => openPatient(tr.dataset.pt, session, load)));
  };

  let t;
  $('#pt-q').addEventListener('input', () => { clearTimeout(t); t = setTimeout(load, 250); });
  $('#pt-new')?.addEventListener('click', () => openPatientForm(null, (id) => { load(); openPatient(id, session, load); }));
  await load();
}

/** ลงทะเบียน/แก้ไขข้อมูลผู้ป่วย */
async function openPatientForm(p, done) {
  const ec = p?.emergency_contact || {};
  formModal(p ? `แก้ไข ${p.first_name} ${p.last_name}` : 'ลงทะเบียนผู้ป่วย', [
    { name: 'hn', label: 'HN', required: true, value: p?.hn, hint: 'เลขประจำตัวผู้ป่วยของคลินิก (ไม่ซ้ำ)' },
    { name: 'title', label: 'คำนำหน้า', value: p?.title },
    { name: 'firstName', label: 'ชื่อ', required: true, value: p?.first_name },
    { name: 'lastName', label: 'นามสกุล', required: true, value: p?.last_name },
    { name: 'dateOfBirth', label: 'วันเกิด', type: 'date', value: p?.date_of_birth ? String(p.date_of_birth).slice(0, 10) : '' },
    { name: 'gender', label: 'เพศ', type: 'select', allowEmpty: true, value: p?.gender, options: Object.entries(GENDER_TH).map(([value, label]) => ({ value, label })) },
    { name: 'phone', label: 'โทรศัพท์', type: 'tel', value: p?.phone },
    { name: 'email', label: 'อีเมล', type: 'email', value: p?.email },
    { name: 'address', label: 'ที่อยู่', type: 'textarea', full: true, value: p?.address },
    { name: 'allergies', label: 'ประวัติแพ้ยา/แพ้อื่น ๆ', full: true, value: p?.allergies },
    { name: 'ecName', label: 'ผู้ติดต่อฉุกเฉิน', value: ec.name },
    { name: 'ecPhone', label: 'เบอร์ผู้ติดต่อฉุกเฉิน', type: 'tel', value: ec.phone },
  ], async (v, m) => {
    const { ecName, ecPhone, ...rest } = v;
    const body = { ...rest, emergencyContact: ecName && ecPhone ? { name: ecName, phone: ecPhone } : null };
    const saved = p ? await api.patch(`/patients/${p.id}`, body) : await api.post('/patients', compact(body));
    toast(p ? 'บันทึกแล้ว' : 'ลงทะเบียนแล้ว — เพิ่มการวินิจฉัยและข้อควรระวังต่อได้เลย', 'success');
    m.close();
    done(saved.id || p.id);
  }, { wide: true, submitLabel: p ? 'บันทึก' : 'ลงทะเบียน', locked: await hisLocked('patient', p) });
}

/** รายละเอียดผู้ป่วย: ข้อมูล, การวินิจฉัย (ICD-10), ข้อควรระวัง */
async function openPatient(id, session, reload) {
  const [p, dxList, pcTypes] = await Promise.all([
    api.get(`/patients/${id}`), api.get('/patients/diagnoses'), api.get('/patients/precaution-types'),
  ]);
  const canWrite = session.can('patients:write');
  const canPrecaution = canWrite || session.can('emr:write');
  const activeDx = p.diagnoses.filter((d) => d.status === 'active');
  const activePc = p.precautions.filter((c) => c.is_active);
  const m = modal(`${p.title || ''}${p.first_name} ${p.last_name}`, `
    <div class="grid lg:grid-cols-3 gap-5 text-sm">
      <section class="space-y-1">
        <div class="font-mono text-slate-500">HN ${esc(p.hn)}</div>
        <div>${p.date_of_birth ? `${fmtDate(p.date_of_birth)} (อายุ ${age(p.date_of_birth)} ปี)` : 'ไม่ระบุวันเกิด'} · ${esc(GENDER_TH[p.gender] || '–')}</div>
        <div>โทร ${esc(p.phone || '–')}${p.email ? ` · ${esc(p.email)}` : ''}</div>
        ${p.allergies ? `<div class="text-rose-700">แพ้: ${esc(p.allergies)}</div>` : ''}
        ${p.emergency_contact ? `<div class="text-slate-500">ติดต่อฉุกเฉิน: ${esc(p.emergency_contact.name)} ${esc(p.emergency_contact.phone)}</div>` : ''}
        <div class="flex flex-wrap gap-2 pt-2">
          ${canWrite ? btn('แก้ไขข้อมูล', 'id="pd-edit"', 'ghost') : ''}
          ${session.can('emr:read') ? `<a href="#/progress/${p.id}" class="inline-flex items-center rounded-lg px-3 py-1.5 text-sm font-medium ring-1 ring-inset ring-slate-300 hover:bg-slate-50">📈 ความก้าวหน้า</a>` : ''}
          ${session.can('appointments:write') ? '<a href="#/schedule" class="inline-flex items-center rounded-lg px-3 py-1.5 text-sm font-medium ring-1 ring-inset ring-slate-300 hover:bg-slate-50">🗓️ ไปจองนัด</a>' : ''}
        </div>
      </section>

      <section>
        <h3 class="font-semibold mb-2">การวินิจฉัย</h3>
        <ul class="space-y-1 mb-3">${p.diagnoses.map((d) => `
          <li class="flex items-start justify-between gap-2 ${d.status === 'resolved' ? 'text-slate-400 line-through' : ''}">
            <span><span class="font-mono">${esc(d.icd10_code)}</span> ${esc(d.name_th)}${d.is_primary ? ' <span class="text-[11px] rounded bg-brand-50 text-brand-700 px-1">หลัก</span>' : ''}</span>
            ${canWrite && d.status === 'active' ? `<button type="button" data-resolve="${d.id}" class="text-xs text-slate-500 hover:text-brand-700 shrink-0">หายแล้ว</button>` : ''}
          </li>`).join('') || '<li class="text-amber-700">ยังไม่มี — ระบบแนะนำต้องใช้การวินิจฉัยอย่างน้อย 1 รายการ</li>'}</ul>
        ${canWrite ? `
        <form id="dx-add" class="space-y-2 rounded-lg bg-slate-50 p-3">
          <select name="diagnosisId" class="${input}" required>${dxList.map((d) => `<option value="${d.id}">${esc(d.icd10_code)} ${esc(d.name_th)}</option>`).join('')}</select>
          <div class="grid grid-cols-2 gap-2">
            <input name="onsetDate" type="date" class="${input}" title="วันที่เริ่มมีอาการ">
            <input name="referredBy" class="${input}" placeholder="แพทย์ผู้ส่งต่อ">
          </div>
          <label class="flex items-center gap-2"><input name="isPrimary" type="checkbox" ${activeDx.length ? '' : 'checked'}> การวินิจฉัยหลัก</label>
          ${btn('+ เพิ่มการวินิจฉัย', 'type="submit"')}
        </form>` : ''}
      </section>

      <section>
        <h3 class="font-semibold mb-2">ข้อควรระวัง / ข้อห้าม</h3>
        <ul class="space-y-1 mb-3">${activePc.map((c) => `
          <li class="flex items-start justify-between gap-2">
            <span><span class="text-[11px] rounded px-1 ring-1 ring-inset ${SEVERITY_CLS[c.severity] || SEVERITY_CLS.low}">${esc(c.name_th)}</span>${c.detail ? ` <span class="text-slate-500">${esc(c.detail)}</span>` : ''}</span>
            ${canPrecaution ? `<button type="button" data-unpc="${c.id}" class="text-xs text-slate-500 hover:text-rose-700 shrink-0">นำออก</button>` : ''}
          </li>`).join('') || '<li class="text-slate-400">ไม่มี</li>'}</ul>
        ${canPrecaution ? `
        <form id="pc-add" class="space-y-2 rounded-lg bg-slate-50 p-3">
          <select name="code" class="${input}" required>${pcTypes.map((c) => `<option value="${esc(c.code)}">${esc(c.name_th)}</option>`).join('')}</select>
          <input name="detail" class="${input}" placeholder="รายละเอียด เช่น ใส่ pacemaker ปี 2024">
          ${btn('+ เพิ่มข้อควรระวัง', 'type="submit"')}
          <p class="text-[11px] text-slate-500">ระบบใช้ข้อมูลนี้ห้ามจองอุปกรณ์ที่ไม่ปลอดภัยกับผู้ป่วยโดยอัตโนมัติ</p>
        </form>` : ''}
      </section>
    </div>`, { wide: true });

  const refresh = () => { m.close(); reload(); openPatient(id, session, reload); };
  $('#pd-edit', m.el)?.addEventListener('click', () => { m.close(); openPatientForm(p, () => { reload(); openPatient(id, session, reload); }); });
  $('#dx-add', m.el)?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      await api.post(`/patients/${id}/diagnoses`, compact({
        diagnosisId: Number(f.get('diagnosisId')), isPrimary: f.get('isPrimary') === 'on',
        onsetDate: f.get('onsetDate') || null, referredBy: f.get('referredBy') || null,
      }));
      toast('เพิ่มการวินิจฉัยแล้ว', 'success');
      refresh();
    } catch (err) { showError(err); }
  });
  $$('[data-resolve]', m.el).forEach((b) => b.addEventListener('click', async () => {
    try { await api.patch(`/patients/${id}/diagnoses/${b.dataset.resolve}`, { status: 'resolved' }); refresh(); } catch (err) { showError(err); }
  }));
  $('#pc-add', m.el)?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      await api.post(`/patients/${id}/precautions`, compact({ code: f.get('code'), detail: f.get('detail') || null }));
      toast('เพิ่มข้อควรระวังแล้ว', 'success');
      refresh();
    } catch (err) { showError(err); }
  });
  $$('[data-unpc]', m.el).forEach((b) => b.addEventListener('click', async () => {
    try { await api.del(`/patients/${id}/precautions/${b.dataset.unpc}`); refresh(); } catch (err) { showError(err); }
  }));
}
