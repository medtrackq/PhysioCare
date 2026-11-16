/**
 * ตัวนับท่าด้วยกล้อง (frontend/js/pose/counter.js) — ทดสอบด้วยลำดับมุม/จุดข้อต่อสังเคราะห์
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = () => import(pathToFileURL(path.join(__dirname, '..', '..', 'frontend', 'js', 'pose', 'counter.js')).href);

// สร้างลำดับมุมแบบเคลื่อนต่อเนื่อง (30 fps) ผ่านจุดที่กำหนด แต่ละช่วงยาว ms
function path30(points, msPerLeg = 600) {
  const out = [];
  let t = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const n = Math.round(msPerLeg / 33);
    for (let k = 0; k < n; k++) { out.push([points[i] + ((points[i + 1] - points[i]) * k) / n, t]); t += 33; }
  }
  out.push([points.at(-1), t]);
  return out;
}
const run = (c, seq) => seq.map(([a, t]) => c.update(a, t)).at(-1);

describe('pose rep counter', () => {
  test('angleAt gives the joint angle in degrees', async () => {
    const { angleAt } = await load();
    assert.equal(Math.round(angleAt({ x: 0, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 })), 90);
    assert.equal(Math.round(angleAt({ x: 0, y: 0 }, { x: 0, y: 1 }, { x: 0, y: 2 })), 180);
  });

  test('counts sit-to-stand reps (extension) and ignores partial attempts', async () => {
    const { RepCounter } = await load();
    const c = new RepCounter({ rest: 110, target: 155 });
    // นั่ง → ยืน → นั่ง ×3, ระหว่างนั้นมีครั้งที่ลุกไม่สุด (140°)
    const s = run(c, path30([95, 170, 95, 170, 95, 140, 95, 172, 95]));
    assert.equal(s.count, 3);
    assert.equal(s.phase, 'rest');
  });

  test('counts flexion exercises where the target angle is smaller than rest', async () => {
    const { RepCounter } = await load();
    const c = new RepCounter({ rest: 160, target: 120 });
    assert.equal(run(c, path30([175, 100, 175, 100, 175])).count, 2);
  });

  test('does not count until the patient has started from the rest position', async () => {
    const { RepCounter } = await load();
    const c = new RepCounter({ rest: 110, target: 155 });
    // เริ่มจากท่ายืน (อยู่ที่เป้าหมาย) → ยังไม่นับจนกว่าจะนั่งก่อน
    let s = run(c, path30([170, 150, 170]));
    assert.equal(s.count, 0);
    assert.equal(s.phase, 'waiting');
    s = run(c, path30([170, 95, 170, 95]).map(([a, t]) => [a, t + 5000]));
    assert.equal(s.count, 1);
  });

  test('requires the prescribed hold time at the target', async () => {
    const { RepCounter } = await load();
    const c = new RepCounter({ rest: 145, target: 165, holdSec: 3 });
    const events = [];
    let t = 0;
    const feed = (a, ms) => { for (let k = 0; k < ms / 33; k++) { events.push(c.update(a, t).event); t += 33; } };
    // ครั้งที่ 1 ค้าง 1 วินาที (ไม่ครบ) · ครั้งที่ 2 ค้าง 3.5 วินาที
    feed(130, 500); feed(175, 1000); feed(130, 800);
    feed(175, 3500); feed(130, 800);
    assert.equal(c.count, 1);
    assert.ok(events.includes('short_hold'));
  });

  test('jitter around the target does not produce extra reps', async () => {
    const { RepCounter } = await load();
    const c = new RepCounter({ rest: 110, target: 155 });
    const seq = path30([95, 160]);
    let t = seq.at(-1)[1];
    for (let k = 0; k < 60; k++) { t += 33; seq.push([157 + (k % 2 ? 4 : -4), t]); }
    seq.push(...path30([160, 95]).map(([a, tt]) => [a, tt + t + 33]));
    assert.equal(run(c, seq).count, 1);
  });

  test('measure() picks the more visible side and refuses low-visibility frames', async () => {
    const { measure } = await load();
    const lm = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, visibility: 0.1 }));
    // ขาขวา (24, 26, 28) เห็นชัด งอ 90°
    lm[24] = { x: 0.4, y: 0.4, visibility: 0.9 };
    lm[26] = { x: 0.6, y: 0.4, visibility: 0.9 };
    lm[28] = { x: 0.6, y: 0.7, visibility: 0.9 };
    const m = measure(lm, 'knee');
    assert.equal(m.side, 'right');
    assert.equal(Math.round(m.angle), 90);
    lm[28].visibility = 0.2;
    assert.equal(measure(lm, 'knee'), null);
  });

  test('counts the same on a slow phone (5 frames per second) as on a fast one', async () => {
    const { RepCounter } = await load();
    const c = new RepCounter({ rest: 110, target: 155 });
    // นั่ง (95°) → ยืน (170°) รอบละ 2.4 วินาที ×4 แต่ได้ภาพทุก 200 ms
    let t = 0;
    for (let i = 0; i <= 48; i++) { c.update(132.5 - 37.5 * Math.cos((2 * Math.PI * t) / 2400), t); t += 200; }
    assert.equal(c.count, 4);
  });

  test('measure() keeps tracking the same leg unless the other is clearly more visible', async () => {
    const { measure } = await load();
    const lm = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, visibility: 0.9 }));
    // ขาซ้ายงอ 90°, ขาขวาเหยียดตรง — ขวาเห็นชัดกว่าเล็กน้อย
    Object.assign(lm[23], { x: 0.4, y: 0.4, visibility: 0.85 }); Object.assign(lm[25], { x: 0.6, y: 0.4, visibility: 0.85 }); Object.assign(lm[27], { x: 0.6, y: 0.7, visibility: 0.85 });
    Object.assign(lm[24], { x: 0.4, y: 0.3, visibility: 0.9 }); Object.assign(lm[26], { x: 0.4, y: 0.5, visibility: 0.9 }); Object.assign(lm[28], { x: 0.4, y: 0.7, visibility: 0.9 });
    assert.equal(measure(lm, 'knee').side, 'right');
    assert.equal(measure(lm, 'knee', { preferSide: 'left' }).side, 'left');
    assert.equal(Math.round(measure(lm, 'knee', { preferSide: 'left' }).angle), 90);
    lm[27].visibility = 0.6; // ขาซ้ายเห็นไม่ชัดลงมาก → เปลี่ยนข้าง
    assert.equal(measure(lm, 'knee', { preferSide: 'left' }).side, 'right');
  });

  test('SideTracker follows the leg that is moving (one-sided exercises)', async () => {
    const { SideTracker, RepCounter } = await load();
    const tr = new SideTracker('knee');
    const c = new RepCounter({ rest: 100, target: 125 });
    // ขาซ้ายเหยียดนิ่ง (~170°) เห็นชัดกว่าเล็กน้อย, ขาขวางอ-เหยียด 80°↔135°
    const frame = (rightKnee) => {
      const lm = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, visibility: 0.9 }));
      Object.assign(lm[23], { x: 0.40, y: 0.30, visibility: 0.99 }); Object.assign(lm[25], { x: 0.41, y: 0.50, visibility: 0.99 }); Object.assign(lm[27], { x: 0.40, y: 0.70, visibility: 0.99 });
      const r = (rightKnee * Math.PI) / 180; // ต้นขาแนวนอน หน้าแข้งหมุนตามมุมเข่า
      Object.assign(lm[24], { x: 0.40, y: 0.50, visibility: 0.97 }); Object.assign(lm[26], { x: 0.60, y: 0.50, visibility: 0.97 });
      Object.assign(lm[28], { x: 0.60 - 0.2 * Math.cos(r), y: 0.50 + 0.2 * Math.sin(r), visibility: 0.97 });
      return lm;
    };
    let side = null;
    for (let t = 0; t <= 12000; t += 100) {
      const m = tr.update(frame(107.5 - 27.5 * Math.cos((2 * Math.PI * t) / 2400)), t);
      if (side && m.side !== side) c.resync();
      side = m.side;
      c.update(m.angle, t);
    }
    assert.equal(side, 'right');
    assert.ok(c.count >= 4, `counted ${c.count}`);
  });

  test('rejects configurations whose rest and target are too close', async () => {
    const { RepCounter } = await load();
    assert.throws(() => new RepCounter({ rest: 100, target: 110 }));
  });
});
