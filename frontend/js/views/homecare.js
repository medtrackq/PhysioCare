import { api } from '../api.js';
import { $, esc, pageHeader, btn, input, card, empty, toast, showError, fmtDate, formModal } from '../ui.js';
import {
  REGION_TH, ALERT_TH, DIFF_TH, DOW_TH, GROC_TH, doseText, pctBadge, openProgramEditor, openLinks,
} from './homecare-ui.js';

/**
 * ติดตามผู้ป่วยที่บ้าน: รายการโปรแกรมที่ใช้งาน (เรียงตามสิ่งที่ต้องดูก่อน), รายละเอียดรายคน, คลังท่า
 */
export async function render(root, { params, session }) {
  if (params[0] === 'library') return renderLibrary(root, session);
  if (params[0]) return renderDetail(root, params[0], session);
  return renderList(root, session);
}

const tabs = (active) => `<div class="inline-flex rounded-lg ring-1 ring-inset ring-slate-300 bg-white overflow-hidden mb-4 text-sm">
  <a href="#/homecare" class="px-4 py-1.5 ${active === 'list' ? 'bg-brand-600 text-white' : ''}">ผู้ป่วยที่ติดตาม</a>
  <a href="#/homecare/library" class="px-4 py-1.5 ${active === 'library' ? 'bg-brand-600 text-white' : ''}">คลังท่าออกกำลังกาย</a></div>`;

// ------------------------------------------------------------------ list
async function renderList(root, session) {
  let mine = false;
  try { mine = localStorage.getItem('pc.home.mine') === 'true'; } catch { /* ไม่มี storage */ }
  root.innerHTML = `
    ${pageHeader('ติดตามกายภาพที่บ้าน', 'ผู้ป่วยที่มีโปรแกรมออกกำลังกายที่บ้าน เรียงตามสิ่งที่ควรดูก่อน: มีแจ้งเตือน → ไม่บันทึกนาน → ทำน้อย')}
    ${tabs('list')}
    <label class="flex items-center gap-2 text-sm mb-3"><input type="checkbox" id="hc-mine" ${mine ? 'checked' : ''}> เฉพาะผู้ป่วยของฉัน</label>
    <div id="hc-list"></div>
    <p class="text-xs text-slate-500 mt-3">สั่งโปรแกรมใหม่ได้จากหน้าเวชระเบียนของนัดนั้น (การ์ด "โปรแกรมที่บ้าน")</p>`;
  async function load() {
    const rows = await api.get(`/home/monitor${mine ? '?mine=true' : ''}`);
    $('#hc-list').innerHTML = rows.length ? card(`<div class="overflow-x-auto"><table class="w-full text-sm">
      <thead class="text-left text-xs text-slate-500"><tr><th class="p-3">ผู้ป่วย</th><th>7 วันล่าสุด</th><th>ทำตามโปรแกรม</th><th>บันทึกล่าสุด</th><th>ปวด</th><th>แจ้งเตือน</th></tr></thead>
      <tbody>${rows.map((r) => `<tr class="border-t border-slate-100 hover:bg-slate-50 cursor-pointer" data-open="${r.id}">
        <td class="p-3"><div class="font-medium">${esc(r.patientName)}</div><div class="text-xs text-slate-500">${esc(r.hn)} · ${esc(r.therapistName)} · ถึง ${fmtDate(r.endDate)}</div></td>
        <td><div class="flex gap-1">${r.week.map((d) => `<span title="${d.date} ${d.done}/${d.scheduled}" class="w-4 h-4 rounded-sm ${!d.scheduled ? 'bg-slate-100' : d.done >= d.scheduled ? 'bg-emerald-500' : d.done ? 'bg-emerald-200' : 'bg-rose-200'}"></span>`).join('')}</div></td>
        <td>${pctBadge(r.adherence7)}</td>
        <td>${r.lastLogDate ? `${fmtDate(r.lastLogDate)}${r.daysWithoutLog >= 3 ? ` <span class="text-rose-600 text-xs">(${r.daysWithoutLog} วันไม่บันทึก)</span>` : ''}` : `<span class="text-slate-400">ยังไม่บันทึก</span>${r.activeLinks ? '' : ' <span class="text-amber-700 text-xs">· ยังไม่มีลิงก์</span>'}`}</td>
        <td>${r.latestPain ?? '–'}${r.baselinePain != null ? ` <span class="text-xs text-slate-400">(ตั้งต้น ${r.baselinePain})</span>` : ''}</td>
        <td>${r.openAlerts.length ? `<span class="inline-flex rounded-full bg-rose-600 text-white text-xs px-2 py-0.5">${r.openAlerts.length}</span> <span class="text-xs text-rose-700">${esc([...new Set(r.openAlerts.map((a) => ALERT_TH[a.kind]))].join(', '))}</span>` : '<span class="text-slate-400">–</span>'}</td>
      </tr>`).join('')}</tbody></table></div>`) : empty('ยังไม่มีผู้ป่วยที่มีโปรแกรมที่บ้าน');
  }
  $('#hc-mine').addEventListener('change', (e) => { mine = e.target.checked; try { localStorage.setItem('pc.home.mine', String(mine)); } catch { /* */ } load(); });
  $('#hc-list').addEventListener('click', (e) => { const r = e.target.closest('[data-open]'); if (r) location.hash = `#/homecare/${r.dataset.open}`; });
  await load();
}

