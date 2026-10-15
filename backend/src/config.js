const path = require('node:path');

const env = process.env;

if (env.NODE_ENV === 'production' && !env.JWT_SECRET) {
  throw new Error('JWT_SECRET is required in production');
}

module.exports = {
  port: Number(env.PORT || 3000),
  databaseUrl: env.DATABASE_URL || 'postgres://postgres@localhost:5432/physiocare',
  jwtSecret: env.JWT_SECRET || 'dev-only-secret-change-me',
  jwtExpiresIn: env.JWT_EXPIRES_IN || '8h',
  uploadDir: path.resolve(env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads')),
  maxUploadBytes: Number(env.MAX_UPLOAD_MB || 5) * 1024 * 1024,
  corsOrigin: env.CORS_ORIGIN || '',
  frontendDir: path.resolve(__dirname, '..', '..', 'frontend'),
  loginMaxAttempts: 5,
  loginLockMinutes: 15,
};
