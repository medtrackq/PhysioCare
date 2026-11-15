/**
 * เข้ารหัสข้อมูลชั้นที่ 2 (นอกเหนือจาก HTTPS) ด้วยมาตรฐาน JWE (RFC 7516) แบบ compact
 *   alg = "dir" (ใช้กุญแจร่วมโดยตรง), enc = "A256GCM" (AES-256-GCM: เข้ารหัส + ตรวจว่าไม่ถูกแก้ไข)
 *
 * protected header: { alg, enc, kid: <รหัส connector>, iat: <วินาที>, jti: <สุ่ม>, cty: "fhir+json" }
 * - kid ผูกข้อความกับ connector (เอาข้อความของโรงพยาบาลหนึ่งไปส่งอีก connector ไม่ได้)
 * - iat + jti กันการส่งซ้ำ (replay) — รับเฉพาะข้อความอายุไม่เกิน 5 นาที และ jti ที่ยังไม่เคยเห็น
 * ฝ่าย IT ใช้ไลบรารี JOSE มาตรฐานได้ทันที (jose / Nimbus / jose-jwt / jwcrypto)
 */
const crypto = require('node:crypto');

const MAX_AGE_SEC = 300;
const b64u = (buf) => Buffer.from(buf).toString('base64url');
const fromB64u = (s) => Buffer.from(s, 'base64url');

function parseKey(raw) {
  if (!raw) throw new Error('ยังไม่ได้ตั้งกุญแจเข้ารหัสในเซิร์ฟเวอร์');
  const s = String(raw).trim();
  const key = /^[0-9a-f]{64}$/i.test(s) ? Buffer.from(s, 'hex') : Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  if (key.length !== 32) throw new Error('กุญแจเข้ารหัสต้องยาว 32 ไบต์ (256 บิต)');
  return key;
}

function encrypt(payload, rawKey, { kid }) {
  const key = parseKey(rawKey);
  const header = { alg: 'dir', enc: 'A256GCM', kid, iat: Math.floor(Date.now() / 1000), jti: crypto.randomUUID(), cty: 'fhir+json' };
  const protectedB64 = b64u(JSON.stringify(header));
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(protectedB64, 'ascii'));
  const ct = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  return `${protectedB64}..${b64u(iv)}.${b64u(ct)}.${b64u(cipher.getAuthTag())}`;
}

// jti ที่เห็นแล้ว (ต่อ process; อายุเท่ากับช่วงเวลาที่รับข้อความ)
const seen = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [k, exp] of seen) if (exp < now) seen.delete(k);
}, 60_000).unref();

class JweError extends Error {}

function decrypt(compact, rawKey, { kid, checkReplay = true } = {}) {
  const parts = String(compact).trim().split('.');
  if (parts.length !== 5) throw new JweError('รูปแบบ JWE ไม่ถูกต้อง (ต้องเป็น compact 5 ส่วน)');
  const [protectedB64, encKey, ivB64, ctB64, tagB64] = parts;
  let header;
  try { header = JSON.parse(fromB64u(protectedB64).toString('utf8')); } catch { throw new JweError('JWE header อ่านไม่ได้'); }
  if (header.alg !== 'dir' || header.enc !== 'A256GCM') throw new JweError('รองรับเฉพาะ alg=dir, enc=A256GCM');
  if (encKey !== '') throw new JweError('alg=dir ต้องไม่มี encrypted key');
  if (kid && header.kid !== kid) throw new JweError('kid ไม่ตรงกับการเชื่อมต่อนี้');
  const key = parseKey(rawKey);
  let plain;
  try {
    const iv = fromB64u(ivB64);
    if (iv.length !== 12) throw new Error('iv');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(Buffer.from(protectedB64, 'ascii'));
    decipher.setAuthTag(fromB64u(tagB64));
    plain = Buffer.concat([decipher.update(fromB64u(ctB64)), decipher.final()]).toString('utf8');
  } catch {
    throw new JweError('ถอดรหัสไม่ได้ — กุญแจไม่ตรงหรือข้อมูลถูกแก้ไขระหว่างทาง');
  }
  if (checkReplay) {
    const now = Math.floor(Date.now() / 1000);
    if (!Number.isInteger(header.iat) || Math.abs(now - header.iat) > MAX_AGE_SEC) throw new JweError('ข้อความหมดอายุหรือเวลาเครื่องไม่ตรง (iat ต้องห่างไม่เกิน 5 นาที)');
    if (!header.jti) throw new JweError('ต้องมี jti (ค่าสุ่มไม่ซ้ำ) ใน header');
    const k = `${header.kid}:${header.jti}`;
    if (seen.has(k)) throw new JweError('ข้อความนี้ถูกส่งมาแล้ว (replay)');
    seen.set(k, Date.now() + MAX_AGE_SEC * 2000);
  }
  try { return { header, payload: JSON.parse(plain) }; } catch { throw new JweError('เนื้อหาที่ถอดรหัสแล้วไม่ใช่ JSON'); }
}

module.exports = { encrypt, decrypt, parseKey, JweError, MAX_AGE_SEC };
