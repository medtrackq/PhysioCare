/**
 * แปลง FHIR R4 ↔ ข้อมูลในระบบ PhysioCare (pure functions — ไม่แตะฐานข้อมูล)
 *
 * ขาเข้า (HIS → PhysioCare)
 *   Location (physicalType lvl/ro/wa/bd) → ชั้น / ห้อง / เตียง
 *   Practitioner                          → บุคลากร (นักกายภาพ)
 *   Device                                → อุปกรณ์
 *   Patient                               → ผู้ป่วย (เฉพาะข้อมูลที่จำเป็น — ไม่เก็บเลขบัตรประชาชน)
 *   Condition (ICD-10)                    → การวินิจฉัยของผู้ป่วย
 *   ServiceRequest                        → ใบสั่งส่งกายภาพ (referral)
 * ขาออก (PhysioCare → HIS)
 *   Appointment, Observation (Pain NRS 0–10, LOINC 72514-3)
 */
const ICD10 = 'http://hl7.org/fhir/sid/icd-10';
const EXT = 'https://physiocare.app/fhir/StructureDefinition/';

const first = (arr) => (Array.isArray(arr) && arr.length ? arr[0] : null);
const codings = (cc) => (Array.isArray(cc) ? cc : cc ? [cc] : []).flatMap((c) => c?.coding || []);
const ext = (r, name) => (r.extension || []).find((e) => e.url === EXT + name || e.url === name);
const trimOrNull = (v) => (v === undefined || v === null || String(v).trim() === '' ? null : String(v).trim());
const dateOnly = (v) => (v ? String(v).slice(0, 10) : null);

/** เลือก identifier: ตรง system ที่ตั้งไว้ → ตรง type code → ตัวแรก */
function identifier(r, { system, typeCodes = [] } = {}, fallbackFirst = true) {
  const ids = r.identifier || [];
  const bySystem = system && ids.find((i) => i.system === system && i.value);
  if (bySystem) return bySystem.value;
  const byType = ids.find((i) => i.value && codings(i.type).some((c) => typeCodes.includes(c.code)));
  if (byType) return byType.value;
  return fallbackFirst ? first(ids.filter((i) => i.value))?.value || null : null;
}

function humanName(names) {
  const n = (names || []).find((x) => x.use === 'official') || first(names) || {};
  const given = (n.given || []).join(' ').trim();
  let family = trimOrNull(n.family);
  let firstName = trimOrNull(given);
  if (!firstName && n.text) {
    const parts = n.text.trim().split(/\s+/);
    firstName = parts.shift();
    family = family || parts.join(' ') || null;
  }
  return { title: trimOrNull(first(n.prefix)), firstName, lastName: family };
}

const telecom = (r, system) => trimOrNull((r.telecom || []).find((t) => t.system === system)?.value);

// ------------------------------------------------------------------ inbound
function locationKind(r) {
  const codes = codings(r.physicalType).map((c) => c.code);
  if (codes.includes('bd')) return 'bed';
  if (codes.includes('lvl') || codes.includes('bu')) return 'floor';
  return 'room'; // ro, wa, area, wi … หรือไม่ระบุ
}

function mapLocation(r, settings) {
  const kind = locationKind(r);
  const code = trimOrNull(identifier(r)) || trimOrNull(first(r.alias)) || r.id;
  const active = !['inactive', 'suspended'].includes(r.status);
  const out = { kind, code, name: trimOrNull(r.name) || code, active, partOf: r.partOf || null };
  if (kind === 'room') {
    const typeCode = codings(r.type).map((c) => c.code).find((c) => settings.roomTypeMap?.[c]);
    out.roomType = typeCode ? settings.roomTypeMap[typeCode] : null;
  }
  if (kind === 'bed') {
    // HL7 v2 table 0116: C=Closed, K=Contaminated, I=Isolated, H=Housekeeping, O=Occupied, U=Unoccupied
    const op = r.operationalStatus?.code;
    out.bedStatus = op === 'C' ? 'out_of_service' : ['K', 'I'].includes(op) ? 'maintenance' : 'available';
  }
  return out;
}

