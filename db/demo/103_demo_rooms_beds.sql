-- =====================================================================
-- PhysioCare — DEMO rooms & beds (ห้ามใช้ใน production)
-- ห้อง/เตียงตัวอย่าง ผูกอุปกรณ์ที่ติดตั้งประจำห้อง และจัดเตียงให้นัดตัวอย่างที่มีอยู่
-- =====================================================================

INSERT INTO rooms (code, name, room_type, floor, capacity) VALUES
 ('R1',  'ห้องรักษา 1',          'treatment', '1', 3),
 ('R2',  'ห้องรักษา 2 (ความร้อนลึก)', 'treatment', '1', 3),
 ('R3',  'ห้องรักษา 3 (ฟื้นฟูเข่า)', 'treatment', '1', 2),
 ('R4',  'ห้องดึงคอ/หลัง',        'treatment', '1', 2),
 ('R5',  'ห้องรักษาส่วนตัว',       'private',   '2', 1),
 ('PED', 'ห้องกายภาพเด็ก',        'pediatric', '2', 2),
 ('GYM', 'ห้องออกกำลังกาย/ฝึกเดิน', 'gym',       '1', 6)
ON CONFLICT (code) DO NOTHING;

INSERT INTO beds (room_id, code, name, bed_type)
SELECT r.id, x.code, x.name, x.type FROM (VALUES
  ('R1','R1-B1','เตียง 1','hi_lo'),('R1','R1-B2','เตียง 2','hi_lo'),('R1','R1-B3','เตียง 3','standard'),
  ('R2','R2-B1','เตียง 1','standard'),('R2','R2-B2','เตียง 2','standard'),('R2','R2-B3','เตียง 3','standard'),
  ('R3','R3-B1','เตียง 1','hi_lo'),('R3','R3-B2','เตียง 2','standard'),
  ('R4','R4-T1','โต๊ะดึง 1','treatment_table'),('R4','R4-T2','โต๊ะดึง 2','treatment_table'),
  ('R5','R5-B1','เตียงส่วนตัว','hi_lo'),
  ('PED','PED-M1','เบาะเด็ก 1','mat'),('PED','PED-M2','เบาะเด็ก 2','pediatric')
) x(room, code, name, type) JOIN rooms r ON r.code = x.room
ON CONFLICT (code) DO NOTHING;

UPDATE beds SET status = 'maintenance', notes = 'มอเตอร์ปรับระดับเสีย รออะไหล่' WHERE code = 'R1-B3';

-- อุปกรณ์ติดตั้งประจำห้อง (ที่เหลือเป็นแบบเคลื่อนย้ายได้)
UPDATE equipment e SET room_id = r.id
  FROM (VALUES ('EQ-SWD-001','R2'),('EQ-TRC-001','R4'),('EQ-TRC-002','R4'),('EQ-ESWT-001','R5'),
               ('EQ-CPM-001','R3'),('EQ-TILT-001','GYM'),('EQ-PB-001','GYM'),('EQ-TM-001','GYM')) x(asset, room)
  JOIN rooms r ON r.code = x.room
 WHERE e.asset_code = x.asset;

-- จัดห้อง/เตียงให้นัดตัวอย่างที่มีอยู่ (ข้ามรายการที่จัดไม่ได้)
DO $$
DECLARE
  a record;
  v_fixed uuid;
  v_gym boolean;
  v_room uuid;
  v_bed uuid;
  v_turn interval := make_interval(mins => COALESCE((SELECT value::text::int FROM system_settings WHERE key = 'scheduling.bed_turnover_minutes'), 5));
BEGIN
  FOR a IN SELECT * FROM appointments WHERE room_id IS NULL ORDER BY start_at LOOP
    SELECT e.room_id INTO v_fixed FROM appointment_equipment ae JOIN equipment e ON e.id = ae.equipment_id
     WHERE ae.appointment_id = a.id AND e.room_id IS NOT NULL LIMIT 1;
    SELECT bool_and(c.space_type = 'gym') INTO v_gym FROM appointment_equipment ae
      JOIN equipment e ON e.id = ae.equipment_id JOIN equipment_categories c ON c.id = e.category_id
     WHERE ae.appointment_id = a.id;
    v_bed := NULL; v_room := NULL;
    IF COALESCE(v_gym, false) THEN
      v_room := COALESCE(v_fixed, (SELECT id FROM rooms WHERE code = 'GYM'));
      UPDATE appointments SET room_id = v_room WHERE id = a.id;
      CONTINUE;
    END IF;
    SELECT b.id, b.room_id INTO v_bed, v_room
      FROM beds b JOIN rooms r ON r.id = b.room_id
     WHERE b.status = 'available' AND b.is_active AND r.room_type <> 'gym'
       AND (v_fixed IS NULL OR b.room_id = v_fixed)
       AND NOT EXISTS (SELECT 1 FROM appointments x WHERE x.bed_id = b.id AND x.status NOT IN ('cancelled','no_show')
                         AND x.bed_period && tstzrange(a.start_at, a.end_at + v_turn, '[)'))
     ORDER BY (CASE WHEN (SELECT p.date_of_birth > CURRENT_DATE - interval '15 years' FROM patients p WHERE p.id = a.patient_id)
                         = (r.room_type = 'pediatric') THEN 0 ELSE 1 END), random()
     LIMIT 1;
    IF v_bed IS NOT NULL THEN
      BEGIN
        UPDATE appointments SET room_id = v_room, bed_id = v_bed, bed_until = a.end_at + v_turn WHERE id = a.id;
      EXCEPTION WHEN exclusion_violation THEN NULL;
      END;
    END IF;
  END LOOP;
END $$;
