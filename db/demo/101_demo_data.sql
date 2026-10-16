-- =====================================================================
-- PhysioCare — DEMO data (ห้ามใช้ใน production)
-- บุคลากร ผู้ป่วย อุปกรณ์ และบัญชีทดลอง (รหัสผ่านทุกบัญชี: Passw0rd!)
-- รันหลัง 001–003 ด้วย `npm run migrate -- --demo`
-- =====================================================================

-- ---------- Staff ----------
INSERT INTO staff (id, employee_code, title, first_name, last_name, position, license_no, license_expiry, phone, color) VALUES
 ('11111111-0000-0000-0000-000000000001','PT001','กภ.','สมชาย','ใจดี','physiotherapist','กภ.10234','2028-12-31','081-111-1111','#0ea5e9'),
 ('11111111-0000-0000-0000-000000000002','PT002','กภ.','สุภาพร','วงศ์ไทย','physiotherapist','กภ.11872','2027-06-30','081-222-2222','#8b5cf6'),
 ('11111111-0000-0000-0000-000000000003','PT003','กภ.','ณัฐธิดา','แสงทอง','physiotherapist','กภ.12990','2029-03-31','081-333-3333','#f59e0b'),
 ('11111111-0000-0000-0000-000000000004','PT004','กภ.','วีระพงษ์','ศรีสุข','physiotherapist','กภ.13501','2028-08-31','081-444-4444','#10b981'),
 ('11111111-0000-0000-0000-000000000005','AS001',NULL,'มานี','รักงาน','assistant',NULL,NULL,'081-555-5555','#64748b');

INSERT INTO staff_specialties (staff_id, specialty_id, level, certified_at)
SELECT s.id, sp.id, x.lvl, x.cert::date FROM (VALUES
  ('PT001','ORTHO',5,'2018-05-01'),('PT001','SPORTS',4,'2020-01-15'),
  ('PT002','NEURO',5,'2017-03-01'),('PT002','GERI',4,'2019-09-01'),
  ('PT003','PEDS',5,'2019-07-01'),('PT003','NEURO',3,'2021-02-01'),
  ('PT004','SPORTS',5,'2016-11-01'),('PT004','ORTHO',4,'2018-04-01')
) x(emp, sp, lvl, cert)
JOIN staff s ON s.employee_code = x.emp JOIN specialties sp ON sp.code = x.sp;

-- กะทำงาน 21 วันนับจากเมื่อวาน (จันทร์-เสาร์)
INSERT INTO staff_shifts (staff_id, shift_template_id, start_at, end_at)
SELECT s.id, t.id,
       (d::date + t.start_time) AT TIME ZONE 'Asia/Bangkok',
       (d::date + t.end_time)   AT TIME ZONE 'Asia/Bangkok'
  FROM generate_series(CURRENT_DATE - 1, CURRENT_DATE + 20, interval '1 day') d
  JOIN (VALUES ('PT001','MORNING'),('PT002','MORNING'),('PT003','AFTERNOON'),
               ('PT004','AFTERNOON'),('AS001','MORNING')) x(emp, tpl) ON true
  JOIN staff s ON s.employee_code = x.emp
  JOIN shift_templates t ON t.code = x.tpl
 WHERE EXTRACT(ISODOW FROM d) BETWEEN 1 AND 6;

