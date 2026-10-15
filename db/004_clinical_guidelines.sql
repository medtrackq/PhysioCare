-- =====================================================================
-- PhysioCare — Evidence-based clinical knowledge base
-- แนวทางการรักษาทางกายภาพบำบัดตามแนวทางเวชปฏิบัติ (CPG) ต่อการวินิจฉัย
--
-- * รันต่อจาก 001_schema.sql และ 002_seed.sql (idempotent: รันซ้ำได้)
-- * แทนที่ข้อมูลตัวอย่าง diagnosis_equipment_map เดิมด้วยข้อมูลที่อ้างอิงแนวทาง
-- * recommendation:
--     recommended      แนวทางแนะนำให้ใช้
--     optional         ใช้เสริมได้ / หลักฐานอ่อน / ระยะสั้น
--     insufficient     หลักฐานไม่เพียงพอที่จะแนะนำหรือไม่แนะนำ
--     not_recommended  แนวทางแนะนำว่าไม่ควรใช้เป็นประจำ
-- * grade = ระดับคำแนะนำตามที่แต่ละแนวทางระบุ (ระบบเกรดต่างกันในแต่ละองค์กร)
--
-- ⚠ ข้อมูลนี้สรุปเพื่อช่วยการตัดสินใจทางคลินิก ไม่ใช่คำสั่งการรักษา
--   คณะทำงานวิชาการของคลินิกควรทบทวนและปรับให้เข้ากับบริบทก่อนใช้งานจริง
--   ข้อมูลสรุป ณ ตุลาคม 2026 — ควรทบทวนเมื่อแนวทางฉบับใหม่ออก
-- =====================================================================

-- ---------- Schema ----------
CREATE TABLE IF NOT EXISTS clinical_sources (
  id           serial PRIMARY KEY,
  code         text UNIQUE NOT NULL,
  title        text NOT NULL,
  organization text NOT NULL,
  year         smallint NOT NULL,
  url          text NOT NULL
);

CREATE TABLE IF NOT EXISTS diagnosis_interventions (
  id             serial PRIMARY KEY,
  diagnosis_id   int NOT NULL REFERENCES diagnoses(id) ON DELETE CASCADE,
  category       text NOT NULL CHECK (category IN
                   ('exercise','manual_therapy','education','functional_training','orthosis_taping','modality','other')),
  name_th        text NOT NULL,
  name_en        text NOT NULL,
  recommendation text NOT NULL CHECK (recommendation IN ('recommended','optional','insufficient','not_recommended')),
  grade          text,
  dosage         text,
  notes          text,
  source_id      int REFERENCES clinical_sources(id),
  sort_order     smallint NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_dx_interventions ON diagnosis_interventions (diagnosis_id, sort_order);

ALTER TABLE diagnosis_equipment_map ADD COLUMN IF NOT EXISTS recommendation text NOT NULL DEFAULT 'optional'
  CHECK (recommendation IN ('recommended','optional','insufficient','not_recommended'));
ALTER TABLE diagnosis_equipment_map ADD COLUMN IF NOT EXISTS grade text;
ALTER TABLE diagnosis_equipment_map ADD COLUMN IF NOT EXISTS source_id int REFERENCES clinical_sources(id);

ALTER TABLE diagnoses ADD COLUMN IF NOT EXISTS summary_th text;
ALTER TABLE diagnoses ADD COLUMN IF NOT EXISTS red_flags text;

-- ---------- Data ----------
-- (เติมจากผลการทบทวนแนวทางเวชปฏิบัติ ด้านล่าง)
