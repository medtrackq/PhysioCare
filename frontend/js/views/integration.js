import { api } from '../api.js';
import { $, esc, pageHeader, btn, card, empty, toast, showError, modal, formModal, fmtDateTime, input } from '../ui.js';

/**
 * เชื่อมต่อระบบโรงพยาบาล (HIS) — ฟังก์ชันเสริม
 * ผู้ดูแลตั้งค่า connector, นำเข้าไฟล์ FHIR (ทดลองก่อนนำเข้าจริง), ดึงข้อมูลจาก HIS, ดูใบส่งกายภาพ และคิวส่งกลับ
 */
const ENTITY_TH = {
  room: 'ห้อง', bed: 'เตียง', staff: 'บุคลากร', equipment: 'อุปกรณ์', patient: 'ผู้ป่วย',
  patient_diagnosis: 'การวินิจฉัย', referral: 'ใบส่งกายภาพ', floor: 'ชั้น/อาคาร',
};
const ACTION_TH = { created: 'สร้างใหม่', updated: 'อัปเดต', linked: 'ผูกกับข้อมูลเดิม', unchanged: 'ไม่เปลี่ยน', skipped: 'ข้าม', failed: 'ผิดพลาด' };
const ACTION_CLS = {
  created: 'text-emerald-700', updated: 'text-sky-700', linked: 'text-violet-700', unchanged: 'text-slate-400', skipped: 'text-amber-700', failed: 'text-rose-600',
};
const INBOUND = [
  ['locations', 'ห้อง/เตียง (Location)'], ['practitioners', 'บุคลากร (Practitioner)'], ['devices', 'อุปกรณ์ (Device)'],
  ['patients', 'ผู้ป่วย (Patient)'], ['conditions', 'การวินิจฉัย ICD-10 (Condition)'], ['serviceRequests', 'ใบส่งกายภาพ (ServiceRequest)'],
];
const OUTBOUND = [['appointments', 'นัดหมาย (Appointment)'], ['observations', 'Pain score หลังลงนาม (Observation)']];
const PRIORITY_TH = { routine: 'ปกติ', urgent: 'ด่วน', asap: 'ด่วนมาก', stat: 'ฉุกเฉิน' };
const REF_STATUS_TH = { pending: 'รอนัด', scheduled: 'นัดแล้ว', completed: 'เสร็จสิ้น', cancelled: 'ยกเลิก' };
const OUTBOX_TH = { pending: 'รอส่ง', sent: 'ส่งแล้ว', failed: 'ส่งไม่สำเร็จ (จะลองใหม่)', dead: 'หยุดส่ง' };

