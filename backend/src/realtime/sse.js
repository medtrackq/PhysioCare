/**
 * Real-time push ด้วย Server-Sent Events
 * แหล่งข้อมูลคือ PostgreSQL LISTEN/NOTIFY (trigger ใน DB) -> ทำงานถูกต้องแม้รัน API หลาย instance
 * เพราะทุก instance LISTEN ช่องเดียวกันและ push ให้ client ของตัวเอง
 */
const { Client } = require('pg');
const config = require('../config');
const { can } = require('../middleware/auth');

const CHANNELS = { equipment_status: 'equipment:read', appointment_changed: 'appointments:read_all' };
const clients = new Set();
let listener = null;
let stopping = false;

function handler(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n: connected\n\n');
  const client = { res, user: req.user };
  clients.add(client);
  const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
  req.on('close', () => {
    clearInterval(ping);
    clients.delete(client);
  });
}

function broadcast(event, data) {
  const perm = CHANNELS[event];
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) {
    if (!perm || can(c.user, perm)) c.res.write(msg);
  }
}

async function startListener() {
  stopping = false;
  listener = new Client({ connectionString: config.databaseUrl });
  listener.on('notification', (n) => {
    try { broadcast(n.channel, JSON.parse(n.payload)); } catch { /* ignore malformed */ }
  });
  listener.on('error', (e) => {
    console.error('[sse] listener error', e.message);
    if (!stopping) setTimeout(() => startListener().catch(() => {}), 3000);
  });
  await listener.connect();
  for (const ch of Object.keys(CHANNELS)) await listener.query(`LISTEN ${ch}`);
}

async function stopListener() {
  stopping = true;
  for (const c of clients) c.res.end();
  clients.clear();
  if (listener) await listener.end().catch(() => {});
}

module.exports = { handler, broadcast, startListener, stopListener };
