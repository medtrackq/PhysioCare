-- ข้อมูลทดลอง: บัญชีหัวหน้านักกายภาพ + Super user และทีมผู้ดูแลผู้ป่วย (ต้องมี 010_care_team_access.sql)
-- รหัสผ่านเหมือนบัญชีทดลองอื่น (Passw0rd!) — ห้ามใช้ใน production

INSERT INTO users (email, password_hash, display_name, role_id, staff_id)
SELECT x.email, crypt('Passw0rd!', gen_salt('bf', 10)), x.name, r.id, x.sid::uuid
  FROM (VALUES
   ('head@physiocare.local',  'กภ.วีระพงษ์ ศรีสุข (หัวหน้า)', 'head_therapist', '11111111-0000-0000-0000-000000000004'),
   ('super@physiocare.local', 'Super user (support)',          'superuser',      NULL)
  ) x(email, name, role, sid)
  JOIN roles r ON r.code = x.role
ON CONFLICT (email) DO NOTHING;

-- ผู้ดูแลหลัก = นักกายภาพที่ผู้ป่วยมีนัดด้วยบ่อยที่สุด
INSERT INTO patient_care_team (patient_id, staff_id, is_primary)
SELECT DISTINCT ON (a.patient_id) a.patient_id, a.therapist_id, true
  FROM appointments a
 WHERE a.status <> 'cancelled'
   AND NOT EXISTS (SELECT 1 FROM patient_care_team ct WHERE ct.patient_id = a.patient_id AND ct.ended_at IS NULL)
 GROUP BY a.patient_id, a.therapist_id
 ORDER BY a.patient_id, count(*) DESC, max(a.start_at) DESC
ON CONFLICT DO NOTHING;
