const path = require('node:path');

const env = process.env;

if (env.NODE_ENV === 'production' && !env.JWT_SECRET) {
  throw new Error('JWT_SECRET is required in production. On Railway: set JWT_SECRET (64 random hex characters) in this service\'s Variables (docs/DEPLOY-RAILWAY.md step 5).');
}
if (env.NODE_ENV === 'production' && !env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required in production. On Railway: set DATABASE_URL=${{Postgres.DATABASE_URL}} (docs/DEPLOY-RAILWAY.md step 2 and 5).');
}

module.exports = {
  port: Number(env.PORT || 3000),
  databaseUrl: env.DATABASE_URL || 'postgres://postgres@localhost:5432/physiocare',
  jwtSecret: env.JWT_SECRET || 'dev-only-secret-change-me',
  jwtExpiresIn: env.JWT_EXPIRES_IN || '8h',
  uploadDir: path.resolve(env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads')),
  maxUploadBytes: Number(env.MAX_UPLOAD_MB || 5) * 1024 * 1024,
  corsOrigin: env.CORS_ORIGIN || '',
  // URL สาธารณะของระบบ (ใช้แนบลิงก์ในข้อความ LINE) — Railway ตั้ง RAILWAY_PUBLIC_DOMAIN ให้อัตโนมัติ
  appBaseUrl: env.APP_BASE_URL || (env.RAILWAY_PUBLIC_DOMAIN ? `https://${env.RAILWAY_PUBLIC_DOMAIN}` : ''),
  frontendDir: path.resolve(__dirname, '..', '..', 'frontend'),
  loginMaxAttempts: 5,
  loginLockMinutes: 15,
};
