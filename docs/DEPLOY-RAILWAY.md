# Deploy PhysioCare บน Railway แบบทีละขั้นตอน

Railway เป็นแพลตฟอร์มที่ build และรันระบบจาก GitHub ให้อัตโนมัติ จึงไม่ต้องดูแลเซิร์ฟเวอร์ ติดตั้ง Docker หรือตั้งค่า HTTPS เอง คู่มือนี้ใช้ `Dockerfile` ที่มีใน repo อยู่แล้ว และตั้งค่าที่เหลือผ่านหน้า dashboard ของ Railway

```
GitHub (medtrackq/PhysioCare) ──push──▶ Railway build จาก Dockerfile
                                          │
Internet ──HTTPS (Railway จัดการ)──▶  service "physiocare"  ──▶  Volume /data/uploads (รูปภาพ)
                                          │  (migration + สร้างผู้ดูแลระบบอัตโนมัติตอนเริ่ม)
                                          ▼
                                     service "Postgres" (ฐานข้อมูล + backup ของ Railway)
```

## ก่อนเริ่ม: ข้อควรรู้เรื่องที่ตั้งข้อมูล (PDPA)

Railway มี region ให้เลือก 4 แห่ง (US West, US East, EU West และ **Southeast Asia – Singapore**) ไม่มีในไทย ข้อมูลผู้ป่วยจึงถูกเก็บนอกประเทศ ซึ่งเป็นการโอนข้อมูลสุขภาพข้ามประเทศตาม PDPA มาตรา 28–29

| การใช้งาน | คำแนะนำ |
|---|---|
| สาธิต / นำเสนอ (ข้อมูลทดลอง) | ใช้ Railway ได้เลย (ดูขั้นที่ 9) |
| ทดลองใช้งานจริง (pilot) หรือใช้งานจริงกับผู้ป่วย | ปรึกษาผู้ดูแลด้าน PDPA ก่อน ต้องมีมาตรการคุ้มครองที่เพียงพอ เช่น สัญญาประมวลผลข้อมูล (DPA) กับ Railway และแจ้งผู้ป่วยในประกาศความเป็นส่วนตัว ถ้าต้องการเก็บข้อมูลในไทย ให้ใช้คู่มือ [DEPLOYMENT.md](DEPLOYMENT.md) (Docker บนเซิร์ฟเวอร์ในไทย) แทน |

## สิ่งที่ต้องเตรียม

- [ ] บัญชี GitHub ที่เข้าถึง repo `medtrackq/PhysioCare` ได้
- [ ] บัญชี Railway (สมัครที่ railway.com ด้วย GitHub) — volume บนแผนฟรี/ทดลองจำกัด 0.5 GB แนะนำแผน Hobby ขึ้นไปสำหรับใช้งานจริง
- [ ] อีเมลผู้ดูแลระบบ และรหัสผ่านอย่างน้อย 12 ตัว (มีตัวพิมพ์ใหญ่ ตัวพิมพ์เล็ก และตัวเลข)
- [ ] รหัสลับสำหรับ `JWT_SECRET` ยาว 64 ตัวอักษร สร้างด้วยคำสั่ง `openssl rand -hex 32` หรือ password manager
- [ ] (ไม่บังคับ) โดเมนของคลินิก ถ้าต้องการใช้ชื่ออย่าง `physio.yourclinic.co.th`

---

## ขั้นที่ 1 สร้าง project จาก GitHub

1. เข้า railway.com → **New Project** → **Deploy from GitHub repo**
2. ถ้า Railway ขอสิทธิ์เข้าถึง GitHub ให้อนุญาตเฉพาะ repo `medtrackq/PhysioCare`
3. เลือก repo **medtrackq/PhysioCare**
4. Railway จะสร้าง service และเริ่ม build ทันที — **deployment แรกจะขึ้นสถานะ CRASHED** เพราะยังไม่มีฐานข้อมูลและตัวแปร ซึ่งเป็นเรื่องปกติ (Deploy Logs จะบอกว่าขาด `DATABASE_URL`) ไม่ต้องกด Restart ให้ทำขั้นที่ 2–6 ก่อน แล้วค่อย deploy ใหม่ในขั้นที่ 7

**ตรวจ:** เปิด service → **Settings** → **Source** ต้องเป็น `medtrackq/PhysioCare` branch `claude/physiocare-system` และใน **Build** ต้องแสดงว่าใช้ **Dockerfile** (Railway เลือกเองเมื่อพบ `Dockerfile` ที่ root ของ repo)

