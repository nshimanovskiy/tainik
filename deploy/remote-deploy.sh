#!/usr/bin/env bash
# Вызывается по SSH из GitHub Actions («Деплой сервера»).
# Ключ Actions в authorized_keys привязан к этому скрипту (command=...), поэтому
# с ним нельзя выполнить ничего другого — только обновление.
set -euo pipefail
cd "$(dirname "$0")/.."
exec 9>/tmp/tainik-deploy.lock
flock -n 9 || { echo "Деплой уже выполняется"; exit 1; }
echo "Тайник: деплой на $(hostname), $(date -Is)"
exec ./deploy/update.sh
