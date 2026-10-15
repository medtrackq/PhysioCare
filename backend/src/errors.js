class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const badRequest = (msg, details) => new AppError(400, 'BAD_REQUEST', msg, details);
const unauthorized = (msg = 'กรุณาเข้าสู่ระบบ') => new AppError(401, 'UNAUTHORIZED', msg);
const forbidden = (msg = 'ไม่มีสิทธิ์เข้าถึงข้อมูลนี้') => new AppError(403, 'FORBIDDEN', msg);
const notFound = (what = 'ข้อมูล') => new AppError(404, 'NOT_FOUND', `ไม่พบ${what}`);
const conflict = (code, msg, details) => new AppError(409, code, msg, details);
const unprocessable = (code, msg, details) => new AppError(422, code, msg, details);

module.exports = { AppError, badRequest, unauthorized, forbidden, notFound, conflict, unprocessable };
