const express = require('express');
const helmet = require('helmet');
const config = require('./config');
const { errorHandler } = require('./middleware/errorHandler');

function createApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'", 'https://cdn.tailwindcss.com', 'https://cdnjs.cloudflare.com'],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com'],
        imgSrc: ["'self'", 'data:', 'blob:'],
        connectSrc: ["'self'"],
      },
    },
  }));
  if (config.corsOrigin) {
    app.use((req, res, next) => {
      res.setHeader('Access-Control-Allow-Origin', config.corsOrigin);
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
      if (req.method === 'OPTIONS') return res.status(204).end();
      next();
    });
  }
  const json = express.json({ limit: '1mb' });
  // FHIR Bundle จาก HIS อาจใหญ่กว่าปกติ และใช้ content-type application/fhir+json
  const fhirJson = express.json({ limit: '10mb', type: ['application/json', 'application/fhir+json'] });
  // ข้อมูลที่เข้ารหัสชั้นที่ 2 (JWE compact) มาเป็นข้อความ application/jose
  const jose = express.text({ limit: '14mb', type: 'application/jose' });
  // LINE webhook: ต้องใช้ raw body ตรวจลายเซ็น
  const raw = express.raw({ type: '*/*', limit: '1mb' });
  app.use((req, res, next) => {
    if (req.path === '/api/line/webhook') return raw(req, res, next);
    if (!req.path.startsWith('/api/integration/')) return json(req, res, next);
    return fhirJson(req, res, (err) => (err ? next(err) : jose(req, res, next)));
  });
  app.use('/api', require('./routes'));
  app.use('/api', (_req, res) => res.status(404).json({ error: { code: 'NOT_FOUND', message: 'ไม่พบ endpoint' } }));
  app.use(express.static(config.frontendDir, { extensions: ['html'] }));
  app.use(errorHandler);
  return app;
}

module.exports = { createApp };
