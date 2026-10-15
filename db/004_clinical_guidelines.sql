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

-- ---------- Additional diagnoses & equipment categories ----------
INSERT INTO diagnoses (icd10_code, name_th, name_en, body_region) VALUES
 ('M75.1',  'เอ็นหมุนไหล่อักเสบ/ไหล่ติดขัด',   'Rotator cuff tendinopathy / subacromial pain', 'shoulder'),
 ('Z96.65', 'ฟื้นฟูหลังผ่าตัดเปลี่ยนข้อเข่า',     'Rehabilitation after total knee arthroplasty', 'knee'),
 ('S93.4',  'ข้อเท้าแพลง (เอ็นด้านนอก)',         'Lateral ankle sprain',                       'ankle'),
 ('G20',    'โรคพาร์กินสัน',                  'Parkinson disease',                          'neuro')
ON CONFLICT (icd10_code) DO NOTHING;

INSERT INTO equipment_categories (code, name_th, name_en, modality, default_session_minutes, cleaning_buffer_minutes, maintenance_interval_days) VALUES
 ('CYCLE', 'จักรยานออกกำลังกาย', 'Cycle ergometer', 'exercise', 20, 5, 180)
ON CONFLICT (code) DO NOTHING;

INSERT INTO diagnosis_specialty_map (diagnosis_id, specialty_id, weight)
SELECT d.id, s.id, x.w FROM (VALUES
  ('M75.1','ORTHO',1.0),('M75.1','SPORTS',0.8),
  ('Z96.65','ORTHO',1.0),('Z96.65','GERI',0.7),
  ('S93.4','SPORTS',1.0),('S93.4','ORTHO',0.8),
  ('G20','NEURO',1.0),('G20','GERI',0.7)
) x(icd, sp, w) JOIN diagnoses d ON d.icd10_code = x.icd JOIN specialties s ON s.code = x.sp
ON CONFLICT DO NOTHING;

-- ---------- Sources ----------
INSERT INTO clinical_sources (code, title, organization, year, url) VALUES
 ('JOSPT-LBP-2021',  'Interventions for the Management of Acute and Chronic Low Back Pain: Revision 2021 (George et al.)', 'JOSPT/APTA', 2021, 'https://pubmed.ncbi.nlm.nih.gov/34719942/'),
 ('NICE-NG59',       'Low back pain and sciatica in over 16s: assessment and management (NG59)', 'NICE', 2020, 'https://www.nice.org.uk/guidance/ng59/chapter/Recommendations'),
 ('ACP-LBP-2017',    'Noninvasive Treatments for Acute, Subacute, and Chronic Low Back Pain (Qaseem et al.)', 'ACP', 2017, 'https://pubmed.ncbi.nlm.nih.gov/28192789/'),
 ('JOSPT-NECK-2017', 'Neck Pain: Revision 2017 (Blanpied et al.)', 'JOSPT/APTA', 2017, 'https://doi.org/10.2519/jospt.2017.0302'),
 ('JOSPT-AC-2013',   'Shoulder Pain and Mobility Deficits: Adhesive Capsulitis (Kelley et al.)', 'JOSPT/APTA', 2013, 'https://www.orthopt.org/uploads/content_files/ICF/Updated_Guidelines/Shoulder_Guidelines_AdhesiveCapsulitis_JOSPT_May_2013.pdf'),
 ('JOSPT-RC-2025',   'Rotator Cuff Tendinopathy Diagnosis, Nonsurgical Medical Care, and Rehabilitation (Desmeules et al.)', 'JOSPT', 2025, 'https://www.jospt.org/doi/10.2519/jospt.2025.13182'),
 ('JOSPT-LE-2022',   'Lateral Elbow Pain and Muscle Function Impairments (Lucado et al.)', 'JOSPT/APTA', 2022, 'https://www.jospt.org/doi/10.2519/jospt.2022.0302'),
 ('NICE-NG226',      'Osteoarthritis in over 16s: diagnosis and management (NG226)', 'NICE', 2022, 'https://www.nice.org.uk/guidance/ng226'),
 ('OARSI-2019',      'OARSI guidelines for the non-surgical management of knee, hip, and polyarticular osteoarthritis (Bannuru et al.)', 'OARSI', 2019, 'https://doi.org/10.1016/j.joca.2019.06.011'),
 ('ACR-OA-2019',     '2019 ACR/Arthritis Foundation Guideline for the Management of Osteoarthritis (Kolasinski et al.)', 'ACR', 2019, 'https://doi.org/10.1002/art.41142'),
 ('JOSPT-ACL-2017',  'Knee Stability and Movement Coordination Impairments: Knee Ligament Sprain Revision 2017 (Logerstedt et al.)', 'JOSPT/APTA', 2017, 'https://www.orthopt.org/uploads/content_files/files/Knee%20Ligament%20Sprain%20CPG%20-%202017.pdf'),
 ('APTA-TKA-2020',   'Physical Therapist Management of Total Knee Arthroplasty (Jette et al.)', 'APTA', 2020, 'https://pmc.ncbi.nlm.nih.gov/articles/PMC7462050'),
 ('JOSPT-HEEL-2023', 'Heel Pain – Plantar Fasciitis: Revision 2023 (Koc et al.)', 'JOSPT/APTA', 2023, 'https://www.orthopt.org/uploads/content_files/files/Heel_Pain_Plantar_Fasciitis_Revision_2023.pdf'),
 ('NICE-IPG311',     'Extracorporeal shockwave therapy for refractory plantar fasciitis (IPG311)', 'NICE', 2009, 'https://www.nice.org.uk/guidance/ipg311'),
 ('JOSPT-ANKLE-2021','Ankle Stability and Movement Coordination Impairments: Lateral Ankle Ligament Sprains Revision 2021 (Martin et al.)', 'JOSPT/APTA', 2021, 'https://www.orthopt.org/uploads/content_files/files/jospt.2021.0302.pdf')
ON CONFLICT (code) DO UPDATE SET title = EXCLUDED.title, organization = EXCLUDED.organization, year = EXCLUDED.year, url = EXCLUDED.url;

-- ---------- Staging tables ----------
CREATE TEMP TABLE _iv (icd text, cat text, name_th text, name_en text, rec text, grade text, dosage text, notes text, src text, ord smallint);
CREATE TEMP TABLE _em (icd text, cat text, rec text, grade text, w numeric, why text, src text);
CREATE TEMP TABLE _dx (icd text, summary text, red_flags text);

-- =====================================================================
-- M54.5 Low back pain
-- =====================================================================
INSERT INTO _dx VALUES ('M54.5',
 'แนวทางเน้นการรักษาเชิงรุก: ออกกำลังกาย, manual therapy ร่วมกับการออกกำลังกาย และให้ความรู้แบบ biopsychosocial; หลีกเลี่ยงการรักษาแบบ passive เพียงอย่างเดียว ควรคัดกรองความเสี่ยง (เช่น STarT Back) เพื่อวางแผนความเข้มข้นของการรักษา',
 'Cauda equina (ชาบริเวณก้น/ฝีเย็บ, ปัสสาวะ-อุจจาระผิดปกติ), อ่อนแรงลุกลาม, ประวัติมะเร็ง/น้ำหนักลด, ไข้/ใช้ยาฉีดเข้าเส้น (ติดเชื้อ), อุบัติเหตุหรือกระดูกพรุน (กระดูกหัก), ปวดกลางคืน, เริ่มปวดครั้งแรกอายุ >50 ปี, ปวดหลังแบบอักเสบ');
