-- =====================================================================
-- PhysioCare — Reference data (ข้อมูลอ้างอิงที่ระบบต้องมีเสมอ — ใช้ใน production)
-- บทบาท/สิทธิ์, การตั้งค่าเริ่มต้น, ความเชี่ยวชาญ, กะ, หมวดอุปกรณ์, ICD-10, ข้อควรระวัง/ข้อห้าม
-- ไม่มีบัญชีผู้ใช้หรือข้อมูลผู้ป่วย — สร้างผู้ดูแลระบบคนแรกด้วย `npm run create-admin`
-- ⚠ กฎทางคลินิก (mapping / contraindications) ต้องให้นักกายภาพบำบัด/คณะกรรมการคลินิกตรวจสอบก่อนใช้งานจริง
-- =====================================================================

-- ---------- RBAC ----------
INSERT INTO roles (code, name_th, description) VALUES
 ('admin',     'ผู้ดูแลระบบ',       'จัดการผู้ใช้ ตั้งค่าระบบ ดูรายงานสถิติ'),
 ('therapist', 'นักกายภาพบำบัด',    'จัดการนัด บันทึกเวชระเบียน ตรวจสอบอุปกรณ์'),
 ('staff',     'เจ้าหน้าที่/ผู้ช่วย', 'จัดการนัด ตรวจสอบอุปกรณ์ (ไม่เขียนเวชระเบียน)'),
 ('patient',   'ผู้ป่วย',           'ดูตารางนัดหมายของตนเอง');

INSERT INTO permissions (code, description) VALUES
 ('users:manage',        'จัดการบัญชีผู้ใช้และสิทธิ์'),
 ('settings:manage',     'ตั้งค่าระบบ'),
 ('reports:view',        'ดูรายงานสถิติ'),
 ('audit:read',          'ดู audit log'),
 ('equipment:read',      'ดูข้อมูลอุปกรณ์'),
 ('equipment:write',     'เพิ่ม/แก้ไขทะเบียนอุปกรณ์'),
 ('equipment:status',    'เปลี่ยนสถานะอุปกรณ์ / แจ้งชำรุด'),
 ('maintenance:write',   'บันทึกการบำรุงรักษา'),
 ('staff:read',          'ดูข้อมูลบุคลากร'),
 ('staff:write',         'จัดการข้อมูลบุคลากร/ความเชี่ยวชาญ'),
 ('shifts:write',        'จัดตารางกะ/วันลา'),
 ('patients:read',       'ดูข้อมูลผู้ป่วย'),
 ('patients:write',      'เพิ่ม/แก้ไขข้อมูลผู้ป่วย'),
 ('appointments:read_all','ดูนัดหมายทั้งหมด'),
 ('appointments:read_own','ดูนัดหมายของตนเอง'),
 ('appointments:write',  'สร้าง/เลื่อน/ยกเลิกนัด'),
 ('emr:read',            'อ่านเวชระเบียน'),
 ('emr:write',           'บันทึก/ลงนามเวชระเบียน'),
 ('media:upload',        'อัปโหลดรูปภาพ');

-- admin: ทุกสิทธิ์ ยกเว้น EMR (หลัก least-privilege / PDPA ข้อมูลสุขภาพ)
INSERT INTO role_permissions (role_id, permission_code)
SELECT r.id, p.code FROM roles r, permissions p
 WHERE r.code = 'admin' AND p.code NOT IN ('emr:read','emr:write','appointments:read_own');

INSERT INTO role_permissions (role_id, permission_code)
SELECT r.id, p FROM roles r, unnest(ARRAY[
  'equipment:read','equipment:status','maintenance:write','staff:read',
  'patients:read','patients:write','appointments:read_all','appointments:write',
  'emr:read','emr:write','media:upload']) p
 WHERE r.code = 'therapist';

INSERT INTO role_permissions (role_id, permission_code)
SELECT r.id, p FROM roles r, unnest(ARRAY[
  'equipment:read','equipment:status','maintenance:write','staff:read','shifts:write',
  'patients:read','patients:write','appointments:read_all','appointments:write','media:upload']) p
 WHERE r.code = 'staff';

INSERT INTO role_permissions (role_id, permission_code)
SELECT r.id, 'appointments:read_own' FROM roles r WHERE r.code = 'patient';

