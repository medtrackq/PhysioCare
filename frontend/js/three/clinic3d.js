/**
 * Clinic 3D — จำลองคลินิกกายภาพบำบัดแบบ 3 มิติ
 *
 *   const view = createClinic3D(container, { THREE, onSelect, onRoomMove, theme });
 *   view.setLayout(board);                 // ห้อง เตียง อุปกรณ์ (GET /api/facilities/board)
 *   view.setDay(appointments, { turnoverMin }); // นัดของวัน (GET /api/appointments)
 *   view.setTime(ms);                      // ตำแหน่ง/ท่าทางของทุกคน ณ เวลานั้น (เรียกทุกเฟรมได้)
 *   view.stats(ms) / view.events(ms)       // ตัวเลขสรุปและเหตุการณ์ ณ เวลานั้น
 *
 * ไม่พึ่ง addon ของ three.js — ใช้ได้ทั้งในแอปและหน้า demo ไฟล์เดียว · หน่วยในฉากเป็นเมตร
 */
export const STATE_COLORS = {
  free: '#10b981', occupied: '#0ea5e9', turnover: '#8b5cf6', maintenance: '#f59e0b', out_of_service: '#94a3b8',
};
export const STATE_TH = { free: 'ว่าง', occupied: 'มีผู้ป่วย', turnover: 'เปลี่ยนผ้าปู', maintenance: 'ปิดซ่อม', out_of_service: 'งดใช้' };
const EQUIPMENT_LIGHT = { in_use: '#38bdf8', available: '#22c55e', broken: '#ef4444', maintenance: '#f59e0b' };
const ROOM_FLOOR = { treatment: '#eef2f5', private: '#efeaf6', gym: '#e4f1ea', pediatric: '#f8eedf', hydro: '#e3f1f4', consult: '#eef2f5' };
const DEFAULT_THEME = {
  bg: '#dfe6ed', ground: '#bfc9d3', corridor: '#d8cbb3', wall: '#eef1f4', wallTop: '#7b8a99', lobby: '#e3d6bf', storage: '#d5dde6', floorTint: null,
};
const GYM_EQUIPMENT = new Set(['PARALLEL', 'TREADMILL', 'CYCLE', 'TILT']);
const MIN = 60000;
// ช่วงเวลาของการเคลื่อนไหว (นาทีของเวลาจำลอง)
const ARRIVE_BEFORE = 9;   // มาถึงคลินิกก่อนนัด
const WALK_MIN = 1.5;      // เวลาเดินแต่ละช่วง
const LEAVE_AFTER = 3;     // ออกจากคลินิกหลังจบ

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, k) => a + (b - a) * k;
const ease = (k) => (k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2);
const hash = (s) => { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) | 0; return Math.abs(h); };
const firstName = (n) => String(n || '').split(' ')[0];

