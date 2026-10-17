-- =====================================================================
-- PhysioCare — Rooms & beds (ห้องและเตียงเป็นทรัพยากรในการจัดตาราง)
--
-- * เตียง (beds): ทรัพยากรแบบใช้ได้ทีละคน — EXCLUDE constraint กันจองซ้อน
--   โดยเผื่อเวลาเปลี่ยนผ้าปู/ทำความสะอาด (bed_until = end_at + turnover)
-- * ห้อง (rooms): มีความจุ (capacity) — ห้องรวม เช่น gym รับได้หลายคนพร้อมกัน
--   ตรวจความจุในชั้นแอปภายใต้ row lock ของห้อง (EXCLUDE ใช้กับความจุ >1 ไม่ได้)
-- * อุปกรณ์ติดตั้งประจำห้อง (equipment.room_id) จองได้เฉพาะนัดที่อยู่ในห้องนั้น
-- * หมวดอุปกรณ์ระบุพื้นที่ที่ต้องใช้ (space_type): bed | gym | none
-- =====================================================================

CREATE TABLE rooms (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code        text UNIQUE NOT NULL,
  name        text NOT NULL,
  room_type   text NOT NULL DEFAULT 'treatment'
                CHECK (room_type IN ('treatment','private','gym','pediatric','hydro','consult')),
  floor       text,
  capacity    smallint NOT NULL DEFAULT 1 CHECK (capacity BETWEEN 1 AND 100), -- ผู้ป่วยพร้อมกันสูงสุด
  is_active   boolean NOT NULL DEFAULT true,
  notes       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER rooms_updated BEFORE UPDATE ON rooms FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at();

CREATE TABLE beds (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id     uuid NOT NULL REFERENCES rooms(id) ON DELETE RESTRICT,
  code        text UNIQUE NOT NULL,
  name        text NOT NULL,
  bed_type    text NOT NULL DEFAULT 'standard'
                CHECK (bed_type IN ('standard','hi_lo','treatment_table','mat','pediatric','bariatric')),
  status      text NOT NULL DEFAULT 'available'
                CHECK (status IN ('available','maintenance','out_of_service')),
  is_active   boolean NOT NULL DEFAULT true,
  notes       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_beds_room ON beds (room_id);
CREATE TRIGGER beds_updated BEFORE UPDATE ON beds FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at();

-- สถานะเตียงเปลี่ยน -> NOTIFY ให้หน้าผังเตียง (real-time)
CREATE OR REPLACE FUNCTION trg_bed_status_change() RETURNS trigger AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    PERFORM pg_notify('bed_status', json_build_object(
      'id', NEW.id, 'code', NEW.code, 'room_id', NEW.room_id, 'from', OLD.status, 'to', NEW.status, 'at', now())::text);
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER bed_status_change AFTER UPDATE OF status ON beds FOR EACH ROW EXECUTE FUNCTION trg_bed_status_change();

-- อุปกรณ์ที่ติดตั้งประจำห้อง (NULL = เคลื่อนย้ายได้)
ALTER TABLE equipment ADD COLUMN room_id uuid REFERENCES rooms(id) ON DELETE SET NULL;
CREATE INDEX idx_equipment_room ON equipment (room_id);

-- พื้นที่ที่หมวดอุปกรณ์ต้องใช้
ALTER TABLE equipment_categories ADD COLUMN space_type text NOT NULL DEFAULT 'bed'
  CHECK (space_type IN ('bed','gym','none'));
UPDATE equipment_categories SET space_type = 'gym'  WHERE code IN ('PARALLEL','TREADMILL','CYCLE','TILT');
UPDATE equipment_categories SET space_type = 'none' WHERE code IN ('COLDPACK');

-- ห้อง/เตียงของนัด
ALTER TABLE appointments ADD COLUMN room_id uuid REFERENCES rooms(id);
ALTER TABLE appointments ADD COLUMN bed_id uuid REFERENCES beds(id);
ALTER TABLE appointments ADD COLUMN bed_until timestamptz;  -- end_at + เวลาเปลี่ยนผ้าปู
ALTER TABLE appointments ADD COLUMN bed_period tstzrange
  GENERATED ALWAYS AS (CASE WHEN bed_id IS NOT NULL THEN tstzrange(start_at, bed_until, '[)') END) STORED;
-- bed_until อาจน้อยกว่า end_at ได้เมื่อจบการรักษาก่อนเวลาและคืนเตียงแล้ว
ALTER TABLE appointments ADD CONSTRAINT chk_bed_until
  CHECK (bed_id IS NULL OR (bed_until IS NOT NULL AND bed_until > start_at));
-- (D) เตียง 1 เตียง ห้ามมีนัดซ้อน (รวมเวลาเปลี่ยนผ้าปู)
ALTER TABLE appointments ADD CONSTRAINT ex_bed_double_booking EXCLUDE USING gist
  (bed_id WITH =, bed_period WITH &&) WHERE (bed_id IS NOT NULL AND status NOT IN ('cancelled','no_show'));
CREATE INDEX idx_appt_room_period ON appointments USING gist (room_id, period) WHERE room_id IS NOT NULL;

-- จบก่อนเวลา -> คืนเวลาที่เหลือของเตียงให้คนอื่นจองได้
CREATE OR REPLACE FUNCTION trg_appointment_release_bed() RETURNS trigger AS $$
BEGIN
  IF NEW.status = 'completed' AND OLD.status IS DISTINCT FROM 'completed'
     AND NEW.bed_id IS NOT NULL AND now() < NEW.end_at THEN
    NEW.bed_until := GREATEST(NEW.start_at + interval '1 minute', now() + (OLD.bed_until - OLD.end_at));
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER appointment_release_bed BEFORE UPDATE OF status ON appointments
  FOR EACH ROW EXECUTE FUNCTION trg_appointment_release_bed();

INSERT INTO system_settings (key, value, description) VALUES
 ('scheduling.bed_turnover_minutes', '5', 'เวลาเปลี่ยนผ้าปู/ทำความสะอาดเตียงหลังใช้ (นาที)'),
 ('scheduling.auto_assign_space', 'true', 'จัดห้อง/เตียงให้อัตโนมัติเมื่อจองโดยไม่ระบุ')
ON CONFLICT (key) DO NOTHING;