-- ---------- Settings ----------
INSERT INTO system_settings (key, value, description) VALUES
 ('clinic.hours',      '{"open":"08:00","close":"20:00","days":[1,2,3,4,5,6]}', 'เวลาทำการ (1=จันทร์ ... 7=อาทิตย์)'),
 ('clinic.utc_offset', '"+07:00"', 'Timezone ของคลินิก'),
 ('scheduling.slot_minutes',    '30', 'ความละเอียดของช่องเวลา'),
 ('scheduling.default_duration','45', 'ระยะเวลานัดเริ่มต้น (นาที)'),
 ('emr.require_pre_assessment', 'true', 'ต้องบันทึก Pre-assessment ก่อนเริ่มรักษา');

-- ---------- Specialties / Shifts ----------
INSERT INTO specialties (code, name_th, name_en) VALUES
 ('ORTHO',  'กายภาพบำบัดระบบกระดูกและกล้ามเนื้อ', 'Orthopedic'),
 ('NEURO',  'กายภาพบำบัดระบบประสาท',            'Neurological'),
 ('PEDS',   'กายภาพบำบัดในเด็ก',                'Pediatric'),
 ('SPORTS', 'กายภาพบำบัดทางการกีฬา',            'Sports'),
 ('CARDIO', 'กายภาพบำบัดระบบหัวใจและทางเดินหายใจ','Cardiopulmonary'),
 ('GERI',   'กายภาพบำบัดผู้สูงอายุ',             'Geriatric');

INSERT INTO shift_templates (code, name_th, start_time, end_time) VALUES
 ('MORNING',   'กะเช้า',  '08:00', '16:00'),
 ('AFTERNOON', 'กะบ่าย',  '12:00', '20:00'),
 ('HALF_AM',   'ครึ่งเช้า', '08:00', '12:00');

-- ---------- Equipment categories ----------
INSERT INTO equipment_categories (code, name_th, name_en, modality, default_session_minutes, cleaning_buffer_minutes, maintenance_interval_days) VALUES
 ('US',        'อัลตราซาวด์เพื่อการรักษา',      'Therapeutic Ultrasound',        'acoustic',       10, 5, 180),
 ('TENS',      'เครื่องกระตุ้นไฟฟ้า TENS',       'TENS',                          'electrotherapy', 20, 5, 365),
 ('IFC',       'กระแสไฟฟ้าอินเตอร์เฟอเรนเชียล',  'Interferential Current',        'electrotherapy', 20, 5, 365),
 ('NMES',      'กระตุ้นกล้ามเนื้อด้วยไฟฟ้า',     'NMES / FES',                    'electrotherapy', 20, 5, 365),
 ('SWD',       'คลื่นสั้นความร้อนลึก',           'Shortwave Diathermy',           'thermotherapy',  20, 10, 180),
 ('HOTPACK',   'ถุงร้อน (Hydrocollator)',       'Hot Pack',                      'thermotherapy',  20, 10, 90),
 ('COLDPACK',  'ถุงเย็น/Cryo',                  'Cold Pack / Cryotherapy',       'cryotherapy',    15, 5, 180),
 ('TRACTION',  'เครื่องดึงคอ/หลัง',              'Cervical/Lumbar Traction',      'mechanical',     20, 5, 180),
 ('SHOCKWAVE', 'คลื่นกระแทก',                   'Extracorporeal Shockwave (ESWT)','acoustic',       15, 10, 180),
 ('LASER',     'เลเซอร์กำลังต่ำ',                'Low-Level Laser Therapy',       'light',          10, 5, 365),
 ('CPM',       'เครื่องขยับข้อต่อเนื่อง',        'Continuous Passive Motion',     'mechanical',     30, 10, 180),
 ('TILT',      'เตียงปรับยืน',                   'Tilt Table',                    'exercise',       30, 10, 365),
 ('PARALLEL',  'ราวคู่ฝึกเดิน',                  'Parallel Bars',                 'exercise',       30, 0,  365),
 ('TREADMILL', 'ลู่วิ่งฝึกเดิน',                  'Treadmill',                     'exercise',       20, 5,  180);

