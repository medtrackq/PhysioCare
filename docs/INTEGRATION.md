# เชื่อมต่อระบบโรงพยาบาล (HIS) — ฟังก์ชันเสริม

> **Optional:** ระบบ PhysioCare ทำงานครบโดยไม่ต้องเชื่อมต่อ โมดูลนี้ไม่มีผลใด ๆ จนกว่าผู้ดูแลจะสร้าง connector และเปิดใช้งาน
> (เมนู **เชื่อมต่อ HIS** เห็นเฉพาะผู้ที่มีสิทธิ์ `integration:manage` = ผู้ดูแลระบบ)

## 1. เป้าหมาย

ลดการกรอกข้อมูลซ้ำระหว่างระบบโรงพยาบาลกับระบบกายภาพ:

| ข้อมูล | ปัญหาถ้าไม่เชื่อม | เมื่อเชื่อมแล้ว |
|---|---|---|
| ห้อง / เตียง | ตั้งรหัสสองที่ ชื่อไม่ตรงกัน | HIS เป็นต้นฉบับ รหัสห้อง/เตียงตรงกันทุกระบบ |
| นักกายภาพ | ลาออก/ต่อใบอนุญาต ต้องแก้สองที่ | ชื่อ เลขใบอนุญาต วันหมดอายุ มาจาก HIS |
| อุปกรณ์ | ทะเบียนครุภัณฑ์ซ้ำกับงานพัสดุ | รหัสครุภัณฑ์ ยี่ห้อ รุ่น S/N ราคา มาจาก HIS |
| ผู้ป่วย | ลงทะเบียนใหม่ทุกคน HN พิมพ์ผิด | มากับใบส่งตัว ไม่ต้องลงทะเบียนเอง |
| การวินิจฉัย / ใบส่งกายภาพ | แพทย์เขียนกระดาษ แล้วพิมพ์ใหม่ | ใบส่ง (ICD-10, จำนวนครั้ง, ความเร่งด่วน) ขึ้นที่หน้าตารางนัด กด "จองนัด" ได้ทันที |
| นัดหมาย / ผลประเมิน | HIS ไม่รู้ว่านัดแล้วหรือยัง | ส่งนัดหมายและ Pain score กลับ HIS อัตโนมัติ |

## 2. สถาปัตยกรรม

```
                 ┌─────────────────────────── HIS โรงพยาบาล ───────────────────────────┐
                 │  FHIR R4 server   หรือ   HL7 v2 / ฐานข้อมูล → interface engine (Mirth) │
                 └──────┬───────────────────────────▲───────────────────────▲──────────┘
         (1) push       │ POST /inbound/:code/fhir  │ (2) pull GET [base]/… │ (3) PUT [base]/Appointment?identifier=…
         X-Api-Key      ▼                           │  Bearer HIS_TOKEN     │     PUT [base]/Observation?identifier=…
 ┌────────────────────────────────────── PhysioCare ──────────────────────────────────────┐
 │  integration.routes ──► sync.service (map FHIR → ข้อมูลหลัก, ตรวจซ้ำ, dry-run)          │
 │                           │                                                             │
 │                           ▼                                                             │
 │  external_refs (id HIS ↔ id ระบบ)   integration_runs (ประวัติ)   referrals (ใบส่ง)       │
 │  rooms/beds/staff/equipment/patients.managed_by  → ล็อกฟิลด์ที่ HIS เป็นเจ้าของ          │
 │                                                                                          │
 │  appointments / clinical_assessments ──trigger──► integration_outbox ──worker 15s──► (3) │
 └──────────────────────────────────────────────────────────────────────────────────────────┘
```

- **มาตรฐานเดียวขาเข้า:** HL7 FHIR R4 (JSON) — HIS ที่ยังไม่รองรับ FHIR (เช่น ส่ง HL7 v2 หรือมีแค่ฐานข้อมูล) ให้ใช้ interface engine (เช่น Mirth/NextGen Connect ซึ่งเป็น open source) แปลงเป็น FHIR แล้ว push เข้ามา ระบบนี้จึงไม่ต้องเขียนตัวแปลงเฉพาะยี่ห้อ HIS
- **รับได้ 3 แบบ:** HIS push เข้ามา, PhysioCare ไปดึง (pull) เป็นรอบ, หรือผู้ดูแลอัปโหลดไฟล์ Bundle เอง (ใช้ทดลองก่อนเปิดจริง)
- **ทุกครั้งทดลองก่อนได้ (dry-run):** ระบบทำงานจริงทุกขั้นแล้ว ROLLBACK จึงเห็นผลตรงกับการนำเข้าจริง