> แนะนำเปลี่ยนชื่อ service เป็น `physiocare` (Settings → ชื่อด้านบน) เพื่อให้ตรงกับคู่มือนี้

## ขั้นที่ 2 เพิ่มฐานข้อมูล PostgreSQL

1. ในหน้า project กด **+ Create** (หรือ **New**) → **Database** → **PostgreSQL**
2. รอจนสถานะของ service **Postgres** เป็น Active

## ขั้นที่ 3 เลือก region เป็น Singapore

ทำกับ **ทั้งสอง service** (`physiocare` และ `Postgres`) เพื่อให้แอปกับฐานข้อมูลอยู่ใกล้กันและใกล้ผู้ใช้ในไทย:

service → **Settings** → **Deploy** → **Regions** → เลือก **Southeast Asia (Singapore)**

## ขั้นที่ 4 เพิ่ม volume สำหรับรูปภาพ

ไฟล์ใน container ของ Railway หายทุกครั้งที่ deploy ใหม่ รูปภาพจึงต้องเก็บใน volume:

1. คลิกขวาที่ service `physiocare` (หรือ **+ Create** → **Volume**) แล้วเลือกต่อกับ service `physiocare`
2. **Mount path:** `/data/uploads`

## ขั้นที่ 5 ตั้งค่าตัวแปร (Variables)

service `physiocare` → **Variables** → **Raw Editor** แล้ววางค่าด้านล่าง (แก้ค่าในวงเล็บมุมเป็นของคลินิก):

```
DATABASE_URL=${{Postgres.DATABASE_URL}}
JWT_SECRET=<ผลจาก openssl rand -hex 32>
RAILWAY_RUN_UID=0
ADMIN_EMAIL=<owner@yourclinic.co.th>
ADMIN_PASSWORD=<รหัสผ่านผู้ดูแลระบบ>
ADMIN_NAME=ผู้ดูแลระบบ
```

| ตัวแปร | ทำไมต้องมี |
|---|---|
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` เป็นการอ้างค่าจาก service Postgres — ถ้าตั้งชื่อ service ฐานข้อมูลเป็นอย่างอื่น ให้เปลี่ยนคำว่า `Postgres` ตามนั้น |
| `JWT_SECRET` | กุญแจลงนาม session — ระบบไม่ยอมเริ่มทำงานถ้าไม่มี (เปลี่ยนแล้วผู้ใช้ทุกคนต้อง login ใหม่) |
| `RAILWAY_RUN_UID` | แอปรันด้วยผู้ใช้ที่ไม่ใช่ root จึงต้องตั้งค่านี้เพื่อให้เขียนรูปภาพลง volume ได้ (ตามเอกสารของ Railway) |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` / `ADMIN_NAME` | ระบบสร้างผู้ดูแลระบบคนแรกให้ตอนเริ่มทำงาน **เฉพาะเมื่อยังไม่มีผู้ดูแลระบบเลย** — ลบ `ADMIN_PASSWORD` ออกหลังขั้นที่ 8 |

ตัวแปรที่ตั้งไว้ใน `Dockerfile` แล้ว ไม่ต้องใส่: `NODE_ENV=production`, `UPLOAD_DIR=/data/uploads` ส่วน `PORT` Railway ตั้งให้เอง

ตัวแปรเสริม (ไม่บังคับ): `JWT_EXPIRES_IN` (ค่าเริ่มต้น `8h`), `MAX_UPLOAD_MB` (ค่าเริ่มต้น `5`), `LOGIN_RATE_LIMIT` (ค่าเริ่มต้น `30` ครั้งต่อ 15 นาทีต่อ IP)

ตัวแปรสำหรับเชื่อมต่อระบบโรงพยาบาล (ใส่เฉพาะเมื่อเปิดใช้เมนู "เชื่อมต่อ HIS" — ดู [INTEGRATION.md](INTEGRATION.md)):

| ตัวแปร | ใช้เมื่อ |
|---|---|
| `HIS_TOKEN` | ระบบต้องไปดึงข้อมูลหรือส่งนัดกลับ FHIR server ของโรงพยาบาล (token ที่ฝ่าย IT ออกให้) |
| `HIS_PAYLOAD_KEY` | เปิด "บังคับเข้ารหัสข้อมูลชั้นที่ 2" — กุญแจ 32 ไบต์ที่กดสร้างในหน้า "เชื่อมต่อ HIS" |
| `INTEGRATION_WORKER` | ตั้ง `false` เพื่อหยุดการส่งข้อมูลกลับ HIS ชั่วคราว |

