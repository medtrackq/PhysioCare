import { api, setToken, hasToken } from './api.js';
import { $, esc, toast } from './ui.js';

const ROLE_TH = { admin: 'ผู้ดูแลระบบ', therapist: 'นักกายภาพบำบัด', staff: 'เจ้าหน้าที่', patient: 'ผู้ป่วย' };

// เมนูแสดงตามสิทธิ์ (permission) ไม่ใช่ตาม role ตรง ๆ
const ROUTES = [
  { path: 'dashboard', label: 'ภาพรวม', icon: '📊', perm: ['appointments:read_all', 'reports:view'], load: () => import('./views/dashboard.js') },
  { path: 'schedule', label: 'ตารางนัดหมาย', icon: '🗓️', perm: ['appointments:read_all'], load: () => import('./views/schedule.js') },
  { path: 'equipment', label: 'อุปกรณ์', icon: '🛠️', perm: ['equipment:read'], load: () => import('./views/equipment.js') },
  { path: 'staff', label: 'บุคลากร & กะ', icon: '👩‍⚕️', perm: ['staff:read'], load: () => import('./views/staff.js') },
  { path: 'guidelines', label: 'แนวทางการรักษา', icon: '📚', perm: ['patients:read', 'emr:read'], load: () => import('./views/knowledge.js') },
  { path: 'emr', label: 'เวชระเบียน', icon: '📝', perm: ['emr:read'], load: () => import('./views/emr.js'), hidden: true },
  { path: 'progress', label: 'ความก้าวหน้า', icon: '📈', perm: ['emr:read'], load: () => import('./views/emr.js'), hidden: true },
  { path: 'my', label: 'นัดหมายของฉัน', icon: '🗓️', perm: ['appointments:read_own'], load: () => import('./views/my.js') },
  { path: 'admin', label: 'ผู้ใช้ & ตั้งค่า', icon: '⚙️', perm: ['users:manage', 'settings:manage'], load: () => import('./views/admin.js') },
  { path: 'reports', label: 'รายงานสถิติ', icon: '📑', perm: ['reports:view'], load: () => import('./views/admin.js') },
];

export const session = { user: null, can: (p) => session.user?.permissions.includes(p) };

function allowedRoutes() {
  return ROUTES.filter((r) => r.perm.some((p) => session.can(p)));
}

function renderNav(active) {
  $('#nav').innerHTML = allowedRoutes().filter((r) => !r.hidden).map((r) => `
    <a href="#/${r.path}" class="flex items-center gap-2 whitespace-nowrap rounded-lg px-3 py-2 text-sm ${r.path === active ? 'bg-brand-50 text-brand-700 font-semibold' : 'text-slate-600 hover:bg-slate-50'}">
      <span aria-hidden="true">${r.icon}</span>${esc(r.label)}</a>`).join('');
}

let cleanup = null;
async function route() {
  const [path, ...params] = location.hash.replace(/^#\/?/, '').split('/');
  const routes = allowedRoutes();
  const r = routes.find((x) => x.path === path) || routes.find((x) => !x.hidden);
  if (!r) { $('#view').innerHTML = '<p>ไม่มีเมนูที่เข้าถึงได้</p>'; return; }
  renderNav(r.path);
  if (typeof cleanup === 'function') cleanup();
  cleanup = null;
  $('#view').innerHTML = '<div class="text-slate-400 text-sm">กำลังโหลด…</div>';
  try {
    const mod = await r.load();
    cleanup = await mod.render($('#view'), { route: r.path, params, session });
  } catch (e) {
    $('#view').innerHTML = `<div class="text-rose-600">${esc(e.message)}</div>`;
  }
}

// ---------- Real-time (SSE) -> window events ----------
let es = null;
function connectRealtime() {
  if (!session.can('equipment:read') && !session.can('appointments:read_all')) return;
  es = new EventSource('/api/realtime/stream');
  const dot = $('#live-dot');
  const txt = $('#live-text');
  es.onopen = () => { dot.className = 'w-2 h-2 rounded-full bg-emerald-500'; txt.textContent = 'live'; };
  es.onerror = () => { dot.className = 'w-2 h-2 rounded-full bg-amber-500'; txt.textContent = 'reconnecting…'; };
  for (const ev of ['equipment_status', 'appointment_changed']) {
    es.addEventListener(ev, (m) => window.dispatchEvent(new CustomEvent(ev, { detail: JSON.parse(m.data) })));
  }
}

async function boot() {
  if (!hasToken()) return showLogin();
  try {
    session.user = await api.get('/auth/me');
  } catch {
    return showLogin();
  }
  $('#login-view').classList.add('hidden');
  $('#app-view').classList.remove('hidden');
  $('#me-name').textContent = session.user.name;
  $('#me-role').textContent = ROLE_TH[session.user.role] || session.user.role;
  connectRealtime();
  window.addEventListener('hashchange', route);
  route();
}

function showLogin() {
  $('#app-view').classList.add('hidden');
  $('#login-view').classList.remove('hidden');
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  try {
    const r = await api.post('/auth/login', { email: f.get('email'), password: f.get('password') });
    setToken(r.token);
    location.hash = '';
    boot();
  } catch (err) {
    const el = $('#login-error');
    el.textContent = err.message;
    el.classList.remove('hidden');
  }
});

$('#logout').addEventListener('click', async () => {
  await api.post('/auth/logout').catch(() => {});
  setToken(null);
  es?.close();
  location.hash = '';
  location.reload();
});

window.addEventListener('equipment_status', (e) => {
  const d = e.detail;
  if (['broken', 'maintenance'].includes(d.to)) toast(`${d.name}: เปลี่ยนสถานะเป็น ${d.to}`, 'warn');
});

boot();
