# คู่มือ Deploy PhysioCare แบบทีละขั้นตอน

คู่มือนี้พาติดตั้งระบบบนเซิร์ฟเวอร์ Linux 1 เครื่องด้วย Docker Compose ตั้งแต่เครื่องเปล่าจนพร้อมใช้งาน เหมาะกับคลินิก 1–3 สาขา ทุกขั้นมีคำสั่งให้คัดลอก ผลลัพธ์ที่ควรเห็น และวิธีตรวจก่อนไปขั้นถัดไป

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
| `app` | API + หน้าเว็บ, migration ตอนเริ่ม, health check `/api/health` | `uploads` (รูปภาพ) |
| `db` | PostgreSQL 16 (ไม่เปิดพอร์ตออกภายนอก) | `pgdata` |
| `backup` | สำรองฐานข้อมูลและรูปภาพทุกวันลง `deploy/backups/` | – |

> **สัญลักษณ์ในคู่มือ:** บรรทัดที่ขึ้นต้นด้วย `$` ให้พิมพ์บนเซิร์ฟเวอร์ (ไม่ต้องพิมพ์ `$`) · ข้อความใน `<...>` ให้แทนด้วยค่าของคลินิก เช่น `<IP>` → `203.0.113.10`

---

## สิ่งที่ต้องเตรียม

- [ ] **โดเมนหรือ sub-domain** ที่แก้ DNS ได้ เช่น `physio.yourclinic.co.th`
- [ ] **บัญชีผู้ให้บริการ cloud** ที่มี data center ในไทย หรือเซิร์ฟเวอร์ในคลินิก (ดูข้อ 1)
- [ ] **คอมพิวเตอร์ที่ใช้ SSH ได้**: Windows 10/11 ใช้ PowerShell, macOS/Linux ใช้ Terminal
- [ ] **อีเมลผู้ดูแลระบบ** และรหัสผ่านอย่างน้อย 12 ตัว (มีตัวพิมพ์ใหญ่ ตัวพิมพ์เล็ก และตัวเลข)
- [ ] **เวลา** ประมาณ 1–2 ชั่วโมง (รวมรอ DNS)

---

# ส่วน A — เตรียมเซิร์ฟเวอร์

## ขั้นที่ 1 สร้างเซิร์ฟเวอร์

ระบบเก็บ **ข้อมูลสุขภาพ** ซึ่งเป็นข้อมูลอ่อนไหวตาม PDPA มาตรา 26 จึงแนะนำให้เก็บข้อมูลไว้ในประเทศไทย ถ้าจะใช้ data center ต่างประเทศ ต้องดูเงื่อนไขการโอนข้อมูลข้ามประเทศตามมาตรา 28 ก่อน

| ทางเลือก | เหมาะกับ | ข้อควรระวัง |
|---|---|---|
| **A. Cloud VM ที่มี data center ในไทย** (แนะนำ) | คลินิกทั่วไป | ทำสัญญาประมวลผลข้อมูล (DPA) กับผู้ให้บริการ |
| **B. เซิร์ฟเวอร์ในคลินิก** | คลินิกที่ต้องการถือข้อมูลเอง | ต้องมี UPS, IP ตายตัว (หรือ tunnel) และสำรองข้อมูลนอกสถานที่ |
| **C. PaaS ต่างประเทศ** (Render, Railway ฯลฯ) | ทดลอง/สาธิตเท่านั้น | ข้อมูลอยู่นอกประเทศ ไม่ใช้กับผู้ป่วยจริง |

ตัวอย่างผู้ให้บริการที่มี data center ในไทย เช่น AWS (ภูมิภาค Asia Pacific – Thailand, `ap-southeast-7`), Huawei Cloud, NIPA Cloud, INET หรือ NT ให้ตรวจสอบภูมิภาคและเงื่อนไข DPA กับผู้ให้บริการก่อนเลือก

ในหน้าสร้างเซิร์ฟเวอร์ (VM / instance) ของผู้ให้บริการ ให้เลือก:

| ตั้งค่า | ค่าที่แนะนำ |
|---|---|
| ระบบปฏิบัติการ | **Ubuntu 24.04 LTS** (64-bit) |
| ขนาด | 2 vCPU, RAM 4 GB (เริ่มต้นสำหรับ 1 คลินิก) |
| ดิสก์ | SSD 40–80 GB (เพิ่มถ้าเก็บรูปภาพมาก) |
| IP | **Static / Elastic IP** (IP ไม่เปลี่ยนเมื่อรีสตาร์ต) |
| Firewall / Security group ของผู้ให้บริการ | เปิดขาเข้า TCP **22** (SSH), **80** (HTTP), **443** (HTTPS) เท่านั้น |
| การเข้าเครื่อง | สร้างหรืออัปโหลด **SSH key** แล้วเก็บไฟล์ key ไว้ให้ดี |

