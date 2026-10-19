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
until curl -fsS "https://$DOMAIN/api/health" >/dev/null 2>&1 || [ $i -ge 30 ]; do i=$((i + 1)); sleep 2; done
if curl -fsS "https://$DOMAIN/api/health" >/dev/null 2>&1; then
  echo "สำเร็จ: https://$DOMAIN ทำงานปกติ"
else
  echo "ระบบยังไม่ตอบ — ดู log ด้วย: docker compose logs --tail=100 app" >&2
  echo "ย้อนกลับเวอร์ชันเดิมได้ด้วย: git checkout $BEFORE && docker compose up -d --build" >&2
  exit 1
fi
