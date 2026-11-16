-- =====================================================================
-- PhysioCare — โปรแกรมกายภาพที่บ้าน (Home Exercise Program)
--
--   exercises              คลังท่าออกกำลังกาย (ท่าพื้นฐานด้านล่างเป็นตัวอย่าง — นักกายภาพควรตรวจทานก่อนใช้)
--   home_programs          โปรแกรมของผู้ป่วยแต่ละช่วง (มีได้ 1 โปรแกรมที่ใช้งานต่อผู้ป่วย)
--   home_program_items     ท่าในโปรแกรม + จำนวนเซ็ต/ครั้ง/ค้าง/รอบต่อวัน/วันในสัปดาห์
--   home_access_links      ลิงก์สำหรับผู้ป่วย/ญาติ (เก็บเฉพาะ hash, มีวันหมดอายุ, ยกเลิกได้)
--   home_logs              บันทึกรายวันจากที่บ้าน (ทำท่าไหน, ปวด, ความยาก, อาการผิดปกติ)
--   home_alerts            แจ้งเตือนนักกายภาพ (ปวดเพิ่มมาก / อาการอันตราย)
-- =====================================================================

CREATE TABLE exercises (
  id               serial PRIMARY KEY,
  code             text NOT NULL UNIQUE,
  name_th          text NOT NULL,
  name_en          text,
  body_region      text NOT NULL CHECK (body_region IN ('neck','shoulder','back','hip','knee','ankle','balance','general')),
  instructions     text NOT NULL,
  cautions         text,
  default_sets     smallint NOT NULL DEFAULT 2 CHECK (default_sets BETWEEN 1 AND 10),
  default_reps     smallint CHECK (default_reps BETWEEN 1 AND 100),
  default_hold_sec smallint CHECK (default_hold_sec BETWEEN 1 AND 3600),
  default_per_day  smallint NOT NULL DEFAULT 1 CHECK (default_per_day BETWEEN 1 AND 6),
  video_url        text CHECK (video_url IS NULL OR video_url ~ '^https://'),
  is_active        boolean NOT NULL DEFAULT true,
  created_by       uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE home_programs (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id          uuid NOT NULL REFERENCES patients(id),
  therapist_id        uuid NOT NULL REFERENCES staff(id),
  appointment_id      uuid REFERENCES appointments(id),          -- นัดที่สั่งโปรแกรม
  status              text NOT NULL DEFAULT 'active' CHECK (status IN ('active','ended')),
  start_date          date NOT NULL,
  end_date            date NOT NULL,
  baseline_pain       smallint CHECK (baseline_pain BETWEEN 0 AND 10),  -- ใช้เทียบเพื่อแจ้งเตือนปวดเพิ่ม
  pain_alert_increase smallint NOT NULL DEFAULT 3 CHECK (pain_alert_increase BETWEEN 1 AND 10),
  notes               text,                                       -- คำแนะนำถึงผู้ป่วย
  consent_at          timestamptz NOT NULL,                       -- ผู้ป่วย/ผู้แทนยินยอมให้บันทึกข้อมูลจากที่บ้าน (PDPA)
  consent_note        text,
  created_by          uuid,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  ended_at            timestamptz,
  CONSTRAINT chk_home_dates CHECK (end_date >= start_date AND end_date <= start_date + 180)
);
CREATE UNIQUE INDEX ux_home_program_active ON home_programs (patient_id) WHERE status = 'active';

CREATE TABLE home_program_items (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  program_id   uuid NOT NULL REFERENCES home_programs(id) ON DELETE CASCADE,
  exercise_id  integer NOT NULL REFERENCES exercises(id),
  sets         smallint NOT NULL CHECK (sets BETWEEN 1 AND 10),
  reps         smallint CHECK (reps BETWEEN 1 AND 100),
  hold_sec     smallint CHECK (hold_sec BETWEEN 1 AND 3600),
  per_day      smallint NOT NULL DEFAULT 1 CHECK (per_day BETWEEN 1 AND 6),
  days_of_week smallint[] NOT NULL DEFAULT '{1,2,3,4,5,6,7}',   -- ISO: 1=จันทร์ … 7=อาทิตย์
  notes        text,
  sort_order   smallint NOT NULL DEFAULT 0,
  is_active    boolean NOT NULL DEFAULT true,                    -- เอาท่าออก = ปิด (ประวัติการบันทึกยังอยู่)
  CONSTRAINT chk_home_dow CHECK (cardinality(days_of_week) BETWEEN 1 AND 7 AND days_of_week <@ '{1,2,3,4,5,6,7}')
);
CREATE INDEX ix_home_items_program ON home_program_items (program_id);

CREATE TABLE home_access_links (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  program_id    uuid NOT NULL REFERENCES home_programs(id) ON DELETE CASCADE,
  token_hash    text NOT NULL UNIQUE,
  label         text NOT NULL DEFAULT 'ผู้ป่วย',                 -- ผู้ป่วย / ญาติ / ผู้ดูแล
  created_by    uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  revoked_at    timestamptz,
  last_used_at  timestamptz
);

CREATE TABLE home_logs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  program_id  uuid NOT NULL REFERENCES home_programs(id) ON DELETE CASCADE,
  log_date    date NOT NULL,
  pain        smallint CHECK (pain BETWEEN 0 AND 10),
  difficulty  text CHECK (difficulty IN ('easy','ok','hard')),
  symptoms    text[] NOT NULL DEFAULT '{}',
  note        text,
  link_id     uuid REFERENCES home_access_links(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (program_id, log_date)
);

CREATE TABLE home_log_items (
  log_id   uuid NOT NULL REFERENCES home_logs(id) ON DELETE CASCADE,
  item_id  uuid NOT NULL REFERENCES home_program_items(id) ON DELETE CASCADE,
  done     boolean NOT NULL,
  PRIMARY KEY (log_id, item_id)
);

CREATE TABLE home_alerts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  program_id       uuid NOT NULL REFERENCES home_programs(id) ON DELETE CASCADE,
  log_id           uuid REFERENCES home_logs(id) ON DELETE CASCADE,
  kind             text NOT NULL CHECK (kind IN ('red_flag','pain_increase','high_pain')),
  detail           jsonb NOT NULL DEFAULT '{}',
  created_at       timestamptz NOT NULL DEFAULT now(),
  acknowledged_by  uuid,
  acknowledged_at  timestamptz,
  ack_note         text
);
CREATE INDEX ix_home_alerts_open ON home_alerts (program_id) WHERE acknowledged_at IS NULL;

