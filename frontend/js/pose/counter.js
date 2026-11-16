/**
 * นับท่าออกกำลังกายจากจุดข้อต่อ (pose landmarks) — ไม่มี DOM ใช้ได้ทั้งเบราว์เซอร์และ test
 *
 * ใช้จุดของ MediaPipe Pose (33 จุด, x/y เป็นสัดส่วนของภาพ, visibility 0–1)
 * นับ 1 ครั้งเมื่อมุมข้อต่อ: อยู่ฝั่งท่าพัก → ไปถึงมุมเป้าหมาย (ค้างตามเวลาที่กำหนด) → กลับมาฝั่งท่าพัก
 * มุมเป้าหมายมากกว่าท่าพัก = ท่าเหยียด (เช่น ลุกยืน), น้อยกว่า = ท่างอ (เช่น ไถส้นเท้างอเข่า)
 */

// จุดของ MediaPipe Pose: [ซ้าย, ขวา]
const LM = {
  shoulder: [11, 12], elbow: [13, 14], wrist: [15, 16], hip: [23, 24], knee: [25, 26], ankle: [27, 28],
};

// มุมที่วัด: [จุดปลาย A, จุดยอดมุม, จุดปลาย B]
export const JOINTS = {
  knee: { label: 'มุมเข่า', pts: ['hip', 'knee', 'ankle'] },
  hip: { label: 'มุมสะโพก (ลำตัว–ต้นขา)', pts: ['shoulder', 'hip', 'knee'] },
  hip_leg: { label: 'มุมสะโพก (ลำตัว–ขาเหยียด)', pts: ['shoulder', 'hip', 'ankle'] },
  shoulder: { label: 'มุมยกแขน (ลำตัว–แขน)', pts: ['hip', 'shoulder', 'elbow'] },
  elbow: { label: 'มุมศอก', pts: ['shoulder', 'elbow', 'wrist'] },
};

export const MIN_VISIBILITY = 0.5;

/** มุมที่จุด b (องศา 0–180) */
export function angleAt(a, b, c) {
  const v1x = a.x - b.x; const v1y = a.y - b.y;
  const v2x = c.x - b.x; const v2y = c.y - b.y;
  const n = Math.hypot(v1x, v1y) * Math.hypot(v2x, v2y);
  if (!n) return null;
  const cos = Math.max(-1, Math.min(1, (v1x * v2x + v1y * v2y) / n));
  return (Math.acos(cos) * 180) / Math.PI;
}

/**
 * วัดมุมข้อต่อจาก landmarks ทั้งตัว เลือกข้างที่กล้องเห็นชัดกว่า
 * @returns {{angle:number, side:'left'|'right', visibility:number}|null} null = เห็นไม่ชัดพอ
 */
export function measure(landmarks, joint, { minVisibility = MIN_VISIBILITY, aspect = 1, preferSide = null, switchMargin = 0.15 } = {}) {
  const def = JOINTS[joint];
  if (!def || !landmarks?.length) return null;
  const cand = [];
  for (const [k, side] of [[0, 'left'], [1, 'right']]) {
    const pts = def.pts.map((name) => landmarks[LM[name][k]]);
    if (pts.some((p) => !p)) continue;
    cand.push({ pts, side, visibility: Math.min(...pts.map((p) => p.visibility ?? 1)) });
  }
  cand.sort((a, b) => b.visibility - a.visibility);
  let best = cand[0];
  // ใช้ข้างเดิมต่อ (ขาซ้ายกับขวาอาจงอไม่เท่ากัน) เว้นแต่อีกข้างเห็นชัดกว่ามาก หรือข้างเดิมเห็นไม่ชัดแล้ว
  const kept = cand.find((c) => c.side === preferSide);
  if (kept && kept !== best && kept.visibility >= minVisibility && best.visibility - kept.visibility < switchMargin) best = kept;
  if (!best || best.visibility < minVisibility) return null;
  // x และ y เป็นสัดส่วนของกว้าง/สูงภาพ — ปรับให้เป็นหน่วยเดียวกันก่อนคิดมุม
  const [a, b, c] = best.pts.map((p) => ({ x: p.x * aspect, y: p.y }));
  const angle = angleAt(a, b, c);
  return angle == null ? null : { angle, side: best.side, visibility: best.visibility };
}

