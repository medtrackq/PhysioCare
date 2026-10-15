const { Pool, types } = require('pg');
const config = require('./config');

// NUMERIC -> number, BIGINT(count) -> number
types.setTypeParser(1700, (v) => (v === null ? null : parseFloat(v)));
types.setTypeParser(20, (v) => (v === null ? null : parseInt(v, 10)));

const pool = new Pool({ connectionString: config.databaseUrl, max: 20 });

/**
 * รันฟังก์ชันภายใน transaction พร้อมผูก user ปัจจุบันไว้กับ session
 * (trigger ในฐานข้อมูลอ่านค่า app.user_id / app.status_reason ได้)
 */
async function withTx(fn, { userId, statusReason } = {}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (userId) await client.query("SELECT set_config('app.user_id', $1, true)", [userId]);
    if (statusReason) await client.query("SELECT set_config('app.status_reason', $1, true)", [statusReason]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, withTx, query: (text, params) => pool.query(text, params) };