-- ---------- Diagnoses (ICD-10) ----------
INSERT INTO diagnoses (icd10_code, name_th, name_en, body_region) VALUES
 ('M54.5', 'ปวดหลังส่วนล่าง',             'Low back pain',              'lumbar'),
 ('M54.2', 'ปวดคอ',                      'Cervicalgia',                'cervical'),
 ('M75.0', 'ข้อไหล่ติด',                   'Adhesive capsulitis of shoulder','shoulder'),
 ('M17.1', 'ข้อเข่าเสื่อม',                 'Primary osteoarthritis of knee','knee'),
 ('S83.5', 'เอ็นไขว้หน้าเข่าบาดเจ็บ (ACL)', 'Sprain of cruciate ligament of knee','knee'),
 ('I63.9', 'โรคหลอดเลือดสมองตีบ',         'Cerebral infarction (Stroke)', 'neuro'),
 ('G80.9', 'ภาวะสมองพิการ',               'Cerebral palsy',             'neuro'),
 ('M72.2', 'รองช้ำ',                      'Plantar fasciitis',          'ankle'),
 ('M77.1', 'ข้อศอกเทนนิส',                'Lateral epicondylitis',      'elbow');

-- helper สำหรับ seed mapping
CREATE TEMP TABLE _dsm(icd text, sp text, w numeric);
INSERT INTO _dsm VALUES
 ('M54.5','ORTHO',1.0),('M54.5','SPORTS',0.5),
 ('M54.2','ORTHO',1.0),('M54.2','SPORTS',0.4),
 ('M75.0','ORTHO',1.0),('M75.0','SPORTS',0.6),('M75.0','GERI',0.4),
 ('M17.1','ORTHO',1.0),('M17.1','GERI',0.7),
 ('S83.5','SPORTS',1.0),('S83.5','ORTHO',0.8),
 ('I63.9','NEURO',1.0),('I63.9','GERI',0.5),
 ('G80.9','PEDS',1.0),('G80.9','NEURO',0.7),
 ('M72.2','SPORTS',0.8),('M72.2','ORTHO',0.8),
 ('M77.1','ORTHO',0.9),('M77.1','SPORTS',0.8);
INSERT INTO diagnosis_specialty_map
SELECT d.id, s.id, x.w FROM _dsm x JOIN diagnoses d ON d.icd10_code = x.icd JOIN specialties s ON s.code = x.sp;

CREATE TEMP TABLE _dem(icd text, cat text, w numeric, why text);
INSERT INTO _dem VALUES
 ('M54.5','TRACTION',0.8,'ลดแรงกดหมอนรองกระดูก'),('M54.5','IFC',0.7,'ลดปวดชั้นลึก'),
 ('M54.5','HOTPACK',0.6,'คลายกล้ามเนื้อก่อนออกกำลังกาย'),('M54.5','SWD',0.5,'ความร้อนลึก'),
 ('M54.2','TRACTION',0.8,'Cervical traction'),('M54.2','TENS',0.6,'ลดปวด'),('M54.2','HOTPACK',0.6,'คลายกล้ามเนื้อ'),
 ('M75.0','US',0.8,'เพิ่มความยืดหยุ่นของเยื่อหุ้มข้อ'),('M75.0','SWD',0.7,'ความร้อนลึกก่อน mobilization'),('M75.0','HOTPACK',0.6,'อุ่นข้อ'),
 ('M17.1','SWD',0.7,'ลดปวดข้อเข่า'),('M17.1','IFC',0.6,'ลดปวด'),('M17.1','US',0.5,'ลดการอักเสบ'),('M17.1','CPM',0.4,'เพิ่มองศาเข่า'),
 ('S83.5','CPM',0.8,'ฟื้นฟูองศาเข่าหลังผ่าตัด'),('S83.5','COLDPACK',0.7,'ลดบวม'),('S83.5','NMES',0.7,'กระตุ้น Quadriceps'),
 ('I63.9','PARALLEL',0.9,'ฝึกเดิน'),('I63.9','TILT',0.8,'ฝึกยืน/ระบบไหลเวียน'),('I63.9','NMES',0.6,'FES กล้ามเนื้ออ่อนแรง'),('I63.9','TREADMILL',0.5,'Gait training'),
 ('G80.9','PARALLEL',0.7,'ฝึกเดิน'),('G80.9','TILT',0.6,'ฝึกรับน้ำหนัก'),
 ('M72.2','SHOCKWAVE',0.9,'ESWT รองช้ำเรื้อรัง'),('M72.2','US',0.6,'ลดอักเสบ'),('M72.2','LASER',0.5,'ลดปวด'),
 ('M77.1','SHOCKWAVE',0.8,'ESWT'),('M77.1','LASER',0.6,'ลดปวด'),('M77.1','US',0.6,'ลดอักเสบเส้นเอ็น');