INSERT INTO _iv VALUES
 ('M54.5','exercise','ออกกำลังกาย (strength/endurance, multimodal, trunk activation, aerobic, aquatic) — ปวดหลังเรื้อรัง','Exercise therapy for chronic LBP','recommended','A (JOSPT)','ส่วนใหญ่ในงานวิจัย 6–8 สัปดาห์ (แนวทางไม่กำหนดขนาด)',NULL,'JOSPT-LBP-2021',1),
 ('M54.5','exercise','Yoga / Pilates / การออกกำลังกายเชิงรุก แทนการให้ความรู้อย่างเดียว','Active treatments (yoga, Pilates, strengthening)','recommended','A (JOSPT)',NULL,NULL,'JOSPT-LBP-2021',2),
 ('M54.5','exercise','Movement control exercise — ปวดหลังเรื้อรัง','Movement control exercise','recommended','B (JOSPT)',NULL,NULL,'JOSPT-LBP-2021',3),
 ('M54.5','exercise','ออกกำลังกาย (รวม trunk activation) — ปวดหลังเฉียบพลัน','Exercise for acute LBP','optional','C (JOSPT)',NULL,'ปวดเฉียบพลันร่วมกับปวดร้าวลงขา: B','JOSPT-LBP-2021',4),
 ('M54.5','manual_therapy','Joint mobilization / manipulation (thrust หรือ non-thrust)','Thrust/non-thrust joint mobilization','recommended','A (JOSPT)',NULL,'NICE: ใช้เฉพาะร่วมกับการออกกำลังกายเท่านั้น','JOSPT-LBP-2021',5),
 ('M54.5','manual_therapy','Massage / soft tissue mobilization (บรรเทาระยะสั้น ร่วมกับการรักษาอื่น)','Massage / soft tissue mobilization','optional','B (JOSPT)',NULL,NULL,'JOSPT-LBP-2021',6),
 ('M54.5','manual_therapy','Neural mobilization — ปวดหลังเรื้อรังร่วมกับปวดร้าวลงขา','Neural mobilization (radicular)','recommended','B (JOSPT)',NULL,NULL,'JOSPT-LBP-2021',7),
 ('M54.5','education','Pain neuroscience education ร่วมกับการรักษาอื่น','Pain neuroscience education','recommended','A (JOSPT)',NULL,NULL,'JOSPT-LBP-2021',8),
 ('M54.5','education','ให้ความรู้เชิงรุก/การดูแลตนเอง (ไม่ใช่ passive) — ปวดหลังเฉียบพลัน','Active education / self-management','recommended','B (JOSPT)',NULL,NULL,'JOSPT-LBP-2021',9),
 ('M54.5','other','Dry needling — ปวดหลังเรื้อรัง','Dry needling','optional','C (JOSPT)',NULL,'แนวทางขัดกัน: NICE ไม่แนะนำ acupuncture','JOSPT-LBP-2021',10);
INSERT INTO _em VALUES
 ('M54.5','HOTPACK','recommended','strong / moderate-quality (ACP)',0.8,'ความร้อนตื้นสำหรับปวดหลังเฉียบพลัน/กึ่งเฉียบพลัน','ACP-LBP-2017'),
 ('M54.5','LASER','optional','ACP: แนะนำ (หลักฐานคุณภาพต่ำ); NICE ไม่กล่าวถึง',0.4,'LLLT สำหรับปวดหลังเรื้อรัง — แนวทางไม่สอดคล้องกัน','ACP-LBP-2017'),
 ('M54.5','TRACTION','not_recommended','NICE: do not offer; JOSPT: should not (ปวดร้าวลงขาเรื้อรัง)',0.1,'Lumbar traction ไม่มีประโยชน์เพิ่ม','NICE-NG59'),
 ('M54.5','TENS','not_recommended','NICE: do not offer',0.1,NULL,'NICE-NG59'),
 ('M54.5','IFC','not_recommended','NICE: do not offer',0.1,NULL,'NICE-NG59'),
 ('M54.5','US','not_recommended','NICE: do not offer',0.1,NULL,'NICE-NG59'),
 ('M54.5','SWD','insufficient',NULL,0.2,'ไม่มีคำแนะนำในแนวทาง',NULL);

-- =====================================================================
-- M54.2 Neck pain
-- =====================================================================
INSERT INTO _dx VALUES ('M54.2',
 'แนวทาง JOSPT 2017 จัดกลุ่มตามลักษณะอาการ (mobility deficit, movement coordination/WAD, headache, radiating pain) และระยะ (เฉียบพลัน/กึ่งเฉียบพลัน/เรื้อรัง) — การรักษาหลักคือ manual therapy ร่วมกับการออกกำลังกาย',
 'Cervical myelopathy (เดินผิดปกติ, มือไม่คล่อง, อาการสองข้าง), หลอดเลือดแดงที่คอฉีกขาด/VBI (5D 3N), ความไม่มั่นคงของคอส่วนบน (RA, Down syndrome, อุบัติเหตุ), กระดูกหัก (Canadian C-spine rule), มะเร็ง, ติดเชื้อ — คัดกรองก่อนทำ manipulation และ traction');
INSERT INTO _iv VALUES
 ('M54.2','manual_therapy','Thoracic manipulation — ระยะเฉียบพลัน (mobility deficit)','Thoracic manipulation','recommended','B (JOSPT)',NULL,NULL,'JOSPT-NECK-2017',1),
 ('M54.2','manual_therapy','Cervical/thoracic manipulation หรือ mobilization ร่วมกับการออกกำลังกาย — เรื้อรัง/ปวดศีรษะจากคอ','Cervical & thoracic manipulation/mobilization + exercise','recommended','B (JOSPT)',NULL,'ระยะเฉียบพลัน/กึ่งเฉียบพลัน: C','JOSPT-NECK-2017',2),
 ('M54.2','exercise','ROM exercise คอ + เสริมความแข็งแรง scapulothoracic/แขน','Cervical ROM & scapulothoracic strengthening','recommended','B (JOSPT)',NULL,NULL,'JOSPT-NECK-2017',3),
 ('M54.2','exercise','Endurance exercise คอและไหล่ — ระยะกึ่งเฉียบพลัน','Neck & shoulder girdle endurance exercise','recommended','B (JOSPT)',NULL,NULL,'JOSPT-NECK-2017',4),
 ('M54.2','exercise','Multimodal exercise (neuromuscular, stretching, strengthening, aerobic) — เรื้อรัง','Mixed exercise (chronic)','recommended','B (JOSPT)',NULL,NULL,'JOSPT-NECK-2017',5),
 ('M54.2','education','ให้ความรู้กลับไปทำกิจกรรม ใส่ collar ให้น้อยที่สุด — whiplash เฉียบพลัน','Education to return to activity (WAD)','recommended','B (JOSPT)',NULL,NULL,'JOSPT-NECK-2017',6),
 ('M54.2','other','Dry needling ร่วมใน multimodal care — เรื้อรัง','Dry needling','optional','B (JOSPT)',NULL,NULL,'JOSPT-NECK-2017',7);