// ------------------------------------------------------------------ detail
let chart;
async function renderDetail(root, id, session) {
  const d = await api.get(`/home/programs/${id}`);
  const canWrite = session.can('emr:write');
  const open = d.alerts.filter((a) => !a.acknowledged_at);
  root.innerHTML = `
    ${pageHeader(`โปรแกรมที่บ้าน · ${d.patient_name}`, `HN ${esc(d.hn)} · ${esc(d.therapist_name)} · ${fmtDate(d.start_date)} – ${fmtDate(d.end_date)} · ${d.status === 'active' ? 'ใช้งานอยู่' : 'สิ้นสุดแล้ว'}`,
      `<a href="#/homecare" class="inline-flex items-center rounded-lg px-3 py-1.5 text-sm font-medium ring-1 ring-inset ring-slate-300 bg-white">← รายการ</a>
       <a href="#/progress/${d.patient_id}" class="inline-flex items-center rounded-lg px-3 py-1.5 text-sm font-medium ring-1 ring-inset ring-slate-300 bg-white">📈 ความก้าวหน้า</a>
       ${canWrite && d.status === 'active' ? `${btn('ลิงก์ & QR', 'id="hc-links"', 'ghost')}${btn('แก้ไขโปรแกรม', 'id="hc-edit"', 'ghost')}${btn('สิ้นสุดโปรแกรม', 'id="hc-end"', 'ghost')}` : ''}`)}
    ${open.length ? `<div class="mb-4 rounded-xl bg-rose-50 ring-1 ring-rose-200 p-4 space-y-2">
      <div class="font-semibold text-rose-800">แจ้งเตือนที่ยังไม่รับทราบ (${open.length})</div>
      ${open.map((a) => `<div class="flex flex-wrap items-center justify-between gap-2 text-sm"><div>
        <b>${ALERT_TH[a.kind]}</b> · ${fmtDate(a.log_date)} ${a.detail?.symptoms ? `: ${esc(a.detail.symptoms.join(', '))}` : ''}${a.detail?.pain != null ? ` ปวด ${a.detail.pain}${a.detail.baseline != null ? ` (ตั้งต้น ${a.detail.baseline})` : ''}` : ''}</div>
        ${canWrite ? `<div class="flex gap-2"><input data-ack-note="${a.id}" class="${input} max-w-[240px]" placeholder="การดำเนินการ เช่น โทรติดตามแล้ว">${btn('รับทราบ', `data-ack="${a.id}"`)}</div>` : ''}</div>`).join('')}
    </div>` : ''}
    <div class="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
      ${[['ทำตามโปรแกรม 7 วัน', pctBadge(d.adherence7)], ['ทั้งช่วง (28 วันล่าสุด)', pctBadge(d.adherenceAll)],
    ['วันที่บันทึก', `${d.series.filter((x) => x.logged).length}/${d.series.length}`], ['ปวดตั้งต้น', d.baseline_pain ?? '–']]
    .map(([l, v]) => card(`<div class="p-3"><div class="text-xs text-slate-500">${l}</div><div class="text-xl font-bold mt-1">${v}</div></div>`)).join('')}
    </div>
    <div class="grid xl:grid-cols-3 gap-4">
      <div class="xl:col-span-2 space-y-4">
        ${card('<div class="p-4"><div class="font-semibold mb-2">ทำตามโปรแกรมและความปวดรายวัน</div><canvas id="hc-chart" height="120"></canvas></div>')}
        ${card(`<div class="p-4 overflow-x-auto"><div class="font-semibold mb-2">บันทึกรายวัน</div><table class="w-full text-sm">
          <thead class="text-left text-xs text-slate-500"><tr><th class="py-1">วันที่</th><th>ทำ</th><th>ปวด</th><th>ความยาก</th><th>อาการ / บันทึก</th></tr></thead><tbody>
          ${[...d.series].reverse().filter((x) => x.logged || x.scheduled).slice(0, 28).map((x) => `<tr class="border-t border-slate-100 align-top">
            <td class="py-1.5 whitespace-nowrap">${fmtDate(x.date)}</td><td>${x.logged ? `${x.done}/${x.scheduled}` : '<span class="text-rose-500">ไม่บันทึก</span>'}</td>
            <td>${x.pain ?? '–'}</td><td>${x.difficulty ? DIFF_TH[x.difficulty] : '–'}</td>
            <td class="text-xs">${x.symptoms.length ? '<span class="text-rose-700">มีอาการผิดปกติ</span> ' : ''}${esc(x.note || '')}</td></tr>`).join('')}
          </tbody></table></div>`)}
      </div>
      <aside class="space-y-4">
        ${d.status === 'active' ? '<div id="hc-suggest"></div>' : ''}
        ${checkinCard(d)}
        ${card(`<div class="p-4"><div class="font-semibold mb-2">ท่าในโปรแกรม</div><div class="space-y-2 text-sm">
          ${d.items.filter((i) => i.is_active).map((i) => {
    const s = d.itemStats.find((x) => x.id === i.id);
    return `<div class="flex justify-between gap-2"><div><div class="font-medium">${esc(i.name_th)}</div>
              <div class="text-xs text-slate-500">${esc(doseText(i))} · ${i.days_of_week.length === 7 ? 'ทุกวัน' : i.days_of_week.map((x) => DOW_TH[x - 1]).join(' ')}</div></div>${pctBadge(s?.pct)}</div>`;
  }).join('')}
          ${d.notes ? `<div class="text-xs text-slate-600 border-t border-slate-100 pt-2">คำแนะนำ: ${esc(d.notes)}</div>` : ''}</div></div>`)}
        ${card(`<div class="p-4 text-sm"><div class="font-semibold mb-1">ลิงก์</div>${d.links.filter((l) => l.active).map((l) => `<div>${esc(l.label)} · ${l.last_used_at ? `เปิดล่าสุด ${fmtDate(l.last_used_at)}` : '<span class="text-amber-700">ยังไม่เคยเปิด</span>'}</div>`).join('') || '<div class="text-amber-700">ยังไม่มีลิงก์ที่ใช้ได้ — กด "ลิงก์ & QR"</div>'}
          <div class="text-xs text-slate-500 mt-2">ยินยอมเมื่อ ${fmtDate(d.consent_at)}${d.consent_note ? ` · ${esc(d.consent_note)}` : ''}</div></div>`)}
      </aside>
    </div>`;

  // กราฟ: แท่ง = % ทำตามโปรแกรม, เส้น = ปวด
  if (window.Chart) {
    chart?.destroy();
    chart = new window.Chart($('#hc-chart'), {
      data: {
        labels: d.series.map((x) => x.date.slice(5)),
        datasets: [
          { type: 'bar', label: '% ทำตามโปรแกรม', data: d.series.map((x) => (x.scheduled ? Math.round((x.done / x.scheduled) * 100) : null)), backgroundColor: '#86efac', yAxisID: 'y' },
          { type: 'line', label: 'ปวด (0–10)', data: d.series.map((x) => x.pain), borderColor: '#dc2626', backgroundColor: '#dc2626', spanGaps: true, yAxisID: 'y1', tension: 0.25 },
        ],
      },
      options: { animation: false, scales: { y: { min: 0, max: 100, title: { display: true, text: '%' } }, y1: { position: 'right', min: 0, max: 10, grid: { drawOnChartArea: false } } } },
    });
  }

  const reload = () => renderDetail(root, id, session);
  if ($('#hc-suggest')) renderSuggestions($('#hc-suggest'), d, canWrite, reload);
  $('#hc-links')?.addEventListener('click', () => openLinks(id, reload));
  $('#hc-edit')?.addEventListener('click', () => openProgramEditor({ patient: { id: d.patient_id, name: d.patient_name }, program: d, onSaved: reload }));
  $('#hc-end')?.addEventListener('click', async () => {
    if (!confirm('สิ้นสุดโปรแกรมนี้? ลิงก์ทั้งหมดจะใช้ไม่ได้ทันที (ข้อมูลที่บันทึกแล้วยังอยู่)')) return;
    try { await api.post(`/home/programs/${id}/end`); toast('สิ้นสุดโปรแกรมแล้ว', 'success'); reload(); } catch (err) { showError(err); }
  });
  root.querySelectorAll('[data-ack]').forEach((b) => b.addEventListener('click', async () => {
    try { await api.post(`/home/alerts/${b.dataset.ack}/ack`, { note: root.querySelector(`[data-ack-note="${b.dataset.ack}"]`).value || undefined }); toast('รับทราบแล้ว', 'success'); reload(); } catch (err) { showError(err); }
  }));
  return () => { chart?.destroy(); chart = null; };
}

