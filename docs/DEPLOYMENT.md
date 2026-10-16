# คู่มือ Deploy PhysioCare

คู่มือนี้ติดตั้งระบบบนเซิร์ฟเวอร์ 1 เครื่องด้วย Docker Compose ซึ่งเหมาะกับคลินิก 1–3 สาขา

```
Internet ──443──▶ Caddy (HTTPS อัตโนมัติ, Let's Encrypt)
                     │
                     ▼
                  app (Node.js: API + หน้าเว็บ, รัน migration อัตโนมัติตอนเริ่ม)
                     │
                     ▼
                  db (PostgreSQL 16) ◀── backup (pg_dump + รูปภาพ ทุกวัน)
```

| Service | หน้าที่ | ข้อมูลถาวร (volume) |
|---|---|---|
| `caddy` | HTTPS, redirect http→https, HSTS, ส่ง real-time (SSE) | `caddy_data` (ใบรับรอง) |
| `app` | API + frontend, migration ตอนเริ่ม, health check `/api/health` | `uploads` (รูปภาพ) |
| `db` | PostgreSQL 16 (ไม่เปิดพอร์ตออกภายนอก) | `pgdata` |
| `backup` | สำรองฐานข้อมูลและรูปภาพทุกวันลง `deploy/backups/` | – |

---

## 1. เลือกที่ตั้งเซิร์ฟเวอร์

ระบบเก็บ **ข้อมูลสุขภาพ** ซึ่งเป็นข้อมูลอ่อนไหวตาม PDPA มาตรา 26 จึงแนะนำให้เก็บข้อมูลไว้ในประเทศไทย ถ้าจะส่งข้อมูลไปเก็บต่างประเทศ ต้องดูเงื่อนไขการโอนข้อมูลข้ามประเทศตามมาตรา 28 ก่อน

| ทางเลือก | เหมาะกับ | ข้อดี | ข้อควรระวัง |
|---|---|---|---|
| **A. Cloud VM ที่มี data center ในไทย** (แนะนำ) | คลินิกทั่วไป | ไฟ/เน็ตเสถียร, ขยายง่าย, เข้าถึงได้จากทุกที่ | ค่าบริการรายเดือน; ทำสัญญาประมวลผลข้อมูล (DPA) กับผู้ให้บริการ |
| **B. เซิร์ฟเวอร์ในคลินิก (on-premise)** | คลินิกที่ต้องการถือข้อมูลเอง | ข้อมูลอยู่กับคลินิก | ต้องมี UPS, IP ตายตัวหรือ tunnel, สำรองข้อมูลไว้นอกสถานที่ด้วย |
| **C. PaaS ต่างประเทศ** (Render, Railway, Fly.io ฯลฯ) | ทดลอง/สาธิตเท่านั้น | ตั้งค่าง่ายที่สุด | ข้อมูลอยู่นอกประเทศ — ไม่แนะนำสำหรับข้อมูลผู้ป่วยจริง |

ตัวอย่างผู้ให้บริการที่มี data center ในไทย เช่น AWS (ภูมิภาค Asia Pacific – Thailand, `ap-southeast-7`), Huawei Cloud, NIPA Cloud, INET หรือ NT ให้ตรวจสอบภูมิภาคและเงื่อนไข DPA กับผู้ให้บริการก่อนเลือก

**สเปกเริ่มต้นที่แนะนำ (ค่าประมาณสำหรับ 1 คลินิก):**
- 2 vCPU, RAM 4 GB, SSD 40–80 GB
- Ubuntu 24.04 LTS
- โดเมน เช่น `physio.yourclinic.co.th`

ถ้าคลินิกเก็บรูปภาพจำนวนมาก ให้เพิ่มพื้นที่ดิสก์

---

## 2. ติดตั้งครั้งแรก

### 2.1 เตรียมเซิร์ฟเวอร์

