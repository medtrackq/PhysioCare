const config = require('./config');
const { createApp } = require('./app');
const sse = require('./realtime/sse');
const { pool } = require('./db');
const outbox = require('./services/integration/outbox.service');
const notify = require('./services/notify.service');

async function main() {
  await sse.startListener();
  // ส่งข้อมูลกลับ HIS (ทำงานเฉพาะเมื่อมี connector ที่เปิดส่งกลับ) — ปิดได้ด้วย INTEGRATION_WORKER=false
  if (process.env.INTEGRATION_WORKER !== 'false') outbox.startWorker();
  // แจ้งเตือนทาง LINE (ทำงานเมื่อ notify.enabled = true) — ปิดได้ด้วย NOTIFY_WORKER=false
  if (process.env.NOTIFY_WORKER !== 'false') notify.startWorker();
  const server = createApp().listen(config.port, () => {
    console.log(`PhysioCare API listening on http://localhost:${config.port}`);
  });
  const shutdown = async () => {
    server.close();
    outbox.stopWorker();
    notify.stopWorker();
    await sse.stopListener();
    await pool.end();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