export async function render(root) {
  root.innerHTML = `
    ${pageHeader('เชื่อมต่อระบบโรงพยาบาล (HIS)',
    'ฟังก์ชันเสริม: รับข้อมูลห้อง เตียง บุคลากร อุปกรณ์ ผู้ป่วย และใบส่งกายภาพจาก HIS ผ่านมาตรฐาน HL7 FHIR R4 เพื่อไม่ต้องกรอกซ้ำ และส่งนัดหมาย/ผลประเมินกลับได้',
    btn('+ เพิ่มการเชื่อมต่อ', 'id="ig-new"'))}
    <div id="ig-connectors" class="space-y-4 mb-8"></div>
    <div class="grid xl:grid-cols-2 gap-6">
      <section>
        <div class="flex items-center justify-between mb-2"><h2 class="font-semibold">ใบส่งกายภาพจาก HIS</h2>
          <select id="ig-ref-status" class="${input} max-w-[140px]">${Object.entries(REF_STATUS_TH).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></div>
        <div id="ig-referrals"></div>
      </section>
      <section>
        <div class="flex items-center justify-between mb-2"><h2 class="font-semibold">คิวส่งข้อมูลกลับ HIS</h2>
          <div class="flex gap-2"><select id="ig-ob-status" class="${input} max-w-[180px]"><option value="">ทั้งหมด</option>${Object.entries(OUTBOX_TH).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select>
          ${btn('ส่งตอนนี้', 'id="ig-ob-run"', 'ghost')}</div></div>
        <div id="ig-outbox"></div>
      </section>
    </div>`;

  let connectors = [];
  async function load() {
    connectors = await api.get('/integration/connectors');
    const el = $('#ig-connectors');
    if (!connectors.length) {
      el.innerHTML = card(`<div class="p-6 text-sm text-slate-600 space-y-2">
        <div class="font-semibold text-slate-800">ยังไม่ได้เชื่อมต่อกับระบบโรงพยาบาล</div>
        <p>ระบบทำงานได้ครบโดยไม่ต้องเชื่อมต่อ ถ้าโรงพยาบาลมีระบบ HIS ที่ส่งข้อมูลแบบ HL7 FHIR ได้ (หรือผ่าน interface engine เช่น Mirth Connect)
        ให้กด "+ เพิ่มการเชื่อมต่อ" แล้วทดลองนำเข้าไฟล์ตัวอย่างก่อนเปิดใช้งานจริง</p>
        <p class="text-xs text-slate-500">ไฟล์ตัวอย่าง: docs/integration/sample-bundle.json · คู่มือ: docs/INTEGRATION.md</p></div>`);
      return;
    }
    el.innerHTML = connectors.map(connectorCard).join('');
  }

  function connectorCard(c) {
    const s = c.settings || {};
    const endpoint = `${location.origin}/api/integration/inbound/${c.code}/fhir`;
    const refs = Object.entries(c.ref_counts || {}).map(([k, n]) => `${ENTITY_TH[k] || k} ${n}`).join(' · ') || 'ยังไม่มีข้อมูลที่ซิงก์';
    const ob = c.outbox_counts || {};
    const run = c.last_run;
    const on = (flag, group) => (group?.[flag] === false ? '<span class="text-slate-400 line-through">' : '<span>');
    return card(`<div class="p-5 space-y-3" data-c="${c.id}">
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div class="flex items-center gap-2"><h3 class="font-semibold text-lg">${esc(c.name)}</h3>
            <span class="text-xs rounded-full px-2 py-0.5 ${c.is_enabled ? 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200' : 'bg-slate-100 text-slate-500 ring-1 ring-slate-200'}">${c.is_enabled ? 'เปิดใช้งาน' : 'ปิดอยู่'}</span></div>
          <div class="text-xs text-slate-500">รหัส ${esc(c.code)} · FHIR R4${c.base_url ? ` · ${esc(c.base_url)}` : ' · ยังไม่ตั้ง URL ของ HIS (รับข้อมูลเข้าอย่างเดียว)'}</div>
        </div>
        <div class="flex flex-wrap gap-2">
          ${btn('นำเข้าไฟล์ FHIR', 'data-act="import"', 'ghost')}
          ${c.base_url ? btn('ดึงจาก HIS', 'data-act="pull"', 'ghost') + btn('ทดสอบการเชื่อมต่อ', 'data-act="test"', 'ghost') : ''}
          ${btn('ประวัติ', 'data-act="runs"', 'ghost')}
          ${btn('สร้างกุญแจเข้ารหัส', 'data-act="genkey"', 'ghost')}
          ${btn('ตั้งค่า', 'data-act="edit"', 'ghost')}
        </div>
      </div>
      <div class="grid md:grid-cols-3 gap-3 text-sm">
        <div class="rounded-lg bg-slate-50 p-3"><div class="text-xs text-slate-500 mb-1">รับจาก HIS</div>
          ${INBOUND.map(([k, l]) => `${on(k, s.inbound)}${l}</span>`).join('<br>')}</div>
        <div class="rounded-lg bg-slate-50 p-3"><div class="text-xs text-slate-500 mb-1">ส่งกลับ HIS</div>
          ${OUTBOUND.map(([k, l]) => (s.outbound?.[k] ? `<span>${l}</span>` : `<span class="text-slate-400 line-through">${l}</span>`)).join('<br>')}
          <div class="text-xs mt-2">${['pending', 'failed', 'dead', 'sent'].filter((k) => ob[k]).map((k) => `${OUTBOX_TH[k]} ${ob[k]}`).join(' · ') || 'ยังไม่มีงาน'}</div>
          <div class="text-xs mt-1">${encLine(c)}</div>
          ${c.auth_secret_env ? `<div class="text-xs mt-1 ${c.auth_env_present ? 'text-slate-500' : 'text-rose-600'}">token: ${esc(c.auth_secret_env)} ${c.auth_env_present ? '✓' : '(ยังไม่ได้ตั้งค่าในเซิร์ฟเวอร์)'}</div>` : ''}</div>
        <div class="rounded-lg bg-slate-50 p-3"><div class="text-xs text-slate-500 mb-1">ข้อมูลที่ซิงก์แล้ว</div>${refs}
          ${run ? `<div class="text-xs text-slate-500 mt-2">ล่าสุด ${fmtDateTime(run.started_at)} · ${run.mode}${run.dry_run ? ' (ทดลอง)' : ''} · ${run.status}</div>` : ''}</div>
      </div>
      <details class="text-sm"><summary class="cursor-pointer text-slate-600">ปลายทางสำหรับ HIS ส่งข้อมูลเข้ามา (push)</summary>
        <div class="mt-2 space-y-1">
          <div><span class="text-slate-500">URL:</span> <code class="text-xs bg-slate-100 rounded px-1.5 py-0.5 break-all">POST ${esc(endpoint)}</code></div>
          <div><span class="text-slate-500">Header:</span> <code class="text-xs bg-slate-100 rounded px-1.5 py-0.5">X-Api-Key: pchis_…${esc(c.inbound_key_hint || '')}</code>
            ${btn('สร้าง API key ใหม่', 'data-act="rotate"', 'ghost')}</div>
          <div class="text-xs text-slate-500">ส่ง FHIR Bundle หรือ resource เดี่ยว (Content-Type: application/fhir+json) · เติม ?dryRun=true เพื่อทดลองโดยไม่บันทึก</div>
        </div></details>
    </div>`);
  }

  function encLine(c) {
    const e = c.settings?.encryption;
    if (e?.mode !== 'required') return '<span class="text-slate-500">เข้ารหัสชั้นที่ 2: ปิด (ใช้ HTTPS อย่างเดียว)</span>';
    const st = { ok: '✓ พร้อม', missing: '(ยังไม่ได้ตั้งค่าในเซิร์ฟเวอร์)', invalid: '(ค่ากุญแจไม่ถูกต้อง ต้องยาว 32 ไบต์)' }[c.encryption_key_status] || '';
    return `<span class="${c.encryption_key_status === 'ok' ? 'text-emerald-700' : 'text-rose-600'}">🔐 เข้ารหัสชั้นที่ 2: บังคับ · ${esc(e.keyEnv)} ${st}</span>`;
  }

  function showNewKey(c) {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const key = btoa(String.fromCharCode(...bytes));
    const envName = c.settings?.encryption?.keyEnv || 'HIS_PAYLOAD_KEY';
    const m = modal('กุญแจเข้ารหัสชั้นที่ 2', `
      <p class="text-sm mb-2">สร้างในเบราว์เซอร์นี้ ระบบ<b>ไม่ได้บันทึก</b>ค่านี้ไว้ — ทำ 2 อย่างก่อนปิดหน้าต่าง:</p>
      <ol class="text-sm list-decimal pl-5 mb-3 space-y-1">
        <li>Railway → Variables → เพิ่ม <code>${esc(envName)}</code> = ค่าด้านล่าง (ระบบจะ deploy ใหม่เอง)</li>
        <li>ส่งค่าเดียวกันให้ฝ่าย IT โรงพยาบาลผ่านช่องทางที่ปลอดภัย (เช่น แจ้งด้วยวาจา/password manager) <b>ไม่ส่งทางอีเมลหรือแชตปกติ</b></li>
      </ol>
      <div class="flex gap-2"><input id="ig-enckey" class="${input} font-mono text-xs" readonly value="${esc(key)}">${btn('คัดลอก', 'id="ig-enccopy"')}</div>
      <p class="text-xs text-slate-500 mt-2">เปลี่ยนกุญแจเมื่อสงสัยว่ารั่ว: สร้างใหม่ → ตั้งค่าทั้งสองฝั่งพร้อมกัน ระหว่างนั้นข้อความที่ใช้กุญแจเก่าจะถูกปฏิเสธ</p>`);
    $('#ig-enccopy', m.el).addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(key); toast('คัดลอกแล้ว', 'success'); } catch { $('#ig-enckey', m.el).select(); }
    });
  }

  // ---------- connector form ----------
  function openConnectorForm(c) {
    const s = c?.settings || {};
    const sys = s.identifierSystems || {};
    const mapText = (m) => Object.entries(m || {}).map(([k, v]) => `${k}=${v}`).join('\n');
    const parseMap = (t) => Object.fromEntries(String(t || '').split(/\n+/).map((l) => l.split('=').map((x) => x.trim())).filter(([k, v]) => k && v));
    formModal(c ? `ตั้งค่า ${c.name}` : 'เพิ่มการเชื่อมต่อ HIS', [
      { name: 'name', label: 'ชื่อ', required: true, value: c?.name, hint: 'เช่น HIS โรงพยาบาล…' },
      { name: 'code', label: 'รหัส (ใช้ใน URL)', required: true, value: c?.code, hint: 'a-z 0-9 _ - เช่น main-his', attrs: c ? 'readonly' : '' },
      { name: 'baseUrl', label: 'FHIR base URL ของ HIS', value: c?.base_url, full: true, hint: 'เว้นว่างได้ถ้า HIS ส่งข้อมูลเข้ามาอย่างเดียว · ต้องมีเพื่อดึงข้อมูล/ส่งกลับ' },
      { name: 'authSecretEnv', label: 'ชื่อตัวแปร token (environment variable)', value: c?.auth_secret_env, hint: 'เช่น HIS_TOKEN — ตั้งค่าจริงใน Railway Variables ไม่เก็บในฐานข้อมูล' },
      { name: 'isEnabled', label: 'เปิดใช้งาน', type: 'checkbox', value: c ? c.is_enabled : false },
      ...INBOUND.map(([k, l]) => ({ name: `in_${k}`, label: `รับ: ${l}`, type: 'checkbox', value: s.inbound?.[k] !== false })),
      { name: 'in_bedStatus', label: 'รับสถานะเตียงจาก HIS (ปิด/ปนเปื้อน)', type: 'checkbox', value: Boolean(s.inbound?.bedStatus) },
      ...OUTBOUND.map(([k, l]) => ({ name: `out_${k}`, label: `ส่งกลับ: ${l}`, type: 'checkbox', value: Boolean(s.outbound?.[k]) })),
      { name: 'sysHn', label: 'Identifier system ของ HN', value: sys.hn, full: true, hint: 'URI ที่ HIS ใช้กับ HN (ถ้าไม่ระบุ ใช้ identifier ชนิด MR หรือตัวแรก)' },
      { name: 'sysLicense', label: 'Identifier system ของเลขใบอนุญาต', value: sys.license, full: true },
      { name: 'sysEmployee', label: 'Identifier system ของรหัสพนักงาน', value: sys.employee },
      { name: 'sysAsset', label: 'Identifier system ของรหัสครุภัณฑ์', value: sys.asset },
      { name: 'deviceMap', label: 'จับคู่ชนิดอุปกรณ์ของ HIS → หมวดในระบบ', type: 'textarea', full: true, value: mapText(s.deviceCategoryMap),
        hint: 'บรรทัดละคู่ เช่น 6515-001=US หรือ system|code=TENS · หมวด: US TENS IFC NMES SWD HOTPACK COLDPACK TRACTION SHOCKWAVE LASER CPM TILT PARALLEL TREADMILL CYCLE' },
      { name: 'roomMap', label: 'จับคู่ชนิดห้องของ HIS → ประเภทห้อง', type: 'textarea', full: true, value: mapText(s.roomTypeMap),
        hint: 'เช่น GYM=gym, PED=pediatric (treatment private gym pediatric hydro consult)' },
      { name: 'allowedIps', label: 'IP ที่อนุญาตให้ส่งเข้า (คั่นด้วย ,)', value: (s.allowedIps || []).join(', '), full: true, hint: 'เว้นว่าง = ไม่จำกัด (ยังต้องใช้ API key)' },
      { name: 'encRequired', label: 'บังคับเข้ารหัสข้อมูลชั้นที่ 2 (JWE · AES-256-GCM) ทั้งขาเข้าและขาออก', type: 'checkbox', full: true, value: s.encryption?.mode === 'required' },
      { name: 'encKeyEnv', label: 'ชื่อตัวแปรกุญแจเข้ารหัส', value: s.encryption?.keyEnv || 'HIS_PAYLOAD_KEY', full: true,
        hint: 'ค่ากุญแจ (32 ไบต์) ตั้งใน Railway → Variables ด้วยชื่อนี้ และฝ่าย IT โรงพยาบาลใช้ค่าเดียวกัน — กดปุ่ม "สร้างกุญแจ" ที่การ์ดการเชื่อมต่อ' },
    ], async (v, m) => {
      const settings = {
        ...s,
        inbound: { ...Object.fromEntries(INBOUND.map(([k]) => [k, v[`in_${k}`]])), bedStatus: v.in_bedStatus },
        outbound: Object.fromEntries(OUTBOUND.map(([k]) => [k, v[`out_${k}`]])),
        identifierSystems: Object.fromEntries(Object.entries({ hn: v.sysHn, license: v.sysLicense, employee: v.sysEmployee, asset: v.sysAsset, local: sys.local }).filter(([, x]) => x)),
        deviceCategoryMap: parseMap(v.deviceMap),
        roomTypeMap: parseMap(v.roomMap),
        allowedIps: String(v.allowedIps || '').split(',').map((x) => x.trim()).filter(Boolean),
        encryption: { mode: v.encRequired ? 'required' : 'off', keyEnv: v.encKeyEnv || null },
      };
      const body = { name: v.name, baseUrl: v.baseUrl || null, authSecretEnv: v.authSecretEnv || null, isEnabled: v.isEnabled, settings };
      if (c) {
        await api.patch(`/integration/connectors/${c.id}`, body);
        toast('บันทึกการตั้งค่าแล้ว', 'success');
        m.close();
      } else {
        const created = await api.post('/integration/connectors', { ...body, code: v.code });
        m.close();
        showKey(created.inboundKey, created.code);
      }
      load();
    }, { wide: true, submitLabel: c ? 'บันทึก' : 'สร้าง' });
  }

  function showKey(key, code) {
    const m = modal('API key สำหรับ HIS', `
      <p class="text-sm mb-2">คัดลอกเก็บไว้ตอนนี้ ระบบจะ<b>ไม่แสดงอีก</b> (เก็บเฉพาะค่า hash) ใช้ใส่ header <code>X-Api-Key</code> เมื่อ HIS ส่งข้อมูลมาที่</p>
      <code class="block text-xs bg-slate-100 rounded p-2 mb-3 break-all">POST ${esc(location.origin)}/api/integration/inbound/${esc(code)}/fhir</code>
      <div class="flex gap-2"><input id="ig-key" class="${input} font-mono text-xs" readonly value="${esc(key)}">${btn('คัดลอก', 'id="ig-copy"')}</div>`);
    $('#ig-copy', m.el).addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(key); toast('คัดลอกแล้ว', 'success'); } catch { $('#ig-key', m.el).select(); }
    });
  }

  // ---------- import / pull preview ----------
  function resultHtml(r) {
    const s = r.stats;
    const head = `<div class="grid grid-cols-3 sm:grid-cols-6 gap-2 mb-3 text-center text-sm">
      ${['created', 'updated', 'linked', 'unchanged', 'skipped', 'failed'].map((k) => `<div class="rounded-lg bg-slate-50 p-2"><div class="text-xl font-bold ${ACTION_CLS[k]}">${s[k] || 0}</div><div class="text-[11px] text-slate-500">${ACTION_TH[k]}</div></div>`).join('')}
    </div>`;
    const pulled = r.pulled ? `<div class="text-xs text-slate-500 mb-2">ดึงมา: ${Object.entries(r.pulled).map(([k, n]) => `${k} ${n}`).join(' · ')}</div>` : '';
    const rows = (r.items || []).map((i) => `<tr class="border-t border-slate-100"><td class="py-1 pr-2 ${ACTION_CLS[i.action]} whitespace-nowrap">${ACTION_TH[i.action] || i.action}</td>
      <td class="py-1 pr-2">${esc(i.label || i.key)}</td><td class="py-1 text-xs text-slate-500">${esc(i.note || '')}</td></tr>`).join('');
    return `${pulled}${head}<div class="max-h-[45vh] overflow-auto"><table class="w-full text-sm">${rows || '<tr><td class="text-slate-400 py-4">ไม่มีรายการ</td></tr>'}</table></div>`;
  }

  async function previewThenApply(c, title, runDry, runReal) {
    let r;
    try { r = await runDry(); } catch (err) { showError(err); return; }
    const m = modal(title, `
      <div class="mb-3 rounded-lg bg-amber-50 text-amber-800 text-sm px-3 py-2">ผลการทดลอง (ยังไม่บันทึก) — ตรวจรายการด้านล่างก่อนกดนำเข้าจริง</div>
      ${resultHtml(r)}
      <div class="mt-4 flex gap-2">${btn('นำเข้าจริง', 'id="ig-apply"')}${btn('ยกเลิก', 'id="ig-cancel"', 'ghost')}</div>`, { wide: true });
    $('#ig-cancel', m.el).addEventListener('click', () => m.close());
    $('#ig-apply', m.el).addEventListener('click', async (e) => {
      e.target.disabled = true;
      try {
        const done = await runReal();
        $('.mb-3', m.el).outerHTML = '<div class="mb-3 rounded-lg bg-emerald-50 text-emerald-800 text-sm px-3 py-2">นำเข้าเรียบร้อย</div>';
        m.el.querySelector('.max-h-\\[45vh\\]').parentElement.innerHTML = resultHtml(done);
        toast(`นำเข้าแล้ว: สร้าง ${done.stats.created} · อัปเดต ${done.stats.updated} · ผูก ${done.stats.linked}`, 'success');
        load(); loadReferrals();
      } catch (err) { showError(err); e.target.disabled = false; }
    });
  }

  function importFile(c) {
    const picker = document.createElement('input');
    picker.type = 'file';
    picker.accept = '.json,application/json,application/fhir+json';
    picker.addEventListener('change', async () => {
      const file = picker.files[0];
      if (!file) return;
      let bundle;
      try { bundle = JSON.parse(await file.text()); } catch { toast('ไฟล์ไม่ใช่ JSON ที่ถูกต้อง', 'error'); return; }
      previewThenApply(c, `นำเข้า ${file.name}`,
        () => api.post(`/integration/connectors/${c.id}/import?dryRun=true`, bundle),
        () => api.post(`/integration/connectors/${c.id}/import?dryRun=false`, bundle));
    });
    picker.click();
  }

  async function showRuns(c) {
    const runs = await api.get(`/integration/connectors/${c.id}/runs`);
    modal(`ประวัติการซิงก์ · ${c.name}`, runs.length ? `<div class="max-h-[60vh] overflow-auto"><table class="w-full text-sm">
      <tr class="text-left text-xs text-slate-500"><th class="py-1">เวลา</th><th>วิธี</th><th>ผล</th><th>สรุป</th></tr>
      ${runs.map((r) => `<tr class="border-t border-slate-100 align-top"><td class="py-1 pr-2 whitespace-nowrap">${fmtDateTime(r.started_at)}</td>
        <td class="pr-2">${esc(r.mode)}${r.dry_run ? ' (ทดลอง)' : ''}<div class="text-xs text-slate-500">${esc(r.started_by_name || 'HIS')}</div></td>
        <td class="pr-2">${esc(r.status)}</td>
        <td class="text-xs">${Object.entries(r.stats || {}).filter(([k, n]) => n && k !== 'total').map(([k, n]) => `${ACTION_TH[k] || k} ${n}`).join(' · ')}
          ${(r.errors || []).slice(0, 5).map((e) => `<div class="text-rose-600">${esc(e.key || '')} ${esc(e.message)}</div>`).join('')}</td></tr>`).join('')}
    </table></div>` : empty('ยังไม่มีประวัติ'), { wide: true });
  }

  $('#ig-new').addEventListener('click', () => openConnectorForm(null));
  $('#ig-connectors').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const c = connectors.find((x) => x.id === Number(b.closest('[data-c]').dataset.c));
    const act = b.dataset.act;
    try {
      if (act === 'edit') openConnectorForm(c);
      else if (act === 'import') importFile(c);
      else if (act === 'runs') await showRuns(c);
      else if (act === 'genkey') showNewKey(c);
      else if (act === 'test') {
        const r = await api.post(`/integration/connectors/${c.id}/test`);
        toast(r.ok ? `เชื่อมต่อได้ · FHIR ${r.fhirVersion || '?'}${r.software ? ` · ${r.software}` : ''}` : `เชื่อมต่อไม่ได้: ${r.error}`, r.ok ? 'success' : 'error');
      } else if (act === 'pull') {
        previewThenApply(c, `ดึงข้อมูลจาก ${c.name}`,
          () => api.post(`/integration/connectors/${c.id}/pull`, { dryRun: true }),
          () => api.post(`/integration/connectors/${c.id}/pull`, { dryRun: false }));
      } else if (act === 'rotate') {
        if (!confirm('สร้าง API key ใหม่? key เดิมจะใช้ไม่ได้ทันที ต้องแก้ค่าที่ HIS ด้วย')) return;
        const r = await api.post(`/integration/connectors/${c.id}/rotate-key`);
        showKey(r.inboundKey, c.code);
        load();
      }
    } catch (err) { showError(err); }
  });

  // ---------- referrals ----------
  async function loadReferrals() {
    const rows = await api.get(`/integration/referrals?status=${$('#ig-ref-status').value}`);
    $('#ig-referrals').innerHTML = rows.length ? card(`<div class="divide-y divide-slate-100">${rows.map((r) => `
      <div class="p-3 text-sm flex flex-wrap items-start justify-between gap-2">
        <div><div class="font-medium">${esc(r.patient_name)} <span class="text-xs text-slate-500">${esc(r.hn)}</span>
          ${r.priority !== 'routine' ? `<span class="ml-1 text-xs rounded-full px-2 py-0.5 bg-rose-50 text-rose-700">${PRIORITY_TH[r.priority]}</span>` : ''}</div>
          <div class="text-xs text-slate-500">${esc(r.icd10_code || '')} ${esc(r.diagnosis_name || '')}${r.sessions_requested ? ` · ${r.sessions_requested} ครั้ง` : ''} · ${esc(r.requester || '')}</div>
          ${r.note ? `<div class="text-xs mt-1">${esc(r.note)}</div>` : ''}</div>
        <select data-ref="${r.id}" class="${input} max-w-[130px]">${Object.entries(REF_STATUS_TH).map(([k, v]) => `<option value="${k}" ${k === r.status ? 'selected' : ''}>${v}</option>`).join('')}</select>
      </div>`).join('')}</div>`) : empty('ไม่มีใบส่งกายภาพในสถานะนี้');
  }
  $('#ig-ref-status').addEventListener('change', loadReferrals);
  $('#ig-referrals').addEventListener('change', async (e) => {
    const sel = e.target.closest('[data-ref]');
    if (!sel) return;
    try { await api.patch(`/integration/referrals/${sel.dataset.ref}`, { status: sel.value }); toast('อัปเดตแล้ว', 'success'); loadReferrals(); } catch (err) { showError(err); }
  });

  // ---------- outbox ----------
  async function loadOutbox() {
    const st = $('#ig-ob-status').value;
    const rows = await api.get(`/integration/outbox${st ? `?status=${st}` : ''}`);
    $('#ig-outbox').innerHTML = rows.length ? card(`<div class="max-h-[50vh] overflow-auto"><table class="w-full text-sm">
      ${rows.map((o) => `<tr class="border-t border-slate-100 align-top"><td class="p-2 whitespace-nowrap">${esc(o.resource_type)}<div class="text-[11px] text-slate-500">${esc(o.connector_code)} · ${fmtDateTime(o.created_at)}</div></td>
        <td class="p-2">${OUTBOX_TH[o.status]}${o.attempts ? ` <span class="text-xs text-slate-500">(${o.attempts} ครั้ง)</span>` : ''}
          ${o.last_error ? `<div class="text-xs text-rose-600 break-all">${esc(o.last_error)}</div>` : ''}</td>
        <td class="p-2 text-right">${['failed', 'dead'].includes(o.status) ? btn('ส่งใหม่', `data-retry="${o.id}"`, 'ghost') : ''}</td></tr>`).join('')}
    </table></div>`) : empty('ไม่มีงานในคิว');
  }
  $('#ig-ob-status').addEventListener('change', loadOutbox);
  $('#ig-outbox').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-retry]');
    if (!b) return;
    try { await api.post(`/integration/outbox/${b.dataset.retry}/retry`); toast('เข้าคิวส่งใหม่แล้ว', 'success'); loadOutbox(); } catch (err) { showError(err); }
  });
  $('#ig-ob-run').addEventListener('click', async () => {
    try {
      const r = await api.post('/integration/outbox/process');
      toast(`ส่งแล้ว ${r.sent} · ไม่สำเร็จ ${r.failed}${r.skipped ? ` · ข้าม ${r.skipped}` : ''}`, r.failed ? 'warn' : 'success');
      loadOutbox(); load();
    } catch (err) { showError(err); }
  });

  await Promise.all([load(), loadReferrals(), loadOutbox()]);
}