INSERT INTO _em VALUES
 ('M54.2','TRACTION','optional','B (JOSPT)',0.7,'Intermittent cervical traction ร่วมกับการออกกำลังกาย — ปวดร้าวลงแขนเรื้อรัง/mobility deficit เรื้อรัง','JOSPT-NECK-2017'),
 ('M54.2','LASER','optional','B เรื้อรัง; C ปวดร้าวเฉียบพลัน (JOSPT)',0.6,'LLLT เสริมในระยะเรื้อรัง','JOSPT-NECK-2017'),
 ('M54.2','TENS','optional','C (JOSPT)',0.4,'เสริมในผู้ป่วย whiplash','JOSPT-NECK-2017'),
 ('M54.2','HOTPACK','insufficient',NULL,0.3,'ไม่มีคำแนะนำในแนวทาง',NULL),
 ('M54.2','US','insufficient',NULL,0.2,'ไม่มีคำแนะนำในแนวทาง',NULL),
 ('M54.2','IFC','insufficient',NULL,0.2,'ไม่มีคำแนะนำในแนวทาง',NULL);

-- =====================================================================
-- M75.0 Adhesive capsulitis
-- =====================================================================
INSERT INTO _dx VALUES ('M75.0',
 'แนวทาง JOSPT 2013 (ฉบับปรับปรุงกำลังจัดทำ): ให้ความรู้เรื่องธรรมชาติของโรค + stretching ตามระดับความไวของเนื้อเยื่อ (irritability); การฉีดสเตียรอยด์ร่วมกับการออกกำลังกายให้ผลระยะสั้นดีที่สุด (ส่งต่อแพทย์)',
 'คัดกรองเบาหวาน/ไทรอยด์ (ปัจจัยเสี่ยง); แยกข้อไหล่เสื่อม, ข้อหลุดค้าง/กระดูกหัก (X-ray ถ้าหมุนออกไม่ได้หลังอุบัติเหตุ), เนื้องอก (Pancoast), ปวดร้าวจากอวัยวะภายใน/หัวใจ; หลีกเลี่ยง stretching รุนแรงในระยะ freezing');
INSERT INTO _iv VALUES
 ('M75.0','other','ฉีดสเตียรอยด์เข้าข้อร่วมกับการออกกำลังกาย (ส่งต่อแพทย์)','Intra-articular corticosteroid + exercise','recommended','A (JOSPT)',NULL,'ผลดีที่สุดในระยะสั้น 4–6 สัปดาห์','JOSPT-AC-2013',1),
 ('M75.0','education','ให้ความรู้ธรรมชาติของโรค ปรับกิจกรรมให้ไม่ปวด','Patient education & activity modification','recommended','B (JOSPT)',NULL,NULL,'JOSPT-AC-2013',2),
 ('M75.0','exercise','Stretching โดยปรับความแรงตาม tissue irritability','Stretching matched to irritability','recommended','B (JOSPT)',NULL,'irritability สูง: ยืดเบา ช่วงสั้น','JOSPT-AC-2013',3),
 ('M75.0','manual_therapy','Glenohumeral joint mobilization','Joint mobilization','optional','C (JOSPT)',NULL,NULL,'JOSPT-AC-2013',4);
INSERT INTO _em VALUES
 ('M75.0','SWD','optional','C (JOSPT)',0.5,'ความร้อนลึกร่วมกับการออกกำลังกาย','JOSPT-AC-2013'),
 ('M75.0','US','optional','C (JOSPT)',0.5,'ร่วมกับการออกกำลังกาย','JOSPT-AC-2013'),
 ('M75.0','TENS','optional','C (JOSPT, electrical stimulation)',0.4,'ลดปวดร่วมกับการออกกำลังกาย','JOSPT-AC-2013'),
 ('M75.0','HOTPACK','insufficient',NULL,0.3,'ไม่มีคำแนะนำ — ใช้เตรียมก่อน stretching ได้ตามดุลยพินิจ',NULL);

-- =====================================================================
-- M75.1 Rotator cuff tendinopathy  (เกรดจากบทสรุปทุติยภูมิ — ตรวจสอบกับฉบับเต็ม)
-- =====================================================================
INSERT INTO _dx VALUES ('M75.1',
 'การออกกำลังกายแบบ progressive resistance + motor control เป็นการรักษาหลัก; manual therapy ใช้ร่วมได้ระยะสั้น (เกรดอ้างอิงจากบทสรุปของแนวทาง JOSPT 2025 — ควรตรวจกับฉบับเต็ม)',
 'อ่อนแรงทันทีหลังอุบัติเหตุ/สงสัยเอ็นขาดทั้งชั้น (ส่งต่อเร็ว), ติดเชื้อ, มะเร็ง, กระดูกหัก/ข้อหลุด, ปวดร้าวจากคอ (cervical radiculopathy), ปวดร้าวจากหัวใจ/อวัยวะภายใน');
INSERT INTO _iv VALUES
 ('M75.1','exercise','Progressive resistance + motor control exercise (ปรับรายบุคคล)','Progressive resistance & motor control exercise','recommended','A (JOSPT 2025)',NULL,NULL,'JOSPT-RC-2025',1),
 ('M75.1','manual_therapy','Manual therapy ร่วมกับการออกกำลังกาย (ระยะสั้น)','Manual therapy + exercise','recommended','B (JOSPT 2025)',NULL,NULL,'JOSPT-RC-2025',2),
 ('M75.1','education','ให้ความรู้ ปรับกิจกรรม pain science การดูแลตนเอง','Education & self-management','optional','C (JOSPT 2025)',NULL,NULL,'JOSPT-RC-2025',3),
 ('M75.1','orthosis_taping','Taping เสริม','Taping','insufficient','D (ตรวจสอบ)',NULL,NULL,'JOSPT-RC-2025',4);
INSERT INTO _em VALUES
 ('M75.1','SHOCKWAVE','optional','C (JOSPT 2025) — เฉพาะ calcific',0.5,'ESWT เฉพาะ calcific tendinopathy; ไม่แนะนำใน non-calcific','JOSPT-RC-2025'),
 ('M75.1','LASER','optional','C (JOSPT 2025)',0.4,'บรรเทาปวดใน calcific tendinopathy','JOSPT-RC-2025'),
 ('M75.1','US','not_recommended','B/C (JOSPT 2025)',0.1,'ไม่แนะนำทั้ง calcific และ non-calcific','JOSPT-RC-2025'),
 ('M75.1','TENS','insufficient',NULL,0.2,'ไม่มีคำแนะนำ',NULL);

-- =====================================================================
-- M77.1 Lateral epicondylitis
-- =====================================================================
INSERT INTO _dx VALUES ('M77.1',
 'แนวทาง JOSPT 2022: การออกกำลังกายต้านแรงกล้ามเนื้อเหยียดข้อมือ (isometric/concentric/eccentric) ร่วมกับ manual therapy เป็นแกนหลัก; taping แบบ rigid ช่วยในรายที่ irritability สูง',
 'แยก radial tunnel/PIN entrapment, cervical radiculopathy, พยาธิสภาพในข้อ/posterolateral instability, OCD ของ capitellum (นักกีฬาอายุน้อย), กระดูกหัก, ข้ออักเสบชนิด inflammatory');