## 3. เจ้าของข้อมูล (field ownership)

record ที่มาจาก HIS จะมี `managed_by = <รหัส connector>` ฟิลด์ที่ HIS เป็นเจ้าของ **แก้ในระบบนี้ไม่ได้** (API ตอบ 409 `HIS_MANAGED`, ฟอร์มแสดงเป็นช่องสีเทา)
ส่วนข้อมูลการทำงานของแผนกกายภาพยังแก้ได้ตามปกติ

| ข้อมูล | HIS เป็นเจ้าของ | PhysioCare เป็นเจ้าของ |
|---|---|---|
| ห้อง | รหัส ชื่อ ชั้น เปิด/ปิดใช้ | ประเภทห้อง ความจุ ผัง 3D |
| เตียง | รหัส ชื่อ ห้อง เปิด/ปิดใช้ (สถานะปิด/ปนเปื้อน ถ้าเปิดตัวเลือก) | ชนิดเตียง สถานะซ่อม ผัง 3D |
| บุคลากร | รหัสพนักงาน คำนำหน้า ชื่อ-สกุล ตำแหน่ง เลข/วันหมดอายุใบอนุญาต โทร อีเมล สถานะ | ความเชี่ยวชาญ กะงาน วันลา สีปฏิทิน รับผู้ป่วยสูงสุด/วัน |
| อุปกรณ์ | รหัสครุภัณฑ์ ชื่อ หมวด ยี่ห้อ รุ่น S/N วันที่/ราคาซื้อ ผู้ขาย หมดประกัน, ปลดระวาง | สถานะใช้งาน/ชำรุด/ซ่อม ประวัติบำรุงรักษา ห้องที่ติดตั้ง ผัง 3D รูปภาพ |
| ผู้ป่วย | HN คำนำหน้า ชื่อ-สกุล วันเกิด เพศ โทร อีเมล ที่อยู่ | แพ้ยา ผู้ติดต่อฉุกเฉิน ข้อควรระวังทางกายภาพ เวชระเบียน |
| ใบส่งกายภาพ | ผู้ป่วย โรค แพทย์ ความเร่งด่วน จำนวนครั้ง หมายเหตุ, ยกเลิก/ปิดงาน | สถานะงาน (รอนัด → นัดแล้ว → เสร็จ) |

รายการฟิลด์อยู่ที่ `backend/src/services/integration/ownership.js` (ใช้ร่วมกันทั้ง API และฟอร์ม)

## 4. การจับคู่ FHIR → ข้อมูลในระบบ

| FHIR R4 | ในระบบ | จับคู่ record เดิม (ครั้งแรก) | หมายเหตุ |
|---|---|---|---|
| `Location` physicalType `lvl`/`bu` | ชื่อชั้น/อาคาร | – | ใช้เติมช่อง "ชั้น" ของห้องที่อ้าง `partOf` |
| `Location` physicalType `ro`/`wa`/อื่น ๆ | ห้อง | รหัสห้อง (`identifier` → `alias` → id) | `type` แปลงเป็นประเภทห้องด้วย `roomTypeMap` |
| `Location` physicalType `bd` | เตียง | รหัสเตียง | ต้องมี `partOf` ชี้ห้อง; `operationalStatus` C → งดใช้, K/I → ปิดซ่อม (เมื่อเปิด `bedStatus`) |
| `Practitioner` | บุคลากร | เลขใบอนุญาต → รหัสพนักงาน | identifier ชนิด PRN/LN = ใบอนุญาต, EI = รหัสพนักงาน; ไม่มีใบอนุญาต → ตำแหน่งผู้ช่วย |
| `Device` | อุปกรณ์ | รหัสครุภัณฑ์ → S/N | หมวดจาก `type` ผ่าน `deviceCategoryMap` (เช่น `6515-001=US`); `location` → ห้องที่ติดตั้ง; วันที่/ราคาซื้อใช้ extension ด้านล่าง |
| `Patient` | ผู้ป่วย | HN | **ไม่เก็บเลขบัตรประชาชน** (หลักการเก็บเท่าที่จำเป็นตาม PDPA) |
| `Condition` | การวินิจฉัยของผู้ป่วย | ผู้ป่วย + รหัสโรค | รับเฉพาะ ICD-10 ที่อยู่ในฐานความรู้ของระบบ (รหัสอื่นข้ามพร้อมเหตุผล) |
| `ServiceRequest` | ใบส่งกายภาพ | ผู้ป่วย + เวลาสั่ง + แพทย์ | `reasonCode`/`reasonReference` → โรค, `quantityQuantity` → จำนวนครั้ง, `priority`, `requester.display` |

