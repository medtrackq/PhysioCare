-- =====================================================================
-- PhysioCare — ระยะที่ 3: กล้องช่วยนับท่า และวิดีโอคอลติดตามผล (telerehab)
--
--   exercises.camera            ค่าสำหรับนับท่าด้วยกล้อง (ข้อต่อที่วัด + มุมท่าพัก/มุมเป้าหมาย)
--                               ประมวลผลภาพในเครื่องผู้ป่วยเท่านั้น — server ได้รับแค่จำนวนครั้งที่นับได้
--   home_log_items.reps_counted จำนวนครั้งที่กล้องนับได้ (รวมทุกเซ็ต) — ข้อมูลช่วย ไม่ใช่ค่าวัดทางคลินิก
--   tele_sessions               นัดวิดีโอคอล (ผู้ป่วยเข้าร่วมด้วยลิงก์ เก็บ token แบบ hash + แบบเข้ารหัสสำหรับแนบใน LINE)
-- ไม่มีการบันทึกภาพหรือเสียงของวิดีโอคอล
-- =====================================================================

ALTER TABLE exercises ADD COLUMN camera jsonb
  CHECK (camera IS NULL OR (
    camera ? 'joint' AND camera->>'joint' IN ('knee','hip','hip_leg','shoulder','elbow')
    AND (camera->>'rest')::numeric BETWEEN 0 AND 180
    AND (camera->>'target')::numeric BETWEEN 0 AND 180
    AND abs((camera->>'rest')::numeric - (camera->>'target')::numeric) >= 15));
COMMENT ON COLUMN exercises.camera IS
  '{"joint":"knee|hip|hip_leg|shoulder|elbow","rest":องศาท่าพัก,"target":องศาที่ต้องถึง,"view":"side|front"} — นับ 1 ครั้งเมื่อมุมจากท่าพักไปถึงเป้าหมายแล้วกลับมา';

ALTER TABLE home_log_items ADD COLUMN reps_counted smallint CHECK (reps_counted BETWEEN 0 AND 1000);

-- ท่าพื้นฐานที่เห็นมุมข้อต่อชัดจากกล้องด้านข้าง
UPDATE exercises SET camera = '{"joint":"knee","rest":110,"target":155,"view":"side"}' WHERE code = 'SIT_STAND' AND camera IS NULL;
UPDATE exercises SET camera = '{"joint":"hip","rest":145,"target":165,"view":"side"}' WHERE code = 'BRIDGE' AND camera IS NULL;
UPDATE exercises SET camera = '{"joint":"hip_leg","rest":165,"target":145,"view":"side"}' WHERE code = 'SLR' AND camera IS NULL;
UPDATE exercises SET camera = '{"joint":"knee","rest":160,"target":120,"view":"side"}' WHERE code = 'HEEL_SLIDE' AND camera IS NULL;
UPDATE exercises SET camera = '{"joint":"shoulder","rest":60,"target":120,"view":"side"}' WHERE code = 'WALL_WALK' AND camera IS NULL;

CREATE TABLE tele_sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id    uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  therapist_id  uuid NOT NULL REFERENCES staff(id),
  program_id    uuid REFERENCES home_programs(id) ON DELETE SET NULL,
  scheduled_at  timestamptz NOT NULL,
  duration_min  smallint NOT NULL DEFAULT 20 CHECK (duration_min BETWEEN 5 AND 120),
  status        text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','in_progress','completed','cancelled','no_show')),
  purpose       text CHECK (char_length(purpose) <= 200),       -- แสดงให้ผู้ป่วยเห็น (ห้ามใส่ชื่อโรค)
  note          text CHECK (char_length(note) <= 4000),         -- บันทึกของนักกายภาพ (ผู้ป่วยไม่เห็น)
  token_hash    text NOT NULL UNIQUE,
  token_enc     text,
  consent_at    timestamptz,                                    -- ผู้ป่วยกดยินยอมก่อนเข้าห้อง
  started_at    timestamptz,
  ended_at      timestamptz,
  created_by    uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_tele_sched ON tele_sessions (scheduled_at) WHERE status IN ('scheduled','in_progress');
CREATE INDEX ix_tele_patient ON tele_sessions (patient_id, scheduled_at DESC);

ALTER TABLE notification_queue DROP CONSTRAINT notification_queue_kind_check;
ALTER TABLE notification_queue ADD CONSTRAINT notification_queue_kind_check
  CHECK (kind IN ('appointment_reminder','home_reminder','test','tele_reminder'));

INSERT INTO system_settings (key, value, description) VALUES
  ('tele.reminder_minutes', '15', 'ส่ง LINE เตือนวิดีโอคอลพร้อมลิงก์ก่อนเวลานัดกี่นาที'),
  ('tele.join_early_minutes', '15', 'ผู้ป่วยเข้าห้องวิดีโอคอลได้ก่อนเวลานัดกี่นาที')
ON CONFLICT (key) DO NOTHING;
