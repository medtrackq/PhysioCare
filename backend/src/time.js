// คลินิกใช้ Asia/Bangkok (UTC+7, ไม่มี DST) — ใช้ offset คงที่จาก settings
const DEFAULT_OFFSET = '+07:00';

/** 'YYYY-MM-DD' + 'HH:MM' (เวลาท้องถิ่น) -> Date (UTC) */
function localToDate(date, hhmm, offset = DEFAULT_OFFSET) {
  return new Date(`${date}T${hhmm}:00${offset}`);
}

function offsetMinutes(offset = DEFAULT_OFFSET) {
  const sign = offset.startsWith('-') ? -1 : 1;
  const [h, m] = offset.slice(1).split(':').map(Number);
  return sign * (h * 60 + m);
}

/** Date -> { date:'YYYY-MM-DD', hhmm:'HH:MM', isoDow:1..7 } ตามเวลาท้องถิ่น */
function toLocalParts(d, offset = DEFAULT_OFFSET) {
  const local = new Date(d.getTime() + offsetMinutes(offset) * 60000);
  const iso = local.toISOString();
  const dow = local.getUTCDay();
  return { date: iso.slice(0, 10), hhmm: iso.slice(11, 16), isoDow: dow === 0 ? 7 : dow };
}

function addMinutes(d, min) {
  return new Date(d.getTime() + min * 60000);
}

const overlaps = (aS, aE, bS, bE) => aS < bE && bS < aE;

module.exports = { localToDate, toLocalParts, addMinutes, overlaps, offsetMinutes };
