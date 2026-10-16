const { AppError } = require('../errors');

/**
 * Rate limiter แบบ fixed window ในหน่วยความจำ (เหมาะกับ instance เดียว;
 * ถ้ารันหลาย instance ให้ย้ายไปเก็บใน Redis/PostgreSQL หรือทำที่ reverse proxy)
 */
function rateLimit({ windowMs, max, key = (req) => req.ip, message = 'คำขอมากเกินไป กรุณาลองใหม่ภายหลัง' }) {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.reset <= now) hits.delete(k);
  }, windowMs).unref();

  return (req, res, next) => {
    const k = key(req);
    const now = Date.now();
    let h = hits.get(k);
    if (!h || h.reset <= now) { h = { count: 0, reset: now + windowMs }; hits.set(k, h); }
    h.count += 1;
    if (h.count > max) {
      res.setHeader('Retry-After', Math.ceil((h.reset - now) / 1000));
      throw new AppError(429, 'RATE_LIMITED', message);
    }
    next();
  };
}

module.exports = { rateLimit };
