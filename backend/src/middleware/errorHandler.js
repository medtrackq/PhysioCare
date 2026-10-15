const { AppError } = require('../errors');
const multer = require('multer');

// แปลง error ของ PostgreSQL เป็น HTTP status ที่เหมาะสม
const PG_ERRORS = {
  '23P01': [409, 'RESOURCE_CONFLICT', 'ช่วงเวลานี้ถูกจองแล้ว (ตรวจพบโดยฐานข้อมูล)'],
  '23505': [409, 'DUPLICATE', 'ข้อมูลซ้ำกับที่มีอยู่แล้ว'],
  '23503': [400, 'INVALID_REFERENCE', 'อ้างอิงข้อมูลที่ไม่มีอยู่'],
  '23514': [400, 'CHECK_VIOLATION', 'ข้อมูลไม่ผ่านเงื่อนไขของระบบ'],
  '22P02': [400, 'INVALID_INPUT', 'รูปแบบข้อมูลไม่ถูกต้อง'],
};

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, _next) {
  if (err instanceof AppError) {
    return res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
  }
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ error: { code: 'UPLOAD_ERROR', message: err.message } });
  }
  if (err.code === 'P0001' && err.hint === 'EMR_LOCKED') {
    return res.status(409).json({ error: { code: 'EMR_LOCKED', message: 'เวชระเบียนลงนามแล้ว แก้ไขไม่ได้ (ใช้ Addendum)' } });
  }
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: { code: 'INVALID_JSON', message: 'JSON ไม่ถูกต้อง' } });
  }
  const mapped = PG_ERRORS[err.code];
  if (mapped) {
    return res.status(mapped[0]).json({ error: { code: mapped[1], message: mapped[2], details: { constraint: err.constraint } } });
  }
  console.error(`[${req.method} ${req.originalUrl}]`, err);
  return res.status(500).json({ error: { code: 'INTERNAL', message: 'เกิดข้อผิดพลาดภายในระบบ' } });
}

module.exports = { errorHandler };