INSERT INTO diagnosis_equipment_map
SELECT d.id, c.id, x.w, x.why FROM _dem x JOIN diagnoses d ON d.icd10_code = x.icd JOIN equipment_categories c ON c.code = x.cat;

-- ---------- Precautions & contraindications ----------
INSERT INTO precaution_types (code, name_th, name_en, severity) VALUES
 ('PACEMAKER',     'ใส่เครื่องกระตุ้นหัวใจ',  'Cardiac pacemaker',      'high'),
 ('PREGNANCY',     'ตั้งครรภ์',              'Pregnancy',              'high'),
 ('METAL_IMPLANT', 'มีโลหะในร่างกาย',        'Metal implant',          'moderate'),
 ('MALIGNANCY',    'มะเร็ง/สงสัยมะเร็ง',      'Malignancy',             'high'),
 ('DVT',           'ลิ่มเลือดหลอดเลือดดำ',    'Deep vein thrombosis',   'high'),
 ('SENSORY_LOSS',  'การรับความรู้สึกบกพร่อง',  'Impaired sensation',     'moderate'),
 ('OSTEOPOROSIS',  'กระดูกพรุน',             'Osteoporosis',           'moderate'),
 ('OPEN_WOUND',    'แผลเปิด',               'Open wound',             'low'),
 ('FALL_RISK',     'เสี่ยงล้ม',              'Fall risk',              'moderate'),
 ('EPILEPSY',      'ลมชัก',                 'Epilepsy',               'moderate');

CREATE TEMP TABLE _pc(p text, cat text, lvl text, note text);
INSERT INTO _pc VALUES
 ('PACEMAKER','TENS','absolute',NULL),('PACEMAKER','IFC','absolute',NULL),('PACEMAKER','NMES','absolute',NULL),
 ('PACEMAKER','SWD','absolute',NULL),('PACEMAKER','US','relative','ห้ามบริเวณทรวงอก'),('PACEMAKER','SHOCKWAVE','relative',NULL),
 ('METAL_IMPLANT','SWD','absolute','ความร้อนสะสมที่โลหะ'),('METAL_IMPLANT','US','relative',NULL),
 ('PREGNANCY','SWD','absolute',NULL),('PREGNANCY','SHOCKWAVE','absolute',NULL),('PREGNANCY','IFC','relative','ห้ามบริเวณท้อง/หลังส่วนล่าง'),
 ('PREGNANCY','TENS','relative','ห้ามบริเวณท้อง'),('PREGNANCY','TRACTION','relative',NULL),('PREGNANCY','LASER','relative',NULL),
 ('MALIGNANCY','US','absolute',NULL),('MALIGNANCY','SWD','absolute',NULL),('MALIGNANCY','SHOCKWAVE','absolute',NULL),
 ('MALIGNANCY','LASER','absolute',NULL),('MALIGNANCY','HOTPACK','relative',NULL),
 ('DVT','SHOCKWAVE','absolute',NULL),('DVT','HOTPACK','relative',NULL),('DVT','CPM','relative',NULL),
 ('SENSORY_LOSS','HOTPACK','relative','เสี่ยงแผลไหม้'),('SENSORY_LOSS','COLDPACK','relative',NULL),('SENSORY_LOSS','SWD','relative',NULL),
 ('OSTEOPOROSIS','TRACTION','absolute',NULL),('OSTEOPOROSIS','SHOCKWAVE','relative',NULL),
 ('OPEN_WOUND','HOTPACK','relative',NULL),('OPEN_WOUND','SHOCKWAVE','relative',NULL),
 ('FALL_RISK','TREADMILL','relative','ต้องใช้ harness'),('FALL_RISK','TILT','relative',NULL),
 ('EPILEPSY','TENS','relative',NULL),('EPILEPSY','IFC','relative',NULL);
INSERT INTO precaution_contraindications
SELECT x.p, c.id, x.lvl, x.note FROM _pc x JOIN equipment_categories c ON c.code = x.cat;

