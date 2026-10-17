/**
 * Clinic 3D — มุมมอง 3 มิติของห้อง เตียง อุปกรณ์ ผู้ป่วย และนักกายภาพ
 *
 *   const view = createClinic3D(container, { THREE, onSelect, onRoomMove });
 *   view.update(board);          // board = GET /api/facilities/board
 *   view.setEditable(true);      // ลากย้ายห้องบนผัง (เรียก onRoomMove(room, x, z))
 *   view.setTheme({ bg, ground, gridMajor, gridMinor, wall, floorTint }); // สีฉาก (โหมดสว่าง/มืด)
 *   view.dispose();
 *
 * ไม่พึ่ง addon ของ three.js (มี orbit controls ในตัว) จึงใช้ได้ทั้งในแอปและหน้า demo ไฟล์เดียว
 * หน่วยในฉากเป็นเมตร
 */
export const STATE_COLORS = {
  free: '#10b981', occupied: '#0ea5e9', turnover: '#8b5cf6', maintenance: '#f59e0b', out_of_service: '#94a3b8',
};
export const STATE_TH = { free: 'ว่าง', occupied: 'มีผู้ป่วย', turnover: 'เปลี่ยนผ้าปู', maintenance: 'ปิดซ่อม', out_of_service: 'งดใช้' };
const EQUIPMENT_COLORS = { in_use: '#2563eb', available: '#64748b', broken: '#ef4444', maintenance: '#f59e0b' };
const ROOM_FLOOR = { treatment: '#f8fafc', private: '#f5f3ff', gym: '#ecfdf5', pediatric: '#fff7ed', hydro: '#ecfeff', consult: '#f8fafc' };
const PATIENT_COLOR = '#f4c58f';

const DEFAULT_THEME = { bg: '#e9eef4', ground: '#dfe6ee', gridMajor: '#c8d2de', gridMinor: '#d6dee7', wall: '#cbd5e1', storage: '#f1f5f9', floorTint: null };

