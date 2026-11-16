-- =====================================================================
-- PhysioCare — สิทธิ์ตามผู้ป่วยที่ดูแล (care team) + Super user + หัวหน้านักกายภาพ
--
--   นักกายภาพเห็นข้อมูลการรักษา (เวชระเบียน, ความก้าวหน้า, โปรแกรมที่บ้าน, วิดีโอคอล) เฉพาะผู้ป่วยที่
--     1) อยู่ในทีมผู้ดูแล (patient_care_team) หรือ
--     2) มีนัดกับตนเอง (ไม่นับนัดที่ยกเลิก) ภายใน access.appointment_window_days วันที่ผ่านมา หรือนัดที่จะถึง หรือ
--     3) เปิดดูฉุกเฉิน (clinical_access_grants: ต้องระบุเหตุผล มีอายุ 8 ชั่วโมง หัวหน้าเห็นรายการ)
--   emr:read_all       เห็นข้อมูลการรักษาของผู้ป่วยทุกคน (หัวหน้านักกายภาพ, super user)
--   care_team:assign   มอบหมาย/เปลี่ยนนักกายภาพผู้ดูแล (หัวหน้านักกายภาพ, เจ้าหน้าที่หน้าเคาน์เตอร์, super user)
--   superuser          ทุกสิทธิ์ (ทดสอบ/support) — ทุกการเปิดดูข้อมูลผู้ป่วยถูกบันทึก audit
-- =====================================================================

INSERT INTO roles (code, name_th, description) VALUES
 ('head_therapist', 'หัวหน้านักกายภาพ', 'เห็นข้อมูลการรักษาผู้ป่วยทุกคน มอบหมายนักกายภาพผู้ดูแล และทำงานแบบนักกายภาพ'),
 ('superuser',      'ผู้ดูแลระบบสูงสุด (Super user)', 'ทุกสิทธิ์รวมเวชระเบียน สำหรับทดสอบ/support — ทุกการเปิดดูข้อมูลผู้ป่วยถูกบันทึก')
ON CONFLICT (code) DO NOTHING;

INSERT INTO permissions (code, description) VALUES
 ('emr:read_all',     'เห็นข้อมูลการรักษาของผู้ป่วยทุกคน (ไม่จำกัดเฉพาะที่ดูแล)'),
 ('care_team:assign', 'มอบหมาย/เปลี่ยนนักกายภาพผู้ดูแลผู้ป่วย')
ON CONFLICT (code) DO NOTHING;

-- หัวหน้านักกายภาพ = สิทธิ์นักกายภาพ + เห็นทุกคน + มอบหมาย
INSERT INTO role_permissions (role_id, permission_code)
SELECT h.id, rp.permission_code FROM roles h, role_permissions rp JOIN roles t ON t.id = rp.role_id
 WHERE h.code = 'head_therapist' AND t.code = 'therapist'
ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id, permission_code)
SELECT r.id, p FROM roles r, unnest(ARRAY['emr:read_all', 'care_team:assign', 'shifts:write']) p WHERE r.code = 'head_therapist'
ON CONFLICT DO NOTHING;
-- เจ้าหน้าที่หน้าเคาน์เตอร์มอบหมายผู้ดูแลตอนลงทะเบียนได้ (ไม่ได้ทำให้เห็นข้อมูลการรักษา)
INSERT INTO role_permissions (role_id, permission_code)
SELECT r.id, 'care_team:assign' FROM roles r WHERE r.code = 'staff'
ON CONFLICT DO NOTHING;
-- super user = ทุกสิทธิ์ ยกเว้น "นัดของตนเอง" ของผู้ป่วย
INSERT INTO role_permissions (role_id, permission_code)
SELECT r.id, p.code FROM roles r, permissions p WHERE r.code = 'superuser' AND p.code <> 'appointments:read_own'
ON CONFLICT DO NOTHING;

CREATE TABLE patient_care_team (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id   uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  staff_id     uuid NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  is_primary   boolean NOT NULL DEFAULT false,
  assigned_by  uuid,
  assigned_at  timestamptz NOT NULL DEFAULT now(),
  ended_at     timestamptz,
  ended_by     uuid
);
CREATE UNIQUE INDEX ux_care_team_active ON patient_care_team (patient_id, staff_id) WHERE ended_at IS NULL;
CREATE UNIQUE INDEX ux_care_team_primary ON patient_care_team (patient_id) WHERE ended_at IS NULL AND is_primary;
CREATE INDEX ix_care_team_staff ON patient_care_team (staff_id) WHERE ended_at IS NULL;

CREATE TABLE clinical_access_grants (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  patient_id  uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  reason      text NOT NULL CHECK (char_length(reason) BETWEEN 10 AND 500),
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  reviewed_by uuid,
  reviewed_at timestamptz
);
CREATE INDEX ix_access_grants_user ON clinical_access_grants (user_id, patient_id, expires_at);
CREATE INDEX ix_access_grants_recent ON clinical_access_grants (created_at DESC);

-- ผู้ป่วยเดิม: นักกายภาพที่ผู้ป่วยมีนัดด้วยบ่อยที่สุด (ไม่นับนัดยกเลิก) เป็นผู้ดูแลหลัก
INSERT INTO patient_care_team (patient_id, staff_id, is_primary)
SELECT DISTINCT ON (a.patient_id) a.patient_id, a.therapist_id, true
  FROM appointments a
 WHERE a.status NOT IN ('cancelled')
 GROUP BY a.patient_id, a.therapist_id
 ORDER BY a.patient_id, count(*) DESC, max(a.start_at) DESC
ON CONFLICT DO NOTHING;

INSERT INTO system_settings (key, value, description) VALUES
  ('access.appointment_window_days', '180', 'นักกายภาพเห็นข้อมูลการรักษาของผู้ป่วยที่เคยมีนัดด้วยภายในกี่วัน (นัดที่จะถึงนับเสมอ)'),
  ('access.break_glass_hours', '8', 'การเปิดดูฉุกเฉินมีผลกี่ชั่วโมง')
ON CONFLICT (key) DO NOTHING;