INSERT INTO _iv VALUES
 ('M77.1','exercise','Resisted wrist extensor exercise (isometric/concentric/eccentric)','Resisted wrist-extensor exercise','recommended','B (JOSPT)',NULL,'ระยะกึ่งเฉียบพลัน/เรื้อรัง','JOSPT-LE-2022',1),
 ('M77.1','manual_therapy','Manual therapy ร่วมกับการออกกำลังกาย / mobilization ข้อศอก','Exercise + manual therapy; elbow mobilization','recommended','B (JOSPT)',NULL,NULL,'JOSPT-LE-2022',2),
 ('M77.1','orthosis_taping','Rigid taping (รายที่ irritability สูง)','Rigid taping','recommended','B (JOSPT)',NULL,NULL,'JOSPT-LE-2022',3),
 ('M77.1','other','Dry needling','Dry needling','recommended','B (JOSPT)',NULL,NULL,'JOSPT-LE-2022',4),
 ('M77.1','manual_therapy','Mobilization คอ/ทรวงอก/ข้อมือ เมื่อพบความบกพร่อง','Cervical/thoracic/wrist mobilization','optional','C (JOSPT)',NULL,NULL,'JOSPT-LE-2022',5),
 ('M77.1','orthosis_taping','Kinesiology tape','Kinesiology tape','optional','C (JOSPT)',NULL,NULL,'JOSPT-LE-2022',6),
 ('M77.1','orthosis_taping','Counterforce brace ระยะยาว','Counterforce orthosis (long-term)','insufficient','D (JOSPT)',NULL,'ใช้ระหว่างทำกิจกรรมเพื่อลดปวดทันที: F','JOSPT-LE-2022',7);
INSERT INTO _em VALUES
 ('M77.1','LASER','optional','C (JOSPT)',0.6,'ลดปวด/เพิ่มแรงบีบมือ','JOSPT-LE-2022'),
 ('M77.1','TENS','optional','C (JOSPT)',0.5,'Burst TENS เฉพาะที่หรือจุดฝังเข็ม','JOSPT-LE-2022'),
 ('M77.1','COLDPACK','optional','E/C (JOSPT)',0.4,'รายที่ irritability สูง','JOSPT-LE-2022'),
 ('M77.1','US','insufficient','D (JOSPT, หลักฐานขัดแย้ง)',0.2,'อัลตราซาวด์อย่างเดียว — ไม่มีคำแนะนำ','JOSPT-LE-2022'),
 ('M77.1','SHOCKWAVE','insufficient','ไม่มีเกรด (JOSPT)',0.2,'กล่าวถึงในเนื้อหาแต่ไม่ให้คำแนะนำ','JOSPT-LE-2022');

-- =====================================================================
-- M17.1 Knee osteoarthritis
-- =====================================================================
INSERT INTO _dx VALUES ('M17.1',
 'การออกกำลังกาย (เสริมความแข็งแรง + แอโรบิก), ให้ความรู้/ดูแลตนเอง และลดน้ำหนักถ้าน้ำหนักเกิน เป็นการรักษาหลักในทุกแนวทาง (NICE, OARSI, ACR); เครื่องมือไฟฟ้าส่วนใหญ่ไม่แนะนำ',
 'ข้อบวมแดงร้อน (ติดเชื้อ/ผลึก), น้ำหนักลดไม่ทราบสาเหตุ, ปวดกลางคืน, ข้อล็อก; ส่งต่อพิจารณาผ่าตัดเมื่ออาการไม่ดีขึ้นด้วยการรักษาหลัก');
INSERT INTO _iv VALUES
 ('M17.1','exercise','ออกกำลังกายเสริมความแข็งแรง + แอโรบิก (พิจารณาแบบมีผู้ดูแล)','Strengthening + aerobic exercise','recommended','NICE offer; OARSI core; ACR strong',NULL,'แจ้งผู้ป่วยว่าอาจปวดเพิ่มช่วงแรก','NICE-NG226',1),
 ('M17.1','education','ให้ความรู้และการดูแลตนเอง','Education & self-management','recommended','OARSI core; ACR strong',NULL,NULL,'OARSI-2019',2),
 ('M17.1','education','ลดน้ำหนัก (ถ้าน้ำหนักเกิน)','Weight management','recommended','NICE; ACR strong',NULL,'ลด 10% ได้ผลดีกว่า 5%','NICE-NG226',3),
 ('M17.1','exercise','Tai chi','Tai chi','recommended','ACR strong',NULL,NULL,'ACR-OA-2019',4),
 ('M17.1','exercise','Aquatic exercise','Aquatic exercise','optional','OARSI 1B/2',NULL,NULL,'OARSI-2019',5),
 ('M17.1','manual_therapy','Manual therapy ร่วมกับการออกกำลังกายเท่านั้น','Manual therapy alongside exercise','optional','NICE (ไม่ใช้เดี่ยว)',NULL,'แนวทางขัดกัน: ACR conditional against','NICE-NG226',6),
 ('M17.1','orthosis_taping','ไม้เท้า / อุปกรณ์ช่วยเดิน','Walking aids','optional','NICE consider; ACR strong (cane)',NULL,NULL,'NICE-NG226',7),
 ('M17.1','orthosis_taping','Brace / tape / insole','Braces, tape, insoles','optional','NICE: ไม่ใช้เป็นประจำ',NULL,'เฉพาะข้อหลวม/การลงน้ำหนักผิดปกติ','NICE-NG226',8),
 ('M17.1','other','Acupuncture / dry needling','Acupuncture / dry needling','not_recommended','NICE do not offer',NULL,NULL,'NICE-NG226',9);
INSERT INTO _em VALUES
 ('M17.1','TREADMILL','recommended','NICE (ส่วนหนึ่งของแอโรบิก)',0.7,'แอโรบิกเป็นส่วนหนึ่งของการออกกำลังกายหลัก','NICE-NG226'),
 ('M17.1','CYCLE','recommended','NICE (ส่วนหนึ่งของแอโรบิก)',0.7,'แอโรบิกแรงกระแทกต่ำ','NICE-NG226'),
 ('M17.1','HOTPACK','optional','ACR conditional',0.4,'ความร้อน/ความเย็นเสริมได้','ACR-OA-2019'),
 ('M17.1','COLDPACK','optional','ACR conditional',0.4,NULL,'ACR-OA-2019'),
 ('M17.1','TENS','not_recommended','NICE do not offer; ACR strong against',0.1,NULL,'NICE-NG226'),
 ('M17.1','US','not_recommended','NICE (insufficient evidence of benefit)',0.1,NULL,'NICE-NG226'),
 ('M17.1','IFC','not_recommended','NICE',0.1,NULL,'NICE-NG226'),
 ('M17.1','SWD','not_recommended','NICE (pulsed shortwave)',0.1,NULL,'NICE-NG226'),
 ('M17.1','LASER','not_recommended','NICE',0.1,NULL,'NICE-NG226'),
 ('M17.1','NMES','not_recommended','NICE',0.1,NULL,'NICE-NG226');

-- =====================================================================
-- S83.5 ACL injury / reconstruction
-- =====================================================================
INSERT INTO _dx VALUES ('S83.5',
 'แนวทาง JOSPT 2017: เสริมความแข็งแรง + neuromuscular training เป็นแกนหลัก ร่วมกับ NMES กล้ามเนื้อ quadriceps; ขยับข้อเร็วภายใน 1 สัปดาห์; ใช้ hop tests และแบบประเมินตนเองตัดสินการกลับไปเล่นกีฬา',
 'DVT, ติดเชื้อ, เหยียดเข่าไม่สุด (arthrofibrosis), graft ล้มเหลว/เข่าทรุดใหม่, ข้อบวมคงอยู่');
