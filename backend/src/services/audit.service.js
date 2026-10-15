const db = require('../db');

/** บันทึก audit log (ไม่ throw — การ log ล้มเหลวต้องไม่ทำให้ธุรกรรมหลักล้ม) */
async function audit(req, action, entityType, entityId, detail, client = db) {
  try {
    await client.query(
      `INSERT INTO audit_logs (user_id, action, entity_type, entity_id, ip, user_agent, detail)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [req.user?.id || null, action, entityType, entityId || null, req.ip || null,
        req.headers?.['user-agent']?.slice(0, 255) || null, detail ? JSON.stringify(detail) : null],
    );
  } catch (e) {
    console.error('audit failed', e.message);
  }
}

module.exports = { audit };