/**
 * เลือกข้างที่ใช้นับ: ข้างที่ "ขยับ" มากที่สุดในช่วง 3 วินาทีล่าสุด (ท่าข้างเดียว เช่น ไถส้นเท้า ยกขา)
 * ถ้าขยับพอ ๆ กันให้ใช้ข้างเดิมต่อ กันการสลับไปมาระหว่างขาซ้าย/ขวาที่งอไม่เท่ากัน
 *   tracker.update(landmarks, tMs, { aspect }) → { angle, side, visibility } | null
 */
export class SideTracker {
  constructor(joint, { windowMs = 3000, switchDeg = 15, minVisibility = MIN_VISIBILITY } = {}) {
    Object.assign(this, { joint, windowMs, switchDeg, minVisibility });
    this.side = null;
    this.hist = { left: [], right: [] };
  }

  range(side) {
    const h = this.hist[side];
    if (!h.length) return 0;
    let lo = Infinity; let hi = -Infinity;
    for (const x of h) { lo = Math.min(lo, x.a); hi = Math.max(hi, x.a); }
    return hi - lo;
  }

  update(landmarks, tMs, { aspect = 1 } = {}) {
    const seen = {};
    for (const side of ['left', 'right']) {
      const m = measure(landmarks, this.joint, { aspect, preferSide: side, switchMargin: Infinity, minVisibility: 0 });
      const h = this.hist[side];
      if (m && m.side === side && m.visibility >= this.minVisibility) { seen[side] = m; h.push({ t: tMs, a: m.angle }); }
      while (h.length && tMs - h[0].t > this.windowMs) h.shift();
    }
    const sides = Object.keys(seen);
    if (!sides.length) return null;
    if (!this.side || !seen[this.side]) {
      this.side = sides.sort((a, b) => this.range(b) - this.range(a) || seen[b].visibility - seen[a].visibility)[0];
    } else {
      const other = this.side === 'left' ? 'right' : 'left';
      if (seen[other] && this.range(other) > this.range(this.side) + this.switchDeg) this.side = other;
    }
    return seen[this.side];
  }
}

/**
 * ตัวนับครั้ง
 *   cfg: { rest, target, holdSec?, smoothMs? (ค่าคงที่เวลาของการกรองสั่น), hysteresis? (องศา) }
 *   การกรองสั่นคิดตามเวลา ไม่ใช่ตามจำนวนภาพ — มือถือรุ่นเก่าที่ประมวลผลได้ไม่กี่ภาพต่อวินาทีจึงนับได้เหมือนรุ่นใหม่
 *   update(angle, tMs) → { count, phase, progress (0–1 จากท่าพักถึงเป้าหมาย), holding (วินาทีที่ค้างแล้ว), event }
 *   event: 'rep' นับเพิ่ม · 'short_hold' ถึงเป้าหมายแต่ค้างไม่ครบ · null
 */
export class RepCounter {
  constructor({ rest, target, holdSec = 0, smoothMs = 120, hysteresis = 5 }) {
    if (Math.abs(rest - target) < 15) throw new Error('มุมท่าพักกับมุมเป้าหมายต้องต่างกันอย่างน้อย 15 องศา');
    this.rest = rest;
    this.target = target;
    this.dir = target > rest ? 1 : -1; // 1 = เหยียดไปถึงเป้าหมาย, -1 = งอไปถึงเป้าหมาย
    this.holdMs = Math.max(0, holdSec) * 1000;
    this.smoothMs = smoothMs;
    this.hyst = hysteresis;
    this.reset();
  }

  reset() {
    this.count = 0;
    this.phase = 'waiting'; // waiting = ยังไม่เห็นท่าพัก · rest · active (ถึงเป้าหมายแล้ว)
    this.smoothed = null;
    this.lastT = null;
    this.reachedAt = null;
    this.held = false;
    this.best = null; // มุมที่ไปได้ไกลที่สุด (ทิศเป้าหมาย)
  }