```bash
# อัปเดตระบบและเปิดการอัปเดตความปลอดภัยอัตโนมัติ
sudo apt update && sudo apt -y upgrade
sudo apt -y install unattended-upgrades git ufw
sudo dpkg-reconfigure -plow unattended-upgrades

# Firewall: เปิดเฉพาะ SSH, HTTP, HTTPS
sudo ufw allow OpenSSH && sudo ufw allow 80/tcp && sudo ufw allow 443/tcp && sudo ufw enable

# ติดตั้ง Docker (สคริปต์ทางการของ Docker)
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER   # ออกจากระบบแล้วเข้าใหม่
```

แนะนำให้ปิดการ login SSH ด้วยรหัสผ่าน และใช้ SSH key เท่านั้น (`PasswordAuthentication no` ใน `/etc/ssh/sshd_config`)

### 2.2 ชี้โดเมน

สร้าง DNS **A record** ให้ชื่อโดเมน เช่น `physio.yourclinic.co.th` ชี้ไปที่ IP ของเซิร์ฟเวอร์ แล้วรอจนค้นชื่อแล้วได้ IP นั้น (ตรวจด้วย `dig +short physio.yourclinic.co.th`) Caddy จะขอใบรับรอง HTTPS ให้อัตโนมัติ

### 2.3 ดาวน์โหลดและตั้งค่า

```bash
git clone https://github.com/medtrackq/PhysioCare.git physiocare
cd physiocare/deploy
cp .env.example .env
chmod 600 .env

# สร้างรหัสลับแบบสุ่ม แล้วนำไปใส่ใน .env
openssl rand -hex 32   # → POSTGRES_PASSWORD
openssl rand -hex 32   # → JWT_SECRET
nano .env              # ใส่ DOMAIN, POSTGRES_PASSWORD, JWT_SECRET
```

| ตัวแปร | ความหมาย |
|---|---|
| `DOMAIN` | โดเมนที่ชี้มาที่เซิร์ฟเวอร์ |
| `POSTGRES_PASSWORD` | รหัสผ่านฐานข้อมูล (ใช้ค่า hex จาก `openssl rand -hex 32`) |
| `JWT_SECRET` | กุญแจลงนาม session (เปลี่ยนแล้วผู้ใช้ทุกคนต้อง login ใหม่) |
| `JWT_EXPIRES_IN` | อายุ session (ค่าเริ่มต้น 8h) |
| `BACKUP_KEEP_DAYS` / `BACKUP_HOUR` | เก็บไฟล์สำรองกี่วัน / สำรองตอนกี่โมง (ค่าเริ่มต้น 14 วัน, 02:00) |

### 2.4 เปิดระบบ

```bash
docker compose up -d --build
docker compose ps              # ทุก service ต้องเป็น Up / healthy
docker compose logs -f app     # ควรเห็น "applying 001… 002… 003…" และ "listening"
```

### 2.5 สร้างผู้ดูแลระบบคนแรก

production **ไม่มีบัญชีทดลอง** ให้สร้างบัญชีผู้ดูแลระบบเองด้วยคำสั่งนี้ รหัสผ่านต้องยาวอย่างน้อย 12 ตัว และมีตัวพิมพ์ใหญ่ ตัวพิมพ์เล็ก และตัวเลข

```bash
read -s ADMIN_PASSWORD && export ADMIN_PASSWORD     # พิมพ์รหัสผ่าน (ไม่แสดงบนจอ)
docker compose exec -e ADMIN_EMAIL=owner@yourclinic.co.th -e ADMIN_NAME='ผู้ดูแลระบบ' \
  -e ADMIN_PASSWORD app npm run -s create-admin
unset ADMIN_PASSWORD
```

ลืมรหัสผ่านให้รันคำสั่งเดิมและเติม `-- --reset-password` ต่อท้าย

### 2.6 ตั้งค่าเริ่มต้นในหน้าเว็บ

เปิด `https://<DOMAIN>` แล้วเข้าสู่ระบบด้วยบัญชีผู้ดูแลระบบ จากนั้นทำตามลำดับ:

1. **ผู้ใช้ & ตั้งค่า:** ตรวจเวลาทำการ (`clinic.hours`) และความยาวช่องนัด
2. **บุคลากร:** เพิ่มนักกายภาพพร้อมเลขใบอนุญาต ความเชี่ยวชาญ และกะทำงาน
3. **ผู้ใช้:** สร้างบัญชีให้บุคลากร และผูกบัญชีกับข้อมูลบุคลากร
4. **อุปกรณ์:** เพิ่มทะเบียนอุปกรณ์ วันที่ซื้อ และรูปภาพ
5. **ผู้ป่วย:** เริ่มลงทะเบียนผู้ป่วยหรือนำเข้าข้อมูล