Extension สำหรับ Device (ไม่บังคับ): `https://physiocare.app/fhir/StructureDefinition/purchase-date` (valueDate),
`…/purchase-price` (valueMoney), `…/vendor` (valueString), `…/warranty-expiry` (valueDate)

**กันข้อมูลซ้ำ 3 ชั้น**

1. `external_refs` จำว่า id ไหนของ HIS คือ record ไหนในระบบ → ส่งซ้ำกี่ครั้งก็อัปเดต record เดิม
2. ครั้งแรกที่เจอ ถ้ามี record เดิมที่รหัสตรงกัน → **ผูก (linked)** แทนการสร้างใหม่ — ใช้ได้กับคลินิกที่กรอกข้อมูลไว้ก่อนเชื่อมต่อ
3. hash ของข้อมูลที่แปลงแล้ว → ข้อมูลไม่เปลี่ยนก็ไม่เขียนฐานข้อมูล (นับเป็น "ไม่เปลี่ยน")

รายการที่ผิดพลาด (เช่น เตียงที่ไม่มีห้อง อุปกรณ์ที่จับคู่หมวดไม่ได้) ล้มเฉพาะรายการนั้นพร้อมเหตุผล รายการอื่นนำเข้าได้ตามปกติ

## 5. ส่งข้อมูลกลับ HIS (เลือกเปิดเอง)

| เหตุการณ์ | FHIR ที่ส่ง | ตัวเลือก |
|---|---|---|
| จอง / เลื่อน / เปลี่ยนนักกายภาพ / เปลี่ยนเตียง / ยกเลิก / มาตามนัด / เสร็จ / ไม่มา | `Appointment` (SNOMED 91251008 Physical therapy, ICD-10, ผู้ป่วย นักกายภาพ ห้อง/เตียง) | `outbound.appointments` |
| ลงนามผลประเมินที่มี Pain score | `Observation` LOINC 72514-3 (Pain 0–10) | `outbound.observations` |

- trigger ในฐานข้อมูลเติมคิว `integration_outbox` (ทุกช่องทางที่แก้นัด รวมถึงการแก้ผ่าน SQL ถูกจับได้หมด)
- worker ในเซิร์ฟเวอร์ส่งทุก 15 วินาทีด้วย **conditional update** `PUT [base]/Appointment?identifier=urn:physiocare:appointment|<id>` → HIS สร้างหรืออัปเดตเอง ส่งซ้ำไม่เกิดข้อมูลซ้ำ
- สร้าง payload จากข้อมูลล่าสุดตอนส่ง (ไม่เก็บสำเนาข้อมูลผู้ป่วยในคิว) และงานที่รอของ record เดียวกันรวมเป็นงานเดียว
- ล้มเหลว → ลองใหม่ 1, 2, 4 … นาที (สูงสุด 6 ชม.) ครบ 10 ครั้ง หรือ HIS ตอบ 400/422 → "หยุดส่ง" ผู้ดูแลกด "ส่งใหม่" ได้
- ปิด worker ได้ด้วย `INTEGRATION_WORKER=false` (เช่นเมื่อรันหลาย instance แล้วต้องการให้ส่งจากเครื่องเดียว — แต่ระบบมี lease กันส่งซ้ำอยู่แล้ว)

## 6. API

**HIS → PhysioCare (ไม่ใช้ JWT)**

```
POST /api/integration/inbound/{code}/fhir[?dryRun=true]
X-Api-Key: pchis_…
Content-Type: application/fhir+json

{ "resourceType": "Bundle", "entry": [ … ] }      ← หรือ resource เดี่ยว / array (สูงสุด 10 MB)
```
ตอบเป็น `OperationOutcome` พร้อม `stats` (created/updated/linked/unchanged/skipped/failed) และรายการผลต่อ resource

**ผู้ดูแล (JWT + สิทธิ์ `integration:manage`)**

| Method | Path | ใช้ทำอะไร |
|---|---|---|
| GET / POST | `/api/integration/connectors` | ดูรายการ / สร้าง (ได้ API key ครั้งเดียว) |
| PATCH | `/api/integration/connectors/:id` | ตั้งค่า เปิด/ปิด |
| POST | `/api/integration/connectors/:id/rotate-key` | สร้าง API key ใหม่ (key เดิมใช้ไม่ได้ทันที) |
| POST | `/api/integration/connectors/:id/import?dryRun=true\|false` | นำเข้าไฟล์ Bundle |
| POST | `/api/integration/connectors/:id/pull` `{resources, dryRun}` | ดึงจาก HIS (ค่าเริ่มต้น Location, Practitioner, Device, ServiceRequest+ผู้ป่วยที่ถูกส่งตัว) |
| POST | `/api/integration/connectors/:id/test` | ทดสอบ `GET [base]/metadata` |
| GET | `/api/integration/connectors/:id/runs` | ประวัติการซิงก์ |
| GET / POST | `/api/integration/outbox`, `/outbox/:id/retry`, `/outbox/process` | ดูคิวส่งกลับ / ส่งใหม่ / ส่งทันที |
| GET / PATCH | `/api/integration/referrals` | ใบส่งกายภาพ (ผู้ที่ดูนัดทั้งหมดได้ / ผู้จองนัด) |

