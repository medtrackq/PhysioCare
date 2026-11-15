-- =====================================================================
-- PhysioCare — เชื่อมต่อระบบโรงพยาบาล (HIS) แบบเลือกใช้ (optional)
-- ไม่มีผลกับระบบจนกว่าผู้ดูแลจะสร้าง connector และเปิดใช้งาน
--
--   integration_connectors  ปลายทาง HIS แต่ละระบบ + การตั้งค่าว่าข้อมูลไหนใครเป็นเจ้าของ
--   external_refs           จับคู่ id ของ HIS ↔ id ในระบบ (ป้องกันข้อมูลซ้ำ)
--   integration_runs        ประวัติการนำเข้า/ดึงข้อมูล (สถิติ + ข้อผิดพลาด)
--   integration_outbox      คิวส่งข้อมูลกลับ HIS (นัดหมาย ผลประเมิน) — ส่งซ้ำอัตโนมัติเมื่อล้มเหลว
--   referrals               ใบสั่งส่งกายภาพจากแพทย์ใน HIS (ServiceRequest)
--   managed_by              คอลัมน์บนข้อมูลหลัก: ระบุว่า record นี้มาจาก HIS (แก้ฟิลด์ของ HIS ในระบบนี้ไม่ได้)
-- =====================================================================