function mapPractitioner(r, settings) {
  const sys = settings.identifierSystems || {};
  const n = humanName(r.name);
  const license = identifier(r, { system: sys.license, typeCodes: ['PRN', 'LN', 'MD'] }, false)
    || trimOrNull(first(r.qualification)?.identifier?.[0]?.value);
  const employee = identifier(r, { system: sys.employee, typeCodes: ['EI'] }, false);
  return {
    employee_code: employee || license || `HIS-${r.id}`,
    title: n.title,
    first_name: n.firstName,
    last_name: n.lastName || '-',
    // นักกายภาพต้องมีเลขใบอนุญาต (constraint ในฐานข้อมูล) — ไม่มีให้เป็นผู้ช่วย
    position: license ? (settings.practitionerPosition || 'physiotherapist') : 'assistant',
    license_no: license,
    license_expiry: dateOnly(first(r.qualification)?.period?.end),
    phone: telecom(r, 'phone'),
    email: telecom(r, 'email'),
    is_active: r.active !== false,
  };
}

/** หมวดอุปกรณ์จาก Device.type: ตาราง map ใน settings → รหัสหมวดตรงกัน → ชื่อหมวดอยู่ในข้อความ */
function deviceCategory(r, settings, categories) {
  const map = settings.deviceCategoryMap || {};
  const cs = codings(r.type);
  for (const c of cs) {
    const hit = map[`${c.system}|${c.code}`] || map[c.code];
    if (hit) return categories.find((k) => k.code === hit) || null;
  }
  for (const c of cs) {
    const hit = categories.find((k) => k.code.toLowerCase() === String(c.code || '').toLowerCase());
    if (hit) return hit;
  }
  const text = [r.type?.text, ...cs.map((c) => c.display), ...(r.deviceName || []).map((d) => d.name)].filter(Boolean).join(' ').toLowerCase();
  return categories.find((k) => text.includes(k.code.toLowerCase()) || (k.name_en && text.includes(k.name_en.toLowerCase()))) || null;
}

function mapDevice(r, settings, categories) {
  const sys = settings.identifierSystems || {};
  const cat = deviceCategory(r, settings, categories);
  const price = ext(r, 'purchase-price');
  return {
    category: cat,
    data: {
      asset_code: identifier(r, { system: sys.asset }) || r.serialNumber || r.id,
      name: trimOrNull(first(r.deviceName)?.name) || trimOrNull(r.type?.text) || cat?.name_th || r.id,
      category_id: cat?.id ?? null,
      brand: trimOrNull(r.manufacturer),
      model: trimOrNull(r.modelNumber),
      serial_no: trimOrNull(r.serialNumber),
      purchase_date: dateOnly(ext(r, 'purchase-date')?.valueDate),
      purchase_price: price?.valueMoney?.value ?? price?.valueDecimal ?? null,
      vendor: trimOrNull(ext(r, 'vendor')?.valueString),
      warranty_expiry: dateOnly(ext(r, 'warranty-expiry')?.valueDate || r.expirationDate),
    },
    retired: ['inactive', 'entered-in-error'].includes(r.status),
    location: r.location || null,
  };
}

function mapPatient(r, settings) {
  const sys = settings.identifierSystems || {};
  const n = humanName(r.name);
  const addr = first(r.address);
  return {
    hn: identifier(r, { system: sys.hn, typeCodes: ['MR'] }),
    title: n.title,
    first_name: n.firstName,
    last_name: n.lastName || '-',
    date_of_birth: dateOnly(r.birthDate),
    gender: ['male', 'female', 'other'].includes(r.gender) ? r.gender : null,
    phone: telecom(r, 'phone'),
    email: telecom(r, 'email'),
    address: trimOrNull(addr?.text || [...(addr?.line || []), addr?.district, addr?.city, addr?.postalCode].filter(Boolean).join(' ')),
  };
}

/** รหัส ICD-10 ที่ระบบรู้จัก (เทียบกับตาราง diagnoses) */
function icd10Of(cc, knownCodes) {
  const cs = codings(cc);
  const pick = cs.find((c) => (c.system || '').toLowerCase().includes('icd-10') && knownCodes.has(c.code))
    || cs.find((c) => knownCodes.has(c.code));
  return pick?.code || null;
}

function mapCondition(r, knownCodes) {
  const clinical = codings(r.clinicalStatus).map((c) => c.code)[0];
  return {
    icd10: icd10Of(r.code, knownCodes),
    rawCode: codings(r.code).map((c) => c.code).filter(Boolean).join(', ') || r.code?.text || '',
    status: ['resolved', 'inactive', 'remission'].includes(clinical) ? 'resolved' : 'active',
    onset_date: dateOnly(r.onsetDateTime || r.onsetPeriod?.start),
    subject: r.subject,
  };
}

