import { api } from '../api.js';
import {
  $, $$, esc, badge, APPT_STATUS, pageHeader, btn, input, toast, showError, fmtDateTime, fmtDate, painColor, card, empty,
} from '../ui.js';

const JOINTS = {
  cervical: ['flexion', 'extension', 'lateral_flexion', 'rotation'],
  lumbar: ['flexion', 'extension', 'lateral_flexion', 'rotation'],
  shoulder: ['flexion', 'extension', 'abduction', 'internal_rotation', 'external_rotation'],
  elbow: ['flexion', 'extension'],
  wrist: ['flexion', 'extension'],
  hip: ['flexion', 'extension', 'abduction', 'internal_rotation', 'external_rotation'],
  knee: ['flexion', 'extension'],
  ankle: ['dorsiflexion', 'plantarflexion'],
};
// ค่าปกติโดยประมาณ (AAOS) ใช้เติมให้อัตโนมัติ
const NORMAL = {
  'cervical.flexion': 45, 'cervical.extension': 45, 'cervical.rotation': 80, 'lumbar.flexion': 60, 'lumbar.extension': 25,
  'shoulder.flexion': 180, 'shoulder.abduction': 180, 'shoulder.extension': 60, 'shoulder.external_rotation': 90, 'shoulder.internal_rotation': 70,
  'elbow.flexion': 150, 'wrist.flexion': 80, 'wrist.extension': 70, 'hip.flexion': 120, 'hip.abduction': 45,
  'knee.flexion': 135, 'knee.extension': 0, 'ankle.dorsiflexion': 20, 'ankle.plantarflexion': 50,
};
const romKey = (r) => `${r.joint}|${r.movement}|${r.side}|${r.mode || 'active'}`;

export async function render(root, { route, params, session }) {
  if (route === 'progress') return renderProgress(root, params[0]);
  const apptId = params[0];
  if (!apptId) {
    root.innerHTML = `${pageHeader('เวชระเบียน')}${empty('เลือกนัดหมายจากหน้าตารางนัดเพื่อเปิดเวชระเบียน')}`;
    return;
  }
  const data = await api.get(`/emr/appointments/${apptId}`);
  const a = data.appointment;
  const canWrite = session.can('emr:write');

  root.innerHTML = `
    ${pageHeader(`เวชระเบียน · ${a.patient_name}`, `HN ${esc(a.hn)} · ${fmtDateTime(a.start_at)} · ${badge(APPT_STATUS, a.status)}`,
      `<a href="#/progress/${a.patient_id}" class="inline-flex items-center rounded-lg px-3 py-1.5 text-sm font-medium ring-1 ring-inset ring-slate-300 bg-white hover:bg-slate-50">📈 ความก้าวหน้า</a>`)}
    ${data.activePrecautions.length ? `<div class="mb-4 rounded-xl bg-rose-50 ring-1 ring-rose-200 px-4 py-3 text-sm text-rose-800">
      ⚠ <b>ข้อควรระวัง:</b> ${data.activePrecautions.map((p) => `${esc(p.name_th)}${p.detail ? ` (${esc(p.detail)})` : ''}`).join(' · ')}</div>` : ''}
    <div class="grid xl:grid-cols-3 gap-5">
      <div class="xl:col-span-2 space-y-5">
        <div id="pre"></div>
        <div id="post"></div>
      </div>
      <aside id="last" class="space-y-4"></aside>
    </div>`;

  renderLastVisit($('#last'), data.lastVisit);
  renderForm($('#pre'), 'pre', data, canWrite, session, () => render(root, { route, params, session }));
  if (['in_progress', 'completed'].includes(a.status) || data.post) {
    renderForm($('#post'), 'post', data, canWrite, session, () => render(root, { route, params, session }));
  } else {
    $('#post').innerHTML = card(`<div class="p-4 text-sm text-slate-400">Post-Treatment Progress Note จะเปิดให้บันทึกเมื่อเริ่มการรักษา</div>`);
  }
}

