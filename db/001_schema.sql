-- =====================================================================
-- PhysioCare Management System — Database Schema (PostgreSQL 14+)
-- =====================================================================
-- หลักการออกแบบ
--  * ใช้ timestamptz ทุกจุด (เก็บเป็น UTC, แสดงผลเป็น Asia/Bangkok)
--  * ป้องกันการจองซ้อนที่ระดับฐานข้อมูลด้วย EXCLUDE constraint (btree_gist)
--    เป็น "ด่านสุดท้าย" แม้ชั้น API จะตรวจสอบก่อนแล้วก็ตาม (กัน race condition)
--  * สถานะอุปกรณ์เปลี่ยน -> trigger บันทึก log + pg_notify เพื่อ push real-time
--  * เวชระเบียนที่ลงนามแล้ว (signed) ห้ามแก้ไข/ลบ — แก้ได้ทาง addendum เท่านั้น
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------
-- Utility
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trg_set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$ LANGUAGE plpgsql;

-- ผู้ใช้ปัจจุบัน (ตั้งค่าใน transaction ด้วย set_config('app.user_id', ..., true))
CREATE OR REPLACE FUNCTION app_current_user() RETURNS uuid AS $$
  SELECT NULLIF(current_setting('app.user_id', true), '')::uuid
$$ LANGUAGE sql STABLE;

-- =====================================================================
-- 1. RBAC
-- =====================================================================
CREATE TABLE roles (
  id          smallserial PRIMARY KEY,
  code        text UNIQUE NOT NULL,              -- admin | therapist | staff | patient
  name_th     text NOT NULL,
  description text
);

CREATE TABLE permissions (
  code        text PRIMARY KEY,                  -- เช่น 'emr:write'
  description text NOT NULL
);

CREATE TABLE role_permissions (
  role_id         smallint REFERENCES roles(id) ON DELETE CASCADE,
  permission_code text     REFERENCES permissions(code) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_code)
);