INSERT INTO _iv VALUES
 ('S83.5','exercise','เสริมความแข็งแรง (WB และ NWB, concentric/eccentric)','Strengthening (WB/NWB)','recommended','A (JOSPT)','เริ่มสัปดาห์ 4–6, 2–3 ครั้ง/สัปดาห์ นาน 6–10 เดือน',NULL,'JOSPT-ACL-2017',1),
 ('S83.5','exercise','Neuromuscular re-education ร่วมกับเสริมความแข็งแรง','Neuromuscular training + strengthening','recommended','A (JOSPT)',NULL,NULL,'JOSPT-ACL-2017',2),
 ('S83.5','functional_training','ขยับข้อทันทีภายใน 1 สัปดาห์','Immediate mobilisation','recommended','B (JOSPT)',NULL,NULL,'JOSPT-ACL-2017',3),
 ('S83.5','functional_training','ลงน้ำหนักเท่าที่ทนได้ภายใน 1 สัปดาห์','Early weight bearing','optional','C (JOSPT)',NULL,NULL,'JOSPT-ACL-2017',4),
 ('S83.5','education','กายภาพที่คลินิกแบบมีผู้ดูแล + home program ที่ปรับระดับ','Supervised rehab + home program','recommended','B (JOSPT)',NULL,NULL,'JOSPT-ACL-2017',5),
 ('S83.5','functional_training','Hop tests + PROs (ACL-RSI) ประเมินการกลับไปเล่นกีฬา','Return-to-sport testing','recommended','B (JOSPT)',NULL,NULL,'JOSPT-ACL-2017',6),
 ('S83.5','orthosis_taping','Functional brace (เข่าที่ไม่มี ACL)','Functional brace (ACL-deficient)','optional','C (JOSPT)',NULL,'หลังผ่าตัด: ตัดสินใจร่วมกับผู้ป่วย (D)','JOSPT-ACL-2017',7);
INSERT INTO _em VALUES
 ('S83.5','NMES','recommended','A (JOSPT)',1.0,'NMES quadriceps 6–8 สัปดาห์ร่วมกับเสริมความแข็งแรง','JOSPT-ACL-2017'),
 ('S83.5','COLDPACK','recommended','B (JOSPT)',0.8,'ลดปวดหลังผ่าตัดทันที','JOSPT-ACL-2017'),
 ('S83.5','CPM','optional','C (JOSPT)',0.4,'ช่วงหลังผ่าตัดทันที เพื่อลดปวดเท่านั้น','JOSPT-ACL-2017'),
 ('S83.5','CYCLE','optional',NULL,0.4,'ส่วนหนึ่งของการฟื้นฟู ROM/แอโรบิก ตามดุลยพินิจ',NULL);

-- =====================================================================
-- Z96.65 Total knee arthroplasty
-- =====================================================================
INSERT INTO _dx VALUES ('Z96.65',
 'แนวทาง APTA 2020: เริ่มกายภาพภายใน 24 ชม.หลังผ่าตัด, ฝึกการเคลื่อนไหว/ทรงตัว/เดิน, เสริมความแข็งแรงแบบเข้มข้นภายใน 7 วัน, NMES และความเย็นช่วงแรก; ไม่แนะนำ CPM ในรายที่ไม่มีภาวะแทรกซ้อน',
 'DVT/PE, แผลติดเชื้อ, งอเข่าได้ <90° ที่ 6 สัปดาห์, หกล้ม; พยากรณ์โรคแย่ลงเมื่อ BMI สูง ซึมเศร้า เบาหวาน สูบบุหรี่');
INSERT INTO _iv VALUES
 ('Z96.65','functional_training','ฝึกการเคลื่อนไหว ทรงตัว และเดินให้สมมาตร','Motor function, balance & gait training','recommended','strong (APTA)',NULL,NULL,'APTA-TKA-2020',1),
 ('Z96.65','exercise','เสริมความแข็งแรงแบบเข้มข้นปรับระดับ (เริ่มภายใน 7 วัน)','High-intensity progressive strength training','recommended','moderate (APTA)','3 ครั้ง/สัปดาห์ 6–8 สัปดาห์ ปรับตามปวด/บวม',NULL,'APTA-TKA-2020',2),
 ('Z96.65','functional_training','เริ่มกายภาพภายใน 24 ชม.หลังผ่าตัด','Start PT within 24 h','recommended','moderate (APTA)',NULL,NULL,'APTA-TKA-2020',3),
 ('Z96.65','exercise','ออกกำลังกายเพิ่มองศาเข่า','Knee ROM exercise','recommended','best practice (APTA)',NULL,NULL,'APTA-TKA-2020',4),
 ('Z96.65','education','กายภาพแบบมีผู้ดูแล (ดีกว่า home program อย่างเดียว)','Supervised PT','recommended','moderate (APTA)',NULL,NULL,'APTA-TKA-2020',5),
 ('Z96.65','exercise','ออกกำลังกายและให้ความรู้ก่อนผ่าตัด','Preoperative exercise & education','optional','moderate (APTA)',NULL,NULL,'APTA-TKA-2020',6),
 ('Z96.65','other','วางเข่างอ 30–90° ช่วง 7 วันแรก','Knee rest positioning 30–90° flexion','optional','weak (APTA)',NULL,NULL,'APTA-TKA-2020',7);
INSERT INTO _em VALUES
 ('Z96.65','NMES','recommended','moderate (APTA)',0.9,'เริ่มวันที่ 2 หลังผ่าตัด, 5–7 ครั้ง/วัน ความแรงสูงสุดที่ทนได้ ≥3 สัปดาห์','APTA-TKA-2020'),
 ('Z96.65','COLDPACK','recommended','moderate (APTA)',0.8,'ลดปวดช่วงแรกหลังผ่าตัด','APTA-TKA-2020'),
 ('Z96.65','TREADMILL','recommended','strong (APTA, motor/gait training)',0.6,'ส่วนหนึ่งของการฝึกเดิน','APTA-TKA-2020'),
 ('Z96.65','PARALLEL','recommended','strong (APTA, motor/gait training)',0.6,'ฝึกเดินช่วงแรก','APTA-TKA-2020'),
 ('Z96.65','CYCLE','optional',NULL,0.4,'เพิ่ม ROM/แอโรบิก ตามดุลยพินิจ',NULL),
 ('Z96.65','CPM','not_recommended','moderate (APTA)',0.1,'ไม่แนะนำในรายที่ไม่มีภาวะแทรกซ้อน','APTA-TKA-2020');

-- =====================================================================
-- M72.2 Plantar fasciitis  (เกรดจากร่างก่อนตีพิมพ์ — ตรวจสอบกับฉบับตีพิมพ์)
-- =====================================================================
INSERT INTO _dx VALUES ('M72.2',
 'แนวทาง JOSPT 2023: manual therapy, ยืดพังผืดฝ่าเท้าและน่อง และ taping เป็นการรักษาหลัก; LLLT เสริมระยะสั้น; อัลตราซาวด์ไม่แนะนำ; ESWT สำหรับรายดื้อต่อการรักษาเท่านั้น (เกรดอ้างอิงจากร่างของแนวทาง — ควรตรวจกับฉบับตีพิมพ์)',
 'กระดูกส้นเท้าร้าว (stress fracture), tarsal tunnel/Baxter nerve entrapment, โรคข้ออักเสบทั้งระบบหรือปวดส้นเท้าสองข้าง, พังผืดฉีกขาดหลังฉีดสเตียรอยด์');