function mapServiceRequest(r, knownCodes) {
  const prio = ['routine', 'urgent', 'asap', 'stat'].includes(r.priority) ? r.priority : 'routine';
  const qty = r.quantityQuantity?.value;
  return {
    icd10: icd10Of(r.reasonCode, knownCodes),
    reasonReference: first(r.reasonReference),
    requester: trimOrNull(r.requester?.display),
    priority: prio,
    sessions_requested: Number.isInteger(qty) && qty > 0 && qty <= 100 ? qty : null,
    note: trimOrNull((r.note || []).map((x) => x.text).filter(Boolean).join('\n')) || trimOrNull(r.code?.text),
    authored_at: r.authoredOn || null,
    cancelled: ['revoked', 'entered-in-error'].includes(r.status),
    completed: r.status === 'completed',
    subject: r.subject,
  };
}

// ------------------------------------------------------------------ outbound
const APPT_STATUS = {
  booked: 'booked', confirmed: 'booked', checked_in: 'checked-in', in_progress: 'arrived',
  completed: 'fulfilled', cancelled: 'cancelled', no_show: 'noshow',
};

function localSystem(settings, kind) {
  return `${settings.identifierSystems?.local || 'urn:physiocare'}:${kind}`;
}

/** อ้างถึง resource ใน HIS: ใช้ id ของ HIS ถ้าเคยซิงก์ ไม่งั้นอ้างด้วย identifier */
function actorRef(externalId, identifierSystem, identifierValue, display) {
  if (externalId) return { reference: externalId, display };
  if (identifierValue) return { identifier: { system: identifierSystem || undefined, value: identifierValue }, display };
  return { display };
}

function buildAppointment(a, refs, settings) {
  const sys = settings.identifierSystems || {};
  const participant = [
    { actor: actorRef(refs.patient, sys.hn, a.hn, a.patient_name), required: 'required', status: 'accepted' },
    { actor: actorRef(refs.staff, sys.license, a.license_no, a.therapist_name), required: 'required', status: 'accepted' },
  ];
  const where = refs.bed || refs.room;
  if (where || a.bed_name || a.room_name) {
    participant.push({ actor: actorRef(where, null, null, [a.room_name, a.bed_name].filter(Boolean).join(' / ')), status: 'accepted' });
  }
  return {
    resourceType: 'Appointment',
    identifier: [{ system: localSystem(settings, 'appointment'), value: a.id }],
    status: APPT_STATUS[a.status] || 'booked',
    serviceType: [{ coding: [{ system: 'http://snomed.info/sct', code: '91251008', display: 'Physical therapy procedure' }], text: 'กายภาพบำบัด' }],
    reasonCode: a.icd10_code ? [{ coding: [{ system: ICD10, code: a.icd10_code, display: a.diagnosis_name || undefined }] }] : undefined,
    ...(refs.referral ? { basedOn: [{ reference: refs.referral }] } : {}),
    start: new Date(a.start_at).toISOString(),
    end: new Date(a.end_at).toISOString(),
    minutesDuration: Math.round((new Date(a.end_at) - new Date(a.start_at)) / 60000),
    participant,
  };
}

function buildPainObservation(x, refs, settings) {
  const sys = settings.identifierSystems || {};
  return {
    resourceType: 'Observation',
    identifier: [{ system: localSystem(settings, 'assessment'), value: `${x.id}-pain` }],
    status: 'final',
    category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: 'survey' }] }],
    code: {
      coding: [{ system: 'http://loinc.org', code: '72514-3', display: 'Pain severity - 0-10 verbal numeric rating [Score] - Reported' }],
      text: x.phase === 'pre' ? 'Pain NRS ก่อนการรักษา' : 'Pain NRS หลังการรักษา',
    },
    subject: actorRef(refs.patient, sys.hn, x.hn, x.patient_name),
    performer: [actorRef(refs.staff, sys.license, x.license_no, x.therapist_name)],
    effectiveDateTime: new Date(x.signed_at).toISOString(),
    valueInteger: x.pain_score,
    bodySite: x.pain_location ? { text: x.pain_location } : undefined,
  };
}

module.exports = {
  ICD10, EXT, locationKind, mapLocation, mapPractitioner, mapDevice, mapPatient, mapCondition, mapServiceRequest,
  buildAppointment, buildPainObservation, localSystem,
};