ชื่อตัวแปรของการเชื่อมต่อต้องขึ้นต้นด้วย `HIS_` เสมอ (ระบบไม่ยอมอ่านตัวแปรอื่น เพื่อกันการส่งรหัสลับของระบบออกไปภายนอก)

> ⚠ ห้ามตั้ง `DEMO_MODE=true` ใน project ที่ใช้กับผู้ป่วยจริง (ดูขั้นที่ 9)

## ขั้นที่ 6 ตั้ง health check และการรีสตาร์ต

service `physiocare` → **Settings** → **Deploy**:

| ตั้งค่า | ค่า |
|---|---|
| Healthcheck Path | `/api/health` |
| Restart Policy | On Failure |
| Start Command | เว้นว่าง (ใช้คำสั่งใน `Dockerfile`) |

## ขั้นที่ 7 deploy และเปิดโดเมน

1. กด **Deploy** (หรือ **Redeploy** ที่ deployment ล่าสุด) — Railway จะ build ใหม่พร้อมตัวแปรครบ
2. เปิด **Deploy Logs** ของ deployment นั้น **ผลที่ควรเห็น:**

   ```
   → applying 001_schema.sql ... ok
   → applying 002_reference_data.sql ... ok
   → applying 003_clinical_guidelines.sql ... ok
   → applying 004_rooms_beds.sql ... ok
   → applying 005_floor_plan.sql ... ok
   → applying 006_integration.sql ... ok
   Done (6 file(s) applied).
   [bootstrap-admin] created admin owner@yourclinic.co.th — remove ADMIN_PASSWORD from the environment now
   PhysioCare API listening on http://localhost:XXXX
   ```

3. service `physiocare` → **Settings** → **Networking** → **Generate Domain** — จะได้ URL ประมาณ `physiocare-production-xxxx.up.railway.app`
4. **ตรวจ:** เปิด `https://<โดเมน>/api/health` ต้องได้ `{"ok":true,...}` แล้วเปิด `https://<โดเมน>` ต้องเห็นหน้าเข้าสู่ระบบ

## ขั้นที่ 8 login และลบรหัสผ่านออกจากตัวแปร

