const db = require('../db');

let cache = null;
let cacheAt = 0;

async function getSettings(client = db) {
  if (cache && Date.now() - cacheAt < 30_000) return cache;
  const { rows } = await client.query('SELECT key, value FROM system_settings');
  const s = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  cache = {
    hours: s['clinic.hours'] || { open: '08:00', close: '20:00', days: [1, 2, 3, 4, 5, 6] },
    utcOffset: s['clinic.utc_offset'] || '+07:00',
    slotMinutes: Number(s['scheduling.slot_minutes'] || 30),
    defaultDuration: Number(s['scheduling.default_duration'] || 45),
    requirePreAssessment: s['emr.require_pre_assessment'] !== false,
    bedTurnoverMinutes: Number(s['scheduling.bed_turnover_minutes'] ?? 5),
    autoAssignSpace: s['scheduling.auto_assign_space'] !== false,
    raw: s,
  };
  cacheAt = Date.now();
  return cache;
}

const invalidateSettings = () => { cache = null; };

module.exports = { getSettings, invalidateSettings };