// ------------------------------------------------------------------ PSFS / GROC รายสัปดาห์
function checkinCard(d) {
  const acts = d.psfs_activities || [];
  if (!acts.length && !d.checkins.length) return '';
  const rows = [...d.checkins].reverse();
  const cell = (v) => `<td class="text-center ${v == null ? 'text-slate-300' : ''}">${v ?? '–'}</td>`;
  return card(`<div class="p-4 text-sm space-y-2"><div class="font-semibold">ประเมินรายสัปดาห์ (PSFS / GROC)</div>
    ${acts.length ? `<div class="text-xs text-slate-500">กิจกรรม: ${acts.map((a, i) => `${i + 1}) ${esc(a)}`).join(' · ')}</div>` : ''}
    ${rows.length ? `<div class="overflow-x-auto"><table class="w-full text-xs"><thead class="text-slate-500"><tr><th class="text-left py-1">วันที่</th>${acts.map((_, i) => `<th>${i + 1}</th>`).join('')}<th>เฉลี่ย</th><th class="text-left">GROC</th></tr></thead><tbody>
      ${rows.map((c) => `<tr class="border-t border-slate-100"><td class="py-1 whitespace-nowrap">${fmtDate(c.date)}</td>${acts.map((a) => cell(c.psfs?.find((x) => x.activity === a)?.score)).join('')}
        <td class="text-center font-semibold">${c.psfsAvg ?? '–'}</td>
        <td class="${c.groc > 0 ? 'text-emerald-700' : c.groc < 0 ? 'text-rose-700' : ''}">${c.groc != null ? `${c.groc > 0 ? '+' : ''}${c.groc} ${GROC_TH[c.groc]}` : '–'}</td></tr>`).join('')}
      </tbody></table></div>
      <div class="text-[11px] text-slate-500">PSFS 0 = ทำไม่ได้เลย, 10 = ทำได้เหมือนก่อนบาดเจ็บ · เปลี่ยนแปลง ≥ 2 คะแนนถือว่ามีนัยสำคัญทางคลินิก</div>`
    : '<div class="text-xs text-slate-400">ผู้ป่วยยังไม่ได้ประเมิน — ระบบจะชวนประเมินในหน้าลิงก์ทุก 7 วัน</div>'}
  </div>`);
}