1. login ด้วย `ADMIN_EMAIL` / `ADMIN_PASSWORD`
2. service `physiocare` → **Variables** → ลบ `ADMIN_PASSWORD` (และ `ADMIN_EMAIL`, `ADMIN_NAME` ได้) → Railway จะ deploy ใหม่ให้
3. **ตรวจ:** Deploy Logs ของรอบใหม่ต้องไม่มีบรรทัด `bootstrap-admin` และยัง login ได้ตามเดิม
4. ตั้งค่าในหน้าเว็บตามลำดับเดียวกับ [DEPLOYMENT.md ขั้นที่ 13](DEPLOYMENT.md#ขั้นที่-13-ตั้งค่าเริ่มต้นในหน้าเว็บ): เวลาทำการ → บุคลากรและกะ → ผู้ใช้ → ห้องและเตียง → อุปกรณ์ → ผัง 3D → ผู้ป่วย

> ลืมรหัสผ่านผู้ดูแลระบบ: ให้ผู้ดูแลระบบคนอื่นรีเซ็ตในหน้า "ผู้ใช้ & ตั้งค่า" ตัวแปร `ADMIN_*` ใช้ได้เฉพาะตอนที่ยังไม่มีผู้ดูแลระบบเลย จะไม่เปลี่ยนรหัสของบัญชีที่มีอยู่

## ขั้นที่ 9 (ไม่บังคับ) project สำหรับสาธิตพร้อมข้อมูลทดลอง

ใช้สำหรับนำเสนอ โดยสร้าง **project แยก** จาก project ที่ใช้งานจริง:

1. ทำขั้นที่ 1–7 ใน project ใหม่ ข้ามตัวแปร `ADMIN_*` แล้วเพิ่ม `DEMO_MODE=true`
2. ระบบจะโหลดข้อมูลทดลอง ได้แก่ บุคลากร, ผู้ป่วยสมมติ, นัดหมาย, ห้อง/เตียง และผังคลินิก
   - Deploy Logs จะขึ้นคำเตือน `!! DEMO_MODE=true …`
3. login ด้วยบัญชีทดลอง (รหัสผ่าน `Passw0rd!` ทุกบัญชี) เช่น `front@physiocare.local`, `somchai@physiocare.local`, `admin@physiocare.local`

> ⚠ บัญชีทดลองใช้รหัสผ่านที่เปิดเผยในเอกสาร ใครที่รู้ URL ก็เข้าได้ ห้ามใส่ข้อมูลผู้ป่วยจริงใน project นี้ นัดทดลองสร้างตามวันที่ที่ deploy ครั้งแรก ถ้าต้องการข้อมูลวันปัจจุบันอีกครั้ง ให้ลบ service Postgres แล้วสร้างใหม่

## ขั้นที่ 10 (ไม่บังคับ) ใช้โดเมนของคลินิก

1. service `physiocare` → **Settings** → **Networking** → **Custom Domain** → ใส่ `physio.yourclinic.co.th`
2. Railway จะแสดงค่า DNS (ปกติเป็น `CNAME` และอาจมี `TXT` สำหรับยืนยัน) ให้ไปเพิ่มที่ผู้ให้บริการ DNS ของโดเมน
3. รอจนสถานะโดเมนใน Railway ขึ้นว่าใช้งานได้ ใบรับรอง HTTPS ออกให้อัตโนมัติ

## ขั้นที่ 11 ตั้งการสำรองข้อมูล

Railway มีระบบ backup สำหรับ service ที่มี volume (ทั้งแบบกดเองและแบบตั้งเวลา):

1. service **Postgres** → แท็บ **Backups** → ตั้งให้สำรองอัตโนมัติ (เช่น รายวัน)
2. service **physiocare** (volume รูปภาพ) → แท็บ **Backups** → ตั้งเช่นเดียวกัน
3. **ทดสอบกู้คืน** อย่างน้อยครั้งแรกหลังติดตั้ง ตามขั้นตอนในหน้า Backups ของ Railway

> ถ้าต้องการสำเนาไว้นอก Railway ด้วย ให้ใช้ `pg_dump` กับ connection string แบบ public ของ Postgres (แท็บ Variables → `DATABASE_PUBLIC_URL`) จากคอมพิวเตอร์ของผู้ดูแล แล้วเก็บไฟล์แบบเข้ารหัส เพราะไฟล์มีข้อมูลสุขภาพ

## ขั้นที่ 12 ตั้งการแจ้งเตือนเมื่อระบบล่ม

สมัคร uptime monitor (เช่น UptimeRobot, Better Stack) ให้เรียก `https://<โดเมน>/api/health` ทุก 1–5 นาที และเปิดการแจ้งเตือน deploy ล้มเหลวในหน้าตั้งค่าบัญชี Railway

---

# การดูแลประจำ

| งาน | วิธี |
|---|---|
| อัปเดตเวอร์ชัน | push โค้ดเข้า branch `claude/physiocare-system` แล้ว Railway จะ build และ deploy ให้อัตโนมัติ (migration ใหม่รันตอนเริ่ม) — service ที่มี volume จะหยุดทำงานช่วงสั้น ๆ ระหว่างสลับ deployment ควรอัปเดตนอกเวลาทำการ |
| ย้อนกลับเวอร์ชัน | service → **Deployments** → เลือก deployment ก่อนหน้า → **Redeploy** (ถ้าเวอร์ชันใหม่เปลี่ยน schema ไปแล้ว ให้กู้ฐานข้อมูลจาก backup ด้วย) |
| ดู log | service → **Deployments** → **Deploy Logs** / **HTTP Logs** |
| เปลี่ยนรหัสลับ session | แก้ `JWT_SECRET` แล้ว Railway จะ deploy ใหม่ ผู้ใช้ทุกคนต้อง login ใหม่ |
| เพิ่มพื้นที่รูปภาพ | volume → Settings → เพิ่มขนาด (ลดขนาดไม่ได้) |

**อย่าเพิ่มจำนวน replica ของ service `physiocare`** เพราะ Railway ไม่รองรับ replica เมื่อมี volume และตัวจำกัดการ login กับการแจ้งเตือน real-time ออกแบบมาสำหรับ instance เดียว

---

# แก้ปัญหา

| อาการ | สาเหตุที่พบบ่อย | วิธีแก้ |
|---|---|---|
| สถานะ CRASHED และ Deploy Logs ขึ้น `DATABASE_URL is not set` | ยังไม่ได้เพิ่ม PostgreSQL หรือยังไม่ได้ตั้ง `DATABASE_URL` | ขั้นที่ 2 และ 5 แล้ว Redeploy |
| Deploy Logs ขึ้น `JWT_SECRET is required in production` | ยังไม่ได้ตั้ง `JWT_SECRET` | ขั้นที่ 5 |
| `connect ECONNREFUSED` หรือ `getaddrinfo ENOTFOUND` | `DATABASE_URL` ผิด หรือชื่อ service Postgres ไม่ตรงกับที่อ้างใน `${{...}}` | ตรวจตัวแปรและชื่อ service ฐานข้อมูล |
| `permission denied` ตอนอัปโหลดรูป | ไม่ได้ตั้ง `RAILWAY_RUN_UID=0` หรือ mount path ไม่ใช่ `/data/uploads` | ขั้นที่ 4–5 |
| รูปภาพหายหลัง deploy ใหม่ | ไม่ได้ต่อ volume | ขั้นที่ 4 |
| `[bootstrap-admin] ADMIN_PASSWORD must be …` | รหัสผ่านไม่ผ่านเกณฑ์ จึงไม่ได้สร้างบัญชี | ตั้งรหัสใหม่ให้ยาว ≥12 ตัว มีตัวพิมพ์ใหญ่ เล็ก และตัวเลข แล้ว redeploy |
| Health check ไม่ผ่าน deploy ค้าง | migration ล้มเหลว (ดู log) หรือ path ผิด | ตรวจ Deploy Logs และ Healthcheck Path `/api/health` |
| real-time หลุดเป็นระยะ | การเชื่อมต่อยาว ๆ ถูกตัดที่ proxy | ไม่ต้องแก้ หน้าเว็บเชื่อมต่อใหม่เองภายในไม่กี่วินาที |

---

# ภาคผนวก: สิ่งที่ทดสอบแล้ว

ทดสอบ image จาก `Dockerfile` นี้โดยจำลองสภาพแวดล้อมแบบ Railway บนเครื่องทดสอบ:
- PORT ที่ไม่ใช่ 3000
- รันด้วย root ตาม `RAILWAY_RUN_UID=0`
- ต่อ volume ที่ `/data/uploads`
- PostgreSQL 16

**ทดสอบผ่าน**
- [x] migration 5 ไฟล์รันตอนเริ่ม และ health check ผ่านทั้ง endpoint และ Docker HEALTHCHECK
- [x] `ADMIN_EMAIL`/`ADMIN_PASSWORD` สร้างผู้ดูแลระบบได้ และรีสตาร์ตแล้วไม่สร้างซ้ำ
- [x] บัญชีทดลอง login ไม่ได้
- [x] อัปโหลดรูปลง volume ได้
- [x] `DEMO_MODE=true` โหลดข้อมูลทดลอง 4 ไฟล์ บัญชีทดลอง login ได้ และรีสตาร์ตแล้วไม่โหลดซ้ำ

**ยังไม่ได้ทดสอบบน Railway จริง**
- [ ] หน้า dashboard และชื่อเมนูอาจต่างจากคู่มือเล็กน้อย เพราะ Railway ปรับหน้าตาบ่อย
- [ ] Postgres ของ Railway ต้องมี extension `btree_gist` และ `pgcrypto` (มากับ PostgreSQL มาตรฐาน) — ถ้า migration แรกล้มเหลวที่ `CREATE EXTENSION` ให้ส่ง log มา
- [ ] การรับ IP ผู้ใช้จริงผ่าน proxy ของ Railway (ใช้กับตัวจำกัดการ login)
- [ ] ระบบ backup และการกู้คืนของ Railway

> หมายเหตุ: Railway กำลังเลิกใช้ไฟล์ตั้งค่า `railway.json` (หยุดอ่านตั้งแต่ 1 ธ.ค. 2026) และเปลี่ยนไปใช้ `.railway/railway.ts` คู่มือนี้จึงตั้งค่าผ่าน dashboard แทน ถ้าต้องการเก็บการตั้งค่าเป็นโค้ดในภายหลัง ใช้ `railway config pull` เพื่อดึงการตั้งค่าปัจจุบันออกมาเป็นไฟล์ได้
