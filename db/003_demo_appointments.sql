-- =====================================================================
-- PhysioCare — Demo appointments (optional)
-- สร้างผู้ป่วยตัวอย่างเพิ่ม 12 ราย และนัดหมายช่วง 7 วันก่อน ถึง 14 วันข้างหน้า
-- เพื่อให้ปฏิทินมีข้อมูลสำหรับสาธิต ห้ามรันบนฐานข้อมูลจริง
-- การจองทุกรายการผ่าน EXCLUDE constraint ตามปกติ (รายการที่ชนจะถูกข้าม)
-- =====================================================================

INSERT INTO patients (hn, title, first_name, last_name, date_of_birth, gender, phone)
SELECT format('HN66-%s', 200 + i), t, f, l, d::date, g, format('089-200-%s', lpad(i::text, 4, '0'))
  FROM (VALUES
    (1,'นาย','อนุชา','ทองดี','1965-02-11','male'),   (2,'นาง','สมศรี','แก้วใส','1952-07-01','female'),
    (3,'นางสาว','พิมพ์ชนก','ใจงาม','1994-03-23','female'), (4,'นาย','ธนพล','รุ่งเรือง','1988-12-05','male'),
    (5,'นาง','จันทร์เพ็ญ','ศรีสวัสดิ์','1949-10-17','female'), (6,'นาย','กิตติ','วัฒนา','1979-06-30','male'),
    (7,'ด.ญ.','ปภาวดี','สุขใจ','2016-05-12','female'),  (8,'นาย','วรวุฒิ','ชัยมงคล','2000-09-09','male'),
    (9,'นาง','ละเอียด','บุญมา','1958-01-28','female'),  (10,'นาย','สุรเชษฐ์','พรหมมา','1971-04-14','male'),
    (11,'นางสาว','กัญญา','เพชรดี','1990-08-08','female'), (12,'ด.ช.','ภูริ','นาคสวัสดิ์','2015-11-02','male')
  ) x(i, t, f, l, d, g)
ON CONFLICT (hn) DO NOTHING;

-- การวินิจฉัยของผู้ป่วยตัวอย่าง (วนตามรายการโรค)
INSERT INTO patient_diagnoses (patient_id, diagnosis_id, is_primary)
SELECT p.id, d.id, true
  FROM (SELECT id, row_number() OVER (ORDER BY hn) AS rn FROM patients WHERE hn LIKE 'HN66-2%') p
  JOIN (SELECT id, row_number() OVER (ORDER BY icd10_code) AS rn, count(*) OVER () AS n FROM diagnoses) d
    ON d.rn = ((p.rn - 1) % d.n) + 1
 WHERE NOT EXISTS (SELECT 1 FROM patient_diagnoses x WHERE x.patient_id = p.id);

DO $$
DECLARE
  v_creator uuid := (SELECT id FROM users WHERE email = 'front@physiocare.local');
  v_patients uuid[] := ARRAY(SELECT id FROM patients ORDER BY hn);
  v_np int := array_length(v_patients, 1);
  sh record;
  v_day int;
  v_slot timestamptz;
  v_idx int;
  v_ti int;
  v_pid uuid;
  v_dx int;
  v_appt uuid;
  v_eq uuid;
  v_status text;
  v_created int := 0;
BEGIN
  FOR sh IN
    SELECT s.staff_id, s.start_at, s.end_at,
           (s.start_at AT TIME ZONE 'Asia/Bangkok')::date - CURRENT_DATE AS day_offset,
           dense_rank() OVER (ORDER BY st.employee_code) AS ti
      FROM staff_shifts s JOIN staff st ON st.id = s.staff_id
     WHERE st.position = 'physiotherapist'
       AND s.start_at >= (CURRENT_DATE - 7)::timestamp AT TIME ZONE 'Asia/Bangkok'
       AND s.start_at <  (CURRENT_DATE + 15)::timestamp AT TIME ZONE 'Asia/Bangkok'
     ORDER BY s.start_at
  LOOP
    v_slot := sh.start_at;
    WHILE v_slot + interval '45 minutes' <= sh.end_at LOOP
      v_idx := extract(hour FROM v_slot AT TIME ZONE 'Asia/Bangkok')::int;
      -- เว้นบางช่องให้ดูสมจริง (~65% ของช่องมีนัด) และเว้นพักเที่ยง
      IF v_idx <> 12 AND (hashtext(sh.staff_id::text || v_slot::text) % 100 + 100) % 100 < 65 THEN
        v_pid := v_patients[((v_idx * 4 + sh.ti + sh.day_offset * 3) % v_np + v_np) % v_np + 1];
        SELECT diagnosis_id INTO v_dx FROM patient_diagnoses WHERE patient_id = v_pid ORDER BY is_primary DESC LIMIT 1;
        v_status := CASE
          WHEN v_slot + interval '45 minutes' < now() THEN
            CASE WHEN (hashtext(v_pid::text || v_slot::text) % 10 + 10) % 10 = 0 THEN 'no_show' ELSE 'completed' END
          ELSE CASE WHEN sh.day_offset <= 2 THEN 'confirmed' ELSE 'booked' END
        END;
        BEGIN
          INSERT INTO appointments (patient_id, therapist_id, diagnosis_id, start_at, end_at, status, created_by, booked_via)
          VALUES (v_pid, sh.staff_id, v_dx, v_slot, v_slot + interval '45 minutes', v_status, v_creator, 'recommendation')
          RETURNING id INTO v_appt;
          -- จองอุปกรณ์ที่แนะนำสำหรับโรคนี้ 1 เครื่อง (ถ้าว่างและไม่ขัดข้อห้าม)
          SELECT e.id INTO v_eq
            FROM diagnosis_equipment_map m
            JOIN equipment e ON e.category_id = m.equipment_category_id AND e.status IN ('available','in_use')
            JOIN equipment_categories c ON c.id = e.category_id
           WHERE m.diagnosis_id = v_dx
             AND NOT EXISTS (SELECT 1 FROM patient_precautions pp JOIN precaution_contraindications pc
                               ON pc.precaution_code = pp.precaution_code
                              WHERE pp.patient_id = v_pid AND pp.is_active AND pc.equipment_category_id = e.category_id)
             AND NOT EXISTS (SELECT 1 FROM appointment_equipment ae WHERE ae.equipment_id = e.id AND ae.is_active
                               AND ae.period && tstzrange(v_slot, v_slot + interval '45 minutes' + make_interval(mins => c.cleaning_buffer_minutes)))
           ORDER BY m.weight DESC LIMIT 1;
          IF v_eq IS NOT NULL THEN
            INSERT INTO appointment_equipment (appointment_id, equipment_id, start_at, end_at)
            SELECT v_appt, v_eq, v_slot, v_slot + interval '45 minutes' + make_interval(mins => c.cleaning_buffer_minutes)
              FROM equipment e JOIN equipment_categories c ON c.id = e.category_id WHERE e.id = v_eq;
          END IF;
          v_created := v_created + 1;
        EXCEPTION WHEN exclusion_violation THEN
          NULL; -- ชนกับนัดเดิม -> ข้าม
        END;
      END IF;
      v_slot := v_slot + interval '1 hour';
    END LOOP;
  END LOOP;
  RAISE NOTICE 'demo appointments created: %', v_created;
END $$;