INSERT INTO _iv VALUES
 ('M72.2','manual_therapy','Manual therapy ข้อต่อและเนื้อเยื่ออ่อน','Joint & soft tissue manual therapy','recommended','A (JOSPT draft)',NULL,NULL,'JOSPT-HEEL-2023',1),
 ('M72.2','exercise','ยืดพังผืดฝ่าเท้าและกล้ามเนื้อน่อง','Plantar fascia-specific & calf stretching','recommended','A (JOSPT draft)',NULL,NULL,'JOSPT-HEEL-2023',2),
 ('M72.2','orthosis_taping','Taping (rigid หรือ elastic) ร่วมกับการรักษาอื่น','Taping','recommended','A (JOSPT draft)',NULL,'ประโยชน์ระยะสั้น 1–6 สัปดาห์','JOSPT-HEEL-2023',3),
 ('M72.2','orthosis_taping','Night splint 1–3 เดือน (ปวดก้าวแรกตอนเช้า)','Night splints','recommended','A (JOSPT draft — ตรวจสอบ)',NULL,NULL,'JOSPT-HEEL-2023',4),
 ('M72.2','other','Dry needling น่องและฝ่าเท้า','Dry needling','optional','B (JOSPT draft)',NULL,NULL,'JOSPT-HEEL-2023',5),
 ('M72.2','exercise','Resistance training เท้าและข้อเท้า','Foot & ankle resistance training','optional','C (JOSPT draft)',NULL,NULL,'JOSPT-HEEL-2023',6),
 ('M72.2','orthosis_taping','แผ่นรองเท้า (ใช้ร่วม ไม่ใช้เดี่ยว)','Foot orthoses (adjunct only)','optional','C ร่วม; B ไม่ใช้เดี่ยว (JOSPT draft)',NULL,NULL,'JOSPT-HEEL-2023',7);
INSERT INTO _em VALUES
 ('M72.2','LASER','recommended','B (JOSPT draft)',0.7,'ลดปวดระยะสั้นร่วมกับการฟื้นฟู','JOSPT-HEEL-2023'),
 ('M72.2','SHOCKWAVE','optional','NICE IPG311: special arrangements',0.4,'เฉพาะรายดื้อต่อการรักษา; นอกขอบเขตแนวทาง JOSPT','NICE-IPG311'),
 ('M72.2','IFC','optional','D (JOSPT draft, second-line)',0.3,'ใช้เมื่อการรักษาหลักไม่ได้ผล','JOSPT-HEEL-2023'),
 ('M72.2','US','not_recommended','A (JOSPT draft)',0.1,NULL,'JOSPT-HEEL-2023');

-- =====================================================================
-- S93.4 Lateral ankle sprain
-- =====================================================================
INSERT INTO _dx VALUES ('S93.4',
 'แนวทาง JOSPT 2021: อุปกรณ์พยุง (brace/tape) + ลงน้ำหนักแบบปรับระดับ, ออกกำลังกาย ROM/balance/neuromuscular และ manual therapy เป็นหลัก; ป้องกันการเป็นซ้ำด้วย brace + proprioceptive training',
 'กระดูกหัก (Ottawa ankle rules), high ankle sprain (syndesmosis), osteochondral lesion, เอ็น peroneal บาดเจ็บ');
INSERT INTO _iv VALUES
 ('S93.4','orthosis_taping','Brace/tape + ลงน้ำหนักแบบปรับระดับ','External support + progressive weight bearing','recommended','A (JOSPT)',NULL,'แพลงรุนแรง: semi-rigid brace ถึงเฝือกใต้เข่าไม่เกิน 10 วัน (A)','JOSPT-ANKLE-2021',1),
 ('S93.4','exercise','ออกกำลังกาย ROM, ยืด, neuromuscular และ balance (คลินิก + บ้าน)','Structured exercise incl. balance training','recommended','A (JOSPT)',NULL,NULL,'JOSPT-ANKLE-2021',2),
 ('S93.4','manual_therapy','Manual therapy (lymphatic drainage, soft tissue, AP talar glide)','Manual therapy','recommended','A (JOSPT)',NULL,NULL,'JOSPT-ANKLE-2021',3),
 ('S93.4','exercise','Brace + proprioceptive/balance exercise ป้องกันการเป็นซ้ำ','Recurrence prevention','recommended','A (JOSPT)',NULL,NULL,'JOSPT-ANKLE-2021',4),
 ('S93.4','functional_training','โปรแกรมกลับไปทำงาน/เล่นกีฬา','Return to work/sport program','recommended','B (JOSPT)',NULL,NULL,'JOSPT-ANKLE-2021',5),
 ('S93.4','manual_therapy','Chronic ankle instability: mobilization/manipulation/MWM','Joint mobilization for chronic instability','recommended','A (JOSPT)',NULL,'brace อย่างเดียวไม่เพียงพอ (B)','JOSPT-ANKLE-2021',6);
INSERT INTO _em VALUES
 ('S93.4','COLDPACK','optional','C (JOSPT)',0.5,'ประคบเย็นเป็นช่วงร่วมกับการออกกำลังกาย','JOSPT-ANKLE-2021'),
 ('S93.4','SWD','optional','C (JOSPT, pulsed)',0.4,'ลดบวม/ช่วยการเดิน','JOSPT-ANKLE-2021'),
 ('S93.4','LASER','optional','C (JOSPT)',0.4,'ลดปวดระยะแรก','JOSPT-ANKLE-2021'),
 ('S93.4','TENS','insufficient','D (JOSPT)',0.2,'Electrotherapy หลักฐานไม่พอ','JOSPT-ANKLE-2021'),
 ('S93.4','US','not_recommended','A (JOSPT)',0.1,NULL,'JOSPT-ANKLE-2021');

-- ---------- Neuro / pediatric sources ----------
INSERT INTO clinical_sources (code, title, organization, year, url) VALUES
 ('AHA-STROKE-2026', '2026 Guideline for Adult Stroke Rehabilitation and Recovery', 'AHA/ASA', 2026, 'https://www.ahajournals.org/doi/10.1161/STR.0000000000000536'),
 ('NICE-NG236',      'Stroke rehabilitation in adults (NG236)', 'NICE', 2023, 'https://www.nice.org.uk/guidance/ng236'),
 ('ANPT-LOCO-2020',  'Clinical Practice Guideline to Improve Locomotor Function Following Chronic Stroke, Incomplete SCI, and Brain Injury (Hornby et al.)', 'ANPT/APTA', 2020, 'https://neuropt.org/practice-resources/anpt-clinical-practice-guidelines/locomotor'),
 ('NOVAK-CP-2020',   'State of the Evidence Traffic Lights 2019: Interventions for Children with Cerebral Palsy (Novak et al.)', 'Curr Neurol Neurosci Rep', 2020, 'https://pmc.ncbi.nlm.nih.gov/articles/PMC7035308/'),
 ('JACKMAN-CP-2022', 'Interventions to improve physical function for children and young people with cerebral palsy: international CPG (Jackman et al.)', 'DMCN', 2022, 'https://doi.org/10.1111/dmcn.15055'),
 ('APTA-PD-2022',    'Physical Therapist Management of Parkinson Disease: A Clinical Practice Guideline (Osborne et al.)', 'APTA', 2022, 'https://academic.oup.com/ptj/article/102/4/pzab302/6485202')
ON CONFLICT (code) DO UPDATE SET title = EXCLUDED.title, organization = EXCLUDED.organization, year = EXCLUDED.year, url = EXCLUDED.url;

-- ข้อควรระวังเพิ่ม: อุปกรณ์กระตุ้นระบบประสาทฝังในร่างกาย (DBS, spinal cord stimulator, baclofen pump)
INSERT INTO precaution_types (code, name_th, name_en, severity) VALUES
 ('NEUROSTIMULATOR', 'มีอุปกรณ์กระตุ้นประสาท/ปั๊มยาฝังในร่างกาย', 'Implanted neurostimulator / drug pump', 'high')
