// ---------- Utilities ----------
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (v) => (v == null ? '' : String(v).replace(/[&<>"']/g, (c) => ESC[c]));
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const TZ = 'Asia/Bangkok';
export const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('th-TH', { timeZone: TZ, day: 'numeric', month: 'short', year: '2-digit' }) : '–');
export const fmtTime = (d) => (d ? new Date(d).toLocaleTimeString('th-TH', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }) : '–');
export const fmtDateTime = (d) => (d ? `${fmtDate(d)} ${fmtTime(d)}` : '–');
export const fmtMoney = (n) => (n == null ? '–' : Number(n).toLocaleString('th-TH', { style: 'currency', currency: 'THB', maximumFractionDigits: 0 }));
/** วันที่ปัจจุบัน (YYYY-MM-DD) ตามเวลาไทย */
export const bkkToday = (offsetDays = 0) => new Date(Date.now() + 7 * 3600e3 + offsetDays * 864e5).toISOString().slice(0, 10);
export const bkkISO = (date, hhmm) => `${date}T${hhmm}:00+07:00`;

// ---------- Status badges ----------
export const EQUIPMENT_STATUS = {
  available: { th: 'พร้อมใช้งาน', cls: 'bg-emerald-50 text-emerald-700 ring-emerald-200', dot: 'bg-emerald-500' },
  in_use: { th: 'กำลังใช้งาน', cls: 'bg-sky-50 text-sky-700 ring-sky-200', dot: 'bg-sky-500' },
  maintenance: { th: 'ส่งซ่อม/บำรุงรักษา', cls: 'bg-amber-50 text-amber-700 ring-amber-200', dot: 'bg-amber-500' },
  broken: { th: 'ชำรุด', cls: 'bg-rose-50 text-rose-700 ring-rose-200', dot: 'bg-rose-500' },
  retired: { th: 'จำหน่ายแล้ว', cls: 'bg-slate-100 text-slate-500 ring-slate-200', dot: 'bg-slate-400' },
};
export const APPT_STATUS = {
  booked: { th: 'จองแล้ว', cls: 'bg-slate-100 text-slate-700 ring-slate-200' },
  confirmed: { th: 'ยืนยันแล้ว', cls: 'bg-indigo-50 text-indigo-700 ring-indigo-200' },
  checked_in: { th: 'มาถึงแล้ว', cls: 'bg-violet-50 text-violet-700 ring-violet-200' },
  in_progress: { th: 'กำลังรักษา', cls: 'bg-sky-50 text-sky-700 ring-sky-200' },
  completed: { th: 'เสร็จสิ้น', cls: 'bg-emerald-50 text-emerald-700 ring-emerald-200' },
  cancelled: { th: 'ยกเลิก', cls: 'bg-rose-50 text-rose-600 ring-rose-200' },
  no_show: { th: 'ไม่มาตามนัด', cls: 'bg-orange-50 text-orange-700 ring-orange-200' },
};
export const badge = (map, key) => {
  const s = map[key] || { th: key, cls: 'bg-slate-100 text-slate-600 ring-slate-200' };
  return `<span class="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${s.cls}">${s.dot ? `<span class="w-1.5 h-1.5 rounded-full ${s.dot}"></span>` : ''}${esc(s.th)}</span>`;
};

export const painColor = (n) => (n == null ? '#94a3b8' : n <= 3 ? '#16a34a' : n <= 6 ? '#d97706' : '#dc2626');

// ---------- Components ----------
export const card = (inner, cls = '') => `<div class="bg-white rounded-xl border border-slate-200 ${cls}">${inner}</div>`;
export const btn = (label, attrs = '', variant = 'primary') => {
  const v = {
    primary: 'bg-brand-600 hover:bg-brand-700 text-white',
    ghost: 'bg-white hover:bg-slate-50 text-slate-700 ring-1 ring-inset ring-slate-300',
    danger: 'bg-rose-600 hover:bg-rose-700 text-white',
  }[variant];
  // ใส่ type="button" เฉพาะเมื่อผู้เรียกไม่ได้กำหนด type เอง (เช่น type="submit") — attribute ซ้ำ เบราว์เซอร์ใช้ตัวแรก
  const type = /\btype\s*=/.test(attrs) ? '' : 'type="button" ';
  return `<button ${type}class="inline-flex items-center justify-center gap-1 rounded-lg px-3 py-1.5 text-sm font-medium disabled:opacity-50 ${v}" ${attrs}>${label}</button>`;
};
export const input = 'w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500';
export const pageHeader = (title, sub = '', actions = '') => `
  <div class="flex flex-wrap items-end justify-between gap-3 mb-6">
    <div><h1 class="text-xl font-bold">${esc(title)}</h1>${sub ? `<p class="text-sm text-slate-500">${sub}</p>` : ''}</div>
    <div class="flex gap-2">${actions}</div>
  </div>`;
export const empty = (msg) => `<div class="text-center text-sm text-slate-400 py-10">${esc(msg)}</div>`;

export function toast(message, type = 'info') {
  const cls = { info: 'bg-slate-800', success: 'bg-emerald-600', error: 'bg-rose-600', warn: 'bg-amber-600' }[type];
  const el = document.createElement('div');
  el.className = `${cls} text-white text-sm rounded-lg shadow-lg px-4 py-2.5 max-w-sm`;
  el.textContent = message;
  $('#toast-root').append(el);
  setTimeout(() => el.remove(), 4500);
}

export function modal(title, body, { wide = false } = {}) {
  const root = document.createElement('div');
  root.className = 'fixed inset-0 z-40 flex items-start justify-center bg-slate-900/40 p-4 overflow-y-auto';
  root.innerHTML = `
    <div class="bg-white rounded-2xl shadow-xl w-full ${wide ? 'max-w-5xl' : 'max-w-xl'} my-8" role="dialog" aria-modal="true">
      <div class="flex items-center justify-between px-5 py-3 border-b border-slate-100">
        <h2 class="font-semibold">${esc(title)}</h2>
        <button data-close class="text-slate-400 hover:text-slate-700 text-xl leading-none" aria-label="ปิด">&times;</button>
      </div>
      <div class="p-5" data-body>${body}</div>
    </div>`;
  const close = () => { root.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => e.key === 'Escape' && close();
  root.addEventListener('click', (e) => { if (e.target === root || e.target.closest('[data-close]')) close(); });
  document.addEventListener('keydown', onKey);
  $('#modal-root').append(root);
  return { el: root, body: $('[data-body]', root), close };
}

/** แสดง error จาก API รวมถึงรายละเอียด conflict */
export function showError(err) {
  toast(err.message || 'เกิดข้อผิดพลาด', 'error');
  console.warn(err.code, err.details);
}

export const imgOrIcon = (url, icon = '🛠️', cls = 'h-36') => (url
  ? `<img src="${esc(url)}" alt="" class="w-full ${cls} object-cover" loading="lazy">`
  : `<div class="w-full ${cls} grid place-items-center bg-slate-50 text-4xl text-slate-300">${icon}</div>`);

/**
 * ฟอร์มใน modal จากรายการฟิลด์
 *   fields: [{ name, label, type: text|email|tel|date|number|color|select|textarea|checkbox, required, value,
 *             options: [{value,label}], allowEmpty, full, hint, attrs }]
 *   onSubmit(values, m) — values: ค่าว่างเป็น null, number แปลงเป็นตัวเลข, checkbox เป็น boolean
 *   ข้อผิดพลาดจาก API แสดงใต้ฟอร์ม (ชื่อฟิลด์เป็นภาษาไทยตาม label)
 */
export function formModal(title, fields, onSubmit, { submitLabel = 'บันทึก', wide = false, intro = '' } = {}) {
  const control = (f) => {
    const v = f.value ?? '';
    const req = f.required ? 'required' : '';
    if (f.type === 'select') {
      return `<select name="${f.name}" class="${input}" ${req}>${f.allowEmpty ? '<option value="">–</option>' : ''}${(f.options || [])
        .map((o) => `<option value="${esc(o.value)}" ${String(o.value) === String(v) ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select>`;
    }
    if (f.type === 'textarea') return `<textarea name="${f.name}" rows="2" class="${input}" ${req}>${esc(v)}</textarea>`;
    if (f.type === 'checkbox') return `<input name="${f.name}" type="checkbox" class="mr-2 align-middle" ${v ? 'checked' : ''}>`;
    return `<input name="${f.name}" type="${f.type || 'text'}" value="${esc(v)}" class="${input}" ${req} ${f.attrs || ''}>`;
  };
  const row = (f) => (f.type === 'checkbox'
    ? `<label class="flex items-center text-sm ${f.full ? 'sm:col-span-2' : ''}">${control(f)}${esc(f.label)}</label>`
    : `<label class="block text-sm ${f.full ? 'sm:col-span-2' : ''}"><span>${esc(f.label)}${f.required ? ' <span class="text-rose-500">*</span>' : ''}</span>${control(f)}${f.hint ? `<span class="block text-[11px] text-slate-500 mt-0.5">${esc(f.hint)}</span>` : ''}</label>`);
  const m = modal(title, `
    ${intro}
    <form class="grid sm:grid-cols-2 gap-3">
      ${fields.map(row).join('')}
      <p data-form-error class="sm:col-span-2 text-sm text-rose-600 hidden"></p>
      <div class="sm:col-span-2 pt-1">${btn(submitLabel, 'type="submit" data-submit')}</div>
    </form>`, { wide });
  const form = $('form', m.el);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const values = {};
    for (const f of fields) {
      const el = form.elements[f.name];
      if (f.type === 'checkbox') { values[f.name] = el.checked; continue; }
      const raw = el.value.trim();
      values[f.name] = raw === '' ? null : f.type === 'number' ? Number(raw) : raw;
    }
    const errEl = $('[data-form-error]', m.el);
    errEl.classList.add('hidden');
    const submit = $('[data-submit]', m.el);
    submit.disabled = true;
    try {
      await onSubmit(values, m);
    } catch (err) {
      const labels = Object.fromEntries(fields.map((f) => [f.name, f.label]));
      const details = Array.isArray(err.details)
        ? err.details.map((d) => `${labels[String(d.path).split('.').pop()] || d.path}: ${d.message}`).join(' · ') : '';
      errEl.textContent = details ? `${err.message} — ${details}` : (err.message || 'บันทึกไม่สำเร็จ');
      errEl.classList.remove('hidden');
    } finally {
      submit.disabled = false;
    }
  });
  return m;
}

/** ตัดค่า null ออก (ใช้ตอนสร้างใหม่) */
export const compact = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined));