**ตรวจ:** จด IP สาธารณะของเครื่อง (เช่น `203.0.113.10`) และชื่อผู้ใช้เริ่มต้น (มักเป็น `ubuntu`)

## ขั้นที่ 2 เข้าเซิร์ฟเวอร์ด้วย SSH

บนคอมพิวเตอร์ของคุณ เปิด PowerShell (Windows) หรือ Terminal (macOS/Linux):

```bash
ssh -i <ไฟล์-key>.pem ubuntu@<IP>
```

ครั้งแรกจะถาม `Are you sure you want to continue connecting?` ให้พิมพ์ `yes`

**ผลที่ควรเห็น:** prompt ประมาณ `ubuntu@<ชื่อเครื่อง>:~$`
ถ้าขึ้น `Permission denied (publickey)` แปลว่าใช้ไฟล์ key หรือชื่อผู้ใช้ผิด ส่วนบน macOS/Linux ถ้าขึ้น `UNPROTECTED PRIVATE KEY FILE` ให้รัน `chmod 600 <ไฟล์-key>.pem` ก่อน

## ขั้นที่ 3 อัปเดตระบบและตั้งเขตเวลา

```bash
$ sudo apt update && sudo apt -y upgrade
$ sudo apt -y install git ufw openssl curl unattended-upgrades
$ sudo timedatectl set-timezone Asia/Bangkok
$ sudo dpkg-reconfigure -plow unattended-upgrades    # เลือก Yes = ติดตั้งแพตช์ความปลอดภัยอัตโนมัติ
```

**ตรวจ:** `timedatectl` ต้องแสดง `Time zone: Asia/Bangkok` ถ้าขึ้นข้อความว่าต้องรีบูต ให้ `sudo reboot` แล้ว SSH เข้าใหม่

## ขั้นที่ 4 เปิด firewall ในเครื่อง

> ⚠ ต้องอนุญาต SSH **ก่อน** เปิด firewall มิฉะนั้นจะเข้าเครื่องไม่ได้อีก

```bash
$ sudo ufw allow OpenSSH
$ sudo ufw allow 80/tcp
$ sudo ufw allow 443/tcp
$ sudo ufw enable           # ตอบ y
$ sudo ufw status
```

**ผลที่ควรเห็น:** `Status: active` และมี `OpenSSH`, `80/tcp`, `443/tcp` เป็น `ALLOW`

> หมายเหตุ: Docker เปิดพอร์ตผ่าน iptables ของตัวเองโดยไม่ผ่าน ufw — compose นี้เปิดออกภายนอกเฉพาะ 80/443 ของ Caddy ฐานข้อมูลไม่มีพอร์ตออกนอกเครื่อง จึงปลอดภัยตามที่ตั้งไว้ อย่าเพิ่ม `ports:` ให้ service `db`

## ขั้นที่ 5 ปิดการ login ด้วยรหัสผ่าน (ใช้ SSH key อย่างเดียว)

ผู้ให้บริการส่วนใหญ่ปิดไว้ให้แล้ว ให้ตรวจและปิดซ้ำ:

```bash
$ sudo sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
$ sudo sshd -t && sudo systemctl reload ssh
```

> ⚠ **อย่าปิดหน้าต่าง SSH เดิม** ให้เปิดหน้าต่างใหม่แล้วลอง `ssh -i <ไฟล์-key>.pem ubuntu@<IP>` ถ้าเข้าได้จึงปิดหน้าต่างเดิม

## ขั้นที่ 6 ติดตั้ง Docker

```bash
$ curl -fsSL https://get.docker.com | sudo sh
$ sudo usermod -aG docker $USER
$ exit
```

SSH เข้าใหม่ (เพื่อให้สิทธิ์กลุ่ม docker มีผล) แล้วตรวจ:

```bash
$ docker run --rm hello-world
$ docker compose version
```

**ผลที่ควรเห็น:** `Hello from Docker!` และ `Docker Compose version v2.x` หรือใหม่กว่า
ถ้าขึ้น `permission denied ... docker.sock` แปลว่ายังไม่ได้ออกแล้วเข้าใหม่หลัง `usermod`