function renderLastVisit(el, lv) {
  if (!lv) { el.innerHTML = card('<div class="p-4 text-sm text-slate-400">ยังไม่มีประวัติการรักษาก่อนหน้า (Initial visit)</div>'); return; }
  el.innerHTML = card(`
    <div class="p-4 space-y-3 text-sm">
      <div class="font-semibold">นัดก่อนหน้า · ${fmtDate(lv.start_at)}</div>
      <div class="flex gap-3">
        <div class="flex-1 rounded-lg bg-slate-50 p-2 text-center"><div class="text-xs text-slate-500">Pain ก่อน</div><div class="text-2xl font-bold" style="color:${painColor(lv.pre_pain)}">${lv.pre_pain ?? '–'}</div></div>
        <div class="flex-1 rounded-lg bg-slate-50 p-2 text-center"><div class="text-xs text-slate-500">Pain หลัง</div><div class="text-2xl font-bold" style="color:${painColor(lv.post_pain)}">${lv.post_pain ?? '–'}</div></div>
      </div>
      ${lv.treatment_response ? `<div>ผลตอบสนอง: <b>${esc(lv.treatment_response)}</b></div>` : ''}
      ${lv.rom.length ? `<div><div class="text-xs text-slate-500 mb-1">ROM ล่าสุด</div>${lv.rom.map((r) => `<div class="flex justify-between"><span>${esc(r.joint)} ${esc(r.movement)} ${r.side !== 'na' ? esc(r.side) : ''} <span class="text-[10px] text-slate-400">${esc(r.phase)}</span></span><span>${r.degrees}°${r.normal ? ` / ${r.normal}°` : ''}</span></div>`).join('')}</div>` : ''}
      ${lv.home_program ? `<div><div class="text-xs text-slate-500">Home program</div>${esc(lv.home_program)}</div>` : ''}
      ${lv.next_visit_plan ? `<div class="rounded-lg bg-amber-50 p-2"><div class="text-xs text-amber-700">แผนสำหรับนัดนี้</div>${esc(lv.next_visit_plan)}</div>` : ''}
    </div>`);
  el.dataset.lastRom = JSON.stringify(lv.rom);
}