-- เบอร์โทรที่แสดงให้ผู้ป่วยเมื่อมีอาการผิดปกติ
INSERT INTO system_settings (key, value, description) VALUES
 ('clinic.contact_phone', '"02-000-0000"', 'เบอร์โทรคลินิกที่แสดงในหน้าโปรแกรมที่บ้านของผู้ป่วย'),
 ('home.link_days_after_end', '7', 'ลิงก์ของผู้ป่วยใช้ได้ต่อหลังวันสิ้นสุดโปรแกรมกี่วัน')
ON CONFLICT (key) DO NOTHING;

-- ---------- คลังท่าพื้นฐาน (ตัวอย่าง: นักกายภาพควรตรวจทานและปรับให้เหมาะกับคลินิก) ----------
INSERT INTO exercises (code, name_th, name_en, body_region, instructions, cautions, default_sets, default_reps, default_hold_sec, default_per_day) VALUES
 ('CHIN_TUCK', 'เก็บคาง', 'Chin tuck', 'neck',
  'นั่งหลังตรง มองตรง ค่อย ๆ เลื่อนคางไปด้านหลังเหมือนทำคางสองชั้น โดยไม่ก้มหน้า ค้างไว้ แล้วคลาย',
  'ไม่ควรรู้สึกปวดร้าวลงแขน ถ้ามีให้หยุด', 2, 10, 5, 2),
 ('NECK_ISO', 'เกร็งกล้ามเนื้อคอต้านมือ', 'Neck isometrics', 'neck',
  'ใช้ฝ่ามือดันหน้าผาก ด้านข้างศีรษะ และท้ายทอย ทีละด้าน ให้คอออกแรงต้านโดยศีรษะไม่ขยับ',
  'ออกแรงปานกลาง ไม่กลั้นหายใจ', 1, 5, 5, 1),
 ('SCAP_RETRACT', 'บีบสะบักเข้าหากัน', 'Scapular retraction', 'shoulder',
  'นั่งหรือยืนหลังตรง แขนข้างลำตัว บีบสะบักทั้งสองข้างเข้าหากันและลงล่าง ค้างไว้ แล้วคลาย',
  NULL, 2, 10, 5, 2),
 ('PENDULUM', 'แกว่งแขนแบบลูกตุ้ม', 'Pendulum (Codman)', 'shoulder',
  'ก้มตัวเล็กน้อย มือข้างดีเท้าโต๊ะ ปล่อยแขนข้างที่เจ็บห้อยลงตามน้ำหนัก แกว่งเป็นวงเล็ก ๆ ตามเข็มและทวนเข็มนาฬิกา',
  'ใช้การโยกลำตัวพาแขนแกว่ง ไม่เกร็งไหล่', 2, 10, NULL, 2),
 ('WALL_WALK', 'ไต่ผนังด้วยนิ้ว', 'Finger wall walk', 'shoulder',
  'ยืนหันหน้าเข้าผนัง ใช้นิ้วไต่ผนังขึ้นไปช้า ๆ จนรู้สึกตึงพอดี ค้างไว้ แล้วไต่กลับลงมา',
  'หยุดที่ระดับตึงพอดี ไม่ฝืนจนปวดมาก', 2, 10, 5, 2),
 ('ER_BAND', 'หมุนแขนออกด้านนอกด้วยยางยืด', 'Shoulder external rotation with band', 'shoulder',
  'ศอกงอ 90 องศาแนบข้างลำตัว มือจับยางยืด หมุนแขนท่อนล่างออกด้านนอกช้า ๆ แล้วกลับ',
  'ศอกแนบลำตัวตลอด', 3, 10, NULL, 1),
 ('PELVIC_TILT', 'กดหลังติดพื้น', 'Pelvic tilt', 'back',
  'นอนหงายชันเข่า เกร็งหน้าท้องเบา ๆ กดหลังส่วนล่างให้แนบพื้น ค้างไว้ แล้วคลาย',
  NULL, 2, 10, 5, 2),
 ('KNEE_CHEST', 'กอดเข่าเข้าหาอก', 'Knee to chest', 'back',
  'นอนหงาย ใช้มือดึงเข่าข้างหนึ่งเข้าหาอกจนรู้สึกตึงที่หลัง ค้างไว้ สลับข้าง',
  'ถ้ามีอาการชาหรือปวดร้าวลงขามากขึ้น ให้หยุด', 2, 5, 20, 2),
 ('CAT_CAMEL', 'แอ่นหลัง-โก่งหลัง', 'Cat-camel', 'back',
  'คุกเข่าวางมือ (ท่าคลาน) ค่อย ๆ โก่งหลังขึ้น แล้วแอ่นหลังลงช้า ๆ ในช่วงที่ไม่ปวด',
  'เคลื่อนไหวช้า ๆ ในช่วงที่ทำได้สบาย', 2, 10, NULL, 2),
 ('BRIDGE', 'ยกสะโพก', 'Bridge', 'back',
  'นอนหงายชันเข่า เกร็งหน้าท้องและก้น ยกสะโพกขึ้นจนลำตัวเป็นแนวตรง ค้างไว้ แล้ววางลงช้า ๆ',
  NULL, 3, 10, 3, 1),
 ('BIRD_DOG', 'เหยียดแขนขาสลับ', 'Bird dog', 'back',
  'ท่าคลาน เกร็งหน้าท้อง เหยียดแขนข้างหนึ่งไปด้านหน้าพร้อมขาข้างตรงข้ามไปด้านหลัง ค้างไว้ สลับข้าง',
  'หลังไม่แอ่นหรือบิด', 2, 8, 5, 1),
 ('PRONE_PRESS', 'นอนคว่ำดันตัวขึ้น', 'Prone press-up', 'back',
  'นอนคว่ำ วางมือระดับไหล่ ดันลำตัวช่วงบนขึ้นโดยให้สะโพกแนบพื้น แล้วลงช้า ๆ',
  'ใช้เฉพาะเมื่อนักกายภาพแนะนำ หยุดถ้าปวดร้าวลงขามากขึ้น', 1, 10, NULL, 3),
 ('QUAD_SET', 'เกร็งต้นขา', 'Quadriceps set', 'knee',
  'นั่งเหยียดขา มีผ้าม้วนรองใต้เข่า เกร็งต้นขากดเข่าลงบนผ้า ค้างไว้ แล้วคลาย',
  NULL, 3, 10, 5, 2),
 ('SLR', 'ยกขาเหยียดตรง', 'Straight leg raise', 'knee',
  'นอนหงาย ขาอีกข้างชันเข่า เกร็งต้นขาข้างที่ทำให้เข่าตรง ยกขาขึ้นสูงประมาณระดับเข่าอีกข้าง แล้ววางลงช้า ๆ',
  'ถ้าเข่างอระหว่างยก ให้ลดจำนวนครั้ง', 3, 10, 3, 1),
 ('HEEL_SLIDE', 'ไถส้นเท้างอเข่า', 'Heel slide', 'knee',
  'นอนหงาย ไถส้นเท้าเข้าหาก้นเพื่องอเข่าให้มากที่สุดที่ทำได้ ค้างไว้ แล้วเหยียดกลับ',
  NULL, 2, 10, 5, 2),
 ('SIT_STAND', 'ลุกนั่งจากเก้าอี้', 'Sit to stand', 'knee',
  'นั่งเก้าอี้ที่มั่นคง เท้าวางเต็มพื้น โน้มตัวไปด้านหน้าแล้วลุกขึ้นยืน จากนั้นนั่งลงช้า ๆ',
  'ใช้เก้าอี้ที่ไม่มีล้อ มีคนหรือราวช่วยพยุงถ้าทรงตัวไม่ดี', 2, 10, NULL, 1),
 ('CALF_RAISE', 'เขย่งปลายเท้า', 'Calf raise', 'ankle',
  'ยืนจับพนักเก้าอี้ เขย่งปลายเท้าขึ้นช้า ๆ ค้างไว้ แล้วลงช้า ๆ',
  'มีที่จับทุกครั้ง', 2, 15, 2, 1),
 ('ANKLE_PUMP', 'กระดกข้อเท้าขึ้นลง', 'Ankle pumps', 'ankle',
  'นั่งหรือนอน กระดกปลายเท้าขึ้นเข้าหาตัวให้สุด แล้วกดลงให้สุด ทำต่อเนื่อง',
  NULL, 2, 20, NULL, 3),
 ('ANKLE_ABC', 'เขียนตัวอักษรด้วยปลายเท้า', 'Ankle alphabet', 'ankle',
  'นั่ง ยกเท้าขึ้นเล็กน้อย ใช้ปลายเท้าเขียนตัวอักษรในอากาศให้ข้อเท้าเคลื่อนไหวทุกทิศทาง',
  NULL, 1, 1, NULL, 2),
 ('SINGLE_LEG', 'ยืนขาเดียว', 'Single leg stance', 'balance',
  'ยืนข้างโต๊ะหรือผนัง ยกขาข้างหนึ่งขึ้น ทรงตัวด้วยขาอีกข้าง ค้างไว้ สลับข้าง',
  'ต้องมีที่จับใกล้ตัวทุกครั้ง ผู้สูงอายุหรือเสี่ยงล้มควรมีคนอยู่ด้วย', 3, 3, 15, 1),
 ('TANDEM_WALK', 'เดินต่อเท้า', 'Tandem walk', 'balance',
  'เดินเป็นเส้นตรงโดยวางส้นเท้าชิดปลายเท้าอีกข้างทุกก้าว เดินข้างผนังหรือราว',
  'เดินใกล้ผนังหรือราวจับ มีคนอยู่ด้วยถ้าเสี่ยงล้ม', 2, 10, NULL, 1),
 ('WALK', 'เดินออกกำลังกาย', 'Walking program', 'general',
  'เดินด้วยความเร็วที่พูดคุยได้แต่เริ่มเหนื่อยเล็กน้อย ตามเวลาที่นักกายภาพกำหนด',
  'หยุดทันทีถ้าเจ็บหน้าอก หายใจไม่ทัน หรือเวียนศีรษะ', 1, NULL, 900, 1)
ON CONFLICT (code) DO NOTHING;
