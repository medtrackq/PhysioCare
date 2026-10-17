-- =====================================================================
-- PhysioCare — Floor plan (ตำแหน่งบนผังพื้นสำหรับมุมมอง 3 มิติ)
-- หน่วยเป็นเมตร: plan_x/plan_z = มุมซ้ายบนของห้อง, plan_w/plan_d = กว้าง/ลึก
-- เตียง/อุปกรณ์: ตำแหน่งสัมพัทธ์กับมุมซ้ายบนของห้อง (NULL = ให้ระบบจัดวางอัตโนมัติ)
-- =====================================================================
ALTER TABLE rooms ADD COLUMN plan_x numeric(6,2);
ALTER TABLE rooms ADD COLUMN plan_z numeric(6,2);
ALTER TABLE rooms ADD COLUMN plan_w numeric(6,2) CHECK (plan_w IS NULL OR plan_w > 0);
ALTER TABLE rooms ADD COLUMN plan_d numeric(6,2) CHECK (plan_d IS NULL OR plan_d > 0);

ALTER TABLE beds ADD COLUMN plan_x numeric(6,2);
ALTER TABLE beds ADD COLUMN plan_z numeric(6,2);
ALTER TABLE beds ADD COLUMN plan_rot smallint NOT NULL DEFAULT 0 CHECK (plan_rot BETWEEN -360 AND 360);

ALTER TABLE equipment ADD COLUMN plan_x numeric(6,2);
ALTER TABLE equipment ADD COLUMN plan_z numeric(6,2);
