/**
 * แจ้งเตือนทาง LINE: ส่วนในหน้าผู้ป่วย (เชื่อม/ทดสอบ/ยกเลิก) และการ์ดตั้งค่าในหน้าผู้ดูแลระบบ
 */
import { api } from '../api.js';
import { $, esc, btn, card, toast, showError, fmtDateTime, input } from '../ui.js';
import { qrDataUrl } from './homecare-ui.js';

const STATE = {
  active: ['เชื่อม LINE แล้ว', 'bg-emerald-50 text-emerald-700 ring-emerald-200'],
  not_linked: ['ยังไม่เชื่อม LINE', 'bg-slate-100 text-slate-600 ring-slate-200'],
  opted_out: ['ผู้ป่วยขอหยุดรับข้อความ', 'bg-amber-50 text-amber-700 ring-amber-200'],
  blocked: ['ผู้ป่วยบล็อก LINE ของคลินิก', 'bg-rose-50 text-rose-700 ring-rose-200'],
};
const KIND_TH = { appointment_reminder: 'เตือนนัด', home_reminder: 'เตือนทำกายภาพ', test: 'ทดสอบ' };
const QSTATUS_TH = { pending: 'รอส่ง', sent: 'ส่งแล้ว', failed: 'ส่งไม่สำเร็จ (จะลองใหม่)', dead: 'หยุดส่ง', skipped: 'ไม่ต้องส่ง' };

/** ส่วน "แจ้งเตือนทาง LINE" ในหน้าต่างข้อมูลผู้ป่วย */
export async function renderLineBox(el, patient, canWrite) {
  let status;
  let c;
  try { [status, c] = await Promise.all([api.get('/notify/status'), api.get(`/notify/patients/${patient.id}`)]); } catch { el.innerHTML = ''; return; }
  const [label, cls] = STATE[c.state];
  el.innerHTML = `<div class="mt-3 rounded-lg ring-1 ring-slate-200 p-3 space-y-2">
    <div class="flex items-center justify-between gap-2"><span class="font-medium">แจ้งเตือนทาง LINE</span>
      <span class="text-xs rounded-full px-2 py-0.5 ring-1 ring-inset ${cls}">${label}</span></div>
    ${c.lineName ? `<div class="text-xs text-slate-500">บัญชี LINE: ${esc(c.lineName)} · เชื่อมเมื่อ ${fmtDateTime(c.linkedAt)}</div>` : ''}
    ${!status.enabled ? '<div class="text-xs text-amber-700">ระบบแจ้งเตือนยังปิดอยู่ (ผู้ดูแลระบบเปิดได้ที่หน้า "ผู้ใช้ & ตั้งค่า")</div>' : ''}
    ${canWrite ? `<div class="flex flex-wrap gap-2">
      ${btn(c.state === 'not_linked' ? 'เชื่อม LINE' : 'สร้าง QR ใหม่', 'data-ln-code', c.state === 'not_linked' ? 'primary' : 'ghost')}
      ${c.state === 'active' ? btn('ส่งข้อความทดสอบ', 'data-ln-test', 'ghost') : ''}
      ${c.state !== 'not_linked' ? btn('ยกเลิกการเชื่อม', 'data-ln-unlink', 'ghost') : ''}
    </div>` : ''}
    <div data-ln-out></div>
  </div>`;
  const reload = () => renderLineBox(el, patient, canWrite);
  el.querySelector('[data-ln-code]')?.addEventListener('click', async () => {
    try {
      const r = await api.post(`/notify/patients/${patient.id}/link-code`);
      const qr = r.url ? await qrDataUrl(r.url, 5).catch(() => null) : null;
      el.querySelector('[data-ln-out]').innerHTML = `<div class="rounded-lg bg-emerald-50 p-3 grid sm:grid-cols-[auto,1fr] gap-3 items-start">
        ${qr ? `<img src="${qr}" alt="QR เชื่อม LINE" class="w-32 h-32 bg-white rounded">` : ''}
        <div class="text-xs space-y-1">
          <div class="text-sm">รหัส <b class="font-mono text-base tracking-widest">${esc(r.code)}</b> (ใช้ได้ ${r.expiresInDays} วัน)</div>
          ${r.url ? '<div>ให้ผู้ป่วย<b>สแกน QR ด้วยกล้องมือถือ</b> → เปิด LINE → กดส่งข้อความที่ขึ้นมาให้ เท่านี้ก็เชื่อมแล้ว</div>'
    : `<div class="text-amber-700">ยังไม่ได้ตั้ง LINE Official Account ID (notify.line_basic_id) — ให้ผู้ป่วยเพิ่มเพื่อน LINE ของคลินิก แล้วพิมพ์รหัสนี้ส่งในแชต</div>`}
          <div class="text-slate-500">เมื่อผู้ป่วยส่งรหัสแล้ว กด "รีเฟรชสถานะ" · ผู้ป่วยพิมพ์ "หยุด" ในแชตเพื่อยกเลิกได้ทุกเมื่อ</div>
          ${btn('รีเฟรชสถานะ', 'data-ln-refresh', 'ghost')}
        </div></div>`;
      el.querySelector('[data-ln-refresh]').addEventListener('click', reload);
    } catch (err) { showError(err); }
  });
  el.querySelector('[data-ln-test]')?.addEventListener('click', async () => {
    try {
      const r = await api.post(`/notify/patients/${patient.id}/test`);
      toast(r.sent ? 'ส่งข้อความทดสอบแล้ว' : 'ยังส่งไม่ได้ — ตรวจการตั้งค่า LINE ที่หน้าผู้ใช้ & ตั้งค่า', r.sent ? 'success' : 'warn');
    } catch (err) { showError(err); }
  });
  el.querySelector('[data-ln-unlink]')?.addEventListener('click', async () => {
    if (!confirm('ยกเลิกการเชื่อม LINE ของผู้ป่วยรายนี้? ระบบจะหยุดส่งข้อความทันที')) return;
    try { await api.post(`/notify/patients/${patient.id}/unlink`); toast('ยกเลิกการเชื่อมแล้ว', 'success'); reload(); } catch (err) { showError(err); }
  });
}