-- =====================================================================
-- 2. MEDIA (เก็บรูปภาพทั้งหมดแบบ polymorphic)
-- =====================================================================
CREATE TABLE media_files (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type   text NOT NULL CHECK (entity_type IN
                  ('equipment','staff','patient','assessment','maintenance','user')),
  entity_id     uuid NOT NULL,
  kind          text NOT NULL DEFAULT 'photo'
                  CHECK (kind IN ('photo','posture','wound','document','avatar')),
  storage_key   text NOT NULL UNIQUE,            -- path ใน local disk / S3 key
  original_name text,
  mime_type     text NOT NULL CHECK (mime_type IN ('image/jpeg','image/png','image/webp')),
  size_bytes    integer NOT NULL CHECK (size_bytes > 0),
  sha256        char(64) NOT NULL,
  caption       text,
  is_primary    boolean NOT NULL DEFAULT false,
  uploaded_by   uuid,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_media_entity ON media_files (entity_type, entity_id);
-- รูปหลักได้แค่ 1 รูปต่อ entity
CREATE UNIQUE INDEX uq_media_primary ON media_files (entity_type, entity_id) WHERE is_primary;

-- =====================================================================
-- 3. STAFF MASTER
-- =====================================================================
CREATE TABLE specialties (
  id      smallserial PRIMARY KEY,
  code    text UNIQUE NOT NULL,                  -- ORTHO | NEURO | PEDS | SPORTS | CARDIO | GERI
  name_th text NOT NULL,
  name_en text NOT NULL
);

CREATE TABLE staff (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_code  text UNIQUE NOT NULL,
  title          text,                            -- กภ., นาย, นางสาว
  first_name     text NOT NULL,
  last_name      text NOT NULL,
  position       text NOT NULL CHECK (position IN ('physiotherapist','assistant','admin')),
  license_no     text,                            -- เลขใบอนุญาตประกอบวิชาชีพกายภาพบำบัด
  license_expiry date,
  phone          text,
  email          text,
  color          text DEFAULT '#0ea5e9',          -- สีบนปฏิทิน
  max_patients_per_day smallint NOT NULL DEFAULT 12,
  is_active      boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_pt_license CHECK (position <> 'physiotherapist' OR license_no IS NOT NULL)
);
CREATE TRIGGER staff_updated BEFORE UPDATE ON staff FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at();

CREATE TABLE staff_specialties (
  staff_id     uuid     REFERENCES staff(id) ON DELETE CASCADE,
  specialty_id smallint REFERENCES specialties(id),
  level        smallint NOT NULL DEFAULT 3 CHECK (level BETWEEN 1 AND 5), -- 5 = ผู้เชี่ยวชาญ
  certified_at date,
  PRIMARY KEY (staff_id, specialty_id)
);

CREATE TABLE shift_templates (
  id         smallserial PRIMARY KEY,
  code       text UNIQUE NOT NULL,               -- MORNING | AFTERNOON | FULL | EVENING
  name_th    text NOT NULL,
  start_time time NOT NULL,
  end_time   time NOT NULL CHECK (end_time > start_time)
);

-- กะทำงานจริงรายวัน (materialized จาก template หรือกำหนดเอง)
CREATE TABLE staff_shifts (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id          uuid NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  shift_template_id smallint REFERENCES shift_templates(id),
  start_at          timestamptz NOT NULL,
  end_at            timestamptz NOT NULL,
  period            tstzrange GENERATED ALWAYS AS (tstzrange(start_at, end_at, '[)')) STORED,
  note              text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (end_at > start_at),
  -- บุคลากร 1 คนมีกะซ้อนกันไม่ได้
  CONSTRAINT ex_shift_overlap EXCLUDE USING gist (staff_id WITH =, period WITH &&)
);
CREATE INDEX idx_shift_period ON staff_shifts USING gist (period);

CREATE TABLE staff_leaves (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id   uuid NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  start_at   timestamptz NOT NULL,
  end_at     timestamptz NOT NULL,
  period     tstzrange GENERATED ALWAYS AS (tstzrange(start_at, end_at, '[)')) STORED,
  leave_type text NOT NULL DEFAULT 'personal' CHECK (leave_type IN ('sick','personal','vacation','training')),
  reason     text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (end_at > start_at)
);
CREATE INDEX idx_leave_period ON staff_leaves USING gist (staff_id, period);

-- =====================================================================
-- 4. EQUIPMENT MASTER
-- =====================================================================
CREATE TABLE equipment_categories (
  id                     smallserial PRIMARY KEY,
  code                   text UNIQUE NOT NULL,   -- US | TENS | IFC | SWD | HOTPACK ...
  name_th                text NOT NULL,
  name_en                text NOT NULL,
  modality               text NOT NULL CHECK (modality IN
                           ('electrotherapy','thermotherapy','cryotherapy','mechanical',
                            'exercise','light','acoustic')),
  default_session_minutes smallint NOT NULL DEFAULT 20,
  cleaning_buffer_minutes smallint NOT NULL DEFAULT 5,   -- เวลาทำความสะอาด/เตรียมเครื่องหลังใช้
  maintenance_interval_days smallint NOT NULL DEFAULT 180
);

CREATE TABLE equipment (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_code           text UNIQUE NOT NULL,     -- รหัสครุภัณฑ์
  name                 text NOT NULL,
  category_id          smallint NOT NULL REFERENCES equipment_categories(id),
  brand                text,
  model                text,
  serial_no            text,
  location             text,
  purchase_date        date,
  purchase_price       numeric(12,2),
  vendor               text,
  warranty_expiry      date,
  status               text NOT NULL DEFAULT 'available'
                         CHECK (status IN ('available','in_use','maintenance','broken','retired')),
  status_changed_at    timestamptz NOT NULL DEFAULT now(),
  current_appointment_id uuid,                   -- ระหว่าง in_use
  last_maintenance_at  date,
  next_maintenance_due date,
  notes                text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_equipment_category_status ON equipment (category_id, status);
CREATE TRIGGER equipment_updated BEFORE UPDATE ON equipment FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at();

CREATE TABLE equipment_status_logs (
  id             bigserial PRIMARY KEY,
  equipment_id   uuid NOT NULL REFERENCES equipment(id) ON DELETE CASCADE,
  from_status    text,
  to_status      text NOT NULL,
  reason         text,
  appointment_id uuid,
  changed_by     uuid,
  changed_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_eq_status_log ON equipment_status_logs (equipment_id, changed_at DESC);

CREATE TABLE equipment_maintenance (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  equipment_id    uuid NOT NULL REFERENCES equipment(id) ON DELETE CASCADE,
  type            text NOT NULL CHECK (type IN ('preventive','corrective','calibration','inspection')),
  status          text NOT NULL DEFAULT 'scheduled'
                    CHECK (status IN ('scheduled','in_progress','completed','cancelled')),
  -- ช่วงเวลาที่วางแผนปิดเครื่อง (ใช้ block การจอง)
  planned_start   timestamptz,
  planned_end     timestamptz,
  planned_period  tstzrange GENERATED ALWAYS AS (tstzrange(planned_start, planned_end, '[)')) STORED,
  reported_at     timestamptz NOT NULL DEFAULT now(),
  started_at      timestamptz,
  completed_at    timestamptz,
  problem         text,
  action_taken    text,
  result          text CHECK (result IN ('pass','fail','repaired','replaced_part','sent_to_vendor')),
  vendor          text,
  technician      text,
  cost            numeric(12,2) DEFAULT 0,
  created_by      uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (planned_end IS NULL OR planned_end > planned_start)
);
CREATE INDEX idx_maint_equipment ON equipment_maintenance (equipment_id, reported_at DESC);
CREATE INDEX idx_maint_period ON equipment_maintenance USING gist (equipment_id, planned_period);

-- =====================================================================
-- 5. PATIENT & CLINICAL KNOWLEDGE BASE
-- =====================================================================
CREATE TABLE patients (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hn                text UNIQUE NOT NULL,        -- Hospital Number
  title             text,
  first_name        text NOT NULL,
  last_name         text NOT NULL,
  date_of_birth     date,
  gender            text CHECK (gender IN ('male','female','other')),
  phone             text,
  email             text,
  address           text,
  emergency_contact jsonb,
  allergies         text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_patient_name ON patients (first_name, last_name);
CREATE TRIGGER patients_updated BEFORE UPDATE ON patients FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at();

CREATE TABLE diagnoses (
  id          serial PRIMARY KEY,
  icd10_code  text UNIQUE NOT NULL,
  name_th     text NOT NULL,
  name_en     text NOT NULL,
  body_region text
);

CREATE TABLE patient_diagnoses (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id   uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  diagnosis_id int  NOT NULL REFERENCES diagnoses(id),
  is_primary   boolean NOT NULL DEFAULT false,
  status       text NOT NULL DEFAULT 'active' CHECK (status IN ('active','resolved')),
  onset_date   date,
  referred_by  text,
  notes        text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_pd_patient ON patient_diagnoses (patient_id) WHERE status = 'active';

-- ประเภทข้อควรระวัง (Precautions / Red flags)
CREATE TABLE precaution_types (
  code     text PRIMARY KEY,                     -- PACEMAKER | PREGNANCY | METAL_IMPLANT ...
  name_th  text NOT NULL,
  name_en  text NOT NULL,
  severity text NOT NULL DEFAULT 'moderate' CHECK (severity IN ('low','moderate','high'))
);

CREATE TABLE patient_precautions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id      uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  precaution_code text NOT NULL REFERENCES precaution_types(code),
  detail          text,
  is_active       boolean NOT NULL DEFAULT true,
  recorded_by     uuid,
  recorded_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_patient_precaution_active ON patient_precautions (patient_id, precaution_code) WHERE is_active;

-- ---------------------------------------------------------------------
-- Knowledge base สำหรับระบบแนะนำ (Diagnosis-to-Staff/Equipment Mapping)
-- ---------------------------------------------------------------------
CREATE TABLE diagnosis_specialty_map (
  diagnosis_id int      REFERENCES diagnoses(id) ON DELETE CASCADE,
  specialty_id smallint REFERENCES specialties(id) ON DELETE CASCADE,
  weight       numeric(3,2) NOT NULL CHECK (weight > 0 AND weight <= 1),
  PRIMARY KEY (diagnosis_id, specialty_id)
);

CREATE TABLE diagnosis_equipment_map (
  diagnosis_id          int      REFERENCES diagnoses(id) ON DELETE CASCADE,
  equipment_category_id smallint REFERENCES equipment_categories(id) ON DELETE CASCADE,
  weight                numeric(3,2) NOT NULL CHECK (weight > 0 AND weight <= 1),
  rationale             text,
  PRIMARY KEY (diagnosis_id, equipment_category_id)
);

-- ข้อห้ามใช้เครื่องมือตามข้อควรระวังของผู้ป่วย
CREATE TABLE precaution_contraindications (
  precaution_code       text     REFERENCES precaution_types(code) ON DELETE CASCADE,
  equipment_category_id smallint REFERENCES equipment_categories(id) ON DELETE CASCADE,
  level                 text NOT NULL CHECK (level IN ('absolute','relative')),
  note                  text,
  PRIMARY KEY (precaution_code, equipment_category_id)
);

-- =====================================================================
-- 6. USERS (ผูกกับ staff หรือ patient)
-- =====================================================================
CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text UNIQUE NOT NULL,
  password_hash text NOT NULL,
  display_name  text NOT NULL,
  role_id       smallint NOT NULL REFERENCES roles(id),
  staff_id      uuid UNIQUE REFERENCES staff(id) ON DELETE SET NULL,
  patient_id    uuid UNIQUE REFERENCES patients(id) ON DELETE SET NULL,
  is_active     boolean NOT NULL DEFAULT true,
  failed_logins smallint NOT NULL DEFAULT 0,
  locked_until  timestamptz,
  last_login_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (NOT (staff_id IS NOT NULL AND patient_id IS NOT NULL))
);
CREATE TRIGGER users_updated BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at();

-- =====================================================================
-- 7. SMART SCHEDULING
-- =====================================================================
CREATE TABLE appointments (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id       uuid NOT NULL REFERENCES patients(id),
  therapist_id     uuid NOT NULL REFERENCES staff(id),
  diagnosis_id     int REFERENCES diagnoses(id),
  start_at         timestamptz NOT NULL,
  end_at           timestamptz NOT NULL,
  period           tstzrange GENERATED ALWAYS AS (tstzrange(start_at, end_at, '[)')) STORED,
  status           text NOT NULL DEFAULT 'booked' CHECK (status IN
                     ('booked','confirmed','checked_in','in_progress','completed','cancelled','no_show')),
  visit_type       text NOT NULL DEFAULT 'follow_up' CHECK (visit_type IN ('initial','follow_up','re_evaluation')),
  notes            text,
  cancel_reason    text,
  booked_via       text NOT NULL DEFAULT 'manual' CHECK (booked_via IN ('manual','recommendation','patient_portal')),
  version          integer NOT NULL DEFAULT 1,   -- optimistic locking สำหรับการเลื่อนนัด
  created_by       uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (end_at > start_at),
  -- (A) นักกายภาพ 1 คน ห้ามมีนัดซ้อน
  CONSTRAINT ex_therapist_double_booking EXCLUDE USING gist
    (therapist_id WITH =, period WITH &&) WHERE (status NOT IN ('cancelled','no_show')),
  -- (B) ผู้ป่วย 1 คน ห้ามมีนัดซ้อน
  CONSTRAINT ex_patient_double_booking EXCLUDE USING gist
    (patient_id WITH =, period WITH &&) WHERE (status NOT IN ('cancelled','no_show'))
);
CREATE INDEX idx_appt_start ON appointments (start_at);
CREATE INDEX idx_appt_patient ON appointments (patient_id, start_at DESC);
CREATE TRIGGER appointments_updated BEFORE UPDATE ON appointments FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at();

ALTER TABLE equipment ADD CONSTRAINT fk_eq_current_appt
  FOREIGN KEY (current_appointment_id) REFERENCES appointments(id) ON DELETE SET NULL;

-- การจองอุปกรณ์ (ช่วงเวลารวม cleaning buffer แล้ว)
CREATE TABLE appointment_equipment (
  appointment_id uuid NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  equipment_id   uuid NOT NULL REFERENCES equipment(id),
  start_at       timestamptz NOT NULL,
  end_at         timestamptz NOT NULL,           -- = appointment.end_at + cleaning buffer
  period         tstzrange GENERATED ALWAYS AS (tstzrange(start_at, end_at, '[)')) STORED,
  is_active      boolean NOT NULL DEFAULT true,
  PRIMARY KEY (appointment_id, equipment_id),
  CHECK (end_at > start_at),
  -- (C) อุปกรณ์ 1 เครื่อง ห้ามถูกจองซ้อน
  CONSTRAINT ex_equipment_double_booking EXCLUDE USING gist
    (equipment_id WITH =, period WITH &&) WHERE (is_active)
);
CREATE INDEX idx_appt_eq_period ON appointment_equipment USING gist (period) WHERE is_active;

-- =====================================================================
-- 8. EMR & CLINICAL ASSESSMENT
-- =====================================================================
CREATE TABLE clinical_assessments (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  appointment_id      uuid NOT NULL REFERENCES appointments(id),
  patient_id          uuid NOT NULL REFERENCES patients(id),
  therapist_id        uuid NOT NULL REFERENCES staff(id),
  phase               text NOT NULL CHECK (phase IN ('pre','post')),
  -- Pain (Numeric Rating Scale 0-10)
  pain_score          smallint CHECK (pain_score BETWEEN 0 AND 10),
  pain_location       text,
  pain_character      text,                     -- sharp, dull, burning, radiating
  -- Vital signs: {"bp_sys":120,"bp_dia":80,"hr":72,"spo2":98}
  vitals              jsonb,
  -- SOAP
  subjective          text,
  objective           text,
  assessment          text,
  plan                text,
  -- Pre-treatment
  precautions_reviewed boolean NOT NULL DEFAULT false,
  red_flags           text,
  -- Post-treatment (progress note)
  treatment_response  text CHECK (treatment_response IN ('improved','unchanged','worsened')),
  adverse_events      text,
  home_program        text,
  next_visit_plan     text,
  goals               jsonb,                    -- [{"goal":"...","target":"...","achieved_pct":40}]
  functional_scores   jsonb,                    -- {"ODI":32,"NDI":20,"BergBalance":45}
  -- Signing
  created_by          uuid NOT NULL,
  signed_by           uuid,
  signed_at           timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (appointment_id, phase)
);
CREATE INDEX idx_assess_patient ON clinical_assessments (patient_id, created_at);
CREATE TRIGGER assessments_updated BEFORE UPDATE ON clinical_assessments FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at();

-- Range of Motion (องศาการเคลื่อนไหว)
CREATE TABLE rom_measurements (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  assessment_id    uuid NOT NULL REFERENCES clinical_assessments(id) ON DELETE CASCADE,
  joint            text NOT NULL CHECK (joint IN
                     ('cervical','thoracic','lumbar','shoulder','elbow','wrist','hip','knee','ankle')),
  movement         text NOT NULL,                -- flexion, extension, abduction, ...
  side             text NOT NULL DEFAULT 'na' CHECK (side IN ('left','right','na')),
  mode             text NOT NULL DEFAULT 'active' CHECK (mode IN ('active','passive')),
  degrees          numeric(5,1) NOT NULL CHECK (degrees BETWEEN -90 AND 360),
  normal_degrees   numeric(5,1),
  pain_on_movement boolean NOT NULL DEFAULT false,
  end_feel         text,
  UNIQUE (assessment_id, joint, movement, side, mode)
);

-- การรักษาที่ทำจริงในนัด (เชื่อมกับอุปกรณ์)
CREATE TABLE treatment_records (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  assessment_id  uuid NOT NULL REFERENCES clinical_assessments(id) ON DELETE CASCADE,
  equipment_id   uuid REFERENCES equipment(id),
  intervention   text NOT NULL,                  -- 'Ultrasound therapy', 'Therapeutic exercise'
  body_part      text,
  parameters     jsonb,                          -- {"frequency_mhz":1,"intensity_w_cm2":1.5,"mode":"pulsed"}
  duration_min   smallint CHECK (duration_min > 0)
);

CREATE TABLE assessment_addenda (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  assessment_id uuid NOT NULL REFERENCES clinical_assessments(id),
  content       text NOT NULL,
  author_id     uuid NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- ห้ามแก้/ลบเวชระเบียนที่ลงนามแล้ว
CREATE OR REPLACE FUNCTION trg_protect_signed_assessment() RETURNS trigger AS $$
BEGIN
  IF OLD.signed_at IS NOT NULL THEN
    RAISE EXCEPTION 'Signed assessment % is immutable; use an addendum', OLD.id
      USING ERRCODE = 'P0001', HINT = 'EMR_LOCKED';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER assessment_lock BEFORE UPDATE OR DELETE ON clinical_assessments
  FOR EACH ROW EXECUTE FUNCTION trg_protect_signed_assessment();

CREATE OR REPLACE FUNCTION trg_protect_signed_children() RETURNS trigger AS $$
DECLARE v_signed timestamptz;
BEGIN
  SELECT signed_at INTO v_signed FROM clinical_assessments
   WHERE id = COALESCE(NEW.assessment_id, OLD.assessment_id);
  IF v_signed IS NOT NULL THEN
    RAISE EXCEPTION 'Assessment is signed; child records are immutable'
      USING ERRCODE = 'P0001', HINT = 'EMR_LOCKED';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER rom_lock BEFORE INSERT OR UPDATE OR DELETE ON rom_measurements
  FOR EACH ROW EXECUTE FUNCTION trg_protect_signed_children();
CREATE TRIGGER treatment_lock BEFORE INSERT OR UPDATE OR DELETE ON treatment_records
  FOR EACH ROW EXECUTE FUNCTION trg_protect_signed_children();

-- =====================================================================
-- 9. SYSTEM SETTINGS & AUDIT
-- =====================================================================
CREATE TABLE system_settings (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  description text,
  updated_by  uuid,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_logs (
  id          bigserial PRIMARY KEY,
  user_id     uuid,
  action      text NOT NULL,                     -- 'emr.read', 'appointment.create', ...
  entity_type text,
  entity_id   uuid,
  ip          inet,
  user_agent  text,
  detail      jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_entity ON audit_logs (entity_type, entity_id, created_at DESC);
CREATE INDEX idx_audit_user ON audit_logs (user_id, created_at DESC);

-- =====================================================================
-- 10. REAL-TIME TRIGGERS
-- =====================================================================
-- (a) สถานะอุปกรณ์เปลี่ยน -> log + NOTIFY 'equipment_status'
CREATE OR REPLACE FUNCTION trg_equipment_status_change() RETURNS trigger AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    NEW.status_changed_at := now();
    IF NEW.status <> 'in_use' THEN NEW.current_appointment_id := NULL; END IF;
    INSERT INTO equipment_status_logs (equipment_id, from_status, to_status, reason, appointment_id, changed_by)
    VALUES (NEW.id, OLD.status, NEW.status,
            NULLIF(current_setting('app.status_reason', true), ''),
            NEW.current_appointment_id, app_current_user());
    PERFORM pg_notify('equipment_status', json_build_object(
      'id', NEW.id, 'asset_code', NEW.asset_code, 'name', NEW.name,
      'from', OLD.status, 'to', NEW.status,
      'appointment_id', NEW.current_appointment_id,
      'at', now())::text);
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER equipment_status_change BEFORE UPDATE OF status ON equipment
  FOR EACH ROW EXECUTE FUNCTION trg_equipment_status_change();

-- (b) สถานะนัดเปลี่ยน -> ซิงก์สถานะอุปกรณ์ + ปลด/คืน reservation + NOTIFY
CREATE OR REPLACE FUNCTION trg_appointment_status_sync() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.status IS DISTINCT FROM OLD.status THEN
    -- เริ่มรักษา: อุปกรณ์ที่จองไว้ -> in_use
    IF NEW.status = 'in_progress' THEN
      UPDATE equipment e SET status = 'in_use', current_appointment_id = NEW.id
        FROM appointment_equipment ae
       WHERE ae.appointment_id = NEW.id AND ae.equipment_id = e.id
         AND ae.is_active AND e.status = 'available';
    END IF;

    -- จบ/ยกเลิก: คืนสถานะ available
    IF NEW.status IN ('completed','cancelled','no_show') THEN
      UPDATE equipment e SET status = 'available'
       WHERE e.current_appointment_id = NEW.id AND e.status = 'in_use';
    END IF;

    -- ยกเลิก: ปลด reservation ให้คนอื่นจองได้
    IF NEW.status IN ('cancelled','no_show') THEN
      UPDATE appointment_equipment SET is_active = false WHERE appointment_id = NEW.id;
    END IF;

    -- จบก่อนเวลา: คืนช่วงเวลาที่เหลือของอุปกรณ์ (เผื่อ buffer เดิม)
    IF NEW.status = 'completed' AND now() < NEW.end_at THEN
      UPDATE appointment_equipment ae
         SET end_at = GREATEST(ae.start_at + interval '1 minute',
                               now() + (ae.end_at - NEW.end_at))
       WHERE ae.appointment_id = NEW.id AND ae.is_active;
    END IF;
  END IF;

  PERFORM pg_notify('appointment_changed', json_build_object(
    'id', NEW.id, 'op', TG_OP, 'status', NEW.status,
    'therapist_id', NEW.therapist_id, 'start_at', NEW.start_at)::text);
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER appointment_status_sync AFTER INSERT OR UPDATE ON appointments
  FOR EACH ROW EXECUTE FUNCTION trg_appointment_status_sync();

-- =====================================================================
-- 11. REPORTING VIEWS
-- =====================================================================
CREATE VIEW v_equipment_overview AS
SELECT e.id, e.asset_code, e.name, e.status, e.location, e.purchase_date,
       e.next_maintenance_due, c.code AS category_code, c.name_th AS category_name,
       (e.next_maintenance_due IS NOT NULL AND e.next_maintenance_due <= CURRENT_DATE + 14) AS maintenance_due_soon,
       (SELECT m.id FROM media_files m WHERE m.entity_type = 'equipment' AND m.entity_id = e.id AND m.is_primary) AS primary_image_id
  FROM equipment e JOIN equipment_categories c ON c.id = e.category_id;