ON CONFLICT (code) DO NOTHING;
INSERT INTO precaution_contraindications (precaution_code, equipment_category_id, level, note)
SELECT 'NEUROSTIMULATOR', c.id, x.lvl, x.note FROM (VALUES
  ('SWD','absolute','ห้ามใช้ diathermy กับผู้มี DBS/stimulator'),
  ('TENS','relative','หลีกเลี่ยงบริเวณใกล้อุปกรณ์'),('IFC','relative','หลีกเลี่ยงบริเวณใกล้อุปกรณ์'),('NMES','relative','หลีกเลี่ยงบริเวณใกล้อุปกรณ์')
) x(cat, lvl, note) JOIN equipment_categories c ON c.code = x.cat
ON CONFLICT DO NOTHING;

-- =====================================================================
-- I63.9 Stroke
-- =====================================================================
INSERT INTO _dx VALUES ('I63.9',
 'ฝึกเดินแบบ task-specific ความเข้มข้นปานกลาง–สูง เป็นหัวใจของการฟื้นฟูการเดิน (โดยเฉพาะระยะเรื้อรังที่เดินได้); ฝึกแขนแบบ repetitive task-specific และ CIMT ในรายที่เหมาะสม; ความเข้มข้นของการรักษาสำคัญ (NICE: ≥3 ชม./วัน 5 วัน/สัปดาห์ เมื่อทำได้) — แนวทาง ANPT 2020 ใช้กับระยะเรื้อรัง (>6 เดือน) ที่เดินได้เท่านั้น',
 'ปรึกษาแพทย์ก่อนฝึกความเข้มข้นสูง และติดตามชีพจร/ความดัน; ห้ามใช้รอกเหนือศีรษะ (เสี่ยงปวดไหล่); เสี่ยงล้ม; ข้อไหล่เคลื่อนจากการจับยกผิดวิธี; ชักหลังโรคหลอดเลือดสมอง; อาการ stroke ซ้ำ (FAST); การกระตุ้นไฟฟ้า: ห้ามในผู้มี pacemaker/ICD, เหนือ carotid sinus, ผิวหนังรับความรู้สึกบกพร่อง');
INSERT INTO _iv VALUES
 ('I63.9','functional_training','ฝึกเดินความเข้มข้นปานกลาง–สูง (task-specific)','Moderate–high intensity walking training','recommended','strong / SHOULD (ANPT)','3 ครั้ง/สัปดาห์ 30–50 นาที ที่ 60–80% HRR หรือ ≤85% HRmax','ระยะเรื้อรังที่เดินได้','ANPT-LOCO-2020',1),
 ('I63.9','functional_training','ฝึกแขนแบบ repetitive task-specific','Repetitive task-specific upper limb training','recommended','NICE offer',NULL,NULL,'NICE-NG236',2),
 ('I63.9','functional_training','CIMT (constraint-induced movement therapy)','Constraint-induced movement therapy','optional','NICE consider','ต้องเหยียดข้อมือได้ ≥20° และนิ้ว ≥10°',NULL,'NICE-NG236',3),
 ('I63.9','other','Mirror therapy (เสริม)','Mirror therapy','optional','NICE consider',NULL,NULL,'NICE-NG236',4),
 ('I63.9','exercise','ฝึกสมรรถภาพหัวใจ-ปอดและแรงต้าน (ผู้ที่เดินได้และอาการคงที่)','Cardiorespiratory & resistance fitness training','recommended','NICE',NULL,NULL,'NICE-NG236',5),
 ('I63.9','exercise','Strength training','Strength training','optional','weak / MAY (ANPT)',NULL,NULL,'ANPT-LOCO-2020',6),
 ('I63.9','exercise','Circuit / combined training','Circuit training','optional','weak / MAY (ANPT)',NULL,NULL,'ANPT-LOCO-2020',7),
 ('I63.9','exercise','ฝึกทรงตัวขณะยืนนิ่งอย่างเดียวเพื่อพัฒนาการเดิน (ระยะเรื้อรัง)','Static/standing balance training alone (to improve walking)','not_recommended','SHOULD NOT (ANPT)',NULL,'ฝึกทรงตัวร่วม VR/visual feedback: MAY','ANPT-LOCO-2020',8),
 ('I63.9','education','ความเข้มข้นการรักษา ≥3 ชม./วัน ≥5 วัน/สัปดาห์ (เมื่อทำได้)','Therapy intensity','recommended','NICE',NULL,NULL,'NICE-NG236',9);
INSERT INTO _em VALUES
 ('I63.9','PARALLEL','recommended','strong (ANPT, walking practice)',0.9,'ฝึกเดินบนพื้น/ราวคู่เป็นส่วนหนึ่งของ task-specific training','ANPT-LOCO-2020'),
 ('I63.9','TREADMILL','recommended','strong (ANPT, ไม่ใช้ BWS); NICE consider',0.8,'ลู่วิ่งความเข้มข้นปานกลาง–สูง; BWS ในระยะเรื้อรัง: SHOULD NOT (ANPT)','ANPT-LOCO-2020'),
 ('I63.9','NMES','optional','AHA 2026: FES/AFO ขาเพื่อการเคลื่อนไหว COR 1; NMES ไหล่ COR 2a',0.6,'FES ขา/ไหล่หลุด — ตรวจข้อห้าม pacemaker','AHA-STROKE-2026'),
 ('I63.9','CYCLE','optional','weak / MAY (ANPT)',0.5,'แอโรบิกความเข้มข้นสูง','ANPT-LOCO-2020'),
 ('I63.9','TILT','insufficient',NULL,0.3,'ไม่พบคำแนะนำในแนวทาง — ใช้ตามดุลยพินิจในผู้ป่วยระยะแรกที่ยืนไม่ได้',NULL),
 ('I63.9','TENS','insufficient',NULL,0.2,'ไม่มีคำแนะนำเฉพาะ',NULL);

-- =====================================================================
-- G80.9 Cerebral palsy
-- =====================================================================
INSERT INTO _dx VALUES ('G80.9',
 'หลักการ: เป้าหมายที่เด็ก/ครอบครัวเลือก, ฝึกทั้งกิจกรรมในบริบทชีวิตจริง, ความเข้มข้นสูง, ให้เด็กเคลื่อนไหวเอง (active) — Goal-directed training, CIMT, bimanual training, strength/fitness training เป็น "ไฟเขียว"; NDT แบบ passive และ sensory integration เป็น "ไฟแดง"',
 'เฝ้าระวังข้อสะโพกเคลื่อน (X-ray ตามรอบ โดยเฉพาะ GMFCS III–V); ลมชัก (ระวังการกระตุ้นไฟฟ้า); กลืนลำบาก/สำลัก; กระดูกบาง (เสี่ยงหักขณะยืด/จับยก); มี shunt หรือ baclofen pump');