function renderForm(el, phase, data, canWrite, session, reload) {
  const a = data[phase] || {};
  const signed = Boolean(a.signed_at);
  const editable = canWrite && !signed && (!a.id || a.created_by === session.user.id);
  const dis = editable ? '' : 'disabled';
  const lastRom = new Map((data.lastVisit?.rom || []).map((r) => [romKey(r), r.degrees]));
  const title = phase === 'pre' ? 'Pre-Treatment Assessment' : 'Post-Treatment Progress Note';

  el.innerHTML = card(`
    <form class="p-5 space-y-4" data-phase="${phase}">
      <div class="flex items-center justify-between">
        <h2 class="font-semibold">${title}</h2>
        ${signed ? `<span class="text-xs rounded-full bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200 px-2 py-0.5">🔒 ลงนามแล้ว ${fmtDateTime(a.signed_at)}</span>` : a.id ? '<span class="text-xs text-slate-500">แบบร่าง</span>' : ''}
      </div>

      <div>
        <div class="flex items-center justify-between text-sm"><span class="font-medium">Pain score (NRS 0–10)</span>
          <span data-pain-val class="text-2xl font-bold" style="color:${painColor(a.pain_score)}">${a.pain_score ?? '–'}</span></div>
        <input name="pain_score" type="range" min="0" max="10" step="1" value="${a.pain_score ?? 0}" class="pain w-full" ${dis}>
        <div class="flex justify-between text-[10px] text-slate-400"><span>ไม่ปวด</span><span>ปวดปานกลาง</span><span>ปวดมากที่สุด</span></div>
      </div>

      ${phase === 'pre' ? `
        <div class="grid sm:grid-cols-2 gap-3">
          <label class="text-sm">ตำแหน่งที่ปวด<input name="pain_location" class="${input}" value="${esc(a.pain_location || '')}" ${dis}></label>
          <label class="text-sm">ลักษณะอาการปวด<input name="pain_character" class="${input}" value="${esc(a.pain_character || '')}" placeholder="ตื้อ / แปลบ / ร้าว" ${dis}></label>
        </div>
        <div class="grid grid-cols-4 gap-2 text-sm">
          ${[['bp_sys', 'SBP'], ['bp_dia', 'DBP'], ['hr', 'HR'], ['spo2', 'SpO₂']].map(([k, l]) => `<label>${l}<input name="v_${k}" type="number" class="${input}" value="${a.vitals?.[k] ?? ''}" ${dis}></label>`).join('')}
        </div>
        <label class="text-sm block">Subjective (อาการที่ผู้ป่วยเล่า)<textarea name="subjective" rows="2" class="${input}" ${dis}>${esc(a.subjective || '')}</textarea></label>
        <label class="text-sm block">Red flags / ข้อสังเกต<textarea name="red_flags" rows="1" class="${input}" ${dis}>${esc(a.red_flags || '')}</textarea></label>
        <label class="flex items-center gap-2 text-sm rounded-lg bg-rose-50 px-3 py-2">
          <input name="precautions_reviewed" type="checkbox" ${a.precautions_reviewed ? 'checked' : ''} ${dis}>
          ทบทวนข้อควรระวัง/ข้อห้ามของผู้ป่วยแล้ว (${data.activePrecautions.length} รายการ)
        </label>` : `
        <div class="grid sm:grid-cols-2 gap-3 text-sm">
          <label>การตอบสนองต่อการรักษา
            <select name="treatment_response" class="${input}" ${dis}>
              <option value="">–</option>
              ${[['improved', 'ดีขึ้น'], ['unchanged', 'คงเดิม'], ['worsened', 'แย่ลง']].map(([v, l]) => `<option value="${v}" ${a.treatment_response === v ? 'selected' : ''}>${l}</option>`).join('')}
            </select></label>
          <label>เหตุการณ์ไม่พึงประสงค์<input name="adverse_events" class="${input}" value="${esc(a.adverse_events || '')}" ${dis}></label>
        </div>
        <div>
          <div class="text-sm font-medium mb-1">การรักษาที่ให้</div>
          <div data-treatments class="space-y-2">${(a.treatments || []).map((t) => treatmentRow(t, data.appointment.equipment, dis)).join('')}</div>
          ${editable ? btn('+ เพิ่มการรักษา', 'data-add-tx', 'ghost') : ''}
        </div>
        <label class="text-sm block">Assessment<textarea name="assessment" rows="2" class="${input}" ${dis}>${esc(a.assessment || '')}</textarea></label>
        <label class="text-sm block">Home program<textarea name="home_program" rows="2" class="${input}" ${dis}>${esc(a.home_program || '')}</textarea></label>
        <label class="text-sm block">แผนสำหรับนัดถัดไป<textarea name="next_visit_plan" rows="2" class="${input}" ${dis}>${esc(a.next_visit_plan || '')}</textarea></label>`}

      <div>
        <div class="flex items-center justify-between mb-1"><span class="text-sm font-medium">Range of Motion (องศา)</span><span class="text-xs text-slate-400">Δ เทียบนัดก่อนหน้า</span></div>
        <div class="overflow-x-auto"><table class="w-full text-sm">
          <thead class="text-xs text-slate-500 text-left"><tr><th>ข้อต่อ</th><th>การเคลื่อนไหว</th><th>ข้าง</th><th>A/P</th><th class="w-20">องศา</th><th class="w-20">ปกติ</th><th>%</th><th>Δ</th><th></th></tr></thead>
          <tbody data-rom>${(a.rom || []).map((r) => romRow(r, lastRom, dis)).join('')}</tbody>
        </table></div>
        ${editable ? btn('+ เพิ่ม ROM', 'data-add-rom', 'ghost') : ''}
      </div>

      ${editable ? `<div class="flex gap-2 pt-2 border-t border-slate-100">${btn('บันทึกแบบร่าง', 'data-save', 'ghost')}${a.id ? btn('ลงนาม (Sign)', 'data-sign') : ''}</div>` : ''}
      ${signed && canWrite ? `
        <div class="pt-3 border-t border-slate-100 space-y-2">
          <div class="text-sm font-medium">Addendum</div>
          ${(a.addenda || []).map((x) => `<div class="text-sm rounded bg-slate-50 p-2"><span class="text-xs text-slate-400">${fmtDateTime(x.created_at)}</span> ${esc(x.content)}</div>`).join('')}
          <div class="flex gap-2"><input data-addendum class="${input}" placeholder="บันทึกเพิ่มเติม (แก้ไขเวชระเบียนที่ลงนามแล้วไม่ได้)">${btn('เพิ่ม', 'data-add-addendum', 'ghost')}</div>
        </div>` : ''}
    </form>`);

  const form = $('form', el);
  const pain = $('[name=pain_score]', form);
  pain.style.setProperty('--pain-color', painColor(Number(pain.value)));
  pain.addEventListener('input', () => {
    const v = Number(pain.value);
    $('[data-pain-val]', form).textContent = v;
    $('[data-pain-val]', form).style.color = painColor(v);
    pain.style.setProperty('--pain-color', painColor(v));
  });

  // ROM: เพิ่มแถว + คำนวณ %/Δ แบบสด
  const recalc = (tr) => {
    const deg = Number($('[data-f=degrees]', tr).value);
    const nor = Number($('[data-f=normal_degrees]', tr).value);
    $('[data-pct]', tr).textContent = nor ? `${Math.round((deg / nor) * 100)}%` : '';
    const prev = lastRom.get(romKey(readRom(tr)));
    const d = prev == null || $('[data-f=degrees]', tr).value === '' ? null : deg - prev;
    $('[data-delta]', tr).innerHTML = d == null ? '' : `<span class="${d > 0 ? 'text-emerald-600' : d < 0 ? 'text-rose-600' : 'text-slate-400'}">${d > 0 ? '+' : ''}${d}°</span>`;
  };
  form.addEventListener('input', (e) => { const tr = e.target.closest('tr[data-rom-row]'); if (tr) recalc(tr); });
  form.addEventListener('change', (e) => {
    const tr = e.target.closest('tr[data-rom-row]');
    if (!tr) return;
    if (e.target.dataset.f === 'joint') {
      $('[data-f=movement]', tr).innerHTML = JOINTS[e.target.value].map((m) => `<option>${m}</option>`).join('');
    }
    if (['joint', 'movement'].includes(e.target.dataset.f)) {
      const n = NORMAL[`${$('[data-f=joint]', tr).value}.${$('[data-f=movement]', tr).value}`];
      if (n != null) $('[data-f=normal_degrees]', tr).value = n;
    }
    recalc(tr);
  });
  $$('tr[data-rom-row]', form).forEach(recalc);
  $('[data-add-rom]', form)?.addEventListener('click', () => {
    $('[data-rom]', form).insertAdjacentHTML('beforeend', romRow({ joint: 'shoulder', movement: 'flexion', side: 'right', mode: 'active', normal_degrees: 180 }, lastRom, ''));
  });
  form.addEventListener('click', (e) => { if (e.target.closest('[data-del-row]')) e.target.closest('tr, [data-tx-row]').remove(); });
  $('[data-add-tx]', form)?.addEventListener('click', () => {
    $('[data-treatments]', form).insertAdjacentHTML('beforeend', treatmentRow({}, data.appointment.equipment ?? [], ''));
  });

  $('[data-save]', form)?.addEventListener('click', async () => {
    try {
      await api.put(`/emr/appointments/${data.appointment.id}/${phase}`, collect(form, phase));
      toast('บันทึกแล้ว', 'success');
      reload();
    } catch (err) { showError(err); }
  });
  $('[data-sign]', form)?.addEventListener('click', async () => {
    if (!confirm('ลงนามแล้วจะแก้ไขไม่ได้ ยืนยัน?')) return;
    try {
      await api.put(`/emr/appointments/${data.appointment.id}/${phase}`, collect(form, phase));
      await api.post(`/emr/assessments/${a.id}/sign`);
      toast('ลงนามเรียบร้อย', 'success');
      reload();
    } catch (err) {
      if (err.details?.missing) toast(`ข้อมูลไม่ครบ: ${err.details.missing.join(', ')}`, 'warn'); else showError(err);
    }
  });
  $('[data-add-addendum]', form)?.addEventListener('click', async () => {
    const content = $('[data-addendum]', form).value.trim();
    if (!content) return;
    try { await api.post(`/emr/assessments/${a.id}/addenda`, { content }); reload(); } catch (err) { showError(err); }
  });
}

