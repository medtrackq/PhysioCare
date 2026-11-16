/**
 * สิทธิ์ตามผู้ป่วยที่ดูแล: ทีมผู้ดูแลในหน้าต่างผู้ป่วย, มอบหมายผู้ดูแล, เปิดดูฉุกเฉิน, รายการเปิดดูฉุกเฉิน (หัวหน้า)
 */
import { api } from '../api.js';
import { $, esc, btn, card, modal, toast, showError, fmtDateTime, input } from '../ui.js';

export const ROLE_TH = {
  admin: 'ผู้ดูแลระบบ', therapist: 'นักกายภาพบำบัด', head_therapist: 'หัวหน้านักกายภาพ',
  staff: 'เจ้าหน้าที่', patient: 'ผู้ป่วย', superuser: 'Super user',
};
const VIA_TH = {
  all: ['เห็นผู้ป่วยทุกคน', 'bg-sky-50 text-sky-700 ring-sky-200'],
  care_team: ['คุณอยู่ในทีมผู้ดูแล', 'bg-emerald-50 text-emerald-700 ring-emerald-200'],
  appointment: ['มีนัดกับคุณ', 'bg-emerald-50 text-emerald-700 ring-emerald-200'],
  break_glass: ['เปิดดูฉุกเฉินอยู่', 'bg-amber-50 text-amber-800 ring-amber-200'],
  none: ['คุณไม่ได้ดูแลผู้ป่วยรายนี้', 'bg-slate-100 text-slate-600 ring-slate-200'],
};

/** หน้าต่าง "เปิดดูฉุกเฉิน" (เรียกเมื่อ API ตอบ NO_CARE_RELATION) */
export function openBreakGlass(d, onGranted) {
  const m = modal('ไม่ได้เป็นผู้ดูแลผู้ป่วยรายนี้', `<form class="space-y-3 text-sm" id="bg-form">
    <p>ข้อมูลการรักษาของ <b>${esc(d.patientName)}</b> (${esc(d.hn)}) เปิดได้เฉพาะนักกายภาพในทีมผู้ดูแล หรือผู้ที่มีนัดกับผู้ป่วย</p>
    <div class="rounded-lg bg-slate-50 p-3 text-slate-600">ถ้าคุณควรดูแลผู้ป่วยรายนี้ประจำ ให้หัวหน้านักกายภาพหรือเจ้าหน้าที่หน้าเคาน์เตอร์ <b>มอบหมายผู้ดูแล</b> ในหน้าผู้ป่วย</div>
    ${d.canBreakGlass ? `<div class="rounded-lg bg-amber-50 ring-1 ring-amber-200 p-3 space-y-2">
      <div class="font-medium text-amber-900">เปิดดูฉุกเฉิน</div>
      <div class="text-amber-900/80 text-xs">ใช้เมื่อจำเป็นต่อการรักษา เช่น รักษาแทนเพื่อนที่ลา · มีผล 8 ชั่วโมง · <b>ระบบบันทึกทุกการเปิดดู และหัวหน้านักกายภาพเห็นรายการพร้อมเหตุผล</b></div>
      <textarea name="reason" rows="2" required minlength="10" maxlength="500" class="${input}" placeholder="เหตุผล เช่น ผู้ป่วย walk-in ระหว่าง กภ.สุภาพร ลาป่วย รักษาแทน"></textarea>
      ${btn('เปิดดูฉุกเฉิน', 'type="submit"')}
    </div>` : ''}
    <p data-form-error class="text-rose-600 hidden"></p>
  </form>`);
  $('#bg-form', m.el)?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const reason = new FormData(e.target).get('reason');
    try {
      await api.post(`/access/patients/${d.patientId}/break-glass`, { reason });
      toast('เปิดดูฉุกเฉินแล้ว (8 ชั่วโมง)', 'warn');
      m.close();
      onGranted?.();
    } catch (err) {
      const el = $('[data-form-error]', m.el);
      el.textContent = err.details?.map?.((x) => x.message).join(' · ') || err.message;
      el.classList.remove('hidden');
    }
  });
}

/** ส่วน "ทีมผู้ดูแล" ในหน้าต่างผู้ป่วย */
export async function renderCareTeam(el, patient, session) {
  let team;
  let via = null;
  try {
    [team, via] = await Promise.all([
      api.get(`/access/patients/${patient.id}/care-team`),
      session.can('emr:read') ? api.get(`/access/patients/${patient.id}/relation`).then((r) => r.via || 'none') : null,
    ]);
  } catch { el.innerHTML = ''; return; }
  const canAssign = session.can('care_team:assign');
  const primary = team.find((x) => x.is_primary);
  const others = team.filter((x) => !x.is_primary);
  el.innerHTML = `<div class="mt-3 rounded-lg ring-1 ring-slate-200 p-3 space-y-1.5">
    <div class="flex items-center justify-between gap-2"><span class="font-medium">ทีมผู้ดูแล</span>
      ${via ? `<span class="text-xs rounded-full px-2 py-0.5 ring-1 ring-inset ${VIA_TH[via][1]}">${VIA_TH[via][0]}</span>` : ''}</div>
    <div>ผู้ดูแลหลัก: ${primary ? `<b>${esc(primary.name)}</b>` : '<span class="text-amber-700">ยังไม่ได้มอบหมาย</span>'}</div>
    ${others.length ? `<div class="text-slate-600">ร่วมดูแล: ${others.map((x) => esc(x.name)).join(', ')}</div>` : ''}
    ${primary?.assigned_by_name ? `<div class="text-xs text-slate-500">มอบหมายโดย ${esc(primary.assigned_by_name)} · ${fmtDateTime(primary.assigned_at)}</div>` : ''}
    ${canAssign ? `<div class="pt-1">${btn(primary ? 'เปลี่ยนผู้ดูแล' : 'มอบหมายผู้ดูแล', 'data-ct-assign', primary ? 'ghost' : 'primary')}</div>` : ''}
  </div>`;
  el.querySelector('[data-ct-assign]')?.addEventListener('click', () => openAssign(patient, team, () => renderCareTeam(el, patient, session)));
}