INSERT INTO _iv VALUES
 ('G80.9','functional_training','Goal-directed training (เป้าหมายที่เด็ก/ผู้ปกครองตั้ง)','Goal-directed training','recommended','GREEN (Novak)',NULL,'ฝึกกิจกรรมจริง ความเข้มข้นสูง เด็กเคลื่อนไหวเอง','NOVAK-CP-2020',1),
 ('G80.9','functional_training','CIMT (hemiplegia)','Constraint-induced movement therapy','recommended','GREEN (Novak)',NULL,NULL,'NOVAK-CP-2020',2),
 ('G80.9','functional_training','Bimanual training','Bimanual training','recommended','GREEN (Novak)',NULL,NULL,'NOVAK-CP-2020',3),
 ('G80.9','exercise','Strength training','Strength training','recommended','GREEN (Novak)',NULL,NULL,'NOVAK-CP-2020',4),
 ('G80.9','exercise','Fitness training','Fitness training','recommended','GREEN (Novak)',NULL,NULL,'NOVAK-CP-2020',5),
 ('G80.9','functional_training','ฝึกเดินบนพื้น (overground walking)','Overground walking practice','recommended','Jackman 2022',NULL,'ลู่วิ่งใช้เสริม','JACKMAN-CP-2022',6),
 ('G80.9','orthosis_taping','Casting / weight-bearing (standing frame)','Casting & weight-bearing','recommended','GREEN (Novak)',NULL,NULL,'NOVAK-CP-2020',7),
 ('G80.9','education','Hip surveillance','Hip surveillance','recommended','GREEN (Novak)',NULL,NULL,'NOVAK-CP-2020',8),
 ('G80.9','manual_therapy','NDT แบบ passive เพื่อพัฒนาการเคลื่อนไหว','Passive neurodevelopmental therapy','not_recommended','RED (Novak)',NULL,NULL,'NOVAK-CP-2020',9),
 ('G80.9','other','Sensory integration','Sensory integration','not_recommended','RED (Novak)',NULL,NULL,'NOVAK-CP-2020',10);
INSERT INTO _em VALUES
 ('G80.9','TREADMILL','recommended','GREEN (Novak); ใช้เสริม (Jackman)',0.7,'ลู่วิ่ง/partial BWS เสริมการฝึกเดินบนพื้น','NOVAK-CP-2020'),
 ('G80.9','PARALLEL','recommended','Jackman 2022 (overground)',0.7,'ฝึกเดินบนพื้น','JACKMAN-CP-2022'),
 ('G80.9','NMES','optional','YELLOW (Novak)',0.4,'เสริมการฝึกการเคลื่อนไหว — ระวังลมชัก','NOVAK-CP-2020'),
 ('G80.9','TILT','insufficient','weight-bearing GREEN; tilt table ไม่มี rating',0.3,'ใช้เพื่อ weight-bearing ตามดุลยพินิจ','NOVAK-CP-2020'),
 ('G80.9','CYCLE','insufficient',NULL,0.3,'ไม่มี rating',NULL);

-- =====================================================================
-- G20 Parkinson disease
-- =====================================================================
INSERT INTO _dx VALUES ('G20',
 'แนวทาง APTA 2022: แอโรบิก, แรงต้าน, ทรงตัว, external cueing, ฝึกเดิน และ task-specific training เป็นคำแนะนำระดับ strong ทั้งหมด (หลักฐานส่วนใหญ่ใน Hoehn & Yahr 1–3); ใช้ RPE ร่วมกับชีพจรเพราะการตอบสนองของชีพจรอาจลดลง',
 'เสี่ยงล้ม/freezing of gait (เพิ่มการดูแลใกล้ชิด), ความดันตกเมื่อเปลี่ยนท่า (วัดความดันนอน-ยืน), นัดรักษาช่วงยาออกฤทธิ์ (on), มี DBS (ห้าม diathermy ระวัง TENS/NMES), กลืนลำบาก, ความจำบกพร่อง');
INSERT INTO _iv VALUES
 ('G20','exercise','Aerobic exercise','Aerobic exercise','recommended','strong (APTA)','≥3 วัน/สัปดาห์ 30–40 นาที ที่ 60–85% HRmax (ใช้ RPE ร่วม)',NULL,'APTA-PD-2022',1),
 ('G20','exercise','Resistance training','Resistance training','recommended','strong (APTA)','1–2 วัน/สัปดาห์ 30–60 นาที ที่ 80% 1RM (strength) หรือ 40% (power)',NULL,'APTA-PD-2022',2),
 ('G20','exercise','Balance training','Balance training','recommended','strong (APTA)','2–3 ครั้ง/สัปดาห์ รวม 16–30 ชม. ใน 5–10 สัปดาห์',NULL,'APTA-PD-2022',3),
 ('G20','functional_training','External cueing (เสียง/ภาพ/สัมผัส)','External cueing','recommended','strong (APTA)','20–60 นาที 2–5 ครั้ง/สัปดาห์ 3–8 สัปดาห์',NULL,'APTA-PD-2022',4),
 ('G20','functional_training','Gait training','Gait training','recommended','strong (APTA)',NULL,'ไม่มีรูปแบบใดดีกว่าชัดเจน','APTA-PD-2022',5),
 ('G20','functional_training','Task-specific training','Task-specific training','recommended','strong (APTA)',NULL,NULL,'APTA-PD-2022',6),
 ('G20','education','ส่งเสริมการออกกำลังกายในชุมชน / integrated care','Community-based exercise & integrated care','recommended','strong (APTA)',NULL,NULL,'APTA-PD-2022',7),
 ('G20','education','Behavior-change approach','Behavior-change approach','recommended','moderate (APTA)',NULL,NULL,'APTA-PD-2022',8),
 ('G20','exercise','Flexibility exercise','Flexibility exercise','optional','weak (APTA)',NULL,NULL,'APTA-PD-2022',9);
INSERT INTO _em VALUES
 ('G20','TREADMILL','recommended','strong (APTA, gait/aerobic)',0.8,'ฝึกเดิน/แอโรบิก ร่วม cueing ได้','APTA-PD-2022'),
 ('G20','CYCLE','recommended','strong (APTA, aerobic)',0.8,'เลือกแทนลู่วิ่งในผู้เสี่ยงล้มสูงหรือมี freezing','APTA-PD-2022'),
 ('G20','PARALLEL','recommended','strong (APTA, gait training)',0.6,'ฝึกเดินบนพื้น','APTA-PD-2022'),
 ('G20','NMES','insufficient',NULL,0.2,'ไม่มีคำแนะนำ',NULL),
 ('G20','TILT','insufficient',NULL,0.2,'ไม่มีคำแนะนำ',NULL);

-- =====================================================================
-- Apply staged data (แทนที่ข้อมูลเดิมเฉพาะโรคที่มีในชุดนี้)
-- =====================================================================
UPDATE diagnoses d SET summary_th = x.summary, red_flags = x.red_flags FROM _dx x WHERE d.icd10_code = x.icd;

DELETE FROM diagnosis_interventions WHERE diagnosis_id IN (SELECT d.id FROM diagnoses d JOIN (SELECT DISTINCT icd FROM _iv) x ON x.icd = d.icd10_code);
INSERT INTO diagnosis_interventions (diagnosis_id, category, name_th, name_en, recommendation, grade, dosage, notes, source_id, sort_order)
SELECT d.id, x.cat, x.name_th, x.name_en, x.rec, x.grade, x.dosage, x.notes, s.id, x.ord
  FROM _iv x JOIN diagnoses d ON d.icd10_code = x.icd LEFT JOIN clinical_sources s ON s.code = x.src;

DELETE FROM diagnosis_equipment_map WHERE diagnosis_id IN (SELECT d.id FROM diagnoses d JOIN (SELECT DISTINCT icd FROM _em) x ON x.icd = d.icd10_code);
INSERT INTO diagnosis_equipment_map (diagnosis_id, equipment_category_id, weight, rationale, recommendation, grade, source_id)
SELECT d.id, c.id, x.w, x.why, x.rec, x.grade, s.id
  FROM _em x JOIN diagnoses d ON d.icd10_code = x.icd JOIN equipment_categories c ON c.code = x.cat
  LEFT JOIN clinical_sources s ON s.code = x.src;

DROP TABLE _iv, _em, _dx;