---

# ส่วน B — ติดตั้งระบบ

## ขั้นที่ 7 ชี้โดเมนมาที่เซิร์ฟเวอร์

ที่ผู้ให้บริการ DNS ของโดเมน (เช่น ที่จดโดเมน หรือ Cloudflare) สร้าง record:

| Type | Name | Value | TTL |
|---|---|---|---|
| `A` | `physio` (สำหรับ `physio.yourclinic.co.th`) | `<IP>` | 300 หรือ Auto |

> ถ้าใช้ Cloudflare ให้ตั้ง Proxy status เป็น **DNS only** (เมฆสีเทา) ในช่วงติดตั้ง เพื่อให้ Caddy ขอใบรับรองได้

**ตรวจ** (บนเซิร์ฟเวอร์ หรือคอมพิวเตอร์ใดก็ได้):

```bash
$ getent hosts physio.yourclinic.co.th      # หรือ: nslookup physio.yourclinic.co.th
```

ต้องได้ `<IP>` ของเซิร์ฟเวอร์ ถ้ายังไม่ได้ให้รอ 5–30 นาทีแล้วลองใหม่ **อย่าทำขั้นที่ 10 จนกว่า DNS จะชี้ถูก** เพราะ Let's Encrypt จำกัดจำนวนครั้งที่ขอใบรับรองล้มเหลว

## ขั้นที่ 8 ดาวน์โหลดโค้ด

```bash
$ cd ~
$ git clone https://github.com/medtrackq/PhysioCare.git physiocare
$ cd physiocare
$ git log --oneline -1
```

**ผลที่ควรเห็น:** โฟลเดอร์ `~/physiocare` และ commit ล่าสุด 1 บรรทัด

> repo นี้เป็น public — ห้าม commit ไฟล์ `.env`, ไฟล์สำรอง หรือข้อมูลผู้ป่วยลง repo (`.gitignore` กันไว้แล้ว)

## ขั้นที่ 9 สร้างไฟล์ตั้งค่า (.env)

```bash
$ cd ~/physiocare/deploy
$ sh init-env.sh physio.yourclinic.co.th
```

สคริปต์จะสร้าง `deploy/.env` (สิทธิ์ `600`) พร้อมรหัสลับแบบสุ่ม:

| ตัวแปร | ความหมาย |
|---|---|
| `DOMAIN` | โดเมนที่ชี้มาที่เซิร์ฟเวอร์ |
| `POSTGRES_PASSWORD` | รหัสผ่านฐานข้อมูล (สุ่ม 64 ตัวอักษร) |
| `JWT_SECRET` | กุญแจลงนาม session (เปลี่ยนแล้วผู้ใช้ทุกคนต้อง login ใหม่) |
| `JWT_EXPIRES_IN` | อายุ session (ค่าเริ่มต้น 8h) |
| `MAX_UPLOAD_MB` | ขนาดรูปสูงสุดต่อไฟล์ |
| `BACKUP_KEEP_DAYS` / `BACKUP_HOUR` | เก็บไฟล์สำรองกี่วัน / สำรองตอนกี่โมง (14 วัน, 02:00) |

**เก็บสำเนา `.env` ไว้นอกเซิร์ฟเวอร์** (เช่น password manager ของคลินิก) เพราะต้องใช้ตอนกู้ระบบ — บนคอมพิวเตอร์ของคุณ:

```bash
scp -i <ไฟล์-key>.pem ubuntu@<IP>:~/physiocare/deploy/.env ./physiocare-env-backup
```

> ⚠ `POSTGRES_PASSWORD` ถูกใช้ตอนสร้างฐานข้อมูลครั้งแรกเท่านั้น หลังขั้นที่ 10 แล้วอย่าแก้ค่านี้ใน `.env` (ดูข้อ "แก้ปัญหา")

## ขั้นที่ 10 เปิดระบบ

```bash
$ cd ~/physiocare/deploy
$ docker compose up -d --build
```

ครั้งแรกใช้เวลาประมาณ 3–8 นาที (ดาวน์โหลด image และติดตั้ง package) จากนั้นตรวจ:

```bash
$ docker compose ps
```

**ผลที่ควรเห็น** (รอ 30 วินาทีหลังคำสั่งก่อนหน้า):

```
app      Up ... (healthy)
backup   Up ...
caddy    Up ...
db       Up ... (healthy)
```

ดู log ของแอป:

