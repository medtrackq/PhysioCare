#!/bin/sh
# สำรอง PostgreSQL (pg_dump custom format) + ไฟล์รูปภาพ แล้วลบไฟล์ที่เก่ากว่า BACKUP_KEEP_DAYS
#   sh backup.sh          สำรองทันที 1 ครั้ง
#   sh backup.sh --loop   สำรองทุกวันเวลา BACKUP_HOUR (ใช้ใน container)
set -eu
# ไฟล์สำรองมีข้อมูลสุขภาพ (PDPA) — ให้เจ้าของอ่านได้คนเดียว
umask 077
OUT=${BACKUP_DIR:-/backups}
KEEP=${BACKUP_KEEP_DAYS:-14}

run_backup() {
  ts=$(date +%Y%m%d-%H%M%S)
  mkdir -p "$OUT"
  pg_dump -Fc -f "$OUT/db-$ts.dump.tmp" && mv "$OUT/db-$ts.dump.tmp" "$OUT/db-$ts.dump"
  if [ -d /uploads ]; then tar -czf "$OUT/uploads-$ts.tar.gz" -C /uploads .; fi
  find "$OUT" -name 'db-*.dump' -mtime +"$KEEP" -delete
  find "$OUT" -name 'uploads-*.tar.gz' -mtime +"$KEEP" -delete
  echo "[backup] $ts done"
}

if [ "${1:-}" = "--loop" ]; then
  while true; do
    if [ "$(date +%H)" = "${BACKUP_HOUR:-02}" ] && [ ! -f "$OUT/.done-$(date +%Y%m%d)" ]; then
      run_backup && rm -f "$OUT"/.done-* && touch "$OUT/.done-$(date +%Y%m%d)"
    fi
    sleep 300
  done
else
  run_backup
fi