// ------------------------------------------------------------------ แนะนำปรับระดับ (นักกายภาพอนุมัติ)
const SUG = {
  progress: ['เพิ่มความยาก', 'bg-emerald-50 ring-emerald-200 text-emerald-800'],
  regress: ['ลดความยาก', 'bg-amber-50 ring-amber-200 text-amber-800'],
  review: ['ควรสอบถาม', 'bg-slate-50 ring-slate-200 text-slate-700'],
};
const doseOf = (x) => [x.sets ? `${x.sets} เซ็ต` : '', x.reps ? `${x.reps} ครั้ง` : '', x.holdSec ? `ค้าง ${x.holdSec} วิ` : ''].filter(Boolean).join(' × ');

async function renderSuggestions(el, d, canWrite, reload) {
  let s;
  try { s = await api.get(`/home/programs/${d.id}/suggestions`); } catch { return; }
  el.innerHTML = card(`<div class="p-4 text-sm space-y-2">
    <div class="font-semibold">ระบบแนะนำปรับระดับท่า</div>
    <div class="text-[11px] text-slate-500">จากข้อมูล 7 วันล่าสุด (บันทึก ${s.basis.loggedDays} วัน${s.basis.hardRatio != null ? ` · รู้สึกยาก ${s.basis.hardRatio}%` : ''}${s.basis.painAvg != null ? ` · ปวดเฉลี่ย ${s.basis.painAvg}` : ''}) — เป็นข้อเสนอเท่านั้น นักกายภาพเป็นผู้ตัดสินใจ</div>
    ${s.note ? `<div class="text-xs text-slate-400">${esc(s.note)}</div>` : ''}
    ${!s.note && !s.items.length ? '<div class="text-xs text-slate-500">ยังไม่มีข้อเสนอ — ระดับปัจจุบันเหมาะสมดี</div>' : ''}
    ${s.items.map((x, k) => `<div class="rounded-lg ring-1 ring-inset p-2.5 space-y-1 ${SUG[x.type][1]}">
      <div class="flex justify-between gap-2"><b>${esc(x.name)}</b><span class="text-[11px] font-semibold">${SUG[x.type][0]}</span></div>
      ${x.proposed ? `<div class="text-xs">${esc(doseOf(x.current))} → <b>${esc(doseOf(x.proposed))}</b></div>` : ''}
      <div class="text-[11px] opacity-80">${esc(x.reason)}</div>
      ${canWrite && x.proposed ? `<div class="pt-1">${btn('ใช้ตามที่แนะนำ', `data-sug="${k}"`, 'ghost')}</div>` : ''}
    </div>`).join('')}
  </div>`);
  el.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-sug]');
    if (!b) return;
    const x = s.items[Number(b.dataset.sug)];
    if (!confirm(`ปรับ "${x.name}" เป็น ${doseOf(x.proposed)}? ผู้ป่วยจะเห็นขนาดใหม่ในลิงก์ทันที`)) return;
    const items = d.items.filter((i) => i.is_active).map((i) => {
      const base = { id: i.id, exerciseId: i.exercise_id, sets: i.sets, reps: i.reps, holdSec: i.hold_sec, perDay: i.per_day, daysOfWeek: i.days_of_week, notes: i.notes };
      return i.id === x.itemId ? { ...base, sets: x.proposed.sets, reps: x.proposed.reps, holdSec: x.proposed.holdSec } : base;
    });
    b.disabled = true;
    try { await api.patch(`/home/programs/${d.id}`, { items }); toast('ปรับระดับท่าแล้ว', 'success'); reload(); } catch (err) { showError(err); b.disabled = false; }
  });
}