CREATE TABLE integration_connectors (
  id               smallserial PRIMARY KEY,
  code             text NOT NULL UNIQUE CHECK (code ~ '^[a-z0-9_-]{2,30}$'),
  name             text NOT NULL,
  kind             text NOT NULL DEFAULT 'fhir_r4' CHECK (kind IN ('fhir_r4')),
  base_url         text CHECK (base_url IS NULL OR base_url ~ '^https?://'),
  -- ชื่อ environment variable ที่เก็บ token สำหรับเรียก HIS (ไม่เก็บ secret ในฐานข้อมูล)
  auth_secret_env  text CHECK (auth_secret_env IS NULL OR auth_secret_env ~ '^HIS_[A-Z0-9_]{1,60}$'),
  -- API key ที่ HIS ใช้ส่งข้อมูลเข้ามา (เก็บเฉพาะ SHA-256)
  inbound_key_hash text,
  inbound_key_hint text,
  is_enabled       boolean NOT NULL DEFAULT false,
  settings         jsonb NOT NULL DEFAULT '{}',
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE external_refs (
  id            bigserial PRIMARY KEY,
  connector_id  smallint NOT NULL REFERENCES integration_connectors(id) ON DELETE CASCADE,
  entity_type   text NOT NULL CHECK (entity_type IN ('room','bed','staff','equipment','patient','patient_diagnosis','referral','floor')),
  local_id      uuid,                         -- floor ไม่มี record ในระบบ
  external_id   text NOT NULL,                -- เช่น "Location/ward-pt-01"
  external_version text,
  content_hash  text,                         -- hash ของข้อมูลที่ map แล้ว ใช้ข้ามรายการที่ไม่เปลี่ยน
  detail        jsonb,                        -- ข้อมูลเสริม เช่น ชื่อชั้น
  synced_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (connector_id, entity_type, external_id)
);
CREATE UNIQUE INDEX ux_external_refs_local ON external_refs (connector_id, entity_type, local_id) WHERE local_id IS NOT NULL;

CREATE TABLE integration_runs (
  id            bigserial PRIMARY KEY,
  connector_id  smallint NOT NULL REFERENCES integration_connectors(id) ON DELETE CASCADE,
  mode          text NOT NULL CHECK (mode IN ('push','pull','manual')),
  dry_run       boolean NOT NULL DEFAULT false,
  status        text NOT NULL DEFAULT 'running' CHECK (status IN ('running','success','partial','failed')),
  stats         jsonb NOT NULL DEFAULT '{}',
  errors        jsonb NOT NULL DEFAULT '[]',
  started_by    uuid,
  started_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz
);
CREATE INDEX ix_integration_runs_connector ON integration_runs (connector_id, started_at DESC);

CREATE TABLE integration_cursors (
  connector_id  smallint NOT NULL REFERENCES integration_connectors(id) ON DELETE CASCADE,
  resource_type text NOT NULL,
  last_updated  timestamptz NOT NULL,
  PRIMARY KEY (connector_id, resource_type)
);

CREATE TABLE integration_outbox (
  id              bigserial PRIMARY KEY,
  connector_id    smallint NOT NULL REFERENCES integration_connectors(id) ON DELETE CASCADE,
  resource_type   text NOT NULL CHECK (resource_type IN ('Appointment','Observation')),
  entity_id       uuid NOT NULL,              -- appointment / clinical_assessment
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed','dead')),
  attempts        smallint NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error      text,
  response_status smallint,
  created_at      timestamptz NOT NULL DEFAULT now(),
  sent_at         timestamptz
);
-- งานที่ยังไม่ส่งของ record เดียวกันรวมเป็นรายการเดียว (สร้าง payload ตอนส่งจากข้อมูลล่าสุดเสมอ)
CREATE UNIQUE INDEX ux_outbox_pending ON integration_outbox (connector_id, resource_type, entity_id) WHERE status IN ('pending','failed');
CREATE INDEX ix_outbox_due ON integration_outbox (next_attempt_at) WHERE status IN ('pending','failed');

CREATE TABLE referrals (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id        uuid NOT NULL REFERENCES patients(id),
  diagnosis_id      integer REFERENCES diagnoses(id),
  requester         text,                     -- แพทย์ผู้สั่ง
  priority          text NOT NULL DEFAULT 'routine' CHECK (priority IN ('routine','urgent','asap','stat')),
  sessions_requested smallint CHECK (sessions_requested BETWEEN 1 AND 100),
  note              text,
  status            text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','scheduled','completed','cancelled')),
  authored_at       timestamptz,
  managed_by        text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_referrals_status ON referrals (status, created_at DESC);

-- record ที่มาจาก HIS: เก็บรหัส connector (ฟิลด์ที่ HIS เป็นเจ้าของจะแก้ในระบบนี้ไม่ได้)
ALTER TABLE rooms     ADD COLUMN managed_by text;
ALTER TABLE beds      ADD COLUMN managed_by text;
ALTER TABLE staff     ADD COLUMN managed_by text;
ALTER TABLE equipment ADD COLUMN managed_by text;
ALTER TABLE patients  ADD COLUMN managed_by text;

-- ---------- ส่งกลับ HIS: เข้าคิวเมื่อนัดหมายเปลี่ยน / ลงนามผลประเมิน ----------
CREATE OR REPLACE FUNCTION fn_outbox_enqueue(p_resource text, p_entity uuid, p_flag text) RETURNS void AS $$
BEGIN
  INSERT INTO integration_outbox (connector_id, resource_type, entity_id)
  SELECT c.id, p_resource, p_entity
    FROM integration_connectors c
   WHERE c.is_enabled AND c.base_url IS NOT NULL
     AND COALESCE((c.settings #>> ARRAY['outbound', p_flag])::boolean, false)
  ON CONFLICT (connector_id, resource_type, entity_id) WHERE status IN ('pending','failed')
  DO UPDATE SET next_attempt_at = LEAST(integration_outbox.next_attempt_at, now());
END $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION trg_outbox_appointment() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.status IS DISTINCT FROM OLD.status OR NEW.start_at IS DISTINCT FROM OLD.start_at
     OR NEW.end_at IS DISTINCT FROM OLD.end_at OR NEW.therapist_id IS DISTINCT FROM OLD.therapist_id
     OR NEW.bed_id IS DISTINCT FROM OLD.bed_id OR NEW.room_id IS DISTINCT FROM OLD.room_id THEN
    PERFORM fn_outbox_enqueue('Appointment', NEW.id, 'appointments');
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER outbox_appointment AFTER INSERT OR UPDATE ON appointments
  FOR EACH ROW EXECUTE FUNCTION trg_outbox_appointment();

CREATE OR REPLACE FUNCTION trg_outbox_assessment() RETURNS trigger AS $$
BEGIN
  IF NEW.signed_at IS NOT NULL AND (TG_OP = 'INSERT' OR OLD.signed_at IS NULL) THEN
    PERFORM fn_outbox_enqueue('Observation', NEW.id, 'observations');
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER outbox_assessment AFTER INSERT OR UPDATE OF signed_at ON clinical_assessments
  FOR EACH ROW EXECUTE FUNCTION trg_outbox_assessment();

-- ---------- สิทธิ์ ----------
INSERT INTO permissions (code, description) VALUES ('integration:manage', 'ตั้งค่าการเชื่อมต่อระบบโรงพยาบาล (HIS)')
ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id, permission_code)
SELECT r.id, 'integration:manage' FROM roles r WHERE r.code = 'admin'
ON CONFLICT DO NOTHING;
-- ดูใบสั่งส่งกายภาพ: ทุกคนที่ดูนัดหมายทั้งหมดได้
