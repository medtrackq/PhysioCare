const jwt = require('jsonwebtoken');
const config = require('../config');
const db = require('../db');
const { unauthorized, forbidden } = require('../errors');

// cache สิทธิ์ตาม role (TTL 60s) — แก้สิทธิ์ใน DB แล้วมีผลภายใน 1 นาทีโดยไม่ต้อง login ใหม่
const permCache = new Map();
const PERM_TTL_MS = 60_000;

async function getRolePermissions(roleCode) {
  const hit = permCache.get(roleCode);
  if (hit && hit.expires > Date.now()) return hit.perms;
  const { rows } = await db.query(
    `SELECT rp.permission_code FROM role_permissions rp JOIN roles r ON r.id = rp.role_id WHERE r.code = $1`,
    [roleCode],
  );
  const perms = new Set(rows.map((r) => r.permission_code));
  permCache.set(roleCode, { perms, expires: Date.now() + PERM_TTL_MS });
  return perms;
}

function readCookie(req, name) {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

function signToken(user) {
  return jwt.sign(
    { sub: user.id, role: user.role, staffId: user.staff_id, patientId: user.patient_id, name: user.display_name },
    config.jwtSecret,
    { expiresIn: config.jwtExpiresIn },
  );
}

/**
 * Bearer token สำหรับทุก request
 * Cookie (httpOnly, SameSite=Strict) รับเฉพาะ GET — ใช้กับ <img src> และ EventSource (SSE)
 * ที่ตั้ง header เองไม่ได้ โดยไม่เปิดช่อง CSRF ให้คำสั่งที่เปลี่ยนแปลงข้อมูล
 */
async function authenticate(req, _res, next) {
  const header = req.headers.authorization || '';
  let token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token && req.method === 'GET') token = readCookie(req, 'pc_token');
  if (!token) throw unauthorized();

  let payload;
  try {
    payload = jwt.verify(token, config.jwtSecret);
  } catch {
    throw unauthorized('Session หมดอายุ กรุณาเข้าสู่ระบบใหม่');
  }
  req.user = {
    id: payload.sub,
    role: payload.role,
    staffId: payload.staffId || null,
    patientId: payload.patientId || null,
    name: payload.name,
    permissions: await getRolePermissions(payload.role),
  };
  next();
}

const can = (user, perm) => Boolean(user?.permissions?.has(perm));

/** ต้องมีอย่างน้อยหนึ่งสิทธิ์ในรายการ */
function authorize(...perms) {
  return (req, _res, next) => {
    if (!req.user) throw unauthorized();
    if (!perms.some((p) => can(req.user, p))) throw forbidden();
    next();
  };
}

module.exports = { authenticate, authorize, can, signToken, getRolePermissions };
