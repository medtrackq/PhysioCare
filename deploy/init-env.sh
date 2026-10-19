#!/bin/sh
# สร้างไฟล์ deploy/.env พร้อมรหัสลับแบบสุ่ม
#   sh init-env.sh physio.yourclinic.co.th
# ไม่เขียนทับ .env ที่มีอยู่แล้ว (รหัสฐานข้อมูลถูกกำหนดตอนสร้างฐานข้อมูลครั้งแรก เปลี่ยนภายหลังไม่ได้ง่าย ๆ)
set -eu
cd "$(dirname "$0")"
DOMAIN="${1:-}"
if [ -z "$DOMAIN" ]; then
  printf 'โดเมนของระบบ (เช่น physio.yourclinic.co.th): '
  read -r DOMAIN
fi
case "$DOMAIN" in
  ""|*" "*|http*) echo "โดเมนไม่ถูกต้อง: ใส่เฉพาะชื่อโดเมน เช่น physio.yourclinic.co.th" >&2; exit 1 ;;
esac
if [ -f .env ]; then
  echo "มีไฟล์ .env อยู่แล้ว — ไม่เขียนทับ (ลบเองถ้าต้องการสร้างใหม่ และยังไม่เคยเปิดระบบ)" >&2
  exit 1
fi
command -v openssl >/dev/null || { echo "ต้องติดตั้ง openssl ก่อน: sudo apt install -y openssl" >&2; exit 1; }
umask 077
cat > .env <<ENV
DOMAIN=$DOMAIN
POSTGRES_PASSWORD=$(openssl rand -hex 32)
JWT_SECRET=$(openssl rand -hex 32)
JWT_EXPIRES_IN=8h
MAX_UPLOAD_MB=5
BACKUP_KEEP_DAYS=14
BACKUP_HOUR=02
ENV
echo "สร้าง $(pwd)/.env แล้ว (สิทธิ์ 600) — เก็บสำเนาไฟล์นี้ไว้ในที่ปลอดภัยนอกเซิร์ฟเวอร์ด้วย"