export function createClinic3D(container, { THREE, onSelect = () => {}, onRoomMove = null, editable = false, theme: initialTheme = {} } = {}) {
  let theme = { ...DEFAULT_THEME, ...initialTheme };

  // ================================================================ renderer & scene
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.92;
  container.appendChild(renderer.domElement);
  renderer.domElement.style.display = 'block';
  renderer.domElement.style.touchAction = 'none';

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(theme.bg);
  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 500);
  scene.add(new THREE.HemisphereLight('#ffffff', '#a9b4c2', 1.35));
  const sun = new THREE.DirectionalLight('#fff6ea', 1.6);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.0004;
  Object.assign(sun.shadow.camera, { left: -30, right: 30, top: 30, bottom: -30, near: 1, far: 120 });
  scene.add(sun, sun.target);

  const world = new THREE.Group();   // ฉากคงที่ (ห้อง เตียง เฟอร์นิเจอร์)
  const actors = new THREE.Group();  // คน + อุปกรณ์เคลื่อนย้ายได้
  scene.add(world, actors);

  // ================================================================ shared materials/geometries
  const disposables = [];
  const track = (o) => { disposables.push(o); return o; };
  const matCache = new Map();
  const mat = (color, opts = {}) => {
    const key = `${color}|${JSON.stringify(opts)}`;
    if (!matCache.has(key)) matCache.set(key, track(new THREE.MeshStandardMaterial({ color, roughness: 0.8, metalness: 0.02, ...opts })));
    return matCache.get(key);
  };
  const geoCache = new Map();
  const geo = (key, make) => { if (!geoCache.has(key)) geoCache.set(key, track(make())); return geoCache.get(key); };
  const box = (w, h, d, material, { cast = true, receive = true } = {}) => {
    const m = new THREE.Mesh(geo(`b${w}|${h}|${d}`, () => new THREE.BoxGeometry(w, h, d)), material);
    m.castShadow = cast;
    m.receiveShadow = receive;
    return m;
  };
  const cyl = (rt, rb, h, material, seg = 16) => {
    const m = new THREE.Mesh(geo(`c${rt}|${rb}|${h}|${seg}`, () => new THREE.CylinderGeometry(rt, rb, h, seg)), material);
    m.castShadow = true;
    return m;
  };

  // พื้นลายกระเบื้องยาง (canvas texture)
  function floorTexture(base) {
    const c = document.createElement('canvas');
    c.width = c.height = 256;
    const g = c.getContext('2d');
    g.fillStyle = base;
    g.fillRect(0, 0, 256, 256);
    for (let i = 0; i < 8; i++) {
      for (let j = 0; j < 2; j++) {
        g.fillStyle = `rgba(0,0,0,${0.015 + ((i * 7 + j * 3) % 5) * 0.008})`;
        g.fillRect(j * 128 + (i % 2) * 64, i * 32, 128, 31);
      }
    }
    g.strokeStyle = 'rgba(0,0,0,0.06)';
    for (let i = 0; i <= 8; i++) { g.beginPath(); g.moveTo(0, i * 32); g.lineTo(256, i * 32); g.stroke(); }
    const t = track(new THREE.CanvasTexture(c));
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }
  function floorMesh(w, d, color) {
    const tex = floorTexture(color);
    tex.repeat.set(Math.max(1, w / 3), Math.max(1, d / 3));
    const m = new THREE.Mesh(track(new THREE.PlaneGeometry(w, d)), track(new THREE.MeshStandardMaterial({ map: tex, roughness: 0.9 })));
    m.rotation.x = -Math.PI / 2;
    m.receiveShadow = true;
    return m;
  }

  // ================================================================ labels (ขนาดคงที่บนจอ)
  const labelCache = new Map();
  function labelTexture(text, sub, { color = '#0f172a', bg = 'rgba(255,255,255,0.93)' } = {}) {
    const key = `${text}|${sub}|${color}|${bg}`;
    if (labelCache.has(key)) return labelCache.get(key);
    const c = document.createElement('canvas');
    const ctx = c.getContext('2d');
    const font = '600 44px "IBM Plex Sans Thai", "Noto Sans Thai", system-ui, sans-serif';
    const subFont = '400 32px "IBM Plex Sans Thai", "Noto Sans Thai", system-ui, sans-serif';
    ctx.font = font;
    const w1 = ctx.measureText(text).width;
    ctx.font = subFont;
    const w2 = sub ? ctx.measureText(sub).width : 0;
    c.width = Math.ceil(Math.max(w1, w2) + 48);
    c.height = sub ? 112 : 72;
    ctx.fillStyle = bg;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(0, 0, c.width, c.height, 18); else ctx.rect(0, 0, c.width, c.height);
    ctx.fill();
    ctx.fillStyle = color;
    ctx.font = font;
    ctx.textBaseline = 'top';
    ctx.fillText(text, 24, 12);
    if (sub) { ctx.font = subFont; ctx.fillStyle = '#475569'; ctx.fillText(sub, 24, 66); }
    const tex = track(new THREE.CanvasTexture(c));
    tex.colorSpace = THREE.SRGBColorSpace;
    const out = { tex, aspect: c.width / c.height, rows: c.height / 72 };
    labelCache.set(key, out);
    return out;
  }
  // ป้ายแต่ละกลุ่มเปิด/ปิดได้: room (ห้องและพื้นที่), bed (ชื่อเตียง), people (ชื่อผู้ป่วย/นักกายภาพ)
  const labelOn = { room: true, bed: true, people: false };
  function label(text, sub = '', opts = {}, size = 0.5, kind = null) {
    const sprite = new THREE.Sprite(track(new THREE.SpriteMaterial({ depthTest: false, transparent: true, sizeAttenuation: false })));
    sprite.renderOrder = 10;
    sprite.userData.size = size;
    sprite.userData.labelKind = kind;
    if (kind) sprite.visible = labelOn[kind] !== false;
    setLabel(sprite, text, sub, opts);
    return sprite;
  }
  function setLabel(sprite, text, sub = '', opts = {}) {
    const key = `${text}|${sub}`;
    if (sprite.userData.key === key) return;
    sprite.userData.key = key;
    const { tex, aspect, rows } = labelTexture(text, sub, opts);
    sprite.material.map = tex;
    sprite.material.needsUpdate = true;
    const h = 0.05 * sprite.userData.size * rows;
    sprite.scale.set(h * aspect, h, 1);
  }

  // ================================================================ people
  const SKIN = ['#f1c9a5', '#e0ac7e', '#c68e5f', '#f6d7bd', '#a8714a'];
  const HAIR = ['#1f1a17', '#3b2a20', '#5a4030', '#2b2b2b', '#8a8a8a'];
  const CLOTHES = ['#7c93b5', '#b08968', '#8aa17a', '#c47e7e', '#6d7a8a', '#9b87b5', '#d4a373', '#5f8f9a'];

  /** สร้างคน (หันหน้าไปทาง +z, เท้าที่ y=0) พร้อมข้อต่อสำหรับท่าทาง */
  function makePerson({ top, bottom, skin, hair, role }) {
    const root = new THREE.Group();
    const body = new THREE.Group();
    root.add(body);
    const mTop = mat(top);
    const mBottom = mat(bottom);
    const mSkin = mat(skin);
    const mHair = mat(hair, { roughness: 0.6 });
    const limb = (r, len, m) => {
      const mesh = new THREE.Mesh(geo(`cap${r}|${len}`, () => new THREE.CapsuleGeometry(r, len, 4, 10)), m);
      mesh.castShadow = true;
      mesh.position.y = -(len / 2 + r);
      return mesh;
    };
    const pivot = (x, y, child) => { const p = new THREE.Group(); p.position.set(x, y, 0); p.add(child); body.add(p); return p; };
    const hipL = pivot(-0.1, 0.9, limb(0.075, 0.7, mBottom));
    const hipR = pivot(0.1, 0.9, limb(0.075, 0.7, mBottom));
    const shoeGeo = geo('shoe', () => new THREE.BoxGeometry(0.11, 0.07, 0.24));
    for (const h of [hipL, hipR]) { const s = new THREE.Mesh(shoeGeo, mat(role === 'patient' ? '#3f3f46' : '#f8fafc')); s.position.set(0, -0.86, 0.05); s.castShadow = true; h.add(s); }
    const torso = new THREE.Mesh(geo('torso', () => new THREE.CapsuleGeometry(0.19, 0.42, 4, 12)), mTop);
    torso.position.y = 1.18;
    torso.scale.set(1, 1, 0.72);
    torso.castShadow = true;
    body.add(torso);
    const shL = pivot(-0.25, 1.4, limb(0.058, 0.52, mTop));
    const shR = pivot(0.25, 1.4, limb(0.058, 0.52, mTop));
    for (const s of [shL, shR]) { const hand = new THREE.Mesh(geo('hand', () => new THREE.SphereGeometry(0.055, 10, 8)), mSkin); hand.position.y = -0.66; s.add(hand); }
    const neck = cyl(0.05, 0.06, 0.08, mSkin, 10);
    neck.position.y = 1.5;
    body.add(neck);
    const head = new THREE.Mesh(geo('head', () => new THREE.SphereGeometry(0.115, 18, 14)), mSkin);
    head.position.y = 1.64;
    head.castShadow = true;
    body.add(head);
    const hairMesh = new THREE.Mesh(geo('hair', () => new THREE.SphereGeometry(0.122, 18, 10, 0, Math.PI * 2, 0, Math.PI * 0.55)), mHair);
    hairMesh.position.y = 1.655;
    hairMesh.rotation.x = -0.25;
    body.add(hairMesh);
    if (role === 'therapist') {
      const badge = box(0.06, 0.08, 0.01, mat('#ffffff'), { cast: false });
      badge.position.set(0.09, 1.3, 0.14);
      body.add(badge);
    }
    root.userData.joints = { body, hipL, hipR, shL, shR };
    return root;
  }

  /** ตั้งท่าทาง: stand | walk | sit | lie | treat | cycle | exercise */
  function pose(person, kind, phase = 0) {
    const { body, hipL, hipR, shL, shR } = person.userData.joints;
    body.position.set(0, 0, 0);
    body.rotation.set(0, 0, 0);
    for (const j of [hipL, hipR, shL, shR]) j.rotation.set(0, 0, 0);
    shL.rotation.z = -0.06;
    shR.rotation.z = 0.06;
    const s = Math.sin(phase);
    switch (kind) {
      case 'walk':
        hipL.rotation.x = s * 0.5;
        hipR.rotation.x = -s * 0.5;
        shL.rotation.x = -s * 0.4;
        shR.rotation.x = s * 0.4;
        body.position.y = Math.abs(Math.cos(phase)) * 0.025;
        break;
      case 'sit':
        body.position.y = -0.42;
        hipL.rotation.x = hipR.rotation.x = -Math.PI / 2;
        shL.rotation.x = shR.rotation.x = -0.35;
        break;
      case 'cycle':
        body.position.y = -0.2;
        body.rotation.x = 0.18;
        hipL.rotation.x = -1.2 + s * 0.45;
        hipR.rotation.x = -1.2 - s * 0.45;
        shL.rotation.x = shR.rotation.x = -1.0;
        break;
      case 'treat':
        shL.rotation.x = -1.05 + s * 0.12;
        shR.rotation.x = -1.15 - s * 0.12;
        body.rotation.x = 0.22;
        break;
      case 'exercise':
        shL.rotation.z = -0.4 - Math.abs(s) * 1.6;
        shR.rotation.z = 0.4 + Math.abs(s) * 1.6;
        break;
      case 'lie':
      case 'stand':
      default:
        break;
    }
  }

  // ================================================================ furniture & equipment models
  function bedModel(b) {
    const g = new THREE.Group();
    const isMat = b.bed_type === 'mat';
    const frame = mat('#64748b', { metalness: 0.4, roughness: 0.5 });
    if (isMat) {
      const m = box(1.0, 0.1, 1.8, mat('#60a5fa'));
      m.position.y = 0.05;
      g.add(m);
      g.userData.top = 0.1;
    } else {
      for (const [x, z] of [[-0.38, -0.85], [0.38, -0.85], [-0.38, 0.85], [0.38, 0.85]]) {
        const leg = box(0.05, 0.55, 0.05, frame);
        leg.position.set(x, 0.275, z);
        g.add(leg);
      }
      const base = box(0.86, 0.06, 1.95, frame);
      base.position.y = 0.55;
      const mattress = box(0.82, 0.12, 1.9, mat(b.bed_type === 'treatment_table' ? '#1e3a5f' : '#334155', { roughness: 0.6 }));
      mattress.position.y = 0.64;
      const sheet = box(0.83, 0.02, 1.4, mat('#f8fafc'));
      sheet.position.set(0, 0.71, 0.22);
      const pillow = box(0.5, 0.08, 0.3, mat('#ffffff'));
      pillow.position.set(0, 0.74, -0.75);
      g.add(base, mattress, sheet, pillow);
      if (b.bed_type === 'treatment_table') {
        const tower = box(0.3, 1.1, 0.25, mat('#cbd5e1', { metalness: 0.3 }));
        tower.position.set(0, 0.55, 1.15);
        g.add(tower);
      }
      g.userData.top = 0.7;
    }
    const halo = new THREE.Mesh(geo('halo', () => new THREE.RingGeometry(1.05, 1.25, 40)),
      new THREE.MeshBasicMaterial({ color: STATE_COLORS.free, transparent: true, opacity: 0.55, side: THREE.DoubleSide }));
    track(halo.material);
    halo.rotation.x = -Math.PI / 2;
    halo.position.y = 0.012;
    halo.scale.set(0.55, 1, 1);
    g.add(halo);
    g.userData.halo = halo;
    return g;
  }

  function equipmentModel(e) {
    const g = new THREE.Group();
    const metal = mat('#cbd5e1', { metalness: 0.5, roughness: 0.35 });
    const dark = mat('#334155', { roughness: 0.5 });
    const screen = new THREE.MeshStandardMaterial({ color: '#0b1220', emissive: '#000000', roughness: 0.3 });
    track(screen);
    const light = new THREE.MeshStandardMaterial({ color: EQUIPMENT_LIGHT.available, emissive: EQUIPMENT_LIGHT.available, emissiveIntensity: 0.8 });
    track(light);
    const lightBulb = new THREE.Mesh(geo('bulb', () => new THREE.SphereGeometry(0.045, 12, 8)), light);
    const cart = () => {
      for (const [x, z] of [[-0.18, -0.15], [0.18, -0.15], [-0.18, 0.15], [0.18, 0.15]]) {
        const w = cyl(0.035, 0.035, 0.03, dark, 10);
        w.rotation.z = Math.PI / 2;
        w.position.set(x, 0.035, z);
        g.add(w);
        const p = box(0.025, 0.75, 0.025, metal);
        p.position.set(x, 0.43, z);
        g.add(p);
      }
      const shelf = box(0.44, 0.03, 0.36, metal);
      shelf.position.y = 0.3;
      const top = box(0.44, 0.03, 0.36, metal);
      top.position.y = 0.8;
      g.add(shelf, top);
    };
    const unit = (w, h, d, color, y) => {
      const u = box(w, h, d, mat(color, { roughness: 0.45 }));
      u.position.y = y + h / 2;
      g.add(u);
      const sc = new THREE.Mesh(geo(`scr${w}|${h}`, () => new THREE.PlaneGeometry(w * 0.6, h * 0.55)), screen);
      sc.position.set(0, y + h * 0.55, d / 2 + 0.002);
      g.add(sc);
      lightBulb.position.set(w / 2 - 0.05, y + h + 0.03, 0);
      g.add(lightBulb);
    };
    switch (e.category_code) {
      case 'PARALLEL': {
        for (const dx of [-0.38, 0.38]) {
          const rail = cyl(0.025, 0.025, 3, metal, 10);
          rail.rotation.x = Math.PI / 2;
          rail.position.set(dx, 0.95, 0);
          g.add(rail);
          for (const dz of [-1.4, 0, 1.4]) { const post = cyl(0.03, 0.03, 0.95, metal, 10); post.position.set(dx, 0.475, dz); g.add(post); }
        }
        const base = box(1.0, 0.04, 3.2, mat('#94a3b8'));
        base.position.y = 0.02;
        g.add(base);
        lightBulb.position.set(0.5, 1.0, -1.5);
        g.add(lightBulb);
        break;
      }
      case 'TREADMILL': {
        const deck = box(0.8, 0.18, 1.9, dark);
        deck.position.y = 0.09;
        const belt = box(0.6, 0.02, 1.7, mat('#111827'));
        belt.position.y = 0.19;
        g.add(deck, belt);
        for (const dx of [-0.37, 0.37]) { const p = cyl(0.025, 0.025, 1.1, metal, 8); p.position.set(dx, 0.7, -0.85); g.add(p); }
        const con = box(0.8, 0.3, 0.12, mat('#1f2937'));
        con.position.set(0, 1.25, -0.85);
        const sc = new THREE.Mesh(geo('tmscr', () => new THREE.PlaneGeometry(0.5, 0.18)), screen);
        sc.position.set(0, 1.27, -0.788);
        g.add(con, sc);
        lightBulb.position.set(0.35, 1.43, -0.85);
        g.add(lightBulb);
        break;
      }
      case 'CYCLE': {
        const frame = box(0.12, 0.08, 1.0, dark);
        frame.position.y = 0.06;
        const post = box(0.08, 0.6, 0.08, dark);
        post.position.set(0, 0.4, 0.25);
        const seat = box(0.28, 0.07, 0.32, mat('#111827'));
        seat.position.set(0, 0.72, 0.25);
        const fly = cyl(0.22, 0.22, 0.08, metal, 20);
        fly.rotation.z = Math.PI / 2;
        fly.position.set(0, 0.3, -0.3);
        const bar = box(0.5, 0.05, 0.05, metal);
        bar.position.set(0, 1.0, -0.35);
        const stem = box(0.06, 0.7, 0.06, dark);
        stem.position.set(0, 0.65, -0.35);
        g.add(frame, post, seat, fly, bar, stem);
        lightBulb.position.set(0, 1.08, -0.35);
        g.add(lightBulb);
        break;
      }
      case 'TILT': {
        const base = box(0.7, 0.3, 1.8, metal);
        base.position.y = 0.15;
        const tbl = box(0.75, 0.1, 2.0, mat('#1e3a5f'));
        tbl.position.set(0, 0.85, 0);
        tbl.rotation.x = -0.55;
        g.add(base, tbl);
        lightBulb.position.set(0.35, 0.4, 0.9);
        g.add(lightBulb);
        break;
      }
      case 'HOTPACK':
        unit(0.6, 0.85, 0.45, '#d1d5db', 0); break;
      case 'COLDPACK':
        unit(0.55, 0.75, 0.45, '#f8fafc', 0); break;
      case 'SWD': {
        cart();
        unit(0.42, 0.3, 0.34, '#e2e8f0', 0.82);
        const arm = cyl(0.02, 0.02, 0.7, metal, 8);
        arm.position.set(0.15, 1.35, 0);
        arm.rotation.z = -0.6;
        const disc = cyl(0.13, 0.13, 0.05, mat('#e2e8f0'), 20);
        disc.position.set(0.38, 1.6, 0);
        g.add(arm, disc);
        break;
      }
      case 'TRACTION':
        unit(0.35, 1.0, 0.3, '#cbd5e1', 0); break;
      case 'CPM': {
        const rail = box(0.3, 0.12, 1.0, mat('#94a3b8'));
        rail.position.y = 0.06;
        g.add(rail);
        unit(0.3, 0.2, 0.25, '#e2e8f0', 0.12);
        break;
      }
      default:
        cart();
        unit(0.4, 0.22, 0.32, e.category_code === 'SHOCKWAVE' ? '#bfdbfe' : '#f1f5f9', 0.82);
    }
    g.userData.screen = screen;
    g.userData.light = light;
    return g;
  }

  function chair(color) {
    const g = new THREE.Group();
    const m = mat(color);
    const seat = box(0.45, 0.06, 0.45, m);
    seat.position.y = 0.45;
    const back = box(0.45, 0.45, 0.05, m);
    back.position.set(0, 0.7, -0.2);
    g.add(seat, back);
    for (const [x, z] of [[-0.2, -0.2], [0.2, -0.2], [-0.2, 0.2], [0.2, 0.2]]) { const l = box(0.03, 0.45, 0.03, mat('#475569')); l.position.set(x, 0.225, z); g.add(l); }
    return g;
  }
  function plant() {
    const g = new THREE.Group();
    const pot = cyl(0.18, 0.14, 0.35, mat('#a8a29e'));
    pot.position.y = 0.175;
    const leaves = new THREE.Mesh(geo('leaves', () => new THREE.IcosahedronGeometry(0.38, 1)), mat('#4d7c0f', { roughness: 0.9 }));
    leaves.position.y = 0.75;
    leaves.castShadow = true;
    g.add(pot, leaves);
    return g;
  }

  // ================================================================ layout
  let L = null;          // ผังที่คำนวณแล้ว
  let board = null;
  let roomGroups = [];

  function layoutRooms(rooms) {
    const placed = rooms.filter((r) => r.plan_x != null && r.plan_z != null);
    let maxZ = placed.reduce((m, r) => Math.max(m, Number(r.plan_z) + Number(r.plan_d || 5)), 0);
    let cursorX = 0;
    return rooms.map((r) => {
      const beds = r.beds?.length || 0;
      const w = Number(r.plan_w) || Math.max(4, beds * 1.9 + 1.2, r.room_type === 'gym' ? 10 : 0);
      const d = Number(r.plan_d) || (r.room_type === 'gym' ? 7 : 5);
      if (r.plan_x != null && r.plan_z != null) return { ...r, x: Number(r.plan_x), z: Number(r.plan_z), w, d };
      if (cursorX === 0 && placed.length) maxZ += 2.5;
      const out = { ...r, x: cursorX, z: maxZ, w, d };
      cursorX += w + 0.5;
      return out;
    });
  }

  /** หาแนวทางเดิน: ช่องว่างระหว่างแถวห้อง (ถ้าไม่มี ใช้แนวหน้าห้อง) และฝั่งประตูของแต่ละห้อง */
  function computeLayout(b) {
    const rooms = layoutRooms(b.rooms || []);
    const bounds = rooms.reduce((o, r) => ({
      minX: Math.min(o.minX, r.x), maxX: Math.max(o.maxX, r.x + r.w), minZ: Math.min(o.minZ, r.z), maxZ: Math.max(o.maxZ, r.z + r.d),
    }), { minX: 0, maxX: 0, minZ: 0, maxZ: 0 });
    if (!rooms.length) Object.assign(bounds, { minX: 0, maxX: 12, minZ: 0, maxZ: 8 });
    const iv = rooms.map((r) => [r.z, r.z + r.d]).sort((a, c) => a[0] - c[0]);
    const merged = [];
    for (const [a, c] of iv) { if (merged.length && a <= merged.at(-1)[1] + 0.05) merged.at(-1)[1] = Math.max(merged.at(-1)[1], c); else merged.push([a, c]); }
    let corridor;
    if (merged.length >= 2 && merged[1][0] - merged[0][1] >= 1.2) corridor = { z0: merged[0][1], z1: merged[1][0] };
    else corridor = { z0: bounds.maxZ, z1: bounds.maxZ + 2.4 };
    const cz = (corridor.z0 + corridor.z1) / 2;
    for (const r of rooms) {
      r.doorSide = r.z + r.d / 2 < cz ? 1 : -1;  // 1 = ประตูผนังด้านใต้ (z+d)
      r.door = { x: r.x + r.w / 2, z: r.doorSide > 0 ? r.z + r.d : r.z };
      const n = r.beds.length;
      r.bedSlots = r.beds.map((bd, i) => {
        if (bd.plan_x != null && bd.plan_z != null) return { x: r.x + Number(bd.plan_x), z: r.z + Number(bd.plan_z), rot: (bd.plan_rot || 0) * Math.PI / 180 };
        const spacing = r.w / n;
        // แถวเตียงชิดผนังด้านในห้อง (ฝั่งตรงข้ามประตู)
        return { x: r.x + spacing * (i + 0.5), z: r.doorSide > 0 ? r.z + 1.7 : r.z + r.d - 1.7, rot: 0 };
      });
    }
    const lobby = { x: bounds.maxX + 0.8, w: 7, z0: Math.min(bounds.minZ, corridor.z0 - 3), z1: Math.max(bounds.maxZ, corridor.z1 + 3) };
    const storage = { x: lobby.x + lobby.w + 0.8, w: 3.5, z0: lobby.z0, z1: lobby.z0 + Math.min(8, lobby.z1 - lobby.z0) };
    const entrance = { x: lobby.x + lobby.w - 0.6, z: cz };
    const seats = [];
    for (let i = 0; i < 24; i++) seats.push({ x: lobby.x + 1.2 + (i % 6) * 0.75, z: lobby.z1 - 1.0 - Math.floor(i / 6) * 1.5, yaw: Math.PI });
    const stations = [];
    for (let i = 0; i < 8; i++) stations.push({ x: lobby.x + 1.0 + (i % 4) * 0.9, z: lobby.z0 + 2.4 + Math.floor(i / 4) * 0.8 });
    return { rooms, byId: new Map(rooms.map((r) => [r.id, r])), bounds, corridor, cz, lobby, storage, entrance, seats, stations };
  }

  function clearWorld() {
    world.clear();
    actors.clear();
    roomGroups = [];
  }

  function setLayout(b) {
    board = b;
    clearWorld();
    L = computeLayout(b);
    const { rooms, bounds, corridor, lobby, storage } = L;

    // พื้นภายนอก
    const W = storage.x + storage.w - bounds.minX + 8;
    const D = lobby.z1 - lobby.z0 + 8;
    const ground = new THREE.Mesh(track(new THREE.PlaneGeometry(W, D)), mat(theme.ground, { roughness: 1 }));
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(bounds.minX - 4 + W / 2, -0.02, lobby.z0 - 4 + D / 2);
    ground.receiveShadow = true;
    world.add(ground);
    // ทางเดิน + โถงต้อนรับ
    const cw = lobby.x - bounds.minX;
    const cor = floorMesh(cw, corridor.z1 - corridor.z0, theme.corridor);
    cor.position.set(bounds.minX + cw / 2, 0.003, (corridor.z0 + corridor.z1) / 2);
    world.add(cor);
    const lob = floorMesh(lobby.w, lobby.z1 - lobby.z0, theme.lobby);
    lob.position.set(lobby.x + lobby.w / 2, 0.004, (lobby.z0 + lobby.z1) / 2);
    world.add(lob);
    const desk = box(2.6, 1.05, 0.6, mat('#8b6f4e', { roughness: 0.6 }));
    desk.position.set(lobby.x + 2.2, 0.525, lobby.z0 + 1.6);
    const deskTop = box(2.7, 0.04, 0.7, mat('#f5f5f4'));
    deskTop.position.set(lobby.x + 2.2, 1.07, lobby.z0 + 1.6);
    world.add(desk, deskTop);
    for (const s of L.seats) { const c = chair('#5b7fa6'); c.position.set(s.x, 0, s.z); c.rotation.y = s.yaw; world.add(c); }
    for (const [x, z] of [[lobby.x + 0.4, lobby.z0 + 0.4], [lobby.x + lobby.w - 0.4, lobby.z1 - 0.4], [lobby.x + lobby.w - 0.4, lobby.z0 + 0.4]]) { const p = plant(); p.position.set(x, 0, z); world.add(p); }
    const lobbyLabel = label('เคาน์เตอร์ต้อนรับ / พักคอย', '', {}, 0.5, 'room');
    lobbyLabel.position.set(lobby.x + lobby.w / 2, 2.2, lobby.z0 + 0.5);
    world.add(lobbyLabel);
    const entryLabel = label('ทางเข้า', '', { bg: 'rgba(14,116,144,0.92)', color: '#ffffff' }, 0.42, 'room');
    entryLabel.position.set(L.entrance.x + 0.4, 1.6, L.entrance.z);
    world.add(entryLabel);
    // คลังอุปกรณ์
    const st = floorMesh(storage.w, storage.z1 - storage.z0, theme.storage);
    st.position.set(storage.x + storage.w / 2, 0.004, (storage.z0 + storage.z1) / 2);
    world.add(st);
    const stl = label('คลังอุปกรณ์', 'เครื่องเคลื่อนย้ายได้', {}, 0.45, 'room');
    stl.position.set(storage.x + storage.w / 2, 1.9, storage.z0 + 0.4);
    world.add(stl);

    // ห้อง
    const wallH = 1.25;
    const wallM = mat(theme.wall, { roughness: 0.9 });
    const capM = mat(theme.wallTop, { roughness: 0.7 });
    const wall = (g, w, d, x, z) => {
      const m = box(w, wallH, d, wallM);
      m.position.set(x, wallH / 2, z);
      const cap = box(w + 0.02, 0.04, d + 0.02, capM, { cast: false });
      cap.position.set(x, wallH + 0.02, z);
      g.add(m, cap);
    };
    L.bedObj = new Map();
    for (const r of rooms) {
      const g = new THREE.Group();
      g.userData = { kind: 'room', data: r };
      const fl = floorMesh(r.w, r.d, (theme.floorTint && theme.floorTint[r.room_type]) || ROOM_FLOOR[r.room_type] || '#eef2f5');
      fl.position.set(r.x + r.w / 2, 0.006, r.z + r.d / 2);
      fl.userData = { kind: 'room', data: r, pick: true };
      g.add(fl);
      const door = Math.min(1.3, r.w * 0.3);
      const t = 0.1;
      const dz = r.doorSide > 0 ? r.z + r.d - t / 2 : r.z + t / 2;
      const bz = r.doorSide > 0 ? r.z + t / 2 : r.z + r.d - t / 2;
      wall(g, r.w, t, r.x + r.w / 2, bz);
      wall(g, t, r.d, r.x + t / 2, r.z + r.d / 2);
      wall(g, t, r.d, r.x + r.w - t / 2, r.z + r.d / 2);
      wall(g, (r.w - door) / 2, t, r.x + (r.w - door) / 4, dz);
      wall(g, (r.w - door) / 2, t, r.x + r.w - (r.w - door) / 4, dz);
      const lb = label(`${r.code} · ${r.name}`, '', {}, 0.48, 'room');
      lb.position.set(r.x + r.w / 2, 1.7, r.door.z + (r.doorSide > 0 ? -0.3 : 0.3));
      g.add(lb);
      r.labelSprite = lb;
      r.beds.forEach((bd, i) => {
        const s = r.bedSlots[i];
        const bg = bedModel(bd);
        bg.position.set(s.x, 0, s.z);
        bg.rotation.y = s.rot;
        const data = { ...bd, roomName: r.name, roomCode: r.code, roomId: r.id };
        bg.traverse((m) => { if (m.isMesh) m.userData = { kind: 'bed', data, pick: true }; });
        const bedTag = bd.status !== 'available'
          ? label(`${bd.name} · ${bd.status === 'maintenance' ? 'ปิดซ่อม' : 'งดใช้'}`, '', { color: '#92400e', bg: 'rgba(254,243,199,0.95)' }, 0.36, 'bed')
          : label(bd.name, '', { color: '#334155', bg: 'rgba(255,255,255,0.85)' }, 0.32, 'bed');
        bedTag.position.set(0, 1.25, -0.6);
        bg.add(bedTag);
        g.add(bg);
        L.bedObj.set(bd.id, { group: bg, slot: s, room: r, data, top: bg.userData.top });
      });
      world.add(g);
      roomGroups.push(g);
    }

    // อุปกรณ์: เครื่องติดตั้งประจำห้องวางในห้อง, เครื่องเคลื่อนย้ายได้วางในคลัง (เลื่อนไปข้างเตียงเมื่อถูกใช้)
    L.equip = new Map();
    const perRoom = new Map();
    let storeIdx = 0;
    for (const e of b.equipment || []) {
      const model = equipmentModel(e);
      const data = { ...e };
      model.traverse((m) => { if (m.isMesh) m.userData = { kind: 'equipment', data, pick: true }; });
      const room = e.room_id && L.byId.get(e.room_id);
      let home;
      if (room) {
        const i = perRoom.get(room.id) || 0;
        perRoom.set(room.id, i + 1);
        if (e.plan_x != null && e.plan_z != null) home = { x: room.x + Number(e.plan_x), z: room.z + Number(e.plan_z) };
        else if (room.room_type === 'gym' || GYM_EQUIPMENT.has(e.category_code)) {
          home = { x: room.x + 1.6 + i * 2.6, z: room.z + room.d / 2 + (room.doorSide > 0 ? -0.6 : 0.6) };
        } else home = { x: room.x + 0.6 + i * 0.7, z: room.doorSide > 0 ? room.z + 0.5 : room.z + room.d - 0.5 };
      } else {
        home = { x: storage.x + 0.6 + (storeIdx % 4) * 0.8, z: storage.z0 + 1.5 + Math.floor(storeIdx / 4) * 0.9 };
        storeIdx++;
      }
      model.position.set(home.x, 0, home.z);
      if (GYM_EQUIPMENT.has(e.category_code) && e.category_code !== 'CYCLE') model.rotation.y = 0;
      (room ? world : actors).add(model);
      L.equip.set(e.id, { model, home, data, fixed: Boolean(room), status: e.status });
    }
    frame();
    if (day.length) setDay(dayRaw, dayOpts); // สร้างคนใหม่ตามผังใหม่
  }

  // ================================================================ day simulation
  let day = [];        // นัดที่ประมวลแล้ว
  let dayRaw = [];
  let dayOpts = {};
  let therapists = new Map();
  let helper = null;   // ผู้ช่วยเปลี่ยนผ้าปู

  function setDay(appointments, opts = {}) {
    dayRaw = appointments || [];
    dayOpts = opts;
    if (!L) return;
    for (const a of day) actors.remove(a.person, a.tag);
    for (const t of therapists.values()) actors.remove(t.person, t.tag);
    if (helper) actors.remove(helper);
    const turnover = (opts.turnoverMin ?? 5) * MIN;
    day = dayRaw.filter((a) => !['cancelled'].includes(a.status)).map((a, i) => {
      const s = new Date(a.start_at).getTime();
      const e = new Date(a.end_at).getTime();
      const h = hash(a.id || i);
      const person = makePerson({
        top: CLOTHES[h % CLOTHES.length], bottom: ['#334155', '#1f2937', '#57534e', '#3f4a5a'][h % 4],
        skin: SKIN[h % SKIN.length], hair: HAIR[(h >> 3) % HAIR.length], role: 'patient',
      });
      person.visible = false;
      actors.add(person);
      const room = a.room_id ? L.byId.get(a.room_id) : null;
      const bed = a.bed_id ? L.bedObj.get(a.bed_id) : null;
      const eqIds = (a.equipment || []).map((x) => x.id || x);
      const gymEq = eqIds.map((id) => L.equip.get(id)).find((x) => x && GYM_EQUIPMENT.has(x.data.category_code));
      const appt = {
        ...a, s, e, turnoverEnd: a.bed_until ? Math.max(e, new Date(a.bed_until).getTime()) : e + turnover, person, room, bed, eqIds, gymEq,
        seat: null, noShow: a.status === 'no_show', h,
      };
      appt.tag = label(firstName(a.patient_name), '', { color: '#0f172a', bg: 'rgba(255,255,255,0.88)' }, 0.3, 'people');
      appt.tag.visible = false;
      actors.add(appt.tag);
      appt.spot = spotFor(appt, i);
      appt.path = { in: pathToSpot(appt), out: null };
      appt.path.out = [...appt.path.in].reverse().slice(0, -1).concat([L.entrance]);
      const pick = { kind: 'patient', data: appt };
      person.traverse((m) => { if (m.isMesh) m.userData = { ...pick, pick: true }; });
      return appt;
    });
    // ที่นั่งพักคอย: ให้คนที่มาถึงได้เก้าอี้ว่างตัวแรก (ไม่นั่งทับกัน)
    const seatFree = L.seats.map(() => -Infinity);
    for (const a of [...day].sort((x, y) => x.s - y.s)) {
      const arrive = a.s - ARRIVE_BEFORE * MIN;
      let i = seatFree.findIndex((until) => until <= arrive);
      if (i < 0) i = seatFree.indexOf(Math.min(...seatFree));
      seatFree[i] = a.s;
      a.seat = L.seats[i];
    }
    // นักกายภาพ: ตามลำดับนัดของแต่ละคน
    therapists = new Map();
    let k = 0;
    for (const a of [...day].sort((x, y) => x.s - y.s)) {
      if (a.noShow) continue;
      const id = a.therapist_id || a.therapist_name;
      if (!therapists.has(id)) {
        const color = a.therapist_color || '#0ea5e9';
        const person = makePerson({ top: color, bottom: color, skin: SKIN[(k + 2) % SKIN.length], hair: HAIR[k % HAIR.length], role: 'therapist' });
        actors.add(person);
        const tag = label(String(a.therapist_name || '').split(' ')[0], '', { color: '#ffffff', bg: color }, 0.3, 'people');
        tag.visible = false;
        actors.add(tag);
        therapists.set(id, { id, name: a.therapist_name, color, person, tag, appts: [], station: L.stations[k % L.stations.length] });
        k++;
      }
      therapists.get(id).appts.push(a);
    }
    for (const t of therapists.values()) {
      const pick = { kind: 'therapist', data: t };
      t.person.traverse((m) => { if (m.isMesh) m.userData = { ...pick, pick: true }; });
    }
    helper = makePerson({ top: '#94a3b8', bottom: '#64748b', skin: SKIN[1], hair: HAIR[0], role: 'helper' });
    helper.visible = false;
    actors.add(helper);
  }

  function spotFor(a) {
    if (a.bed) {
      const { slot, top } = a.bed;
      return { kind: 'bed', x: slot.x, z: slot.z, top, rot: slot.rot };
    }
    const r = a.room;
    if (a.gymEq) {
      const { home, data } = a.gymEq;
      return { kind: data.category_code, x: home.x, z: home.z };
    }
    if (r) {
      const i = a.h % 6;
      return { kind: 'floor', x: r.x + 1.2 + (i % 3) * ((r.w - 2.4) / 2), z: r.z + r.d / 2 + (Math.floor(i / 3) - 0.5) * 1.4 };
    }
    return { kind: 'lobby', x: L.lobby.x + 3.5, z: L.cz };
  }

  /** ทางเดิน: ทางเข้า → ทางเดินกลาง → หน้าประตูห้อง → ข้างเตียง/จุดฝึก */
  function pathToSpot(a) {
    const pts = [{ x: L.entrance.x, z: L.entrance.z }, { x: L.lobby.x - 0.3, z: L.cz }];
    const r = a.room;
    if (!r) return pts;
    const side = r.doorSide;
    pts.push({ x: r.door.x, z: L.cz });
    pts.push({ x: r.door.x, z: r.door.z + side * 0.6 });
    pts.push({ x: r.door.x, z: r.door.z - side * 0.8 });
    const sp = a.spot;
    if (sp.kind === 'bed') {
      const sideX = sp.x + 0.75;
      pts.push({ x: sideX, z: r.door.z - side * 0.8 });
      pts.push({ x: sideX, z: sp.z });
    } else {
      pts.push({ x: sp.x, z: r.door.z - side * 0.8 });
      pts.push({ x: sp.x, z: sp.z + (sp.kind === 'PARALLEL' ? 1.4 : sp.kind === 'TREADMILL' ? 0.4 : 0) });
    }
    return pts;
  }

  function along(pts, k) {
    k = clamp(k, 0, 1);
    const seg = [];
    let total = 0;
    for (let i = 1; i < pts.length; i++) { const l = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z); seg.push(l); total += l; }
    let dist = k * total;
    for (let i = 0; i < seg.length; i++) {
      if (dist <= seg[i] || i === seg.length - 1) {
        const f = seg[i] ? clamp(dist / seg[i], 0, 1) : 1;
        const a = pts[i];
        const b = pts[i + 1];
        return { x: lerp(a.x, b.x, f), z: lerp(a.z, b.z, f), yaw: Math.atan2(b.x - a.x, b.z - a.z) };
      }
      dist -= seg[i];
    }
    const last = pts.at(-1);
    return { x: last.x, z: last.z, yaw: 0 };
  }

  const walkPhase = () => performance.now() / 160;

  function placeWalk(p, pos) {
    p.position.set(pos.x, 0, pos.z);
    p.rotation.set(0, pos.yaw, 0);
    pose(p, 'walk', walkPhase());
  }

  /** ตั้งตำแหน่งทุกอย่าง ณ เวลา t (ms) */
  function setTime(t) {
    if (!L) return;
    const tm = (x) => x * MIN;
    const bedState = new Map();
    const equipUse = new Map();
    const occupancy = new Map();
    let helperAt = null;

    for (const a of day) {
      const p = a.person;
      const arrive = a.s - tm(ARRIVE_BEFORE);
      const leaveEnd = a.e + tm(LEAVE_AFTER);
      if (a.bed && t >= a.s && t < a.e && !a.noShow) bedState.set(a.bed.data.id, 'occupied');
      else if (a.bed && t >= a.e && t < a.turnoverEnd && !a.noShow && !bedState.has(a.bed.data.id)) { bedState.set(a.bed.data.id, 'turnover'); helperAt = a.bed; }
      if (!a.noShow && t >= a.s - tm(3) && t < a.e + tm(2)) for (const id of a.eqIds) equipUse.set(id, a);
      if (a.room && !a.noShow && t >= a.s && t < a.e) occupancy.set(a.room.id, (occupancy.get(a.room.id) || 0) + 1);
      if (a.noShow || t < arrive || t >= leaveEnd) { p.visible = false; continue; }
      p.visible = true;
      p.rotation.set(0, 0, 0);
      const walkIn0 = a.s - tm(WALK_MIN);
      if (t < arrive + tm(WALK_MIN)) {                        // เดินจากทางเข้าไปที่นั่งพักคอย
        const k = ease((t - arrive) / tm(WALK_MIN));
        placeWalk(p, along([L.entrance, { x: a.seat.x, z: a.seat.z + 0.5 }, a.seat], k));
      } else if (t < walkIn0) {                               // นั่งรอ
        p.position.set(a.seat.x, 0, a.seat.z);
        p.rotation.set(0, a.seat.yaw, 0);
        pose(p, 'sit');
      } else if (t < a.s) {                                   // เดินเข้าห้อง
        const k = ease((t - walkIn0) / tm(WALK_MIN));
        placeWalk(p, along([a.seat, ...a.path.in.slice(1)], k));
      } else if (t < a.e) {                                   // ระหว่างรักษา
        const sp = a.spot;
        const ph = walkPhase();
        if (sp.kind === 'bed') {
          p.position.set(sp.x, sp.top + 0.09, sp.z + 0.85);
          p.rotation.set(-Math.PI / 2, sp.rot, 0, 'YXZ');
          pose(p, 'lie');
        } else if (sp.kind === 'PARALLEL') {
          const k = (Math.sin((t - a.s) / (tm(1.2))) + 1) / 2;
          p.position.set(sp.x, 0, sp.z - 1.2 + k * 2.4);
          p.rotation.set(0, Math.cos((t - a.s) / tm(1.2)) > 0 ? 0 : Math.PI, 0);
          pose(p, 'walk', ph * 0.6);
        } else if (sp.kind === 'TREADMILL') {
          p.position.set(sp.x, 0.2, sp.z + 0.2);
          p.rotation.set(0, Math.PI, 0);
          pose(p, 'walk', ph);
        } else if (sp.kind === 'CYCLE') {
          p.position.set(sp.x, 0.42, sp.z + 0.25);
          p.rotation.set(0, Math.PI, 0);
          pose(p, 'cycle', ph);
        } else if (sp.kind === 'TILT') {
          p.position.set(sp.x, 0.95, sp.z + 0.75);
          p.rotation.set(-1.0, 0, 0);
          pose(p, 'stand');
        } else {
          p.position.set(sp.x, 0, sp.z);
          p.rotation.set(0, Math.PI, 0);
          pose(p, 'exercise', ph * 0.5);
        }
      } else {                                                // ลุก เดินออก
        const k = ease((t - a.e) / tm(LEAVE_AFTER));
        placeWalk(p, along(a.path.out, k));
      }
    }

    // นักกายภาพ
    for (const th of therapists.values()) {
      const p = th.person;
      const list = th.appts;
      const first = list[0];
      const last = list.at(-1);
      if (!first || t < first.s - tm(25) || t > last.e + tm(12)) { p.visible = false; continue; }
      p.visible = true;
      p.rotation.set(0, 0, 0);
      const cur = list.find((a) => t >= a.s && t < a.e);
      const next = list.find((a) => a.s > t);
      const prev = [...list].reverse().find((a) => a.e <= t);
      const posAt = (a) => (a.spot.kind === 'bed'
        ? { x: a.spot.x - 0.8, z: a.spot.z - 0.1, yaw: Math.PI / 2 }
        : { x: a.spot.x + 0.9, z: a.spot.z + 0.6, yaw: -Math.PI / 2 });
      const stationPos = { x: th.station.x, z: th.station.z, yaw: Math.PI };
      const route = (from, to) => {
        const pts = [from];
        const rf = from.room;
        const rt = to.room;
        if (rf) { pts.push({ x: rf.door.x, z: rf.door.z - rf.doorSide * 0.8 }); pts.push({ x: rf.door.x, z: L.cz }); } else pts.push({ x: from.x, z: L.cz });
        if (rt) { pts.push({ x: rt.door.x, z: L.cz }); pts.push({ x: rt.door.x, z: rt.door.z - rt.doorSide * 0.8 }); } else pts.push({ x: to.x, z: L.cz });
        pts.push(to);
        return pts;
      };
      if (cur) {
        const q = posAt(cur);
        p.position.set(q.x, 0, q.z);
        p.rotation.y = q.yaw;
        pose(p, 'treat', walkPhase() * 0.5);
      } else if (next && t >= next.s - tm(WALK_MIN)) {
        const from = prev && next.s - prev.e < tm(15) ? { ...posAt(prev), room: prev.room } : { ...stationPos, room: null };
        const to = { ...posAt(next), room: next.room };
        placeWalk(p, along(route(from, to), ease((t - (next.s - tm(WALK_MIN))) / tm(WALK_MIN))));
      } else if (prev && t < prev.e + tm(WALK_MIN) && (!next || next.s - prev.e >= tm(15))) {
        placeWalk(p, along(route({ ...posAt(prev), room: prev.room }, { ...stationPos, room: null }), ease((t - prev.e) / tm(WALK_MIN))));
      } else if (prev && next && next.s - prev.e < tm(15)) {
        const q = posAt(prev);                                   // รอข้างเตียงเดิม (บันทึกเวชระเบียน)
        p.position.set(q.x, 0, q.z);
        p.rotation.y = q.yaw;
        pose(p, 'stand');
      } else {
        p.position.set(stationPos.x, 0, stationPos.z);
        p.rotation.y = stationPos.yaw;
        pose(p, 'stand');
      }
    }

    // ผู้ช่วยเปลี่ยนผ้าปู
    if (helper) {
      helper.visible = Boolean(helperAt);
      if (helperAt) {
        helper.position.set(helperAt.slot.x + 0.75, 0, helperAt.slot.z + 0.3);
        helper.rotation.set(0, -Math.PI / 2, 0);
        pose(helper, 'treat', walkPhase());
      }
    }

    // เตียง: สีวงแสงตามสถานะ
    for (const [id, b] of L.bedObj) {
      const state = b.data.status !== 'available' ? b.data.status : bedState.get(id) || 'free';
      b.state = state;
      b.group.userData.halo.material.color.set(STATE_COLORS[state]);
      b.group.userData.halo.material.opacity = state === 'occupied' ? 0.55 + Math.sin(performance.now() / 400) * 0.2 : 0.5;
    }
    // อุปกรณ์: ไฟสถานะ จอ และตำแหน่งเครื่องเคลื่อนย้ายได้
    for (const [id, eq] of L.equip) {
      const a = equipUse.get(id);
      const down = ['broken', 'maintenance'].includes(eq.status);
      const inUse = Boolean(a && t >= a.s && t < a.e);
      const st = down ? eq.status : inUse ? 'in_use' : 'available';
      eq.state = st;
      eq.model.userData.light.color.set(EQUIPMENT_LIGHT[st]);
      eq.model.userData.light.emissive.set(EQUIPMENT_LIGHT[st]);
      eq.model.userData.screen.emissive.set(inUse ? '#38bdf8' : '#000000');
      eq.model.userData.screen.emissiveIntensity = inUse ? 0.6 + Math.sin(performance.now() / 300) * 0.2 : 0;
      if (!eq.fixed) {
        let target = eq.home;
        if (a && a.bed && !down) target = { x: a.bed.slot.x - 0.85, z: a.bed.slot.z + 0.65 };
        else if (a && a.room && !down) target = { x: a.spot.x - 0.8, z: a.spot.z + 0.6 };
        if (a && !down) {
          const k = t < a.s ? ease(clamp((t - (a.s - tm(3))) / tm(2), 0, 1)) : t >= a.e ? 1 - ease(clamp((t - a.e) / tm(2), 0, 1)) : 1;
          const mid = { x: target.x, z: L.cz };
          const pts = [eq.home, { x: eq.home.x, z: L.cz }, mid, target];
          const pos = along(pts, k);
          eq.model.position.set(pos.x, 0, pos.z);
        } else eq.model.position.set(eq.home.x, 0, eq.home.z);
      }
    }
    // ป้ายชื่อคน: ลอยเหนือศีรษะ
    const placeTag = (tag, p, lying) => {
      tag.visible = labelOn.people && p.visible;
      if (!tag.visible) return;
      if (lying) tag.position.set(p.position.x + 0.75, p.position.y + 0.35, p.position.z - 0.9);
      else tag.position.set(p.position.x, p.position.y + 2.05, p.position.z);
    };
    for (const a of day) placeTag(a.tag, a.person, Math.abs(a.person.rotation.x) > 0.5);
    for (const th of therapists.values()) placeTag(th.tag, th.person, false);
    // ป้ายห้อง: จำนวนผู้ป่วย
    for (const r of L.rooms) setLabel(r.labelSprite, `${r.code} · ${r.name}`, `ผู้ป่วยตอนนี้ ${occupancy.get(r.id) || 0}/${r.capacity}`);
    lastT = t;
  }
  let lastT = 0;

  function stats(t = lastT) {
    const active = day.filter((a) => !a.noShow && t >= a.s && t < a.e);
    const inClinic = day.filter((a) => !a.noShow && t >= a.s - ARRIVE_BEFORE * MIN && t < a.e + LEAVE_AFTER * MIN);
    const bedsTotal = L ? [...L.bedObj.values()].filter((b) => b.data.status === 'available').length : 0;
    const eqInUse = new Set(active.flatMap((a) => a.eqIds)).size;
    return {
      patientsNow: inClinic.length,
      inTreatment: active.length,
      waiting: inClinic.filter((a) => t < a.s).length,
      therapistsBusy: new Set(active.map((a) => a.therapist_id || a.therapist_name)).size,
      bedsOccupied: active.filter((a) => a.bed).length,
      bedsTotal,
      equipmentInUse: eqInUse,
      equipmentDown: L ? [...L.equip.values()].filter((e) => ['broken', 'maintenance'].includes(e.status)).length : 0,
      remainingToday: day.filter((a) => !a.noShow && a.s > t).length,
      completed: day.filter((a) => !a.noShow && a.e <= t).length,
      active,
    };
  }

  /** เหตุการณ์ของวัน (มาถึง / เริ่ม / จบ) ที่เกิดก่อนเวลา t */
  function events(t = lastT, limit = 8) {
    const out = [];
    for (const a of day) {
      if (a.noShow) { if (a.s <= t) out.push({ t: a.s, type: 'no_show', a }); continue; }
      if (a.s - ARRIVE_BEFORE * MIN <= t) out.push({ t: a.s - ARRIVE_BEFORE * MIN, type: 'arrive', a });
      if (a.s <= t) out.push({ t: a.s, type: 'start', a });
      if (a.e <= t) out.push({ t: a.e, type: 'end', a });
    }
    return out.sort((x, y) => y.t - x.t).slice(0, limit);
  }

  // ================================================================ camera & interaction
  const target = new THREE.Vector3();
  const sph = { r: 30, theta: -0.8, phi: 0.82 };
  function applyCamera() {
    sph.phi = clamp(sph.phi, 0.15, 1.45);
    sph.r = clamp(sph.r, 3, 140);
    camera.position.set(
      target.x + sph.r * Math.sin(sph.phi) * Math.sin(sph.theta),
      target.y + sph.r * Math.cos(sph.phi),
      target.z + sph.r * Math.sin(sph.phi) * Math.cos(sph.theta),
    );
    camera.lookAt(target);
  }
  function frame(zoom = 1) {
    if (!L) return;
    const minX = L.bounds.minX;
    const maxX = L.storage.x + L.storage.w;
    const minZ = L.lobby.z0;
    const maxZ = L.lobby.z1;
    target.set((minX + maxX) / 2, 0, (minZ + maxZ) / 2);
    sun.target.position.copy(target);
    sun.position.set(target.x - 16, 32, target.z + 20);
    // ขยายระยะกล้องจนทุกมุมของผังอยู่ในจอ
    const corners = [];
    for (const x of [minX, maxX]) for (const z of [minZ, maxZ]) for (const y of [0, 1.5]) corners.push(new THREE.Vector3(x, y, z));
    const v = new THREE.Vector3();
    sph.r = 5;
    for (let i = 0; i < 80; i++) {
      applyCamera();
      camera.updateMatrixWorld();
      const ok = corners.every((c) => { v.copy(c).project(camera); return Math.abs(v.x) < 0.94 && Math.abs(v.y) < 0.9 && v.z < 1; });
      if (ok) break;
      sph.r *= 1.06;
    }
    if (zoom !== 1) { sph.r /= zoom; applyCamera(); }
  }
  function focus(x, z, r = 9) { target.set(x, 0, z); sph.r = r; applyCamera(); }

  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const setNdc = (ev) => {
    const rect = renderer.domElement.getBoundingClientRect();
    ndc.set(((ev.clientX - rect.left) / rect.width) * 2 - 1, -((ev.clientY - rect.top) / rect.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
  };
  function pick(ev) {
    setNdc(ev);
    return ray.intersectObjects([actors, world], true).find((h) => h.object.userData?.pick && h.object.visible !== false) || null;
  }
  function groundPoint(ev) {
    setNdc(ev);
    const p = new THREE.Vector3();
    return ray.ray.intersectPlane(groundPlane, p) ? p : null;
  }
  function describe(sel) {
    if (!sel) return null;
    const { kind, data } = sel;
    if (kind === 'bed') { const b = L.bedObj.get(data.id); return { kind, data: { ...data, state: b?.state || 'free', current: day.find((a) => a.bed === b && lastT >= a.s && lastT < a.e) || null, next: day.filter((a) => a.bed === b && a.s > lastT).sort((x, y) => x.s - y.s)[0] || null } }; }
    if (kind === 'equipment') return { kind, data: { ...data, state: L.equip.get(data.id)?.state || 'available' } };
    return sel;
  }

  const pointers = new Map();
  let drag = null;
  let pinch = 0;
  const el = renderer.domElement;
  el.addEventListener('contextmenu', (e) => e.preventDefault());
  el.addEventListener('pointerdown', (e) => {
    el.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) { const [a, b] = [...pointers.values()]; pinch = Math.hypot(a.x - b.x, a.y - b.y); drag = null; return; }
    const mode = e.button === 2 || e.shiftKey ? 'pan' : 'rotate';
    drag = { mode, x: e.clientX, y: e.clientY, moved: 0 };
    if (editable && mode === 'rotate') {
      const hit = pick(e);
      if (hit?.object.userData.kind === 'room') {
        const group = roomGroups.find((g) => g.userData.data.id === hit.object.userData.data.id);
        const gp = groundPoint(e);
        if (group && gp) drag = { mode: 'moveRoom', group, start: gp, origin: group.position.clone(), x: e.clientX, y: e.clientY, moved: 0 };
      }
    }
  });
  el.addEventListener('pointermove', (e) => {
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinch) sph.r *= pinch / d;
      pinch = d;
      applyCamera();
      return;
    }
    if (!drag) { hover(e); return; }
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    drag.moved += Math.abs(dx) + Math.abs(dy);
    drag.x = e.clientX;
    drag.y = e.clientY;
    if (drag.mode === 'rotate') { sph.theta -= dx * 0.006; sph.phi -= dy * 0.006; }
    else if (drag.mode === 'pan') {
      const k = sph.r * 0.0016;
      const fwd = new THREE.Vector3(Math.sin(sph.theta), 0, Math.cos(sph.theta));
      const right = new THREE.Vector3(fwd.z, 0, -fwd.x);
      target.addScaledVector(right, -dx * k).addScaledVector(fwd, -dy * k);
    } else if (drag.mode === 'moveRoom') {
      const gp = groundPoint(e);
      if (gp) {
        const snap = (v) => Math.round(v * 4) / 4;
        drag.group.position.x = snap(drag.origin.x + gp.x - drag.start.x);
        drag.group.position.z = snap(drag.origin.z + gp.z - drag.start.z);
      }
    }
    applyCamera();
  });
  const end = (e) => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = 0;
    if (!drag) return;
    const d = drag;
    drag = null;
    if (d.mode === 'moveRoom' && d.moved > 4) {
      const r = d.group.userData.data;
      onRoomMove?.(r, r.x + d.group.position.x, r.z + d.group.position.z);
      return;
    }
    if (d.moved < 6) { const hit = pick(e); onSelect(hit ? describe(hit.object.userData) : null); }
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
  el.addEventListener('wheel', (e) => { e.preventDefault(); sph.r *= Math.exp(e.deltaY * 0.0012); applyCamera(); }, { passive: false });

  const tip = document.createElement('div');
  Object.assign(tip.style, {
    position: 'absolute', pointerEvents: 'none', padding: '4px 8px', borderRadius: '6px', fontSize: '12px',
    background: 'rgba(15,23,42,0.88)', color: '#fff', display: 'none', whiteSpace: 'nowrap', zIndex: 5,
  });
  if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
  container.appendChild(tip);
  function hover(e) {
    const hit = pick(e);
    if (!hit) { tip.style.display = 'none'; el.style.cursor = editable ? 'grab' : 'default'; return; }
    const { kind, data } = hit.object.userData;
    const text = kind === 'bed' ? `${data.roomCode} ${data.name} · ${STATE_TH[L.bedObj.get(data.id)?.state || 'free']}`
      : kind === 'equipment' ? `${data.name} (${data.asset_code})`
        : kind === 'patient' ? `ผู้ป่วย ${firstName(data.patient_name)} · ${data.therapist_name}`
          : kind === 'therapist' ? `${data.name}`
            : `${data.code} ${data.name}`;
    const rect = container.getBoundingClientRect();
    tip.textContent = text;
    tip.style.left = `${e.clientX - rect.left + 12}px`;
    tip.style.top = `${e.clientY - rect.top + 12}px`;
    tip.style.display = 'block';
    el.style.cursor = editable && kind === 'room' ? 'move' : 'pointer';
  }

  // ================================================================ loop
  function resize() {
    const w = container.clientWidth || 800;
    const h = container.clientHeight || 500;
    renderer.setSize(w, h, false);
    renderer.domElement.style.width = `${w}px`;
    renderer.domElement.style.height = `${h}px`;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  const ro = new ResizeObserver(resize);
  ro.observe(container);
  resize();
  applyCamera();
  let raf = 0;
  let clock = null; // ฟังก์ชันคืนเวลาจำลองปัจจุบัน (ให้หน้าเว็บกำหนด)
  const loop = () => {
    if (clock) setTime(clock());
    else if (day.length) setTime(lastT); // ให้ท่าเดิน/ไฟกระพริบยังขยับ
    renderer.render(scene, camera);
    raf = requestAnimationFrame(loop);
  };
  loop();

  return {
    setLayout,
    update: (b) => setLayout(b),
    setDay,
    setTime,
    setClock(fn) { clock = fn; },
    stats,
    events,
    frame,
    focus,
    setEditable(v) { editable = Boolean(v); },
    /** เปิด/ปิดป้าย: { room, bed, people } */
    setLabels(opts) {
      Object.assign(labelOn, opts);
      for (const root of [world, actors]) {
        root.traverse((o) => { if (o.isSprite && o.userData.labelKind && o.userData.labelKind !== 'people') o.visible = labelOn[o.userData.labelKind]; });
      }
      setTime(lastT);
    },
    labels: () => ({ ...labelOn }),
    setTheme(t) {
      theme = { ...DEFAULT_THEME, ...t };
      scene.background = new THREE.Color(theme.bg);
      matCache.clear();
      if (board) setLayout(board);
    },
    snapshot: () => { renderer.render(scene, camera); return renderer.domElement.toDataURL('image/png'); },
    dispose() {
      cancelAnimationFrame(raf);
      ro.disconnect();
      clearWorld();
      disposables.splice(0).forEach((o) => o.dispose?.());
      renderer.dispose();
      renderer.domElement.remove();
      tip.remove();
    },
  };
}