```bash
$ docker compose logs app
```

**ผลที่ควรเห็น:**

```
→ applying 001_schema.sql ... ok
→ applying 002_reference_data.sql ... ok
→ applying 003_clinical_guidelines.sql ... ok
→ applying 004_rooms_beds.sql ... ok
→ applying 005_floor_plan.sql ... ok
Done (5 file(s) applied).
PhysioCare API listening on http://localhost:3000
```

## ขั้นที่ 11 ตรวจ HTTPS

```bash
$ docker compose logs caddy | grep -i "certificate obtained"
$ curl https://physio.yourclinic.co.th/api/health
```

**ผลที่ควรเห็น:** `certificate obtained successfully` และ `{"ok":true,"time":"..."}`
จากนั้นเปิด `https://physio.yourclinic.co.th` ในเบราว์เซอร์ ต้องเห็นหน้า "เข้าสู่ระบบ" และรูปแม่กุญแจ

ถ้าใบรับรองไม่ผ่าน ให้ดู `docker compose logs caddy` สาเหตุที่พบบ่อยคือ DNS ยังไม่ชี้ หรือพอร์ต 80/443 ถูกปิดที่ firewall ของผู้ให้บริการ

## ขั้นที่ 12 สร้างผู้ดูแลระบบคนแรก

production **ไม่มีบัญชีทดลอง** ให้สร้างบัญชีผู้ดูแลระบบเอง:

```bash
$ cd ~/physiocare/deploy
$ read -s ADMIN_PASSWORD && export ADMIN_PASSWORD     # พิมพ์รหัสผ่านแล้วกด Enter (ไม่แสดงบนจอ)
$ docker compose exec -e ADMIN_EMAIL=owner@yourclinic.co.th -e ADMIN_NAME='ผู้ดูแลระบบ' \
    -e ADMIN_PASSWORD app npm run -s create-admin
$ unset ADMIN_PASSWORD
```

**ผลที่ควรเห็น:** `Admin owner@yourclinic.co.th created`
ถ้ารหัสผ่านไม่ผ่านเกณฑ์ จะขึ้นว่าต้องยาวอย่างน้อย 12 ตัวและมีตัวพิมพ์ใหญ่ ตัวพิมพ์เล็ก และตัวเลข

**ตรวจ:** login ที่หน้าเว็บด้วยอีเมลนี้ได้ และบัญชีทดลอง `admin@physiocare.local` ต้อง login **ไม่ได้**

> ลืมรหัสผ่าน: รันคำสั่งเดิมและเติม `-- --reset-password` ต่อท้าย

## ขั้นที่ 13 ตั้งค่าเริ่มต้นในหน้าเว็บ

login ด้วยบัญชีผู้ดูแลระบบ แล้วทำตามลำดับ (ลำดับมีผล เพราะขั้นหลังอ้างข้อมูลจากขั้นก่อน):

1. **ผู้ใช้ & ตั้งค่า:** ตรวจเวลาทำการ `clinic.hours` (เช่น `{"open":"08:00","close":"20:00","days":[1,2,3,4,5,6]}` โดย 1 = จันทร์), ความยาวช่องนัด และเวลาเปลี่ยนผ้าปูเตียง
2. **บุคลากร & กะ:** เพิ่มนักกายภาพพร้อมเลขใบอนุญาต ความเชี่ยวชาญ (ระดับ 1–5) และสร้างกะทำงาน
3. **ผู้ใช้ & ตั้งค่า → เพิ่มผู้ใช้:** สร้างบัญชีให้บุคลากร โดยเลือกบทบาทและผูกบัญชีกับข้อมูลบุคลากร
4. **ห้อง & เตียง:** เพิ่มห้อง (ประเภท, จำนวนผู้ป่วยที่รับได้พร้อมกัน) และเตียงในแต่ละห้อง — ให้ครบ **ก่อน** เปิดรับจอง (เมื่อมีห้องแล้ว การจองที่ต้องใช้เตียงจะหาเตียงจากรายการนี้)
5. **อุปกรณ์:** เพิ่มทะเบียนอุปกรณ์ วันที่ซื้อ และรูปภาพ และระบุห้องสำหรับเครื่องที่ติดตั้งประจำ (เช่น เครื่องดึงหลัง)
6. **ผัง 3D:** เปิด "จัดผัง" แล้วลากห้องให้ตรงกับผังจริงของคลินิก
7. **ผู้ป่วย:** เริ่มลงทะเบียนผู้ป่วย