-- ---------- Equipment ----------
INSERT INTO equipment (asset_code, name, category_id, brand, model, serial_no, location, purchase_date, purchase_price, warranty_expiry, status, last_maintenance_at, next_maintenance_due)
SELECT x.code, x.name, c.id, x.brand, x.model, x.sn, x.loc, x.pdate::date, x.price, x.warranty::date, x.status,
       CURRENT_DATE - x.last_mt, CURRENT_DATE - x.last_mt + c.maintenance_interval_days
  FROM (VALUES
   ('EQ-US-001','Ultrasound Therapy Unit #1','US','Chattanooga','Intelect Mobile 2','US2-88121','ห้อง 1','2022-03-10',85000,'2025-03-10','available',40),
   ('EQ-US-002','Ultrasound Therapy Unit #2','US','Enraf-Nonius','Sonopuls 190','SP-55102','ห้อง 2','2023-06-01',92000,'2026-06-01','available',20),
   ('EQ-TENS-001','TENS Portable #1','TENS','Compex','Fit 3.0','CX-3301','ตู้ 1','2023-01-05',15000,'2025-01-05','available',100),
   ('EQ-IFC-001','IFC Combo #1','IFC','Chattanooga','Intelect Neo','NEO-7781','ห้อง 1','2021-08-20',150000,'2024-08-20','available',60),
   ('EQ-NMES-001','NMES/FES Unit','NMES','BTL','BTL-4825','BTL-99812','ห้อง 3','2022-11-11',120000,'2025-11-11','available',30),
   ('EQ-SWD-001','Shortwave Diathermy','SWD','Enraf-Nonius','Curapuls 970','CP-11823','ห้อง 2','2019-02-15',380000,'2022-02-15','maintenance',170),
   ('EQ-HOT-001','Hydrocollator 8 packs','HOTPACK','Chattanooga','M-2','HC-2231','ห้องเตรียม','2020-05-05',45000,'2022-05-05','available',10),
   ('EQ-COLD-001','Cold Pack Chiller','COLDPACK','Chattanooga','C-5','CC-4410','ห้องเตรียม','2020-05-05',38000,'2022-05-05','available',15),
   ('EQ-TRC-001','Traction Table','TRACTION','Chattanooga','Triton DTS','TR-1192','ห้อง 4','2021-01-20',260000,'2024-01-20','available',90),
   ('EQ-TRC-002','Traction Table #2','TRACTION','Saunders','3D ActiveTrac','SA-2290','ห้อง 4','2018-07-01',310000,'2021-07-01','broken',200),
   ('EQ-ESWT-001','Shockwave Therapy','SHOCKWAVE','Storz Medical','Masterpuls MP100','ST-77120','ห้อง 5','2023-09-09',650000,'2026-09-09','available',50),
   ('EQ-LSR-001','Low Level Laser','LASER','BTL','BTL-6000','LS-12345','ห้อง 5','2022-02-02',280000,'2025-02-02','available',120),
   ('EQ-CPM-001','Knee CPM','CPM','Kinetec','Spectra','KN-88812','ห้อง 3','2021-04-04',95000,'2024-04-04','available',80),
   ('EQ-TILT-001','Tilt Table','TILT','Chattanooga','Tru-Trac','TT-12001','ห้องฝึก','2017-10-10',120000,'2020-10-10','available',150),
   ('EQ-PB-001','Parallel Bars 3m','PARALLEL','Local','PB-300','PB-0001','ห้องฝึก','2016-01-01',30000,NULL,'available',200),
   ('EQ-TM-001','Rehab Treadmill','TREADMILL','h/p/cosmos','Locomotion','HP-55120','ห้องฝึก','2022-12-12',540000,'2025-12-12','available',30)
  ) x(code, name, cat, brand, model, sn, loc, pdate, price, warranty, status, last_mt)
  JOIN equipment_categories c ON c.code = x.cat;

INSERT INTO equipment_maintenance (equipment_id, type, status, reported_at, started_at, completed_at, problem, action_taken, result, vendor, technician, cost)
SELECT e.id, x.type, x.status, now() - x.ago::interval, now() - x.ago::interval,
       CASE WHEN x.status = 'completed' THEN now() - x.ago::interval + interval '2 hours' END,
       x.problem, x.action, x.result, x.vendor, x.tech, x.cost
  FROM (VALUES
   ('EQ-US-001','calibration','completed','40 days','ตรวจสอบ output ประจำ 6 เดือน','สอบเทียบหัว 1/3 MHz','pass','Chattanooga TH','ช่างวิชัย',2500),
   ('EQ-SWD-001','corrective','in_progress','2 days','เครื่องไม่ปล่อยพลังงาน, error E04','ส่งตรวจบอร์ด RF','sent_to_vendor','Enraf TH','ช่างอนันต์',0),
   ('EQ-TRC-002','corrective','scheduled','1 day','มอเตอร์ดึงมีเสียงดังและหยุดกลางคัน',NULL,NULL,NULL,NULL,0),
   ('EQ-IFC-001','preventive','completed','60 days','PM ประจำปี','ทำความสะอาด/ตรวจสาย electrode','pass','Chattanooga TH','ช่างวิชัย',1800)
  ) x(code, type, status, ago, problem, action, result, vendor, tech, cost)
  JOIN equipment e ON e.asset_code = x.code;

-- ---------- Patients ----------
INSERT INTO patients (id, hn, title, first_name, last_name, date_of_birth, gender, phone) VALUES
 ('22222222-0000-0000-0000-000000000001','HN66-000101','นาย','ประเสริฐ','มั่นคง','1970-04-12','male','089-100-0001'),
 ('22222222-0000-0000-0000-000000000002','HN66-000102','นาง','วิไลวรรณ','สุขสันต์','1958-09-30','female','089-100-0002'),
 ('22222222-0000-0000-0000-000000000003','HN66-000103','ด.ช.','ภูมิ','ใจกล้า','2017-01-20','male','089-100-0003');

INSERT INTO patient_diagnoses (patient_id, diagnosis_id, is_primary, onset_date, referred_by)
SELECT x.pid::uuid, d.id, x.prim, x.onset::date, 'นพ.ออร์โธ' FROM (VALUES
  ('22222222-0000-0000-0000-000000000001','M54.5',true,'2026-08-01'),
  ('22222222-0000-0000-0000-000000000001','M75.0',false,'2026-07-15'),
  ('22222222-0000-0000-0000-000000000002','I63.9',true,'2026-06-20'),
  ('22222222-0000-0000-0000-000000000003','G80.9',true,'2018-01-01')
) x(pid, icd, prim, onset) JOIN diagnoses d ON d.icd10_code = x.icd;

