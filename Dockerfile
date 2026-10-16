# PhysioCare — production image (API + static frontend + migrations)
FROM node:22-alpine AS deps
WORKDIR /app/backend
COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:22-alpine
ENV NODE_ENV=production \
    PORT=3000 \
    UPLOAD_DIR=/data/uploads \
    MIGRATIONS_DIR=/app/db
WORKDIR /app
COPY --from=deps /app/backend/node_modules backend/node_modules
COPY backend/package.json backend/
COPY backend/src backend/src
COPY backend/scripts backend/scripts
COPY frontend frontend
COPY db db
RUN mkdir -p /data/uploads && chown -R node:node /data
USER node
WORKDIR /app/backend
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD wget -qO- http://127.0.0.1:3000/api/health >/dev/null || exit 1
# รัน migration ก่อนเริ่มเซิร์ฟเวอร์ทุกครั้ง (มี advisory lock กันรันซ้อน)
CMD ["sh", "-c", "node scripts/migrate.js && exec node src/server.js"]