function romRow(r, lastRom, dis) {
  const sel = (f, opts, v) => `<select data-f="${f}" class="${input} !px-1" ${dis}>${opts.map((o) => `<option ${o === v ? 'selected' : ''}>${o}</option>`).join('')}</select>`;
  return `<tr data-rom-row class="align-middle">
    <td>${sel('joint', Object.keys(JOINTS), r.joint)}</td>
    <td>${sel('movement', JOINTS[r.joint] || [], r.movement)}</td>
    <td>${sel('side', ['left', 'right', 'na'], r.side || 'na')}</td>
    <td>${sel('mode', ['active', 'passive'], r.mode || 'active')}</td>
    <td><input data-f="degrees" type="number" step="0.5" class="${input} !px-1" value="${r.degrees ?? ''}" ${dis}></td>
    <td><input data-f="normal_degrees" type="number" class="${input} !px-1" value="${r.normal_degrees ?? ''}" ${dis}></td>
    <td data-pct class="text-xs text-slate-500"></td>
    <td data-delta class="text-xs"></td>
    <td>${dis ? '' : '<button type="button" data-del-row class="text-slate-400 hover:text-rose-600">✕</button>'}</td>
  </tr>`;
}

function treatmentRow(t, equipment, dis) {
  return `<div data-tx-row class="grid grid-cols-12 gap-2 items-center">
    <input data-t="intervention" class="${input} col-span-4" placeholder="Intervention" value="${esc(t.intervention || '')}" ${dis}>
    <select data-t="equipment_id" class="${input} col-span-4" ${dis}><option value="">– ไม่ใช้อุปกรณ์ –</option>
      ${equipment.map((e) => `<option value="${e.id}" ${e.id === t.equipment_id ? 'selected' : ''}>${esc(e.name)}</option>`).join('')}
      ${t.equipment_id && !equipment.some((e) => e.id === t.equipment_id) ? `<option value="${t.equipment_id}" selected>${esc(t.equipment_name || t.equipment_id)}</option>` : ''}</select>
    <input data-t="body_part" class="${input} col-span-2" placeholder="ตำแหน่ง" value="${esc(t.body_part || '')}" ${dis}>
    <input data-t="duration_min" type="number" class="${input} col-span-1 !px-1" placeholder="นาที" value="${t.duration_min ?? ''}" ${dis}>
    <div class="col-span-1">${dis ? '' : '<button type="button" data-del-row class="text-slate-400 hover:text-rose-600">✕</button>'}</div>
  </div>`;
}