INSERT INTO patient_precautions (patient_id, precaution_code, detail) VALUES
 ('22222222-0000-0000-0000-000000000002','PACEMAKER','ใส่ pacemaker ปี 2024'),
 ('22222222-0000-0000-0000-000000000002','FALL_RISK','Berg Balance 38/56'),
 ('22222222-0000-0000-0000-000000000001','METAL_IMPLANT','ใส่สกรูข้อเท้าซ้าย');

-- ---------- Users (password: Passw0rd!) ----------
INSERT INTO users (email, password_hash, display_name, role_id, staff_id, patient_id)
SELECT x.email, crypt('Passw0rd!', gen_salt('bf', 10)), x.name, r.id, x.sid::uuid, x.pid::uuid
  FROM (VALUES
   ('admin@physiocare.local',   'ผู้ดูแลระบบ',          'admin',     NULL, NULL),
   ('somchai@physiocare.local', 'กภ.สมชาย ใจดี',       'therapist', '11111111-0000-0000-0000-000000000001', NULL),
   ('supaporn@physiocare.local','กภ.สุภาพร วงศ์ไทย',    'therapist', '11111111-0000-0000-0000-000000000002', NULL),
   ('front@physiocare.local',   'มานี รักงาน (Front desk)','staff',   '11111111-0000-0000-0000-000000000005', NULL),
   ('patient@physiocare.local', 'ประเสริฐ มั่นคง',      'patient',   NULL, '22222222-0000-0000-0000-000000000001')
  ) x(email, name, role, sid, pid)
  JOIN roles r ON r.code = x.role;

-- ---------- ประวัติการรักษาย้อนหลัง (สำหรับดู progress) ----------
DO $$
DECLARE
  v_pt   uuid := '11111111-0000-0000-0000-000000000001';
  v_pat  uuid := '22222222-0000-0000-0000-000000000001';
  v_user uuid := (SELECT id FROM users WHERE email = 'somchai@physiocare.local');
  v_dx   int  := (SELECT id FROM diagnoses WHERE icd10_code = 'M54.5');
  v_appt uuid; v_pre uuid; v_post uuid;
  r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
      (21, 8, 6, 20::numeric, 30::numeric, 110::numeric, 'unchanged'),
      (14, 6, 4, 30, 40, 125, 'improved'),
      ( 7, 5, 3, 40, 50, 140, 'improved')
    ) v(days_ago, pre_pain, post_pain, lum_pre, lum_post, sh_flex, resp)
  LOOP
    INSERT INTO appointments (patient_id, therapist_id, diagnosis_id, start_at, end_at, status, visit_type, created_by)
    VALUES (v_pat, v_pt, v_dx,
            ((CURRENT_DATE - r.days_ago) + time '09:00') AT TIME ZONE 'Asia/Bangkok',
            ((CURRENT_DATE - r.days_ago) + time '09:45') AT TIME ZONE 'Asia/Bangkok',
            'completed', CASE WHEN r.days_ago = 21 THEN 'initial' ELSE 'follow_up' END, v_user)
    RETURNING id INTO v_appt;

    INSERT INTO clinical_assessments (appointment_id, patient_id, therapist_id, phase, pain_score, pain_location,
           subjective, precautions_reviewed, created_by, signed_by, signed_at)
    VALUES (v_appt, v_pat, v_pt, 'pre', r.pre_pain, 'หลังส่วนล่าง ร้าวลงขาขวา',
            'ปวดมากเวลานั่งนาน', true, v_user, NULL, NULL) RETURNING id INTO v_pre;
    INSERT INTO rom_measurements (assessment_id, joint, movement, side, mode, degrees, normal_degrees, pain_on_movement) VALUES
      (v_pre, 'lumbar', 'flexion', 'na', 'active', r.lum_pre, 60, true),
      (v_pre, 'shoulder', 'flexion', 'right', 'active', r.sh_flex, 180, true);
    UPDATE clinical_assessments SET signed_by = v_user, signed_at = now() WHERE id = v_pre;

    INSERT INTO clinical_assessments (appointment_id, patient_id, therapist_id, phase, pain_score, treatment_response,
           assessment, plan, home_program, next_visit_plan, functional_scores, created_by)
    VALUES (v_appt, v_pat, v_pt, 'post', r.post_pain, r.resp,
            'ปวดลดลงหลังการรักษา', 'IFC + Traction + Core stabilization',
            'McKenzie extension 10 ครั้ง x 3 รอบ/วัน', 'เพิ่ม traction force 10%',
            json_build_object('ODI', 50 - (21 - r.days_ago)), v_user) RETURNING id INTO v_post;
    INSERT INTO rom_measurements (assessment_id, joint, movement, side, mode, degrees, normal_degrees) VALUES
      (v_post, 'lumbar', 'flexion', 'na', 'active', r.lum_post, 60);
    INSERT INTO treatment_records (assessment_id, equipment_id, intervention, body_part, parameters, duration_min)
    SELECT v_post, e.id, 'Interferential current', 'lumbar', '{"beat_freq_hz":100,"intensity":"tolerance"}', 20
      FROM equipment e WHERE e.asset_code = 'EQ-IFC-001';
    UPDATE clinical_assessments SET signed_by = v_user, signed_at = now() WHERE id = v_post;
  END LOOP;
END $$;