// ------------------------------------------------------------------ exercise library
async function renderLibrary(root, session) {
  const canWrite = session.can('emr:write');
  root.innerHTML = `
    ${pageHeader('ติดตามกายภาพที่บ้าน', 'คลังท่าที่ใช้สั่งโปรแกรม — ท่าพื้นฐานที่ติดมากับระบบเป็นตัวอย่าง ควรตรวจทานและปรับให้เหมาะกับคลินิก', canWrite ? btn('+ เพิ่มท่า', 'id="ex-new"') : '')}
    ${tabs('library')}
    <div id="ex-list"></div>`;
  async function load() {
    const list = await api.get('/home/exercises?all=true');
    $('#ex-list').innerHTML = card(`<div class="overflow-x-auto"><table class="w-full text-sm"><thead class="text-left text-xs text-slate-500"><tr>
      <th class="p-3">ท่า</th><th>ส่วน</th><th>ค่าเริ่มต้น</th><th>วิดีโอ</th><th>สถานะ</th><th></th></tr></thead><tbody>
      ${list.map((e) => `<tr class="border-t border-slate-100 align-top"><td class="p-3"><div class="font-medium">${esc(e.name_th)}</div><div class="text-xs text-slate-500">${esc(e.name_en || '')} · ${esc(e.code)}</div>
        <div class="text-xs mt-1 max-w-[60ch]">${esc(e.instructions)}</div></td>
        <td>${esc(REGION_TH[e.body_region])}</td><td class="whitespace-nowrap">${esc(doseText(e))}</td>
        <td>${e.video_url ? `<a href="${esc(e.video_url)}" target="_blank" rel="noopener" class="text-brand-700">เปิด</a>` : '<span class="text-slate-400">–</span>'}</td>
        <td>${e.is_active ? 'ใช้งาน' : '<span class="text-slate-400">ปิด</span>'}</td>
        <td class="text-right pr-3">${canWrite ? btn('แก้ไข', `data-edit="${e.id}"`, 'ghost') : ''}</td></tr>`).join('')}</tbody></table></div>`);
    $('#ex-list').querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => openExercise(list.find((x) => x.id === Number(b.dataset.edit)), load)));
  }
  $('#ex-new')?.addEventListener('click', () => openExercise(null, load));
  await load();
}

