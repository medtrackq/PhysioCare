-- =====================================================================
-- PhysioCare — ระยะที่ 2: แจ้งเตือนทาง LINE, แบบประเมินรายสัปดาห์, แนะนำปรับระดับท่า
--
--   patient_contacts      ผู้ป่วยที่เชื่อม LINE แล้ว (userId ของ LINE, ยกเลิกรับข้อความได้)
--   line_link_codes       รหัสเชื่อม LINE (ผู้ป่วยสแกน QR → ส่งรหัสในแชต → ระบบผูกบัญชี)
--   notification_queue    คิวข้อความ (กันส่งซ้ำด้วย dedupe_key, ส่งซ้ำอัตโนมัติเมื่อล้มเหลว)
--   home_checkins         แบบประเมินรายสัปดาห์จากที่บ้าน (PSFS + GROC)
-- ปิดไว้จนกว่าจะตั้ง notify.enabled = true และใส่ค่าการเชื่อมต่อ LINE ใน environment
-- =====================================================================

CREATE TABLE patient_contacts (
  patient_id     uuid PRIMARY KEY REFERENCES patients(id) ON DELETE CASCADE,
  line_user_id   text UNIQUE,
  line_name      text,
  linked_at      timestamptz,
  opted_out_at   timestamptz,          -- ผู้ป่วยพิมพ์ "หยุด" → ไม่ส่งข้อความ
  blocked_at     timestamptz,          -- ผู้ป่วยบล็อก/เลิกเป็นเพื่อน
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE line_link_codes (
  code        text PRIMARY KEY CHECK (code ~ '^[A-Z0-9]{6}$'),
  patient_id  uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  created_by  uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz
);

CREATE TABLE notification_queue (
  id             bigserial PRIMARY KEY,
  patient_id     uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  channel        text NOT NULL DEFAULT 'line' CHECK (channel IN ('line')),
  kind           text NOT NULL CHECK (kind IN ('appointment_reminder','home_reminder','test')),
  dedupe_key     text NOT NULL UNIQUE,
  ref_id         uuid,                 -- นัด / โปรแกรม
  scheduled_for  timestamptz NOT NULL DEFAULT now(),
  status         text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed','dead','skipped')),
  attempts       smallint NOT NULL DEFAULT 0,
  last_error     text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  sent_at        timestamptz
);
CREATE INDEX ix_notify_due ON notification_queue (scheduled_for) WHERE status IN ('pending','failed');

-- โปรแกรมที่บ้าน: เวลาเตือนรายคน + กิจกรรมสำหรับ PSFS (สูงสุด 3 กิจกรรม)
ALTER TABLE home_programs ADD COLUMN reminder_time time;
ALTER TABLE home_programs ADD COLUMN psfs_activities text[] NOT NULL DEFAULT '{}'
  CHECK (cardinality(psfs_activities) <= 3);
-- เวลาที่ปรับขนาดท่าล่าสุด: ระบบแนะนำนับเฉพาะวันหลังปรับ (ไม่แนะนำซ้ำจากข้อมูลของขนาดเดิม)
ALTER TABLE home_program_items ADD COLUMN dose_changed_at timestamptz;
ALTER TABLE home_program_items ALTER COLUMN dose_changed_at SET DEFAULT now();
-- ลิงก์ที่ระบบสร้างเพื่อแนบในข้อความ LINE: เก็บ token แบบเข้ารหัส (นำกลับมาใช้ซ้ำได้) แทนการสร้างลิงก์ใหม่ทุกวัน
ALTER TABLE home_access_links ADD COLUMN token_enc text;

CREATE TABLE home_checkins (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  program_id  uuid NOT NULL REFERENCES home_programs(id) ON DELETE CASCADE,
  checkin_date date NOT NULL,
  psfs        jsonb NOT NULL DEFAULT '[]',     -- [{"activity":"เดินขึ้นบันได","score":6}]
  groc        smallint CHECK (groc BETWEEN -3 AND 3),  -- -3 แย่ลงมาก … 0 เท่าเดิม … +3 ดีขึ้นมาก
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (program_id, checkin_date)
);

INSERT INTO system_settings (key, value, description) VALUES
 ('clinic.name',                  '"คลินิกกายภาพบำบัด"', 'ชื่อคลินิกที่แสดงในข้อความถึงผู้ป่วย'),
 ('notify.enabled',               'false', 'เปิดการส่งข้อความแจ้งเตือนทาง LINE (ต้องตั้งค่าการเชื่อมต่อ LINE ก่อน)'),
 ('notify.line_basic_id',         '""', 'LINE Official Account ID ของคลินิก เช่น @123abcde (ใช้สร้าง QR ให้ผู้ป่วยเชื่อม LINE)'),
 ('notify.appointment_hours',     '[24]', 'เตือนนัดล่วงหน้ากี่ชั่วโมง (ใส่ได้หลายค่า เช่น [24, 2])'),
 ('notify.home_reminder_time',    '"18:00"', 'เวลาเตือนทำกายภาพที่บ้าน (ถ้าโปรแกรมไม่ได้กำหนดเอง)'),
 ('notify.quiet_hours',           '{"start":"21:00","end":"07:00"}', 'ช่วงเวลาที่ไม่ส่งข้อความ (เลื่อนไปส่งเมื่อพ้นช่วง)')
ON CONFLICT (key) DO NOTHING;