---

## 3. อัปเดตเวอร์ชัน

```bash
cd physiocare/deploy
docker compose exec backup sh /backup.sh     # สำรองก่อนอัปเดตทุกครั้ง
git pull
docker compose up -d --build                 # migration ใหม่จะรันอัตโนมัติตอน app เริ่ม
docker compose logs --tail=50 app
```

- **ไฟล์ migration:** ไฟล์ที่รันไปแล้วจะไม่ถูกรันซ้ำ ยกเว้น `003_clinical_guidelines.sql` ที่ทำเครื่องหมาย `@repeatable` ไว้ ไฟล์นี้จะรันใหม่เมื่อเนื้อหาเปลี่ยน
- **แก้ schema:** ให้เพิ่มเป็นไฟล์ใหม่เสมอ เช่น `db/004_add_rooms.sql` ห้ามแก้ไฟล์เดิมที่รันไปแล้ว ถ้าแก้ ระบบจะเตือนและไม่รันไฟล์นั้น

**ย้อนกลับเวอร์ชัน:** ให้ `git checkout <tag/commit ก่อนหน้า>` แล้ว `docker compose up -d --build` ถ้า migration ใหม่เปลี่ยน schema ไปแล้ว ให้กู้ฐานข้อมูลจากไฟล์สำรองก่อนอัปเดต (ข้อ 4.2)

---

## 4. สำรองและกู้คืนข้อมูล

### 4.1 การสำรอง

- service `backup` สำรองทุกวันตาม `BACKUP_HOUR` ลงโฟลเดอร์ `deploy/backups/`
  - `db-YYYYMMDD-HHMMSS.dump` คือฐานข้อมูล (รูปแบบ pg_dump custom)
  - `uploads-YYYYMMDD-HHMMSS.tar.gz` คือรูปภาพทั้งหมด
- ไฟล์สำรองตั้งสิทธิ์ให้เจ้าของอ่านได้คนเดียว (`rw-------`)
- ไฟล์ที่เก่ากว่า `BACKUP_KEEP_DAYS` จะถูกลบอัตโนมัติ
- สำรองทันทีได้ด้วย `docker compose exec backup sh /backup.sh`

**ต้องคัดลอกไฟล์สำรองออกนอกเซิร์ฟเวอร์ด้วย** เพราะถ้าเซิร์ฟเวอร์เสียหาย ไฟล์สำรองบนเครื่องจะหายไปพร้อมกัน ตัวอย่างการส่งออกด้วย cron วันละครั้งหลังเวลาสำรอง:

```bash
# crontab -e   (เข้ารหัสก่อนส่งออก — ไฟล์มีข้อมูลสุขภาพ)
30 3 * * * cd ~/physiocare/deploy/backups && for f in $(find . -name '*.dump' -o -name '*.tar.gz' -mmin -120); do gpg --batch --yes -r backup@yourclinic.co.th -e "$f" && rclone copy "$f.gpg" offsite:physiocare-backups/ && rm "$f.gpg"; done
```

`rclone` เชื่อมต่อได้ทั้ง S3, Google Drive และ OneDrive ให้เลือกปลายทางที่มี DPA กับคลินิก

### 4.2 การกู้คืน

```bash
cd physiocare/deploy
docker compose stop app
F=backups/db-YYYYMMDD-HHMMSS.dump
docker compose exec -T db sh -c 'dropdb -U physiocare --if-exists physiocare && createdb -U physiocare physiocare'
docker compose exec -T db pg_restore -U physiocare -d physiocare --no-owner < "$F"

# กู้รูปภาพ
docker compose run --rm -T --user root -v "$PWD/backups:/b:ro" --entrypoint sh app \
  -c 'cd /data/uploads && tar -xzf /b/uploads-YYYYMMDD-HHMMSS.tar.gz && chown -R node:node /data/uploads'
docker compose start app
```