---

# ส่วน C — หลังติดตั้ง

## ขั้นที่ 14 ส่งไฟล์สำรองออกนอกเซิร์ฟเวอร์

service `backup` สำรองทุกวันลง `deploy/backups/` อยู่แล้ว แต่ถ้าเซิร์ฟเวอร์เสียหาย ไฟล์สำรองบนเครื่องจะหายไปพร้อมกัน จึงต้องคัดลอกออกนอกเครื่องทุกวัน ไฟล์สำรองมีข้อมูลสุขภาพ ต้องเข้ารหัสก่อนส่ง

**14.1 สร้างกุญแจเข้ารหัส** (ทำบนคอมพิวเตอร์ของผู้ดูแล ไม่ใช่บนเซิร์ฟเวอร์ เพื่อให้กุญแจถอดรหัสไม่อยู่บนเครื่องที่อาจถูกเจาะ):

```bash
gpg --quick-gen-key "PhysioCare Backup <backup@yourclinic.co.th>" rsa4096 encr never
gpg --armor --export backup@yourclinic.co.th > physiocare-backup-public.asc
```

เก็บ private key (`gpg --export-secret-keys`) ไว้ในที่ปลอดภัย 2 แห่ง ถ้าหาย จะถอดรหัสไฟล์สำรองไม่ได้

**14.2 นำเข้ากุญแจสาธารณะบนเซิร์ฟเวอร์** (ใช้บัญชี root เพราะไฟล์สำรองอ่านได้เฉพาะ root):

```bash
# บนคอมพิวเตอร์ของคุณ
scp -i <ไฟล์-key>.pem physiocare-backup-public.asc ubuntu@<IP>:~
# บนเซิร์ฟเวอร์
$ sudo apt -y install gnupg rclone
$ sudo gpg --import ~/physiocare-backup-public.asc
$ sudo mkdir -p -m 700 /root/physiocare-outbox
```

**14.3 ตั้งปลายทางด้วย rclone** (S3, Google Drive, OneDrive ฯลฯ — เลือกที่มี DPA กับคลินิก):

```bash
$ sudo rclone config        # สร้าง remote ชื่อ offsite ตามขั้นตอนบนจอ
$ sudo rclone lsd offsite:  # ต้องไม่ error
```

**14.4 ตั้งงานรายวันใน crontab ของ root:**

```bash
$ sudo crontab -e
```

เพิ่มบรรทัดนี้ (แทน `ubuntu` ด้วยชื่อผู้ใช้ที่ clone โค้ดไว้) — ทุกวัน 03:30 หลังการสำรองตอน 02:00 ระบบจะเข้ารหัสไฟล์สำรองที่สร้างภายใน 2 ชั่วโมงลงโฟลเดอร์พัก แล้ว `rclone move` ส่งออก (ลบไฟล์ที่เข้ารหัสในโฟลเดอร์พักเมื่อส่งสำเร็จ):

```
30 3 * * * cd /home/ubuntu/physiocare/deploy/backups && for f in $(find . \( -name '*.dump' -o -name '*.tar.gz' \) -mmin -120); do gpg --batch --yes --trust-model always -r backup@yourclinic.co.th -o "/root/physiocare-outbox/$(basename "$f").gpg" -e "$f"; done && rclone move /root/physiocare-outbox offsite:physiocare-backups/
```

**ตรวจ:** สำรองทันทีด้วย `docker compose exec backup sh /backup.sh` แล้วรันคำสั่งเดียวกับใน cron ด้วยมือหนึ่งครั้ง (`sudo sh -c '<คำสั่งหลังเครื่องหมาย * * * * *>'`) จากนั้น `sudo rclone ls offsite:physiocare-backups/` ต้องเห็นไฟล์ `.gpg` และทดลองถอดรหัสไฟล์หนึ่งบนคอมพิวเตอร์ของผู้ดูแลด้วย `gpg -d`

## ขั้นที่ 15 ทดสอบกู้คืน (ทำครั้งแรก และเดือนละครั้ง)

ไฟล์สำรองที่ไม่เคยทดลองกู้ ไม่สามารถยืนยันได้ว่าใช้งานได้จริง ให้กู้ลงฐานข้อมูลชั่วคราวแล้วนับข้อมูล:

```bash
$ cd ~/physiocare/deploy
$ F=$(sudo ls -t backups/db-*.dump | head -1)
$ sudo cat "$F" | docker compose exec -T db sh -c 'createdb -U physiocare restore_test && pg_restore -U physiocare -d restore_test --no-owner'
$ docker compose exec -T db psql -U physiocare -d restore_test -c 'select (select count(*) from patients) patients, (select count(*) from appointments) appointments'
$ docker compose exec -T db dropdb -U physiocare restore_test
```

**ผลที่ควรเห็น:** จำนวนผู้ป่วยและนัดใกล้เคียงกับในระบบจริง

## ขั้นที่ 16 ตั้งการแจ้งเตือนเมื่อระบบล่ม

สมัคร uptime monitor (เช่น UptimeRobot, Better Stack) ให้เรียก `https://physio.yourclinic.co.th/api/health` ทุก 1–5 นาที และแจ้งเตือนทางอีเมล/LINE ของผู้ดูแลเมื่อไม่ตอบ

## ขั้นที่ 17 ตรวจรายการก่อนเปิดใช้งานจริง

**ความปลอดภัย**
- [ ] `.env` สร้างด้วย `init-env.sh` (รหัสลับสุ่ม) มีสิทธิ์ `600` และมีสำเนาเก็บนอกเซิร์ฟเวอร์
- [ ] บัญชีทดลอง `admin@physiocare.local` / `Passw0rd!` login **ไม่ได้** (ไม่ได้รัน `--demo`)
- [ ] SSH ใช้ key เท่านั้น, firewall เปิดแค่ 22/80/443, เปิดการอัปเดตความปลอดภัยอัตโนมัติ
- [ ] ไฟล์สำรองเข้ารหัส ส่งออกนอกเซิร์ฟเวอร์ และทดสอบกู้คืนแล้ว
- [ ] ทำ penetration test / security review ก่อนเปิดให้ผู้ป่วยเข้าใช้จากภายนอก

**PDPA**
- [ ] ประกาศความเป็นส่วนตัว (privacy notice) และขั้นตอนขอความยินยอมสำหรับข้อมูลสุขภาพ
- [ ] สัญญาประมวลผลข้อมูล (DPA) กับผู้ให้บริการ cloud และปลายทางที่เก็บไฟล์สำรอง
- [ ] ขั้นตอนแจ้งเหตุข้อมูลรั่วไหลต่อ สคส. ภายใน 72 ชั่วโมง และกำหนดผู้รับผิดชอบ (พิจารณาแต่งตั้ง DPO)
- [ ] นโยบายระยะเวลาเก็บเวชระเบียน (ตรวจตามกฎกระทรวงภายใต้ พ.ร.บ.สถานพยาบาล)

**ทางคลินิก**
- [ ] คณะทำงานวิชาการทบทวน `db/002_reference_data.sql` (การจับคู่โรค-ความเชี่ยวชาญ, ข้อห้ามใช้อุปกรณ์) และ `db/003_clinical_guidelines.sql`
- [ ] อบรมเจ้าหน้าที่ และทดลองใช้คู่กับระบบเดิม (pilot) 2–4 สัปดาห์

---

# งานดูแลประจำ

## อัปเดตเป็นเวอร์ชันใหม่

```bash
$ cd ~/physiocare/deploy
$ sh update.sh
```

สคริปต์ทำ 4 ขั้นตามลำดับ:
1. สำรองข้อมูลก่อนอัปเดต
2. ดึงโค้ดล่าสุด (`git pull --ff-only`)
3. build และเปิดระบบใหม่ (migration ใหม่รันอัตโนมัติ)
4. ตรวจว่าแอปและ HTTPS ตอบปกติ ถ้าไม่ผ่านจะแสดงคำสั่งย้อนกลับไปเวอร์ชันเดิม

**ผลที่ควรเห็นตอนจบ:** `สำเร็จ: https://<DOMAIN> ทำงานปกติ`

- **ไฟล์ migration:** ไฟล์ที่รันไปแล้วจะไม่ถูกรันซ้ำ ยกเว้น `003_clinical_guidelines.sql` (`@repeatable`) ที่รันใหม่เมื่อเนื้อหาเปลี่ยน
- **แก้ schema:** เพิ่มเป็นไฟล์ใหม่เสมอ เช่น `db/006_xxx.sql` ห้ามแก้ไฟล์เดิมที่รันไปแล้ว (ระบบจะเตือนและไม่รัน)

## ย้อนกลับเวอร์ชัน

```bash
$ cd ~/physiocare/deploy
$ git log --oneline -5                 # เลือก commit ที่ต้องการ
$ git checkout <commit>
$ docker compose up -d --build
```