  /** เปลี่ยนข้างที่วัด: เริ่มสถานะใหม่ (เก็บจำนวนเดิมไว้) — กันมุมกระโดดแล้วนับเกิน */
  resync() {
    this.phase = 'waiting';
    this.smoothed = null;
    this.lastT = null;
    this.reachedAt = null;
    this.held = false;
  }

  // ระยะในทิศของเป้าหมาย: + = เลยไปทางเป้าหมาย
  #toward(angle, ref) { return (angle - ref) * this.dir; }

  update(angle, tMs) {
    if (angle == null || Number.isNaN(angle)) return this.#state(null);
    const dt = this.lastT == null ? Infinity : Math.max(0, tMs - this.lastT);
    this.lastT = tMs;
    const alpha = this.smoothMs > 0 ? 1 - Math.exp(-dt / this.smoothMs) : 1;
    this.smoothed = this.smoothed == null ? angle : this.smoothed + alpha * (angle - this.smoothed);
    const a = this.smoothed;
    if (this.best == null || this.#toward(a, this.best) > 0) this.best = a;
    let event = null;
    const atRest = this.#toward(a, this.rest) <= 0; // อยู่ฝั่งท่าพัก
    const atTarget = this.#toward(a, this.target) >= 0;
    const leftTarget = this.#toward(a, this.target) < -this.hyst; // ถอยออกจากเป้าหมายเกินระยะกันสั่น

    if (this.phase === 'waiting') {
      if (atRest) this.phase = 'rest';
    } else if (this.phase === 'rest') {
      if (atTarget) { this.phase = 'active'; this.reachedAt = tMs; this.held = this.holdMs === 0; }
    } else if (this.phase === 'active') {
      if (!this.held && this.reachedAt != null && tMs - this.reachedAt >= this.holdMs) this.held = true;
      if (leftTarget && !this.held) {
        // ถอยออกก่อนค้างครบ: นับไม่ได้ ต้องกลับไปตั้งต้นที่ท่าพัก
        this.phase = 'returning';
        event = 'short_hold';
      } else if (atRest) {
        this.count += 1;
        this.phase = 'rest';
        event = 'rep';
      } else if (leftTarget) {
        this.reachedAt = null; // ออกจากเป้าหมายแล้ว (ค้างครบ) กำลังกลับท่าพัก
      }
    } else if (this.phase === 'returning') {
      if (atRest) this.phase = 'rest';
    }
    return this.#state(event, tMs);
  }

  #state(event, tMs) {
    const a = this.smoothed;
    const progress = a == null ? 0 : Math.max(0, Math.min(1, this.#toward(a, this.rest) / Math.abs(this.target - this.rest)));
    const holding = this.phase === 'active' && this.reachedAt != null && tMs != null ? (tMs - this.reachedAt) / 1000 : 0;
    return { count: this.count, phase: this.phase, angle: a, progress, holding, held: this.held, event };
  }
}

/** ค่าที่แนะนำตามข้อต่อ (ใช้เติมในหน้าแก้ไขท่า) */
export const PRESETS = {
  knee_extend: { joint: 'knee', rest: 110, target: 155, view: 'side', label: 'ลุกยืน / เหยียดเข่า' },
  knee_flex: { joint: 'knee', rest: 160, target: 120, view: 'side', label: 'งอเข่า' },
  hip: { joint: 'hip', rest: 145, target: 165, view: 'side', label: 'ยกสะโพก (bridge)' },
  hip_leg: { joint: 'hip_leg', rest: 165, target: 145, view: 'side', label: 'ยกขาเหยียดตรง' },
  shoulder: { joint: 'shoulder', rest: 60, target: 120, view: 'side', label: 'ยกแขนไปด้านหน้า/ด้านข้าง' },
  elbow: { joint: 'elbow', rest: 160, target: 60, view: 'side', label: 'งอศอก' },
};