การดึง (pull) ใช้ `_lastUpdated=gt<เวลาล่าสุดที่ได้>` จึงดึงเฉพาะที่เปลี่ยน และ **ไม่ดึงผู้ป่วยทั้งโรงพยาบาล** — ดึงเฉพาะผู้ป่วยที่ถูกส่งมากายภาพผ่าน `ServiceRequest?_include=ServiceRequest:subject`

## 7. ความปลอดภัยและ PDPA

- API key สุ่ม 256 บิต เก็บเฉพาะ SHA-256 เปรียบเทียบแบบ timing-safe จำกัด 60 ครั้ง/นาที/IP และกำหนด IP ที่อนุญาตได้
- token สำหรับเรียก HIS **ไม่เก็บในฐานข้อมูล** — เก็บเป็น environment variable ที่ชื่อต้องขึ้นต้นด้วย `HIS_` (กันการตั้งค่าให้ส่ง `JWT_SECRET`/`DATABASE_URL` ออกไป)
- ตามลิงก์หน้าถัดไปเฉพาะเซิร์ฟเวอร์เดียวกับ base URL, ไม่ตาม redirect, timeout 20 วินาที
- รับเฉพาะข้อมูลที่จำเป็นต่อการรักษา (ไม่เก็บเลขบัตรประชาชน) ส่งกลับเฉพาะเมื่อผู้ดูแลเปิดเอง
- ทุกการนำเข้า/ตั้งค่าบันทึกใน audit log และ `integration_runs`
- ควรใช้ HTTPS ทั้งสองทาง และทำข้อตกลงการประมวลผลข้อมูล (DPA) กับฝ่าย IT โรงพยาบาลก่อนเปิดใช้งานจริง

## 8. ขั้นตอนเปิดใช้งาน

1. เมนู **เชื่อมต่อ HIS → + เพิ่มการเชื่อมต่อ** ตั้งชื่อและรหัส (เช่น `main-his`) → **คัดลอก API key เก็บไว้** (แสดงครั้งเดียว)
2. กด **นำเข้าไฟล์ FHIR** เลือก `docs/integration/sample-bundle.json` → ดูผลทดลอง → กด "นำเข้าจริง" เพื่อดูว่าข้อมูลไปอยู่ตรงไหน
3. ขอไฟล์ Bundle ตัวอย่างจากฝ่าย IT โรงพยาบาล → ทดลองนำเข้า ตั้ง `deviceCategoryMap` / `roomTypeMap` / identifier system ให้ครบจนไม่มีรายการผิดพลาด
4. ส่ง URL + API key ให้ฝ่าย IT ตั้งให้ HIS (หรือ interface engine) push ข้อมูลเข้ามา **หรือ** ใส่ FHIR base URL แล้วตั้ง token:
   Railway → Variables → `HIS_TOKEN=…` แล้วใส่ชื่อ `HIS_TOKEN` ในช่อง "ชื่อตัวแปร token" → กด **ทดสอบการเชื่อมต่อ** → **ดึงจาก HIS**
5. (ไม่บังคับ) เปิด "ส่งกลับ: นัดหมาย" เมื่อ HIS พร้อมรับ แล้วดูผลที่ **คิวส่งข้อมูลกลับ HIS**

## 9. ต่อยอดได้ (ยังไม่ทำ)

- `PractitionerRole.specialty` → ความเชี่ยวชาญ (ตอนนี้กำหนดในระบบกายภาพ)
- รับ `Schedule`/`Slot` ของ HIS เพื่อจองนัดจากระบบนัดกลางของโรงพยาบาล
- `Encounter` / ค่าบริการ / สิทธิการรักษา (เบิกจ่าย) และ `DocumentReference` สำหรับสรุปผลกายภาพเป็น PDF
- ยืนยันตัวแบบ SMART Backend Services (OAuth2 client credentials) หรือ mTLS แทน API key
- FHIR Subscription (HIS แจ้งเมื่อข้อมูลเปลี่ยน) แทนการดึงเป็นรอบ