const readRom = (tr) => ({
  joint: $('[data-f=joint]', tr).value,
  movement: $('[data-f=movement]', tr).value,
  side: $('[data-f=side]', tr).value,
  mode: $('[data-f=mode]', tr).value,
});

function collect(form, phase) {
  const f = new FormData(form);
  const s = (k) => (f.get(k) || '').toString().trim() || null;
  const body = { pain_score: Number(f.get('pain_score')) };
  body.rom = $$('tr[data-rom-row]', form)
    .filter((tr) => $('[data-f=degrees]', tr).value !== '')
    .map((tr) => ({
      ...readRom(tr),
      degrees: Number($('[data-f=degrees]', tr).value),
      normal_degrees: $('[data-f=normal_degrees]', tr).value === '' ? null : Number($('[data-f=normal_degrees]', tr).value),
    }));
  if (phase === 'pre') {
    Object.assign(body, {
      pain_location: s('pain_location'), pain_character: s('pain_character'), subjective: s('subjective'), red_flags: s('red_flags'),
      precautions_reviewed: f.get('precautions_reviewed') === 'on',
    });
    const vitals = {};
    for (const k of ['bp_sys', 'bp_dia', 'hr', 'spo2']) if (f.get(`v_${k}`)) vitals[k] = Number(f.get(`v_${k}`));
    body.vitals = Object.keys(vitals).length ? vitals : null;
  } else {
    Object.assign(body, {
      treatment_response: s('treatment_response'), adverse_events: s('adverse_events'), assessment: s('assessment'),
      home_program: s('home_program'), next_visit_plan: s('next_visit_plan'),
    });
    body.treatments = $$('[data-tx-row]', form).map((row) => ({
      intervention: $('[data-t=intervention]', row).value.trim(),
      equipment_id: $('[data-t=equipment_id]', row).value || null,
      body_part: $('[data-t=body_part]', row).value || null,
      duration_min: $('[data-t=duration_min]', row).value ? Number($('[data-t=duration_min]', row).value) : null,
    })).filter((t) => t.intervention);
  }
  return body;
}

