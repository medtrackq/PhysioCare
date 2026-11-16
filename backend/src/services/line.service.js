/**
 * LINE Messaging API (ใช้กับ LINE Official Account ของคลินิก)
 *
 * ค่าการเชื่อมต่ออยู่ใน environment เท่านั้น (ไม่เก็บในฐานข้อมูล):
 *   LINE_CHANNEL_SECRET        ใช้ตรวจลายเซ็น webhook (X-Line-Signature)
 *   LINE_CHANNEL_ACCESS_TOKEN  ใช้ส่งข้อความ (push / reply)
 *   LINE_API_BASE              (ใช้ตอนทดสอบเท่านั้น) ค่าเริ่มต้น https://api.line.me
 */
const crypto = require('node:crypto');

const secret = () => process.env.LINE_CHANNEL_SECRET || '';
const token = () => process.env.LINE_CHANNEL_ACCESS_TOKEN || '';
const apiBase = () => (process.env.LINE_API_BASE || 'https://api.line.me').replace(/\/+$/, '');

const configured = () => Boolean(secret() && token());

/** ตรวจว่า webhook มาจาก LINE จริง: HMAC-SHA256(channel secret, raw body) แบบ base64 */
function verifySignature(rawBody, signature) {
  if (!secret() || !signature || !Buffer.isBuffer(rawBody)) return false;
  const expected = crypto.createHmac('sha256', secret()).update(rawBody).digest();
  let given;
  try { given = Buffer.from(String(signature), 'base64'); } catch { return false; }
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

class LineError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function call(path, body) {
  if (!token()) throw new LineError(0, 'ยังไม่ได้ตั้ง LINE_CHANNEL_ACCESS_TOKEN');
  const res = await fetch(`${apiBase()}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${token()}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
    redirect: 'error',
  });
  if (!res.ok) {
    const text = (await res.text().catch(() => '')).slice(0, 300);
    throw new LineError(res.status, `LINE API ${res.status}${text ? `: ${text}` : ''}`);
  }
  return res.headers.get('content-type')?.includes('json') ? res.json() : {};
}

const textMessages = (texts) => (Array.isArray(texts) ? texts : [texts]).slice(0, 5).map((t) => ({ type: 'text', text: String(t).slice(0, 5000) }));

async function push(to, texts) {
  return call('/v2/bot/message/push', { to, messages: textMessages(texts) });
}
async function reply(replyToken, texts) {
  return call('/v2/bot/message/reply', { replyToken, messages: textMessages(texts) });
}
async function profile(userId) {
  try { return await call(`/v2/bot/profile/${encodeURIComponent(userId)}`); } catch { return null; }
}

module.exports = { configured, verifySignature, push, reply, profile, LineError };