**ทดสอบการกู้คืนเดือนละครั้ง** ให้กู้ไฟล์สำรองลงฐานข้อมูลชั่วคราวแล้วตรวจว่าข้อมูลครบ ไฟล์สำรองที่ไม่เคยทดลองกู้ ไม่สามารถยืนยันได้ว่าใช้งานได้จริง

```bash
docker compose exec -T db sh -c 'createdb -U physiocare restore_test && pg_restore -U physiocare -d restore_test --no-owner' < "$F"
docker compose exec -T db psql -U physiocare -d restore_test -c 'select count(*) from patients'
docker compose exec -T db dropdb -U physiocare restore_test
```

---

## 5. ดูแลระบบประจำวัน

| งาน | คำสั่ง / วิธี |
|---|---|
| ดูสถานะ | `docker compose ps` |
| ดู log | `docker compose logs -f --tail=100 app` |
| ตรวจว่าระบบทำงาน | `curl https://<DOMAIN>/api/health` — ตั้ง uptime monitor (เช่น UptimeRobot, Better Stack) ให้เรียก URL นี้ทุก 1–5 นาที |
| พื้นที่ดิสก์ | `df -h` และ `docker system df` (ล้าง image เก่า: `docker image prune`) |
| รีสตาร์ต | `docker compose restart app` |
| Audit log | ผู้ดูแลระบบดูได้ที่ `GET /api/reports/audit` (การอ่าน/แก้เวชระเบียน, การ login) |

---

## 6. Checklist ก่อนเปิดใช้งานจริง

**ความปลอดภัย**
- [ ] `POSTGRES_PASSWORD` และ `JWT_SECRET` สุ่มใหม่ ไม่ใช่ค่าตัวอย่าง และ `.env` มีสิทธิ์ `600`
- [ ] ไม่ได้รัน `--demo` (บัญชี `admin@physiocare.local` / `Passw0rd!` ต้อง login ไม่ได้)
- [ ] SSH ใช้ key เท่านั้น, firewall เปิดแค่ 22/80/443, ฐานข้อมูลไม่เปิดพอร์ตออกภายนอก
- [ ] เปิดการอัปเดตความปลอดภัยอัตโนมัติของ OS
- [ ] ไฟล์สำรองถูกเข้ารหัสและส่งออกนอกเซิร์ฟเวอร์ และทดสอบกู้คืนแล้ว
- [ ] ทำ penetration test / security review ก่อนเปิดให้ผู้ป่วยเข้าใช้จากภายนอก

**PDPA**
- [ ] ประกาศความเป็นส่วนตัว (privacy notice) และขั้นตอนขอความยินยอมสำหรับข้อมูลสุขภาพ
- [ ] สัญญาประมวลผลข้อมูล (DPA) กับผู้ให้บริการ cloud และปลายทางที่เก็บไฟล์สำรอง
- [ ] ขั้นตอนแจ้งเหตุข้อมูลรั่วไหลต่อ สคส. ภายใน 72 ชั่วโมง และกำหนดผู้รับผิดชอบ (พิจารณาแต่งตั้ง DPO)
- [ ] นโยบายระยะเวลาเก็บเวชระเบียน (ตรวจตามกฎกระทรวงภายใต้ พ.ร.บ.สถานพยาบาล)

**ทางคลินิก**
- [ ] คณะทำงานวิชาการทบทวน `002_reference_data.sql` (การจับคู่โรค-ความเชี่ยวชาญ, ข้อห้ามใช้อุปกรณ์) และ `003_clinical_guidelines.sql`
- [ ] อบรมเจ้าหน้าที่ และทดลองใช้คู่กับระบบเดิม (pilot) 2–4 สัปดาห์

---

## 7. ข้อจำกัดที่ควรทราบ

