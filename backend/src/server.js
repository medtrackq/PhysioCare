const config = require('./config');
const { createApp } = require('./app');
const sse = require('./realtime/sse');
const { pool } = require('./db');

async function main() {
  await sse.startListener();
  const server = createApp().listen(config.port, () => {
    console.log(`PhysioCare API listening on http://localhost:${config.port}`);
  });
  const shutdown = async () => {
    server.close();
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
