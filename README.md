# PhysioCare Management System

ระบบบริหารจัดการห้องกายภาพบำบัด ประกอบด้วยทะเบียนอุปกรณ์และบุคลากร ระบบนัดหมายที่กันการจองซ้อนพร้อมแนะนำนักกายภาพและอุปกรณ์ตามการวินิจฉัย เวชระเบียนก่อน/หลังการรักษา และสิทธิ์การใช้งานตามบทบาท

- **Backend:** Node.js 20+ / Express 5 / PostgreSQL 14+
- **Frontend:** Tailwind CSS + Vanilla JS (ES Modules) ไม่ต้อง build

รายละเอียดสถาปัตยกรรม, ER diagram, อัลกอริทึม และ API ทั้งหมดอยู่ที่ [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)

## ฟีเจอร์

| โมดูล | ความสามารถ |
|---|---|
| Equipment Master | สถานะ real-time (พร้อมใช้ / กำลังใช้ / ส่งซ่อม / ชำรุด / จำหน่าย), หมวดหมู่, วันที่ซื้อ/ราคา/ประกัน, ประวัติบำรุงรักษาและค่าใช้จ่าย, รอบ PM อัตโนมัติ, timeline สถานะ, แจ้งชำรุดแล้วแสดงนัดที่กระทบและเครื่องทดแทน |
| Staff Master | ความเชี่ยวชาญ (Orthopedic, Neurological, Pediatric, Sports, Cardio, Geriatric) ระดับ 1–5, ใบอนุญาต, ตารางกะรายสัปดาห์, สร้างกะแบบ bulk, วันลา |
| รูปภาพ | อัปโหลดรูปของอุปกรณ์ บุคลากร ผู้ป่วย เวชระเบียน และงานซ่อม ตรวจชนิดไฟล์จาก magic bytes และตรวจสิทธิ์ก่อนเสิร์ฟ |
| Smart Scheduling | กันจองซ้อนทั้งบุคลากร ผู้ป่วย และอุปกรณ์ 3 ชั้น (ตรวจในแอป → row lock → EXCLUDE constraint), เผื่อเวลาทำความสะอาดเครื่อง, ตรวจกะ/วันลา/ช่วงปิดซ่อม, เสนอช่วงเวลา/คน/เครื่องทดแทนเมื่อชน, optimistic locking ตอนเลื่อนนัด |
| Recommendation | จับคู่การวินิจฉัย (ICD-10) กับความเชี่ยวชาญและหมวดอุปกรณ์, คิดคะแนนจากความเชี่ยวชาญ ความต่อเนื่อง ภาระงาน และความว่าง, ตัดอุปกรณ์ที่ห้ามใช้ตามข้อควรระวังของผู้ป่วย (pacemaker, ตั้งครรภ์, โลหะในร่างกาย ฯลฯ) |
| EMR | Pre-assessment (Pain NRS, ROM, vital signs, ข้อควรระวัง), Post progress note (ผลตอบสนอง, การรักษาที่ใช้อุปกรณ์, home program), ลงนามแล้วแก้ไม่ได้ (เพิ่มเติมได้ทาง addendum), กราฟความก้าวหน้าเทียบกับครั้งแรกและครั้งก่อน |
| RBAC | Admin / Therapist / Staff / Patient ตรวจสิทธิ์ระดับ permission, ผู้ป่วยเห็นเฉพาะนัดของตนเอง, audit log |

## เริ่มใช้งาน

ต้องมี Node.js 20 ขึ้นไป และ PostgreSQL 14 ขึ้นไป

```bash
# 1) สร้างฐานข้อมูล
createdb physiocare
psql physiocare -f db/001_schema.sql -f db/002_seed.sql

# 2) รัน API (เสิร์ฟ frontend ให้ด้วย)
cd backend
cp .env.example .env        # แก้ DATABASE_URL และ JWT_SECRET
npm install
node --env-file=.env src/server.js
# เปิด http://localhost:3000
```

### บัญชีทดลอง (รหัสผ่าน `Passw0rd!`)

| อีเมล | บทบาท |
|---|---|
| admin@physiocare.local | ผู้ดูแลระบบ |
| somchai@physiocare.local | นักกายภาพบำบัด (Ortho/Sports) |
| supaporn@physiocare.local | นักกายภาพบำบัด (Neuro/Geriatric) |
| front@physiocare.local | เจ้าหน้าที่ |
| patient@physiocare.local | ผู้ป่วย |

## การทดสอบ

Integration test 29 กรณี รันกับ PostgreSQL จริง ครอบคลุมการจองซ้อน, คำขอจองพร้อมกัน, ข้อห้ามใช้อุปกรณ์, RBAC, การล็อกเวชระเบียน, การ push ผ่าน SSE และการอัปโหลดรูป

```bash
createdb physiocare_test
cd backend
DATABASE_URL=postgres://localhost/physiocare_test npm test   # ⚠ จะล้าง schema ของฐานข้อมูลนี้
```

> ⚠ ความเชื่อมโยงระหว่างโรค ความเชี่ยวชาญ และอุปกรณ์ รวมถึงกฎข้อห้ามใช้ใน `db/002_seed.sql` เป็นข้อมูลตัวอย่าง ต้องให้นักกายภาพบำบัดตรวจรับรองก่อนใช้งานจริง