function openExercise(e, done) {
  formModal(e ? `แก้ไขท่า · ${e.name_th}` : 'เพิ่มท่าออกกำลังกาย', [
    { name: 'nameTh', label: 'ชื่อท่า (ไทย)', required: true, value: e?.name_th },
    { name: 'nameEn', label: 'ชื่อท่า (อังกฤษ)', value: e?.name_en },
    { name: 'code', label: 'รหัส', required: true, value: e?.code, hint: 'A-Z 0-9 _ เช่น HAMSTRING_STRETCH', attrs: e ? 'readonly' : '' },
    { name: 'bodyRegion', label: 'ส่วนของร่างกาย', type: 'select', required: true, value: e?.body_region || 'back', options: Object.entries(REGION_TH).map(([value, label]) => ({ value, label })) },
    { name: 'instructions', label: 'วิธีทำ (ภาษาที่ผู้ป่วยเข้าใจ)', type: 'textarea', required: true, full: true, value: e?.instructions },
    { name: 'cautions', label: 'ข้อควรระวัง', type: 'textarea', full: true, value: e?.cautions },
    { name: 'defaultSets', label: 'เซ็ต (ค่าเริ่มต้น)', type: 'number', value: e?.default_sets ?? 2, attrs: 'min="1" max="10"' },
    { name: 'defaultReps', label: 'ครั้ง (ค่าเริ่มต้น)', type: 'number', value: e?.default_reps ?? 10, attrs: 'min="1" max="100"' },
    { name: 'defaultHoldSec', label: 'ค้าง (วินาที)', type: 'number', value: e?.default_hold_sec, attrs: 'min="1" max="3600"' },
    { name: 'defaultPerDay', label: 'รอบต่อวัน', type: 'number', value: e?.default_per_day ?? 1, attrs: 'min="1" max="6"' },
    { name: 'videoUrl', label: 'ลิงก์วิดีโอ (https)', full: true, value: e?.video_url, hint: 'เช่น วิดีโอที่คลินิกถ่ายเองและอัปโหลดไว้ (YouTube แบบไม่เป็นสาธารณะ / Google Drive)' },
    ...(e ? [{ name: 'isActive', label: 'ใช้งาน (เอาออกจากคลังโดยไม่ลบ)', type: 'checkbox', value: e.is_active, full: true }] : []),
  ], async (v, m) => {
    const body = { ...v };
    for (const k of ['defaultSets', 'defaultReps', 'defaultHoldSec', 'defaultPerDay']) body[k] = v[k] == null ? null : Number(v[k]);
    if (body.defaultSets == null) delete body.defaultSets;
    if (body.defaultPerDay == null) delete body.defaultPerDay;
    if (!body.defaultReps && !body.defaultHoldSec) throw new Error('ระบุจำนวนครั้งหรือเวลาค้างอย่างน้อยหนึ่งอย่าง');
    if (e) { delete body.code; await api.patch(`/home/exercises/${e.id}`, body); } else await api.post('/home/exercises', body);
    toast('บันทึกท่าแล้ว', 'success');
    m.close();
    done();
  }, { wide: true, submitLabel: e ? 'บันทึก' : 'เพิ่มท่า' });
}