// ---------------------------------------------------------------------
// Progress (เปรียบเทียบ baseline → ล่าสุด)
// ---------------------------------------------------------------------
const charts = [];
async function renderProgress(root, patientId) {
  const p = await api.get(`/emr/patients/${patientId}/progress`);
  const s = p.summary;
  root.innerHTML = `
    ${pageHeader(`ความก้าวหน้า · ${p.patient.first_name} ${p.patient.last_name}`, `HN ${esc(p.patient.hn)} · ${s.visits} visits`)}
    <div class="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
      ${[['Pain เริ่มต้น', s.baselinePain, painColor(s.baselinePain)], ['Pain ล่าสุด', s.latestPain, painColor(s.latestPain)],
        ['เปลี่ยนแปลง', s.baselinePain != null && s.latestPain != null ? s.latestPain - s.baselinePain : '–', '#0f172a'],
        ['ลดปวดทันทีเฉลี่ย/ครั้ง', s.avgImmediateRelief ?? '–', '#0f172a']]
        .map(([l, v, c]) => card(`<div class="p-4"><div class="text-xs text-slate-500">${l}</div><div class="text-3xl font-bold" style="color:${c}">${v ?? '–'}</div></div>`)).join('')}
    </div>
    <div class="grid xl:grid-cols-2 gap-5">
      ${card('<div class="p-4"><div class="font-semibold mb-2">Pain score ก่อน/หลังการรักษา</div><canvas id="pain-chart" height="180"></canvas></div>')}
      ${card(`<div class="p-4"><div class="font-semibold mb-2">ROM เทียบ baseline</div>
        <table class="w-full text-sm"><thead class="text-left text-xs text-slate-500"><tr><th>ข้อต่อ</th><th>Baseline</th><th>ล่าสุด</th><th>Δ baseline</th><th>Δ ก่อนหน้า</th><th>% ปกติ</th></tr></thead>
        <tbody class="divide-y divide-slate-100">${p.romSeries.map((r) => `<tr>
          <td class="py-1.5">${esc(r.joint)} ${esc(r.movement)} ${r.side !== 'na' ? esc(r.side) : ''}</td><td>${r.baseline}°</td><td>${r.latest}°</td>
          <td class="${r.changeFromBaseline > 0 ? 'text-emerald-600' : r.changeFromBaseline < 0 ? 'text-rose-600' : ''}">${r.changeFromBaseline > 0 ? '+' : ''}${r.changeFromBaseline}°</td>
          <td>${r.changeFromPrevious == null ? '–' : `${r.changeFromPrevious > 0 ? '+' : ''}${r.changeFromPrevious}°`}</td>
          <td>${r.pctOfNormal ?? '–'}%</td></tr>`).join('')}</tbody></table>
        <canvas id="rom-chart" height="180" class="mt-3"></canvas></div>`)}
    </div>`;

  charts.splice(0).forEach((c) => c.destroy());
  if (!window.Chart) return;
  const labels = p.visits.map((v) => fmtDate(v.start_at));
  charts.push(new window.Chart($('#pain-chart'), {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: 'ก่อนรักษา', data: p.visits.map((v) => v.pre_pain), borderColor: '#dc2626', backgroundColor: '#dc2626', tension: 0.3 },
        { label: 'หลังรักษา', data: p.visits.map((v) => v.post_pain), borderColor: '#16a34a', backgroundColor: '#16a34a', tension: 0.3 },
      ],
    },
    options: { scales: { y: { min: 0, max: 10, title: { display: true, text: 'NRS' } } }, plugins: { legend: { position: 'bottom' } } },
  }));
  const palette = ['#1d8fe0', '#8b5cf6', '#f59e0b', '#10b981', '#ef4444', '#64748b'];
  const romLabels = [...new Set(p.romSeries.flatMap((r) => r.points.map((pt) => ({ t: new Date(pt.at).getTime() + (pt.phase === 'post' ? 1 : 0), l: `${fmtDate(pt.at)} ${pt.phase}` }))).sort((a, b) => a.t - b.t).map((x) => x.l))];
  charts.push(new window.Chart($('#rom-chart'), {
    type: 'line',
    data: {
      labels: romLabels,
      datasets: p.romSeries.map((r, i) => ({
        label: `${r.joint} ${r.movement}${r.side !== 'na' ? ` (${r.side})` : ''}`,
        data: r.points.map((pt) => ({ x: `${fmtDate(pt.at)} ${pt.phase}`, y: pt.degrees })),
        borderColor: palette[i % palette.length], backgroundColor: palette[i % palette.length], tension: 0.3, spanGaps: true,
      })),
    },
    options: { parsing: true, scales: { x: { type: 'category' }, y: { title: { display: true, text: 'องศา' } } }, plugins: { legend: { position: 'bottom' } } },
  }));
  return () => charts.splice(0).forEach((c) => c.destroy());
}
