const crypto = require('node:crypto');
const db = require('../db');
const storage = require('../storage/local');
const { badRequest, notFound, forbidden } = require('../errors');
const { can } = require('../middleware/auth');

// ตรวจชนิดไฟล์จาก magic bytes (ไม่เชื่อ mimetype/นามสกุลที่ client ส่งมา)
function sniffImage(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg' };
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { mime: 'image/png', ext: 'png' };
  if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return { mime: 'image/webp', ext: 'webp' };
  return null;
}

// สิทธิ์อ่าน/เขียนรูปตามประเภท entity
const READ_PERM = {
  equipment: ['equipment:read'], staff: ['staff:read'], user: ['users:manage'],
  maintenance: ['equipment:read'], patient: ['patients:read'], assessment: ['emr:read'],
};
const WRITE_PERM = {
  equipment: ['equipment:write', 'equipment:status'], staff: ['staff:write'], user: ['users:manage'],
  maintenance: ['maintenance:write'], patient: ['patients:write'], assessment: ['emr:write'],
};
const ENTITY_TABLE = {
  equipment: 'equipment', staff: 'staff', user: 'users', maintenance: 'equipment_maintenance',
  patient: 'patients', assessment: 'clinical_assessments',
};

function assertCan(user, map, entityType) {
  if (!(map[entityType] || []).some((p) => can(user, p))) throw forbidden();
}

async function assertEntityExists(entityType, entityId) {
  const { rowCount } = await db.query(`SELECT 1 FROM ${ENTITY_TABLE[entityType]} WHERE id = $1`, [entityId]);
  if (!rowCount) throw notFound('ข้อมูลที่จะแนบรูป');
}

async function saveImages(user, entityType, entityId, files, { kind = 'photo', caption = null, makePrimary = false } = {}) {
  assertCan(user, WRITE_PERM, entityType);
  await assertEntityExists(entityType, entityId);
  if (!files?.length) throw badRequest('ไม่พบไฟล์รูปภาพ (field: images)');

  const prepared = files.map((f) => {
    const type = sniffImage(f.buffer);
    if (!type) throw badRequest(`ไฟล์ ${f.originalname} ไม่ใช่รูป JPEG/PNG/WebP`);
    const now = new Date();
    const key = `${entityType}/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${crypto.randomUUID()}.${type.ext}`;
    return { f, type, key, sha256: crypto.createHash('sha256').update(f.buffer).digest('hex') };
  });

  for (const p of prepared) await storage.put(p.key, p.f.buffer);
  try {
    return await db.withTx(async (c) => {
      const out = [];
      const hasPrimary = (await c.query(
        'SELECT 1 FROM media_files WHERE entity_type = $1 AND entity_id = $2 AND is_primary', [entityType, entityId])).rowCount > 0;
      if (makePrimary) await c.query('UPDATE media_files SET is_primary = false WHERE entity_type = $1 AND entity_id = $2', [entityType, entityId]);
      for (const [i, p] of prepared.entries()) {
        const primary = i === 0 && (makePrimary || !hasPrimary);
        const { rows: [m] } = await c.query(
          `INSERT INTO media_files (entity_type, entity_id, kind, storage_key, original_name, mime_type, size_bytes, sha256, caption, is_primary, uploaded_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
           RETURNING id, entity_type, entity_id, kind, mime_type, size_bytes, caption, is_primary, created_at`,
          [entityType, entityId, kind, p.key, p.f.originalname?.slice(0, 200), p.type.mime, p.f.size, p.sha256, caption, primary, user.id]);
        out.push({ ...m, url: `/api/media/${m.id}` });
      }
      return out;
    });
  } catch (e) {
    await Promise.all(prepared.map((p) => storage.remove(p.key))); // rollback ไฟล์
    throw e;
  }
}

async function getForRead(user, id) {
  const { rows: [m] } = await db.query('SELECT * FROM media_files WHERE id = $1', [id]);
  if (!m) throw notFound('รูปภาพ');
  // ผู้ป่วยดูรูปโปรไฟล์ตัวเองได้
  const ownPatient = m.entity_type === 'patient' && user.patientId === m.entity_id;
  if (!ownPatient) assertCan(user, READ_PERM, m.entity_type);
  return m;
}

async function list(user, entityType, entityId) {
  assertCan(user, READ_PERM, entityType);
  const { rows } = await db.query(
    `SELECT id, kind, mime_type, size_bytes, caption, is_primary, created_at FROM media_files
      WHERE entity_type = $1 AND entity_id = $2 ORDER BY is_primary DESC, created_at DESC`, [entityType, entityId]);
  return rows.map((r) => ({ ...r, url: `/api/media/${r.id}` }));
}

async function remove(user, id) {
  const { rows: [m] } = await db.query('SELECT * FROM media_files WHERE id = $1', [id]);
  if (!m) throw notFound('รูปภาพ');
  assertCan(user, WRITE_PERM, m.entity_type);
  if (m.entity_type === 'assessment') throw forbidden('รูปในเวชระเบียนลบไม่ได้ (เก็บเป็นหลักฐานทางการแพทย์)');
  await db.query('DELETE FROM media_files WHERE id = $1', [id]);
  await storage.remove(m.storage_key);
}

async function setPrimary(user, id) {
  const { rows: [m] } = await db.query('SELECT * FROM media_files WHERE id = $1', [id]);
  if (!m) throw notFound('รูปภาพ');
  assertCan(user, WRITE_PERM, m.entity_type);
  await db.withTx(async (c) => {
    await c.query('UPDATE media_files SET is_primary = false WHERE entity_type = $1 AND entity_id = $2', [m.entity_type, m.entity_id]);
    await c.query('UPDATE media_files SET is_primary = true WHERE id = $1', [id]);
  });
}

module.exports = { saveImages, getForRead, list, remove, setPrimary, sniffImage, storage };
