#!/usr/bin/env bash
# Временные (1 час) учётные данные TURN для ручной проверки, например на странице
# https://webrtc.github.io/samples/src/content/peerconnection/trickle-ice/
set -euo pipefail
cd "$(dirname "$0")/.."
SECRET="$(grep '^TURN_SECRET=' .env | cut -d= -f2- || true)"
HOST="$(grep '^TURN_HOST=' .env | cut -d= -f2- || true)"
PORT="$(grep '^TURN_PORT=' .env | cut -d= -f2- || echo 3478)"
[ -n "$SECRET" ] || { echo "TURN не настроен: запустите deploy/setup-calls.sh"; exit 1; }
USER="$(( $(date +%s) + 3600 )):test"
PASS="$(printf '%s' "$USER" | openssl dgst -sha1 -hmac "$SECRET" -binary | base64)"
echo "URI:      turn:${HOST}:${PORT:-3478}"
echo "Логин:    ${USER}"
echo "Пароль:   ${PASS}"
echo
echo "В тесте должна появиться строка с типом «relay» — значит TURN работает."
