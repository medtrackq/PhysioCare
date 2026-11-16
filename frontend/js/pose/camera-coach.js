/**
 * หน้าจอนับท่าด้วยกล้อง (ใช้ในหน้าโปรแกรมที่บ้านของผู้ป่วย)
 *
 * ภาพจากกล้องประมวลผลในเบราว์เซอร์ด้วย MediaPipe Pose Landmarker เท่านั้น — ไม่ส่งภาพหรือจุดข้อต่อออกจากเครื่อง
 * ผลที่ส่งกลับมีแค่จำนวนครั้งที่นับได้ (ผู้ป่วยกดบันทึกเองตามปกติ)
 *
 *   openCoach({ name, camera, sets, reps, holdSec, onFinish(counted, completed) })
 */
import { JOINTS, RepCounter, SideTracker } from './counter.js';

const MP_VERSION = '0.10.14';
const MP_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}`;
const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';
const JOINT_TH = { knee: 'เข่า', hip: 'สะโพก', hip_leg: 'สะโพกและขา', shoulder: 'ไหล่และแขน', elbow: 'ศอก' };
// เส้นโครงร่างที่วาด (MediaPipe Pose)
const BONES = [[11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24], [23, 24], [23, 25], [25, 27], [24, 26], [26, 28]];
const JOINT_PTS = { knee: [[23, 25, 27], [24, 26, 28]], hip: [[11, 23, 25], [12, 24, 26]], hip_leg: [[11, 23, 27], [12, 24, 28]], shoulder: [[23, 11, 13], [24, 12, 14]], elbow: [[11, 13, 15], [12, 14, 16]] };

let landmarkerPromise;
async function getLandmarker() {
  landmarkerPromise ||= (async () => {
    const { PoseLandmarker, FilesetResolver } = await import(/* webpackIgnore: true */ `${MP_BASE}/vision_bundle.mjs`);
    const vision = await FilesetResolver.forVisionTasks(`${MP_BASE}/wasm`);
    const opts = (delegate) => ({
      baseOptions: { modelAssetPath: MODEL_URL, delegate }, runningMode: 'VIDEO', numPoses: 1,
      minPoseDetectionConfidence: 0.5, minPosePresenceConfidence: 0.5, minTrackingConfidence: 0.5,
    });
    try { return await PoseLandmarker.createFromOptions(vision, opts('GPU')); } catch { return PoseLandmarker.createFromOptions(vision, opts('CPU')); }
  })();
  landmarkerPromise.catch(() => { landmarkerPromise = null; });
  return landmarkerPromise;
}

const STYLE = `
.cc{position:fixed;inset:0;z-index:50;background:#0b1620;color:#fff;display:flex;flex-direction:column;font-family:inherit}
.cc-top{display:flex;align-items:center;gap:10px;padding:12px 14px;background:rgba(0,0,0,.35)}
.cc-top b{flex:1;font-size:1.05rem;line-height:1.3}
.cc-x{min-width:44px;min-height:44px;border-radius:12px;border:0;background:rgba(255,255,255,.15);color:#fff;font-size:1.3rem;cursor:pointer}
.cc-stage{position:relative;flex:1;overflow:hidden;display:grid;place-items:center}
.cc-stage video,.cc-stage canvas{position:absolute;inset:0;width:100%;height:100%;object-fit:contain}
.cc-stage.mirror video,.cc-stage.mirror canvas{transform:scaleX(-1)}
.cc-count{position:absolute;top:12px;left:12px;background:rgba(0,0,0,.55);border-radius:16px;padding:10px 16px;text-align:center;min-width:120px}
.cc-count .n{font-size:3.2rem;font-weight:800;line-height:1}
.cc-count .of{font-size:.95rem;opacity:.85}
.cc-hold{position:absolute;top:12px;right:12px;background:#d97706;border-radius:16px;padding:10px 14px;font-weight:700;font-size:1.3rem}
.cc-msg{position:absolute;left:12px;right:12px;bottom:12px;background:rgba(0,0,0,.6);border-radius:14px;padding:10px 14px;font-size:1.05rem;line-height:1.45;text-align:center}
.cc-bar{height:10px;background:rgba(255,255,255,.15)}
.cc-bar i{display:block;height:100%;width:0;background:#22c55e;transition:width .1s}
.cc-bottom{display:grid;grid-template-columns:1fr 1fr 1.4fr;gap:8px;padding:10px 12px calc(10px + env(safe-area-inset-bottom))}
.cc-bottom button{min-height:52px;border-radius:12px;border:0;font:inherit;font-weight:700;cursor:pointer;background:rgba(255,255,255,.15);color:#fff}
.cc-bottom .done{background:#15803d}
.cc-intro{max-width:460px;margin:auto;padding:22px;line-height:1.6}
.cc-intro h2{margin:0 0 8px;font-size:1.3rem}
.cc-intro ul{padding-left:20px;margin:8px 0 14px}
.cc-intro .priv{background:rgba(255,255,255,.1);border-radius:12px;padding:10px 12px;font-size:.95rem}
.cc-intro button{width:100%;min-height:54px;border-radius:12px;border:0;font:inherit;font-weight:700;font-size:1.1rem;background:#16a34a;color:#fff;margin-top:14px;cursor:pointer}
.cc-intro .ghost{background:rgba(255,255,255,.15)}
`;

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function openCoach({ name, camera, sets = 1, reps, holdSec = 0, onFinish }) {
  if (!document.getElementById('cc-style')) {
    const st = document.createElement('style');
    st.id = 'cc-style';
    st.textContent = STYLE;
    document.head.append(st);
  }
  const perSet = reps || 1;
  const total = perSet * Math.max(1, sets);
  const root = document.createElement('div');
  root.className = 'cc';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', `นับท่าด้วยกล้อง: ${name}`);
  document.body.append(root);
  document.body.style.overflow = 'hidden';

  let stream = null;
  let raf = 0;
  let facing = camera.view === 'front' ? 'user' : 'environment';
  let counter = new RepCounter({ rest: camera.rest, target: camera.target, holdSec });
  let speak = 'speechSynthesis' in window;
  let closed = false;
  let lastMsgAt = 0;

  function close(completed) {
    if (closed) return;
    closed = true;
    cancelAnimationFrame(raf);
    stream?.getTracks().forEach((t) => t.stop());
    try { window.speechSynthesis?.cancel(); } catch { /* ไม่มีเสียง */ }
    root.remove();
    document.body.style.overflow = '';
    onFinish?.(counter.count, completed);
  }
  const say = (text) => {
    if (!speak) return;
    try {
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'th-TH';
      u.rate = 1.05;
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(u);
    } catch { /* บางเครื่องไม่มีเสียงภาษาไทย */ }
  };

  // ---------------------------------------------------------------- หน้าแนะนำก่อนเปิดกล้อง
  root.innerHTML = `<div class="cc-top"><b>${esc(name)}</b><button type="button" class="cc-x" data-x aria-label="ปิด">✕</button></div>
    <div class="cc-intro">
      <h2>นับด้วยกล้อง</h2>
      <ul>
        <li>${camera.view === 'front' ? 'หันหน้าเข้ากล้อง' : '<b>หันด้านข้าง</b>เข้ากล้อง'} วางโทรศัพท์ให้นิ่ง ห่างประมาณ 2–3 เมตร ให้เห็น<b>ทั้งตัว</b></li>
        <li>ระบบดูมุม<b>${esc(JOINT_TH[camera.joint])}</b> และนับให้ทุกครั้งที่ทำครบช่วง${holdSec ? ` (ค้าง ${holdSec} วินาที)` : ''}</li>
        <li>เป้าหมาย ${sets} เซ็ต × ${perSet} ครั้ง${speak ? ' · ระบบนับออกเสียงให้' : ''}</li>
      </ul>
      <div class="priv">🔒 ภาพจากกล้อง<b>ประมวลผลในเครื่องนี้เท่านั้น</b> ไม่ถูกส่งไปที่ใดและไม่ถูกบันทึก — คลินิกได้รับเฉพาะจำนวนครั้งเมื่อคุณกดบันทึก</div>
      <div class="priv" style="margin-top:8px">⚠ การนับเป็นตัวช่วยเท่านั้น ถ้าปวดหรือมีอาการผิดปกติให้หยุดทันที</div>
      <button type="button" data-start>เปิดกล้องและเริ่ม</button>
      <button type="button" class="ghost" data-x>ไม่ใช้กล้อง</button>
    </div>`;
  root.addEventListener('click', (e) => {
    if (e.target.closest('[data-x]')) close(false);
    if (e.target.closest('[data-start]')) start();
  });

  // ---------------------------------------------------------------- เริ่มกล้อง
  async function start() {
    root.innerHTML = `<div class="cc-top"><b>${esc(name)}</b><button type="button" class="cc-x" data-x aria-label="ปิด">✕</button></div>
      <div class="cc-bar"><i></i></div>
      <div class="cc-stage"><video playsinline muted></video><canvas></canvas>
        <div class="cc-count" aria-live="polite"><div class="n">0</div><div class="of">จาก ${perSet} ครั้ง · เซ็ต 1/${sets}</div></div>
        <div class="cc-hold" hidden></div>
        <div class="cc-msg" aria-live="polite">กำลังเปิดกล้อง…</div></div>
      <div class="cc-bottom">
        <button type="button" data-flip>🔄 สลับกล้อง</button>
        <button type="button" data-sound aria-pressed="${speak}">${speak ? '🔊 เสียง' : '🔇 เสียง'}</button>
        <button type="button" class="done" data-finish>เสร็จแล้ว</button>
      </div>`;
    const stage = root.querySelector('.cc-stage');
    const video = root.querySelector('video');
    const canvas = root.querySelector('canvas');
    const ctx = canvas.getContext('2d');
    const nEl = root.querySelector('.n');
    const ofEl = root.querySelector('.of');
    const msgEl = root.querySelector('.cc-msg');
    const holdEl = root.querySelector('.cc-hold');
    const bar = root.querySelector('.cc-bar i');
    const msg = (t, force = false) => {
      const now = performance.now();
      if (!force && now - lastMsgAt < 700) return;
      lastMsgAt = now;
      if (msgEl.textContent !== t) msgEl.textContent = t;
    };

    root.querySelector('[data-finish]').addEventListener('click', () => close(counter.count >= total));
    root.querySelector('[data-sound]').addEventListener('click', (e) => {
      speak = !speak && 'speechSynthesis' in window;
      e.currentTarget.textContent = speak ? '🔊 เสียง' : '🔇 เสียง';
      e.currentTarget.setAttribute('aria-pressed', String(speak));
    });
    root.querySelector('[data-flip]').addEventListener('click', async () => {
      facing = facing === 'user' ? 'environment' : 'user';
      await openCamera();
    });

    async function openCamera() {
      stream?.getTracks().forEach((t) => t.stop());
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: facing, width: { ideal: 960 }, height: { ideal: 720 } }, audio: false });
      } catch (err) {
        msg(err?.name === 'NotAllowedError' ? 'ไม่ได้รับอนุญาตให้ใช้กล้อง — เปิดสิทธิ์กล้องในการตั้งค่าเบราว์เซอร์ แล้วลองใหม่' : 'เปิดกล้องไม่ได้ในเครื่องนี้', true);
        return false;
      }
      video.srcObject = stream;
      await video.play().catch(() => {});
      const settings = stream.getVideoTracks()[0]?.getSettings?.() || {};
      stage.classList.toggle('mirror', (settings.facingMode || facing) === 'user');
      return true;
    }

    if (!navigator.mediaDevices?.getUserMedia) { msg('เบราว์เซอร์นี้ไม่รองรับกล้อง — ลองเปิดลิงก์ด้วย Chrome หรือ Safari', true); return; }
    if (!(await openCamera())) return;
    msg('กำลังโหลดตัวตรวจจับท่าทาง… (ครั้งแรกใช้อินเทอร์เน็ตประมาณ 15 MB)', true);
    let landmarker;
    try { landmarker = await getLandmarker(); } catch {
      msg('โหลดตัวตรวจจับท่าทางไม่สำเร็จ — ตรวจอินเทอร์เน็ตแล้วลองใหม่ หรือทำท่าแล้วกดบันทึกตามปกติ', true);
      return;
    }
    if (closed) return;
    msg(camera.view === 'front' ? 'หันหน้าเข้ากล้อง ให้เห็นทั้งตัว' : 'หันด้านข้างเข้ากล้อง ให้เห็นทั้งตัว', true);

    let lastTs = -1;
    const tracker = new SideTracker(camera.joint);
    let trackedSide = null;
    let finished = false;
    let lastSeen = performance.now();
    const loop = () => {
      if (closed) return;
      raf = requestAnimationFrame(loop);
      if (video.readyState < 2 || !video.videoWidth) return;
      const ts = performance.now();
      if (ts - lastTs < 45) return; // ~20 ครั้ง/วินาที พอสำหรับการนับและประหยัดแบตเตอรี่
      lastTs = ts;
      if (canvas.width !== video.videoWidth) { canvas.width = video.videoWidth; canvas.height = video.videoHeight; }
      let res;
      try { res = landmarker.detectForVideo(video, ts); } catch { return; }
      const lm = res?.landmarks?.[0];
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (!lm) {
        if (ts - lastSeen > 1500) msg('ยังไม่เห็นตัว — ถอยห่างจากกล้องให้เห็นทั้งตัว');
        counter.update(null, ts);
        return;
      }
      lastSeen = ts;
      const m = tracker.update(lm, ts, { aspect: video.videoWidth / video.videoHeight });
      if (m && trackedSide && m.side !== trackedSide) counter.resync();
      if (m) trackedSide = m.side;
      draw(ctx, lm, canvas, m);
      if (finished) return;
      if (!m) { msg(`มองไม่ชัดที่${JOINT_TH[camera.joint]} — ปรับมุมกล้องให้เห็นทั้งตัวจากด้านข้าง`); return; }
      const s = counter.update(m.angle, ts);
      bar.style.width = `${Math.round(s.progress * 100)}%`;
      const done = Math.min(counter.count, total);
      const setNo = done >= total ? sets : Math.floor(done / perSet) + 1;
      nEl.textContent = String(done >= total ? perSet : done % perSet);
      ofEl.textContent = `จาก ${perSet} ครั้ง · เซ็ต ${setNo}/${sets}`;
      if (holdSec && s.phase === 'active' && !s.held) { holdEl.hidden = false; holdEl.textContent = `ค้างไว้ ${Math.max(0, holdSec - s.holding).toFixed(0)}`; } else holdEl.hidden = true;
      if (s.event === 'rep') {
        if (counter.count >= total) {
          finished = true;
          say('ครบแล้ว เก่งมาก');
          msg('✓ ครบตามเป้าหมายแล้ว กด "เสร็จแล้ว" เพื่อบันทึก', true);
          setTimeout(() => close(true), 1800);
          return;
        }
        if (counter.count % perSet === 0) { say(`ครบเซ็ตที่ ${counter.count / perSet} พักสักครู่`); msg(`ครบเซ็ตที่ ${counter.count / perSet} — พักสักครู่แล้วทำเซ็ตต่อไป`, true); } else { say(String(counter.count % perSet)); msg('ดีมาก ทำต่อ', true); }
      } else if (s.event === 'short_hold') {
        say('ค้างให้นานขึ้น'); msg(`ค้างไว้ให้ครบ ${holdSec} วินาที ครั้งนี้ยังไม่นับ`, true);
      } else if (s.phase === 'waiting') {
        msg(camera.target > camera.rest ? 'เริ่มจากท่าตั้งต้นก่อน (งอ)' : 'เริ่มจากท่าตั้งต้นก่อน (เหยียด)');
      } else if (s.phase === 'rest' && counter.count === 0) {
        msg('พร้อมแล้ว เริ่มทำได้เลย');
      }
    };
    raf = requestAnimationFrame(loop);
  }

  function draw(ctx, lm, canvas, m) {
    const W = canvas.width; const H = canvas.height;
    ctx.lineWidth = Math.max(3, W / 200);
    ctx.strokeStyle = 'rgba(255,255,255,.75)';
    for (const [a, b] of BONES) {
      if ((lm[a].visibility ?? 1) < 0.4 || (lm[b].visibility ?? 1) < 0.4) continue;
      ctx.beginPath(); ctx.moveTo(lm[a].x * W, lm[a].y * H); ctx.lineTo(lm[b].x * W, lm[b].y * H); ctx.stroke();
    }
    if (!m) return;
    const pts = JOINT_PTS[camera.joint][m.side === 'left' ? 0 : 1].map((i) => lm[i]);
    ctx.strokeStyle = '#22c55e';
    ctx.lineWidth = Math.max(6, W / 110);
    ctx.beginPath(); ctx.moveTo(pts[0].x * W, pts[0].y * H); ctx.lineTo(pts[1].x * W, pts[1].y * H); ctx.lineTo(pts[2].x * W, pts[2].y * H); ctx.stroke();
    ctx.fillStyle = '#22c55e';
    ctx.beginPath(); ctx.arc(pts[1].x * W, pts[1].y * H, Math.max(8, W / 70), 0, Math.PI * 2); ctx.fill();
  }

  return { close: () => close(false) };
}

export { JOINTS };