ถ้าเวอร์ชันใหม่มี migration ที่เปลี่ยน schema ไปแล้ว ต้องกู้ฐานข้อมูลจากไฟล์ที่ `update.sh` สำรองไว้ก่อนอัปเดตด้วย (ดู "กู้คืนทั้งระบบ") กลับมาใช้เวอร์ชันล่าสุดด้วย `git checkout claude/physiocare-system`

## กู้คืนทั้งระบบจากไฟล์สำรอง

```bash
$ cd ~/physiocare/deploy
$ docker compose stop app
$ F=backups/db-YYYYMMDD-HHMMSS.dump
$ docker compose exec -T db sh -c 'dropdb -U physiocare --if-exists physiocare && createdb -U physiocare physiocare'
$ sudo cat "$F" | docker compose exec -T db pg_restore -U physiocare -d physiocare --no-owner
$ docker compose run --rm -T --user root -v "$PWD/backups:/b:ro" --entrypoint sh app \
    -c 'cd /data/uploads && tar -xzf /b/uploads-YYYYMMDD-HHMMSS.tar.gz && chown -R node:node /data/uploads'
$ docker compose start app
```

ถ้ากู้จากไฟล์ที่ส่งออกนอกเซิร์ฟเวอร์ ให้ถอดรหัสบนคอมพิวเตอร์ที่มี private key ก่อน (`gpg -d db-....dump.gpg > db-....dump`) แล้วคัดลอกขึ้นเซิร์ฟเวอร์ไว้ที่ `deploy/backups/`

## ย้ายไปเซิร์ฟเวอร์ใหม่

1. ทำขั้นที่ 1–8 บนเครื่องใหม่
2. คัดลอก `.env` เดิม (สำเนาที่เก็บไว้ในขั้นที่ 9) ไปไว้ที่ `deploy/.env` แล้วรัน `chmod 600 .env` — **อย่า** รัน `init-env.sh`
3. `docker compose up -d --build` แล้วกู้ข้อมูลตาม "กู้คืนทั้งระบบ"
4. เปลี่ยน DNS ให้ชี้ IP ใหม่

## คำสั่งที่ใช้บ่อย

| งาน | คำสั่ง |
|---|---|
| ดูสถานะ | `docker compose ps` |
| ดู log | `docker compose logs -f --tail=100 app` (เปลี่ยน `app` เป็น `caddy`, `db`, `backup` ได้) |
| สำรองทันที | `docker compose exec backup sh /backup.sh` |
| รีสตาร์ตแอป | `docker compose restart app` |
| ปิด/เปิดทั้งระบบ | `docker compose down` / `docker compose up -d` (ข้อมูลอยู่ใน volume ไม่หาย — **ห้ามใช้** `down -v` ซึ่งลบข้อมูลทั้งหมด) |
| พื้นที่ดิสก์ | `df -h` และ `docker system df` (ล้าง image เก่า: `docker image prune`) |
| Audit log | ผู้ดูแลระบบเรียก `GET /api/reports/audit` |

---

# แก้ปัญหา

| อาการ | สาเหตุที่พบบ่อย | วิธีแก้ |
|---|---|---|
| `docker compose up` แจ้ง `set POSTGRES_PASSWORD in .env` | ยังไม่ได้สร้าง `.env` | ขั้นที่ 9 |
| `init-env.sh` แจ้ง "มีไฟล์ .env อยู่แล้ว" | สร้างไปแล้ว | ใช้ไฟล์เดิม ถ้ายังไม่เคยเปิดระบบและต้องการสร้างใหม่ ให้ลบ `.env` ก่อน |
| เปิดเว็บแล้วใบรับรองไม่ถูกต้อง | DNS ยังไม่ชี้ / พอร์ต 80,443 ถูกปิด / Cloudflare proxy เปิดอยู่ | `docker compose logs caddy` ตรวจ DNS (ขั้นที่ 7) และ firewall ของผู้ให้บริการ |
| `app` รีสตาร์ตวนซ้ำ | migration ล้มเหลว หรือต่อฐานข้อมูลไม่ได้ | `docker compose logs app` |
| แก้ `POSTGRES_PASSWORD` แล้วต่อฐานข้อมูลไม่ได้ | รหัสถูกกำหนดตอนสร้าง volume ครั้งแรก | ใส่ค่าเดิมกลับใน `.env` หรือเปลี่ยนในฐานข้อมูล: `docker compose exec db psql -U physiocare -c "ALTER USER physiocare PASSWORD '<ค่าใหม่>'"` ให้ตรงกับ `.env` |
| login ไม่ได้ "พยายามเข้าสู่ระบบบ่อยเกินไป" | เกิน 30 ครั้ง/15 นาทีต่อ IP | รอ 15 นาที หรือ `docker compose restart app` |
| บัญชีถูกล็อก | ใส่รหัสผิด 5 ครั้ง | รอ 15 นาที หรือรีเซ็ตรหัสด้วย `create-admin -- --reset-password` |
| ผัง 3D ไม่ขึ้น | เครือข่ายบล็อก CDN (cdnjs) หรือเบราว์เซอร์ปิด WebGL | ตรวจการเข้าถึง cdnjs.cloudflare.com / เปิด hardware acceleration |
| real-time ไม่อัปเดต | มี proxy อื่นบัฟเฟอร์ SSE | ปิด buffering ของ `/api/realtime/stream` ที่ proxy นั้น |
| ดิสก์เต็ม | ไฟล์สำรอง/รูปภาพ/image เก่า | ลด `BACKUP_KEEP_DAYS`, `docker image prune`, ขยายดิสก์ |