export function createClinic3D(container, { THREE, onSelect = () => {}, onRoomMove = null, editable = false, theme: initialTheme = {} } = {}) {
  let theme = { ...DEFAULT_THEME, ...initialTheme };
  let lastBoard = null;
  // ---------------------------------------------------------------- scene
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  container.appendChild(renderer.domElement);
  renderer.domElement.style.display = 'block';
  renderer.domElement.style.touchAction = 'none';

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(theme.bg);
  const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 500);

  scene.add(new THREE.HemisphereLight('#ffffff', '#b6c2d1', 1.6));
  const sun = new THREE.DirectionalLight('#ffffff', 1.4);
  sun.position.set(-18, 30, 22);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -40, right: 40, top: 40, bottom: -40, near: 1, far: 120 });
  scene.add(sun, sun.target);

  const world = new THREE.Group();
  scene.add(world);
  const disposables = [];
  const track = (o) => { disposables.push(o); return o; };
  const mat = (color, extra = {}) => track(new THREE.MeshStandardMaterial({ color, roughness: 0.85, metalness: 0.02, ...extra }));
  const box = (w, h, d, color, extra) => {
    const m = new THREE.Mesh(track(new THREE.BoxGeometry(w, h, d)), mat(color, extra));
    m.castShadow = true;
    m.receiveShadow = true;
    return m;
  };

  // ---------------------------------------------------------------- labels
  function label(text, { size = 0.5, color = '#0f172a', bg = 'rgba(255,255,255,0.92)', sub = '' } = {}) {
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
    const r = 18;
    ctx.beginPath();
    ctx.roundRect ? ctx.roundRect(0, 0, c.width, c.height, r) : ctx.rect(0, 0, c.width, c.height);
    ctx.fill();
    ctx.fillStyle = color;
    ctx.font = font;
    ctx.textBaseline = 'top';
    ctx.fillText(text, 24, 12);
    if (sub) { ctx.font = subFont; ctx.fillStyle = '#475569'; ctx.fillText(sub, 24, 66); }
    const tex = track(new THREE.CanvasTexture(c));
    tex.colorSpace = THREE.SRGBColorSpace;
    // ขนาดคงที่บนจอ (ไม่ขยายตามระยะ) เพื่อให้อ่านได้ทุกมุมกล้อง
    const sprite = new THREE.Sprite(track(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true, sizeAttenuation: false })));
    const h = 0.05 * size * (c.height / 72);
    sprite.scale.set(h * (c.width / c.height), h, 1);
    sprite.renderOrder = 10;
    return sprite;
  }

  // ---------------------------------------------------------------- figures
  function person(color, { lying = false } = {}) {
    const g = new THREE.Group();
    const body = new THREE.Mesh(track(new THREE.CapsuleGeometry(0.2, lying ? 1.1 : 0.9, 4, 12)), mat(color));
    const head = new THREE.Mesh(track(new THREE.SphereGeometry(0.15, 16, 12)), mat('#f1d3b3'));
    body.castShadow = head.castShadow = true;
    if (lying) {
      body.rotation.x = Math.PI / 2;
      body.position.set(0, 0.2, 0.1);
      head.position.set(0, 0.25, -0.75);
    } else {
      body.position.y = 0.65;
      head.position.y = 1.4;
    }
    g.add(body, head);
    return g;
  }

  // ---------------------------------------------------------------- equipment shapes
  function equipmentMesh(e, color) {
    const g = new THREE.Group();
    switch (e.category_code) {
      case 'PARALLEL': {
        for (const dx of [-0.35, 0.35]) {
          const rail = box(0.05, 0.05, 3, '#94a3b8');
          rail.position.set(dx, 0.95, 0);
          g.add(rail);
          for (const dz of [-1.4, 1.4]) { const post = box(0.06, 0.95, 0.06, '#64748b'); post.position.set(dx, 0.47, dz); g.add(post); }
        }
        const base = box(0.9, 0.04, 3.1, color);
        base.position.y = 0.02;
        g.add(base);
        break;
      }
      case 'TREADMILL': {
        const deck = box(0.8, 0.2, 1.8, '#334155');
        deck.position.y = 0.1;
        const consoleMesh = box(0.8, 0.5, 0.12, color);
        consoleMesh.position.set(0, 1.1, -0.85);
        const pole = box(0.06, 1.0, 0.06, '#64748b');
        pole.position.set(0, 0.6, -0.85);
        g.add(deck, consoleMesh, pole);
        break;
      }
      case 'TILT': {
        const tbl = box(0.8, 0.12, 2.0, color);
        tbl.position.y = 0.9;
        tbl.rotation.x = -0.6;
        const stand = box(0.3, 0.8, 0.3, '#64748b');
        stand.position.y = 0.4;
        g.add(tbl, stand);
        break;
      }
      case 'CYCLE': {
        const frame = box(0.4, 0.7, 1.0, color);
        frame.position.y = 0.35;
        const seat = box(0.3, 0.08, 0.3, '#1e293b');
        seat.position.set(0, 0.85, 0.25);
        g.add(frame, seat);
        break;
      }
      default: {
        // เครื่องบนรถเข็น
        const cart = box(0.45, 0.75, 0.4, '#cbd5e1');
        cart.position.y = 0.375;
        const unit = box(0.42, 0.22, 0.36, color);
        unit.position.y = 0.86;
        g.add(cart, unit);
      }
    }
    return g;
  }

  // ---------------------------------------------------------------- layout
  function layoutRooms(rooms) {
    const placed = rooms.filter((r) => r.plan_x != null && r.plan_z != null);
    let maxZ = placed.reduce((m, r) => Math.max(m, Number(r.plan_z) + Number(r.plan_d || 5)), 0);
    let cursorX = 0;
    return rooms.map((r) => {
      const beds = r.beds?.length || 0;
      const w = Number(r.plan_w) || Math.max(4, beds * 1.9 + 1.2, r.room_type === 'gym' ? 10 : 0);
      const d = Number(r.plan_d) || (r.room_type === 'gym' ? 7 : 5);
      if (r.plan_x != null && r.plan_z != null) return { ...r, x: Number(r.plan_x), z: Number(r.plan_z), w, d };
      if (cursorX === 0 && placed.length) maxZ += 1.5;
      const out = { ...r, x: cursorX, z: maxZ, w, d };
      cursorX += w + 0.5;
      return out;
    });
  }

  function bedSlots(room) {
    const n = room.beds.length;
    return room.beds.map((b, i) => {
      if (b.plan_x != null && b.plan_z != null) return { x: Number(b.plan_x), z: Number(b.plan_z), rot: (b.plan_rot || 0) * Math.PI / 180 };
      const spacing = room.w / n;
      return { x: spacing * (i + 0.5), z: room.d * 0.42, rot: 0 };
    });
  }

  // ---------------------------------------------------------------- build scene from board
  let roomGroups = [];
  let bounds = { minX: 0, maxX: 20, minZ: 0, maxZ: 14 };
  let firstBuild = true;

  function clear() {
    world.clear();
    disposables.splice(0).forEach((o) => o.dispose?.());
    roomGroups = [];
  }

  function update(board) {
    lastBoard = board;
    clear();
    const rooms = layoutRooms(board.rooms || []);
    const byId = new Map(rooms.map((r) => [r.id, r]));
    bounds = rooms.reduce((b, r) => ({
      minX: Math.min(b.minX, r.x), maxX: Math.max(b.maxX, r.x + r.w), minZ: Math.min(b.minZ, r.z), maxZ: Math.max(b.maxZ, r.z + r.d),
    }), { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity });
    if (!rooms.length) bounds = { minX: 0, maxX: 20, minZ: 0, maxZ: 14 };

    // พื้นอาคาร + โซนคลังอุปกรณ์
    const storage = { x: bounds.maxX + 1, z: bounds.minZ, w: 4, d: Math.max(6, bounds.maxZ - bounds.minZ) };
    const W = storage.x + storage.w - bounds.minX + 4;
    const D = bounds.maxZ - bounds.minZ + 6;
    const S = Math.max(W, D);
    const ground = new THREE.Mesh(track(new THREE.PlaneGeometry(S, S)), mat(theme.ground));
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(bounds.minX - 2 + W / 2, -0.01, bounds.minZ - 2 + D / 2);
    ground.receiveShadow = true;
    world.add(ground);
    const grid = new THREE.GridHelper(S, Math.round(S), theme.gridMajor, theme.gridMinor);
    grid.position.copy(ground.position);
    grid.position.y = 0;
    track(grid.geometry); track(grid.material);
    world.add(grid);

    const bedPos = new Map(); // bedId -> world position (สำหรับวางอุปกรณ์ข้างเตียง)

    for (const r of rooms) {
      const g = new THREE.Group();
      g.position.set(r.x, 0, r.z);
      g.userData = { kind: 'room', data: r };
      // พื้นห้อง (ใช้เป็นจุดคลิก/ลาก)
      const floor = box(r.w, 0.04, r.d, (theme.floorTint && theme.floorTint[r.room_type]) || ROOM_FLOOR[r.room_type] || '#f8fafc');
      floor.position.set(r.w / 2, 0.02, r.d / 2);
      floor.castShadow = false;
      floor.userData = { kind: 'room', data: r, pick: true };
      g.add(floor);
      // ผนัง (เว้นประตูด้านหน้า)
      const wallH = 1.1;
      const wallColor = theme.wall;
      const wallMat = { transparent: true, opacity: 0.9 };
      const back = box(r.w, wallH, 0.1, wallColor, wallMat); back.position.set(r.w / 2, wallH / 2, 0.05);
      const left = box(0.1, wallH, r.d, wallColor, wallMat); left.position.set(0.05, wallH / 2, r.d / 2);
      const right = box(0.1, wallH, r.d, wallColor, wallMat); right.position.set(r.w - 0.05, wallH / 2, r.d / 2);
      const door = Math.min(1.4, r.w * 0.3);
      const fl = box((r.w - door) / 2, wallH, 0.1, wallColor, wallMat); fl.position.set((r.w - door) / 4, wallH / 2, r.d - 0.05);
      const fr = box((r.w - door) / 2, wallH, 0.1, wallColor, wallMat); fr.position.set(r.w - (r.w - door) / 4, wallH / 2, r.d - 0.05);
      g.add(back, left, right, fl, fr);

      const occ = `${r.occupancyNow ?? 0}/${r.capacity}`;
      const lb = label(`${r.code} · ${r.name}`, { size: 0.5, sub: `ผู้ป่วยตอนนี้ ${occ}` });
      lb.position.set(r.w / 2, 1.5, r.d - 0.2);
      g.add(lb);

      // เตียง
      const slots = bedSlots(r);
      r.beds.forEach((b, i) => {
        const s = slots[i];
        const bg = new THREE.Group();
        bg.position.set(s.x, 0, s.z);
        bg.rotation.y = s.rot;
        const color = STATE_COLORS[b.state] || '#94a3b8';
        const isMat = b.bed_type === 'mat';
        const frame = box(0.9, isMat ? 0.12 : 0.5, isMat ? 1.6 : 2.0, '#e2e8f0');
        frame.position.y = isMat ? 0.06 : 0.25;
        const top = box(0.92, 0.08, isMat ? 1.62 : 2.02, color);
        top.position.y = isMat ? 0.14 : 0.54;
        const data = { ...b, roomName: r.name, roomCode: r.code };
        frame.userData = top.userData = { kind: 'bed', data, pick: true };
        bg.add(frame, top);
        if (b.state === 'occupied' && b.current) {
          const p = person(PATIENT_COLOR, { lying: true });
          p.position.y = isMat ? 0.2 : 0.6;
          p.traverse((m) => { m.userData = { kind: 'bed', data, pick: true }; });
          const t = person(b.current.therapist_color || '#0ea5e9');
          t.position.set(0.85, 0, 0.2);
          t.traverse((m) => { m.userData = { kind: 'bed', data, pick: true }; });
          bg.add(p, t);
        }
        if (b.state === 'maintenance' || b.state === 'out_of_service') {
          const warn = label('ปิดซ่อม', { size: 0.45, color: '#92400e', bg: 'rgba(254,243,199,0.95)' });
          warn.position.set(0, 1.3, 0);
          bg.add(warn);
        }
        g.add(bg);
        bedPos.set(b.id, { room: r, x: s.x, z: s.z });
      });

      // ห้องรวม (gym): ผู้ป่วยที่อยู่ตอนนี้
      if (r.room_type === 'gym' && r.current?.length) {
        r.current.forEach((a, i) => {
          const col = i % 4;
          const row = Math.floor(i / 4);
          const px = 1.5 + col * ((r.w - 3) / 3 || 1);
          const pz = r.d - 1.8 - row * 1.4;
          const p = person(PATIENT_COLOR);
          p.position.set(px, 0, pz);
          const t = person(a.therapist_color || '#0ea5e9');
          t.position.set(px + 0.6, 0, pz + 0.3);
          const data = { ...a, roomName: r.name };
          [p, t].forEach((o) => o.traverse((m) => { m.userData = { kind: 'gymPatient', data, pick: true }; }));
          g.add(p, t);
        });
      }
      world.add(g);
      roomGroups.push(g);
    }

    // อุปกรณ์
    const storageItems = [];
    const roomEquipIndex = new Map();
    for (const e of board.equipment || []) {
      const status = e.in_use_by ? 'in_use' : ['broken', 'maintenance'].includes(e.status) ? e.status : 'available';
      const mesh = equipmentMesh(e, EQUIPMENT_COLORS[status]);
      const data = { ...e, state: status };
      mesh.traverse((m) => { m.userData = { kind: 'equipment', data, pick: true }; });
      const bed = e.in_use_bed_id && bedPos.get(e.in_use_bed_id);
      const room = byId.get(e.in_use_room_id || e.room_id);
      if (bed) {
        mesh.position.set(bed.room.x + bed.x - 0.85, 0, bed.room.z + bed.z - 0.6);
      } else if (room) {
        const idx = roomEquipIndex.get(room.id) || 0;
        roomEquipIndex.set(room.id, idx + 1);
        if (e.plan_x != null && e.plan_z != null) {
          mesh.position.set(room.x + Number(e.plan_x), 0, room.z + Number(e.plan_z));
        } else if (room.room_type === 'gym') {
          const big = ['PARALLEL', 'TREADMILL', 'TILT', 'CYCLE'].includes(e.category_code);
          mesh.position.set(room.x + 1.2 + idx * (big ? 2.4 : 0.8), 0, room.z + (big ? 2.2 : 0.6));
        } else {
          mesh.position.set(room.x + 0.5 + idx * 0.6, 0, room.z + 0.45);
        }
        if (e.in_use_room_id && !e.room_id) mesh.position.z = room.z + room.d - 0.6;
      } else {
        storageItems.push(mesh);
        continue;
      }
      world.add(mesh);
    }
    // คลังอุปกรณ์ (เครื่องเคลื่อนย้ายได้ที่ไม่ได้ใช้)
    const sf = box(storage.w, 0.04, storage.d, theme.storage);
    sf.position.set(storage.x + storage.w / 2, 0.02, storage.z + storage.d / 2);
    world.add(sf);
    const sl = label('คลังอุปกรณ์', { size: 0.55, sub: 'เครื่องเคลื่อนย้ายได้ที่ว่าง' });
    sl.position.set(storage.x + storage.w / 2, 1.5, storage.z + 0.4);
    world.add(sl);
    storageItems.forEach((m, i) => {
      m.position.set(storage.x + 0.7 + (i % 4) * 0.85, 0, storage.z + 1.6 + Math.floor(i / 4) * 0.9);
      world.add(m);
    });

    if (firstBuild) { frame(); firstBuild = false; }
  }

  // ---------------------------------------------------------------- camera controls
  const target = new THREE.Vector3();
  const sph = { r: 30, theta: -0.3, phi: 0.72 };
  function applyCamera() {
    sph.phi = Math.min(1.45, Math.max(0.15, sph.phi));
    sph.r = Math.min(120, Math.max(4, sph.r));
    camera.position.set(
      target.x + sph.r * Math.sin(sph.phi) * Math.sin(sph.theta),
      target.y + sph.r * Math.cos(sph.phi),
      target.z + sph.r * Math.sin(sph.phi) * Math.cos(sph.theta),
    );
    camera.lookAt(target);
  }
  function frame() {
    const cx = (bounds.minX + bounds.maxX + 5) / 2;
    const cz = (bounds.minZ + bounds.maxZ) / 2;
    target.set(cx, 0, cz);
    const aspect = camera.aspect || 1.6;
    const span = Math.max((bounds.maxX - bounds.minX + 6) / aspect, bounds.maxZ - bounds.minZ);
    sph.r = span * 1.3 + 3;
    sun.target.position.copy(target);
    sun.position.set(cx - 18, 30, cz + 22);
    applyCamera();
  }

  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  function pick(ev) {
    const rect = renderer.domElement.getBoundingClientRect();
    ndc.set(((ev.clientX - rect.left) / rect.width) * 2 - 1, -((ev.clientY - rect.top) / rect.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const hit = ray.intersectObjects(world.children, true).find((h) => h.object.userData?.pick);
    return hit || null;
  }
  function groundPoint(ev) {
    const rect = renderer.domElement.getBoundingClientRect();
    ndc.set(((ev.clientX - rect.left) / rect.width) * 2 - 1, -((ev.clientY - rect.top) / rect.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const p = new THREE.Vector3();
    return ray.ray.intersectPlane(groundPlane, p) ? p : null;
  }

  const pointers = new Map();
  let drag = null;
  let pinchDist = 0;
  const el = renderer.domElement;
  el.addEventListener('contextmenu', (e) => e.preventDefault());
  el.addEventListener('pointerdown', (e) => {
    el.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
      drag = null;
      return;
    }
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
      if (pinchDist) sph.r *= pinchDist / d;
      pinchDist = d;
      applyCamera();
      return;
    }
    if (!drag) { hover(e); return; }
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    drag.moved += Math.abs(dx) + Math.abs(dy);
    drag.x = e.clientX;
    drag.y = e.clientY;
    if (drag.mode === 'rotate') {
      sph.theta -= dx * 0.006;
      sph.phi -= dy * 0.006;
    } else if (drag.mode === 'pan') {
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
    if (pointers.size < 2) pinchDist = 0;
    if (!drag) return;
    const d = drag;
    drag = null;
    if (d.mode === 'moveRoom' && d.moved > 4) {
      onRoomMove?.(d.group.userData.data, d.group.position.x, d.group.position.z);
      return;
    }
    if (d.moved < 6) {
      const hit = pick(e);
      onSelect(hit ? hit.object.userData : null);
    }
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
  el.addEventListener('wheel', (e) => { e.preventDefault(); sph.r *= Math.exp(e.deltaY * 0.0012); applyCamera(); }, { passive: false });

  // tooltip
  const tip = document.createElement('div');
  Object.assign(tip.style, {
    position: 'absolute', pointerEvents: 'none', padding: '4px 8px', borderRadius: '6px', fontSize: '12px',
    background: 'rgba(15,23,42,0.85)', color: '#fff', display: 'none', whiteSpace: 'nowrap', zIndex: 5,
  });
  if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
  container.appendChild(tip);
  function hover(e) {
    const hit = pick(e);
    if (!hit) { tip.style.display = 'none'; el.style.cursor = editable ? 'grab' : 'default'; return; }
    const { kind, data } = hit.object.userData;
    const text = kind === 'bed' ? `${data.roomCode} ${data.name} · ${STATE_TH[data.state]}${data.current ? ` · ${data.current.patient_name}` : ''}`
      : kind === 'equipment' ? `${data.name} (${data.asset_code})`
        : kind === 'gymPatient' ? `${data.patient_name} · ${data.therapist_name}`
          : `${data.code} ${data.name}`;
    const rect = container.getBoundingClientRect();
    tip.textContent = text;
    tip.style.left = `${e.clientX - rect.left + 12}px`;
    tip.style.top = `${e.clientY - rect.top + 12}px`;
    tip.style.display = 'block';
    el.style.cursor = editable && kind === 'room' ? 'move' : 'pointer';
  }

  // ---------------------------------------------------------------- loop & resize
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
  const loop = () => { renderer.render(scene, camera); raf = requestAnimationFrame(loop); };
  loop();

  return {
    update,
    frame,
    setEditable(v) { editable = Boolean(v); },
    setTheme(t) {
      theme = { ...DEFAULT_THEME, ...t };
      scene.background = new THREE.Color(theme.bg);
      if (lastBoard) update(lastBoard);
    },
    snapshot: () => { renderer.render(scene, camera); return renderer.domElement.toDataURL('image/png'); },
    dispose() {
      cancelAnimationFrame(raf);
      ro.disconnect();
      clear();
      renderer.dispose();
      renderer.domElement.remove();
      tip.remove();
    },
  };
}