- **หน้าเว็บพึ่ง CDN:** โหลด Tailwind CSS (Play CDN), Chart.js และ Google Fonts จาก CDN ถ้าเครือข่ายของคลินิกบล็อก CDN หน้าเว็บจะแสดงผลผิด ระยะยาวควร build Tailwind และ host ไฟล์เองบนเซิร์ฟเวอร์
- **ตัวจำกัดการ login อยู่ในหน่วยความจำ:** จำกัด 30 ครั้งต่อ 15 นาทีต่อ IP ใช้ได้กับ app instance เดียว ถ้าขยายเป็นหลาย instance ต้องย้ายไปใช้ที่เก็บกลาง
- **รูปภาพเก็บบนดิสก์ของเซิร์ฟเวอร์:** ถ้าต้องการขยายเป็นหลายเครื่อง ให้เปลี่ยน `backend/src/storage/local.js` เป็น S3 หรือ MinIO
- **ยังไม่มีระบบส่งอีเมลหรือ SMS** จึงยังรีเซ็ตรหัสผ่านด้วยตัวเองไม่ได้ ผู้ดูแลระบบต้องรีเซ็ตให้ในหน้าผู้ใช้ หรือใช้คำสั่ง `create-admin --reset-password`

---

## 8. แก้ปัญหาเบื้องต้น

| อาการ | สาเหตุที่พบบ่อย | วิธีแก้ |
|---|---|---|
| `docker compose up` แจ้ง `set POSTGRES_PASSWORD in .env` | ยังไม่ได้สร้าง/กรอก `.env` | ทำข้อ 2.3 |
| เปิดเว็บแล้วใบรับรองไม่ถูกต้อง | DNS ยังไม่ชี้มา หรือพอร์ต 80/443 ถูกบล็อก | `docker compose logs caddy`, ตรวจ DNS และ firewall |
| app รีสตาร์ตวนซ้ำ | migration ล้มเหลว หรือเชื่อมฐานข้อมูลไม่ได้ | `docker compose logs app` |
| เปลี่ยน `POSTGRES_PASSWORD` แล้วต่อฐานข้อมูลไม่ได้ | รหัสถูกกำหนดตอนสร้าง volume ครั้งแรก | เปลี่ยนในฐานข้อมูลด้วย `ALTER USER physiocare PASSWORD '...'` ให้ตรงกับ `.env` |
| login ไม่ได้ "พยายามบ่อยเกินไป" | เกิน rate limit | รอ 15 นาที หรือ `docker compose restart app` |
| real-time ไม่อัปเดต | proxy อื่นบัฟเฟอร์ SSE | ถ้าวาง reverse proxy อื่นไว้หน้า Caddy ให้ปิด buffering ของเส้นทาง `/api/realtime/stream` |

---

## ภาคผนวก: ผลทดสอบ deploy

ทดสอบชุด Docker Compose นี้แล้วบน Linux (Docker 29, Compose v5) โดยใช้ `DOMAIN=localhost` ผลที่ได้:

- [x] Build image สำเร็จ (ขนาด 253 MB) และทั้ง 4 service ขึ้นสถานะ healthy
- [x] Migration รันอัตโนมัติตอนเริ่มครั้งแรก และรอบถัดไปขึ้นว่า "up to date"
- [x] ฐานข้อมูลใหม่ไม่มีข้อมูลทดลอง บัญชีทดลอง login ไม่ได้ (401) และสร้างผู้ดูแลระบบด้วย `create-admin` ได้
- [x] เข้าผ่าน HTTPS ได้ โดย:
  - HTTP ถูก redirect ไป HTTPS (308)
  - มี header HSTS
  - cookie ตั้งค่าเป็น `HttpOnly; SameSite=Strict; Secure`
- [x] Real-time (SSE) ผ่าน Caddy ได้ หน้าเว็บขึ้นสถานะ "live" และไม่มี JavaScript error
- [x] ข้อมูลยังอยู่หลัง `docker compose down` / `up`
- [x] สำรองข้อมูลแล้วกู้คืนตามขั้นตอนข้อ 4.2 (ทั้งฐานข้อมูลและรูปภาพ) ได้ข้อมูลครบ และไฟล์สำรองมีสิทธิ์ `rw-------`

ยังไม่ได้ทดสอบการขอใบรับรองจริงจาก Let's Encrypt เพราะต้องใช้โดเมนจริงที่ชี้ DNS มาที่เซิร์ฟเวอร์ ถ้าใช้ `localhost` Caddy จะออกใบรับรองภายในแทน