---

# ข้อจำกัดที่ควรทราบ

- **หน้าเว็บพึ่ง CDN:** โหลด Tailwind CSS (Play CDN), Chart.js, Three.js และ Google Fonts จาก CDN ถ้าเครือข่ายของคลินิกบล็อก CDN หน้าเว็บจะแสดงผลผิด ระยะยาวควร build Tailwind และ host ไฟล์เองบนเซิร์ฟเวอร์
- **ตัวจำกัดการ login อยู่ในหน่วยความจำ:** จำกัด 30 ครั้งต่อ 15 นาทีต่อ IP ใช้ได้กับ app instance เดียว
- **รูปภาพเก็บบนดิสก์ของเซิร์ฟเวอร์:** ถ้าต้องการขยายเป็นหลายเครื่อง ให้เปลี่ยน `backend/src/storage/local.js` เป็น S3 หรือ MinIO
- **ยังไม่มีระบบส่งอีเมลหรือ SMS** จึงยังรีเซ็ตรหัสผ่านด้วยตัวเองไม่ได้ ผู้ดูแลระบบต้องรีเซ็ตให้

---

# ภาคผนวก: ผลการซ้อม deploy

ซ้อมติดตั้งตามคู่มือนี้จากเครื่องเปล่า (clone จาก GitHub ใหม่, Docker 29, Compose v5, `DOMAIN=localhost`):

**ทดสอบผ่าน**
- [x] ขั้นที่ 8–12: clone → `init-env.sh` → `docker compose up -d --build` → `create-admin`
  - build ผ่าน และทั้ง 4 service ขึ้น healthy
  - migration 5 ไฟล์รันอัตโนมัติ
  - หน้าเว็บตอบ 200
  - ผู้ดูแลระบบ login ได้ และบัญชีทดลอง login ไม่ได้ (401)
- [x] `init-env.sh` ปฏิเสธโดเมนผิดรูปแบบ และไม่เขียนทับ `.env` เดิม
- [x] `update.sh`: สำรองข้อมูล → ดึงโค้ด → build → ตรวจสุขภาพ ครบทุกขั้น
- [x] HTTPS, redirect 308, HSTS, cookie `Secure`, real-time ผ่าน Caddy
- [x] ข้อมูลยังอยู่หลัง `down`/`up`
- [x] กู้คืนฐานข้อมูลและรูปภาพตามขั้นตอน "กู้คืนทั้งระบบ" แล้วข้อมูลครบ
- [x] ไฟล์สำรองมีสิทธิ์ `rw-------`

**ยังไม่ได้ทดสอบ** (ต้องใช้เครื่องหรือบริการจริง)
- [ ] การขอใบรับรองจริงจาก Let's Encrypt (ต้องมีโดเมนจริง)
- [ ] ขั้นที่ 1–6 บน VM จริง: ufw, การตั้งค่า SSH และสคริปต์ติดตั้ง Docker
- [x] ขั้นที่ 14: ส่วนเข้ารหัสด้วย gpg (เลือกเฉพาะไฟล์ใหม่ ข้ามไฟล์เก่า และถอดรหัสกลับได้)
- [ ] ขั้นที่ 14: การส่งออกด้วย rclone และการรันผ่าน cron จริง
