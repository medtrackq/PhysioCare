#!/bin/sh
# อัปเดตระบบเป็นเวอร์ชันล่าสุดอย่างปลอดภัย: สำรองข้อมูล -> ดึงโค้ด -> build -> ตรวจว่าระบบกลับมาทำงาน
#   sh update.sh
set -eu
cd "$(dirname "$0")"
[ -f .env ] || { echo "ไม่พบ deploy/.env — ทำขั้นตอนติดตั้งก่อน" >&2; exit 1; }
DOMAIN=$(sed -n 's/^DOMAIN=//p' .env)

echo "== 1/4 สำรองข้อมูลก่อนอัปเดต"
docker compose exec -T backup sh /backup.sh

echo "== 2/4 ดึงโค้ดล่าสุด"
BEFORE=$(git rev-parse --short HEAD)
git pull --ff-only
AFTER=$(git rev-parse --short HEAD)
echo "เวอร์ชัน $BEFORE -> $AFTER"

echo "== 3/4 build และเปิดระบบใหม่ (migration รันอัตโนมัติ)"
docker compose up -d --build

echo "== 4/4 ตรวจว่าระบบทำงาน"
i=0
until docker compose exec -T app wget -qO- http://127.0.0.1:3000/api/health >/dev/null 2>&1 || [ $i -ge 30 ]; do i=$((i + 1)); sleep 2; done
if ! docker compose exec -T app wget -qO- http://127.0.0.1:3000/api/health >/dev/null 2>&1; then
  echo "แอปยังไม่ตอบ — ดู log ด้วย: docker compose logs --tail=100 app" >&2
  echo "ย้อนกลับเวอร์ชันเดิมได้ด้วย: git checkout $BEFORE && docker compose up -d --build" >&2
  exit 1
fi
K=""; [ "$DOMAIN" = "localhost" ] && K="-k"   # localhost ใช้ใบรับรองภายในของ Caddy
if curl -fsS $K "https://$DOMAIN/api/health" >/dev/null 2>&1; then
  echo "สำเร็จ: https://$DOMAIN ทำงานปกติ"
else
  echo "แอปทำงานแล้ว แต่ยังเปิดผ่าน https://$DOMAIN ไม่ได้ — ตรวจ DNS/พอร์ต 80,443 และ docker compose logs caddy"
fi