/** การ์ด "แจ้งเตือนทาง LINE" ในหน้าผู้ใช้ & ตั้งค่า */
export async function renderNotifyAdmin(el) {
  const s = await api.get('/notify/status');
  const webhook = `${s.appBaseUrl || location.origin}${s.webhookPath}`;
  const check = (ok, text, hint = '') => `<li class="flex gap-2"><span>${ok === null ? '👉' : ok ? '✅' : '⬜'}</span><span>${text}${!ok && hint ? `<span class="block text-xs text-slate-500">${hint}</span>` : ''}</span></li>`;
  el.innerHTML = card(`<div class="p-4 space-y-3 text-sm">
    <div class="flex flex-wrap items-center justify-between gap-2">
      <h2 class="font-semibold">แจ้งเตือนผู้ป่วยทาง LINE</h2>
      <span class="text-xs rounded-full px-2 py-0.5 ring-1 ring-inset ${s.ready ? 'bg-emerald-50 text-emerald-700 ring-emerald-200' : 'bg-slate-100 text-slate-600 ring-slate-200'}">${s.ready ? 'พร้อมส่ง' : 'ยังไม่พร้อม'}</span>
    </div>
    <ol class="space-y-1.5">
      ${check(s.lineConfigured, 'ตั้งค่า LINE_CHANNEL_SECRET และ LINE_CHANNEL_ACCESS_TOKEN ใน Railway → Variables', 'ได้จาก LINE Developers Console → Messaging API (ดูคู่มือการติดตั้ง หัวข้อ LINE)')}
      ${check(Boolean(s.basicId), `ตั้ง notify.line_basic_id ด้านล่าง${s.basicId ? ` (${esc(s.basicId)})` : ''}`, 'LINE Official Account ID เช่น @123abcde')}
      ${check(null, `ตั้ง Webhook URL ใน LINE Developers Console: <code class="text-xs bg-slate-100 rounded px-1 break-all">${esc(webhook)}</code> แล้วกด Verify และเปิด Use webhook`)}
      ${check(Boolean(s.appBaseUrl), 'URL ของระบบสำหรับแนบลิงก์ในข้อความ', 'ตั้ง APP_BASE_URL ใน Variables (บน Railway ระบบใช้โดเมนของ Railway ให้อัตโนมัติ)')}
      ${check(s.enabled, 'เปิด notify.enabled = true ด้านล่าง')}
    </ol>
    <div class="text-xs text-slate-500">ผู้ป่วยที่เชื่อม LINE แล้ว ${s.linkedPatients} คน · ขอหยุดรับ/บล็อก ${s.stoppedPatients} คน · ระบบตรวจและส่งทุก 1 นาที</div>
    <div class="flex flex-wrap items-center gap-2">
      <select id="nq-status" class="${input} max-w-[200px]"><option value="">คิวข้อความทั้งหมด</option>${Object.entries(QSTATUS_TH).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select>
      ${btn('ตรวจและส่งตอนนี้', 'id="nq-run"', 'ghost')}
    </div>
    <div id="nq-list"></div>
  </div>`);
  async function loadQueue() {
    const st = $('#nq-status', el).value;
    const rows = await api.get(`/notify/queue${st ? `?status=${st}` : ''}`);
    $('#nq-list', el).innerHTML = rows.length ? `<div class="max-h-[40vh] overflow-auto"><table class="w-full text-xs">
      <thead class="text-left text-slate-500"><tr><th class="py-1">เวลา</th><th>ผู้ป่วย</th><th>ประเภท</th><th>สถานะ</th><th></th></tr></thead><tbody>
      ${rows.map((q) => `<tr class="border-t border-slate-100 align-top"><td class="py-1 whitespace-nowrap">${fmtDateTime(q.sent_at || q.scheduled_for)}</td>
        <td>${esc(q.patient_name)}</td><td>${KIND_TH[q.kind]}</td>
        <td>${QSTATUS_TH[q.status]}${q.last_error ? `<div class="text-rose-600">${esc(q.last_error)}</div>` : ''}</td>
        <td class="text-right">${['failed', 'dead'].includes(q.status) ? btn('ส่งใหม่', `data-nq-retry="${q.id}"`, 'ghost') : ''}</td></tr>`).join('')}
      </tbody></table></div>` : '<div class="text-slate-400 text-xs">ยังไม่มีข้อความในคิว</div>';
  }
  $('#nq-status', el).addEventListener('change', loadQueue);
  $('#nq-run', el).addEventListener('click', async () => {
    try {
      const r = await api.post('/notify/run');
      toast(`เพิ่มเข้าคิว ${r.scheduled.appointments + r.scheduled.home} · ส่งแล้ว ${r.delivered.sent} · ไม่สำเร็จ ${r.delivered.failed}`, r.delivered.failed ? 'warn' : 'success');
      loadQueue();
    } catch (err) { showError(err); }
  });
  $('#nq-list', el).addEventListener('click', async (e) => {
    const b = e.target.closest('[data-nq-retry]');
    if (!b) return;
    try { await api.post(`/notify/queue/${b.dataset.nqRetry}/retry`); toast('เข้าคิวส่งใหม่แล้ว', 'success'); loadQueue(); } catch (err) { showError(err); }
  });
  await loadQueue();
}
