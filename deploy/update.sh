#!/bin/bash
# Оновлення дашборду з GitHub. Запуск від root на сервері дашборду:
#   bash /opt/queue-dashboard/deploy/update.sh
# config.json, data/ і node_modules не чіпаються (вони в .gitignore).
set -euo pipefail
DIR=/opt/queue-dashboard
cd "$DIR"
[ -d .git ] || { echo "У $DIR немає git — див. INSTALL.md, розділ «Перехід на оновлення з GitHub»"; exit 1; }
[ -f config.json ] || { echo "Немає $DIR/config.json — це не сервер дашборду?"; exit 1; }

before=$(git rev-parse --short HEAD)
git fetch --quiet origin
git reset --hard --quiet origin/main
after=$(git rev-parse --short HEAD)

if [ "$before" = "$after" ]; then
  echo "Оновлень немає (версія $after)."
  exit 0
fi

echo "Оновлено: $before → $after"
git log --oneline "$before..$after"
npm ci --omit=dev --no-audit --no-fund
chown -R queuedash:queuedash "$DIR"
chmod 640 config.json
systemctl restart queue-dashboard
sleep 4
echo -n "Стан: "; curl -s http://127.0.0.1:8080/healthz; echo
