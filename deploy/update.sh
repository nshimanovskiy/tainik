#!/usr/bin/env bash
# Обновление сервера до последней версии из GitHub.
# Запускается вручную (./deploy/update.sh) или кнопкой Actions → «Деплой сервера».
#   1) бэкап базы;
#   2) git fetch + reset на origin/<ветка> (.env, бэкапы и настройки TURN не затрагиваются);
#   3) пересборка и перезапуск контейнеров, проверка /healthz.
set -euo pipefail
cd "$(dirname "$0")/.."

say()  { printf '\n\033[1;32m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m[!] %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m[x] %s\033[0m\n' "$*" >&2; exit 1; }
envval() { { grep -E "^$1=" .env 2>/dev/null || true; } | tail -1 | cut -d= -f2-; }

if [ "${1:-}" != "--no-pull" ]; then
  say "Бэкап базы"
  ./deploy/backup.sh || warn "бэкап не удался — продолжаю"

  if [ -d .git ]; then
    BRANCH="$(envval DEPLOY_BRANCH)"
    BRANCH="${BRANCH:-main}"
    say "Забираю ${BRANCH} из GitHub"
    OLD="$(git rev-parse --short HEAD 2>/dev/null || echo '-')"
    git fetch --quiet origin "$BRANCH"
    git reset --hard --quiet "origin/${BRANCH}"
    NEW="$(git rev-parse --short HEAD)"
    if [ "$OLD" = "$NEW" ]; then
      echo "Код не изменился (${NEW})"
    else
      echo "${OLD} → ${NEW}"
      git log --oneline --no-decorate "${OLD}..${NEW}" 2>/dev/null | head -20 || true
    fi
    chmod +x deploy/*.sh
    # Дальше — уже новая версия этого скрипта
    exec ./deploy/update.sh --no-pull
  else
    warn "Папка не подключена к GitHub (нет .git). Подключите: sudo ./deploy/connect-github.sh ВЛАДЕЛЕЦ/РЕПОЗИТОРИЙ"
  fi
fi

say "Сборка и перезапуск"
docker compose up -d --build --remove-orphans
docker image prune -f >/dev/null 2>&1 || true

say "Проверка"
PORT="$(envval TAINIK_PORT)"
for i in $(seq 1 30); do
  if R="$(curl -fsS --max-time 3 "http://127.0.0.1:${PORT:-8787}/healthz" 2>/dev/null)"; then
    echo "OK: ${R}"
    docker compose ps
    exit 0
  fi
  sleep 1
done
docker compose logs --tail 50 tainik || true
die "Сервер не отвечает после обновления"
