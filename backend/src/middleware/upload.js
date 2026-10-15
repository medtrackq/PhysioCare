const multer = require('multer');
const config = require('../config');
const { badRequest } = require('../errors');

const ALLOWED = new Set(['image/jpeg', 'image/png', 'image/webp']);

// เก็บใน memory เพื่อตรวจ magic bytes + sha256 ก่อนเขียนลง storage
module.exports = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxUploadBytes, files: 10 },
  fileFilter: (_req, file, cb) => (ALLOWED.has(file.mimetype) ? cb(null, true) : cb(badRequest('รองรับเฉพาะ JPEG/PNG/WebP'))),
});
