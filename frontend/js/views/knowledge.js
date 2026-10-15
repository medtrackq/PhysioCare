import { api } from '../api.js';
import { $, $$, esc, pageHeader, card, empty } from '../ui.js';

export const REC = {
  recommended: { th: 'แนะนำ', cls: 'bg-emerald-50 text-emerald-700 ring-emerald-200' },
  optional: { th: 'เสริมได้', cls: 'bg-sky-50 text-sky-700 ring-sky-200' },
  insufficient: { th: 'หลักฐานไม่พอ', cls: 'bg-slate-100 text-slate-600 ring-slate-200' },
  not_recommended: { th: 'ไม่แนะนำ', cls: 'bg-rose-50 text-rose-700 ring-rose-200' },
};
export const recBadge = (rec, grade) => {
  const r = REC[rec] || REC.insufficient;
  return `<span class="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset ${r.cls}">${r.th}${grade ? ` · ${esc(grade)}` : ''}</span>`;
};
export const sourceLink = (s) => (s
  ? `<a href="${esc(s.url)}" target="_blank" rel="noopener noreferrer" class="text-brand-600 hover:underline">${esc(s.organization)} ${esc(s.year)}</a>`
  : '');

const CATEGORY_TH = {
  exercise: 'การออกกำลังกาย', manual_therapy: 'Manual therapy', education: 'ให้ความรู้/ปรับพฤติกรรม',
  functional_training: 'ฝึกการเคลื่อนไหว/กิจวัตร', orthosis_taping: 'อุปกรณ์พยุง/เทป', modality: 'Modality', other: 'อื่น ๆ',
};

/** รายการวิธีรักษา จัดกลุ่มตามประเภท — ใช้ซ้ำในหน้าจอง/เวชระเบียน */
export function interventionsHtml(list, { compact = false } = {}) {
  if (!list.length) return empty('ยังไม่มีข้อมูลแนวทาง');
  const groups = {};
  list.forEach((i) => (groups[i.category] ||= []).push(i));
  return Object.entries(groups).map(([cat, items]) => `
    <div class="mb-3">
      <div class="text-xs uppercase tracking-wide text-slate-500 mb-1">${esc(CATEGORY_TH[cat] || cat)}</div>
      <ul class="space-y-1.5">${items.map((i) => `
        <li class="text-sm ${i.recommendation === 'not_recommended' ? 'text-slate-400' : ''}">
          <div class="flex flex-wrap items-center gap-1.5"><span class="font-medium">${esc(i.name_th)}</span>${recBadge(i.recommendation, i.grade)}</div>
          ${!compact && i.dosage ? `<div class="text-xs text-slate-600">ขนาด/ความถี่: ${esc(i.dosage)}</div>` : ''}
          ${!compact && i.notes ? `<div class="text-xs text-slate-500">${esc(i.notes)}</div>` : ''}
          ${!compact && i.source ? `<div class="text-[11px]">${sourceLink(i.source)}</div>` : ''}
        </li>`).join('')}</ul>
    </div>`).join('');
}

export async function render(root, { params }) {
  const list = await api.get('/knowledge/diagnoses');
  const selected = Number(params[0]) || list[0]?.id;
  root.innerHTML = `
    ${pageHeader('คลังแนวทางการรักษา', 'วิธีรักษาและอุปกรณ์ตามแนวทางเวชปฏิบัติ (Clinical Practice Guidelines) พร้อมระดับหลักฐานและแหล่งอ้างอิง')}
    <div class="mb-4 rounded-xl bg-amber-50 ring-1 ring-amber-200 px-4 py-3 text-sm text-amber-900">
      ข้อมูลนี้สรุปจากแนวทางเวชปฏิบัติสากลเพื่อช่วยการตัดสินใจ ไม่ใช่คำสั่งการรักษา นักกายภาพบำบัดต้องประเมินผู้ป่วยรายบุคคล และคลินิกควรให้คณะทำงานวิชาการทบทวนก่อนใช้งานจริง
    </div>
    <div class="grid lg:grid-cols-4 gap-5">
      <nav class="space-y-1">${list.map((d) => `
        <a href="#/guidelines/${d.id}" class="block rounded-lg px-3 py-2 text-sm ${d.id === selected ? 'bg-brand-50 text-brand-700 font-semibold' : 'hover:bg-white'}">
          <span class="font-mono text-xs text-slate-500">${esc(d.icd10_code)}</span> ${esc(d.name_th)}
          <span class="block text-[11px] text-slate-400">${d.interventions} วิธีรักษา · ${d.equipment} อุปกรณ์</span>
        </a>`).join('')}</nav>
      <div id="kb-detail" class="lg:col-span-3"></div>
    </div>`;
  if (selected) await renderDetail(selected);
}

async function renderDetail(id) {
  const d = await api.get(`/knowledge/diagnoses/${id}`);
  $('#kb-detail').innerHTML = `
    <div class="space-y-5">
      ${card(`<div class="p-5">
        <div class="text-sm text-slate-500 font-mono">${esc(d.icd10_code)}</div>
        <h2 class="text-lg font-bold">${esc(d.name_th)} <span class="font-normal text-slate-500">· ${esc(d.name_en)}</span></h2>
        ${d.summary_th ? `<p class="text-sm text-slate-700 mt-2">${esc(d.summary_th)}</p>` : ''}
        ${d.red_flags ? `<div class="mt-3 rounded-lg bg-rose-50 ring-1 ring-rose-200 px-3 py-2 text-sm text-rose-800"><b>Red flags / ข้อควรระวัง:</b> ${esc(d.red_flags)}</div>` : ''}
        ${d.specialties.length ? `<div class="mt-3 flex flex-wrap gap-1 text-xs">ความเชี่ยวชาญที่เหมาะสม: ${d.specialties.map((s) => `<span class="rounded-full bg-slate-100 px-2 py-0.5">${esc(s.name_en)} ${Math.round(s.weight * 100)}%</span>`).join('')}</div>` : ''}
      </div>`)}
      <div class="grid xl:grid-cols-2 gap-5">
        ${card(`<div class="p-5"><h3 class="font-semibold mb-3">วิธีการรักษา</h3>${interventionsHtml(d.interventions)}</div>`)}
        ${card(`<div class="p-5"><h3 class="font-semibold mb-3">อุปกรณ์/Modality</h3>
          ${d.equipment.length ? `<ul class="space-y-2">${d.equipment.map((e) => `
            <li class="text-sm ${e.recommendation === 'not_recommended' ? 'opacity-70' : ''}">
              <div class="flex flex-wrap items-center gap-1.5"><span class="font-medium">${esc(e.name_th)}</span>${recBadge(e.recommendation, e.grade)}
                <span class="text-[11px] text-slate-400">ในคลินิก ${e.units_available} เครื่อง</span></div>
              ${e.rationale ? `<div class="text-xs text-slate-500">${esc(e.rationale)}</div>` : ''}
              ${e.source ? `<div class="text-[11px]">${sourceLink(e.source)}</div>` : ''}
            </li>`).join('')}</ul>` : empty('ไม่มีข้อมูล')}</div>`)}
      </div>
      ${card(`<div class="p-5"><h3 class="font-semibold mb-2">แหล่งอ้างอิง</h3>
        <ol class="list-decimal pl-5 text-sm space-y-1">${d.sources.map((s) => `<li>${esc(s.title)} — ${esc(s.organization)}, ${esc(s.year)}. <a class="text-brand-600 hover:underline break-all" href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">${esc(s.url)}</a></li>`).join('')}</ol></div>`)}
    </div>`;
}
