#!/usr/bin/env bash
# Резервная копия базы Тайника без остановки сервера. Хранит последние 14 копий.
#   ./deploy/backup.sh
set -euo pipefail
cd "$(dirname "$0")/.."
KEEP="${KEEP:-14}"
STAMP="$(date +%Y%m%d-%H%M%S)"
mkdir -p backups
chmod 700 backups

docker compose exec -T tainik node --disable-warning=ExperimentalWarning server/backup.js "/data/backup-${STAMP}.db"
docker compose cp "tainik:/data/backup-${STAMP}.db" "backups/tainik-${STAMP}.db"
docker compose exec -T tainik rm -f "/data/backup-${STAMP}.db"
gzip -9 "backups/tainik-${STAMP}.db"
chmod 600 "backups/tainik-${STAMP}.db.gz"

# Удаляем старые копии
ls -1t backups/tainik-*.db.gz 2>/dev/null | tail -n +"$((KEEP + 1))" | xargs -r rm -f
echo "$(date -Is) бэкап: backups/tainik-${STAMP}.db.gz"