/** มอบหมายผู้ดูแลหลัก + ผู้ร่วมดูแล (แสดงจำนวนผู้ป่วยที่แต่ละคนดูแลอยู่) */
export async function openAssign(patient, team, onSaved) {
  const workload = await api.get('/access/workload');
  const cur = new Set(team.filter((x) => !x.is_primary).map((x) => x.staff_id));
  const primary = team.find((x) => x.is_primary)?.staff_id || '';
  const name = `${patient.title || ''}${patient.first_name} ${patient.last_name}`;
  const m = modal(`มอบหมายผู้ดูแล · ${name}`, `<form class="space-y-3 text-sm" id="ct-form">
    <label class="block">ผู้ดูแลหลัก
      <select name="primary" class="${input}"><option value="">– ยังไม่มอบหมาย –</option>
        ${workload.map((w) => `<option value="${w.id}" ${w.id === primary ? 'selected' : ''}>${esc(w.name)} (ดูแลหลัก ${w.primary_count} คน)</option>`).join('')}</select></label>
    <div><div class="mb-1">ผู้ร่วมดูแล <span class="text-slate-500">(เห็นข้อมูลการรักษาได้ เช่น นักกายภาพที่รักษาแทนประจำ)</span></div>
      <div class="grid sm:grid-cols-2 gap-1">${workload.map((w) => `<label class="flex items-center gap-2"><input type="checkbox" name="co" value="${w.id}" ${cur.has(w.id) ? 'checked' : ''}> ${esc(w.name)} <span class="text-xs text-slate-400">(${w.total})</span></label>`).join('')}</div></div>
    <p class="text-xs text-slate-500">นักกายภาพที่มีนัดกับผู้ป่วยเห็นข้อมูลได้อยู่แล้ว (ย้อนหลัง 180 วัน) · คนที่ถูกเอาออกจะเห็นไม่ได้ทันที แต่ประวัติการมอบหมายยังอยู่</p>
    <p data-form-error class="text-rose-600 hidden"></p>
    ${btn('บันทึก', 'type="submit"')}
  </form>`);
  $('#ct-form', m.el).addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const primaryStaffId = f.get('primary') || null;
    const staffIds = f.getAll('co').filter((x) => x !== primaryStaffId);
    try {
      await api.put(`/access/patients/${patient.id}/care-team`, { primaryStaffId, staffIds });
      toast('บันทึกทีมผู้ดูแลแล้ว', 'success');
      m.close();
      onSaved?.();
    } catch (err) {
      const el = $('[data-form-error]', m.el);
      el.textContent = err.message;
      el.classList.remove('hidden');
    }
  });
}

/** การ์ด "เปิดดูฉุกเฉิน" สำหรับหัวหน้านักกายภาพ / super user (หน้าภาพรวม) */
export async function renderBreakGlassCard(el) {
  const rows = await api.get('/access/break-glass?days=30');
  const pending = rows.filter((r) => !r.reviewed_at);
  el.innerHTML = card(`<div class="p-4 space-y-2 text-sm">
    <div class="flex items-center justify-between"><div class="font-semibold">เปิดดูฉุกเฉิน (30 วัน)</div>
      ${pending.length ? `<span class="text-xs rounded-full px-2 py-0.5 bg-amber-100 text-amber-800">รอตรวจ ${pending.length}</span>` : ''}</div>
    ${rows.length ? `<div class="space-y-2 max-h-[40vh] overflow-y-auto">${rows.map((r) => `<div class="rounded-lg ${r.reviewed_at ? 'bg-slate-50' : 'bg-amber-50 ring-1 ring-amber-200'} p-2">
      <div class="flex justify-between gap-2"><b>${esc(r.user_name)}</b><span class="text-xs text-slate-500">${fmtDateTime(r.created_at)}</span></div>
      <div class="text-xs">ผู้ป่วย ${esc(r.patient_name)} (${esc(r.hn)}) · ${esc(r.user_role)}</div>
      <div class="text-xs text-slate-700 mt-0.5">“${esc(r.reason)}”</div>
      ${r.reviewed_at ? `<div class="text-[11px] text-slate-500">ตรวจแล้วโดย ${esc(r.reviewed_by_name)}</div>` : `<div class="pt-1">${btn('รับทราบ', `data-bg-review="${r.id}"`, 'ghost')}</div>`}
    </div>`).join('')}</div>` : '<div class="text-xs text-slate-400">ไม่มีการเปิดดูฉุกเฉิน</div>'}
  </div>`);
  if (el.dataset.bound) return;
  el.dataset.bound = '1';
  el.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-bg-review]');
    if (!b) return;
    try { await api.post(`/access/break-glass/${b.dataset.bgReview}/review`); renderBreakGlassCard(el); } catch (err) { showError(err); }
  });
}
