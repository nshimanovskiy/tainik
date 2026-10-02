#!/usr/bin/env bash
# Запуск Gradle в GitHub Actions. При ошибке главное из лога попадает в аннотацию
# (её видно на странице запуска и через API, без открытия полного лога).
set -uo pipefail
cd "$(dirname "$0")/.."
./gradlew --no-daemon --stacktrace "$@" 2>&1 | tee build.log
status=${PIPESTATUS[0]}
if [ "$status" -ne 0 ]; then
  msg="$(grep -E '^e: |error:|ERROR:|What went wrong|^> |Caused by:' build.log | grep -v '^> Task' | head -40 \
    | sed -e 's#file://[^ ]*/android/##' -e 's/%/%25/g' | awk '{printf "%s%%0A", $0}')"
  echo "::error title=Сборка Android не удалась::${msg:-см. лог шага}"
fi
exit "$status"
