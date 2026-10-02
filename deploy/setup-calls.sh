#!/usr/bin/env bash
# Включение звонков через NAT: TURN-сервер coturn рядом с Тайником.
# Файрвол не трогается. Запуск из папки проекта:
#   sudo ./deploy/setup-calls.sh
#
# Что делает:
#   1) генерирует общий секрет TURN и пишет его в .env (сервер выдаёт клиентам
#      временные учётные данные, действующие 12 часов);
#   2) создаёт deploy/turnserver.conf;
#   3) запускает coturn (сеть хоста, порты 3478 UDP/TCP и 49160–49200 UDP)
#      и перезапускает сервер Тайника с новыми настройками.
set -euo pipefail
cd "$(dirname "$0")/.."

say()  { printf '\n\033[1;32m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m[!] %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m[x] %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Запустите от root: sudo $0"
[ -f .env ] || die "Нет .env — сначала выполните deploy/setup.sh"
DOMAIN="$(grep '^DOMAIN=' .env | cut -d= -f2- || true)"
[ -n "$DOMAIN" ] || die "В .env не указан DOMAIN"

TURN_PORT="${TURN_PORT:-3478}"
MIN_PORT="${MIN_PORT:-49160}"
MAX_PORT="${MAX_PORT:-49200}"

set_env() { if grep -q "^$1=" .env; then sed -i "s|^$1=.*|$1=$2|" .env; else echo "$1=$2" >> .env; fi; }

say "Проверяю порты"
if ss -Hlun "sport = :${TURN_PORT}" | grep -q . || ss -Hltn "sport = :${TURN_PORT}" | grep -q .; then
  if ! docker compose ps --status running coturn 2>/dev/null | grep -q coturn; then
    die "Порт ${TURN_PORT} уже занят другой программой: $(ss -Hlpn "sport = :${TURN_PORT}" | head -1)"
  fi
fi
echo "OK: ${TURN_PORT} свободен"

say "Секрет TURN"
SECRET="$(grep '^TURN_SECRET=' .env | cut -d= -f2- || true)"
if [ -z "$SECRET" ]; then
  SECRET="$(openssl rand -hex 32 2>/dev/null || head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  echo "создан новый"
else
  echo "используется существующий"
fi
set_env TURN_SECRET "$SECRET"
set_env TURN_HOST "$DOMAIN"
set_env TURN_PORT "$TURN_PORT"
set_env TURNS_PORT 0
# coturn входит в профиль calls — теперь docker compose up -d запускает и его
if grep -q '^COMPOSE_PROFILES=' .env; then
  grep -q '^COMPOSE_PROFILES=.*calls' .env || sed -i 's|^COMPOSE_PROFILES=\(.*\)|COMPOSE_PROFILES=\1,calls|' .env
else
  echo "COMPOSE_PROFILES=calls" >> .env
fi
chmod 600 .env

say "Конфигурация coturn"
PUBLIC_IP="$(curl -4fsS --max-time 10 https://api.ipify.org || true)"
LOCAL_IP="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1); exit}}')"
EXT=""
if [ -n "$PUBLIC_IP" ]; then
  if [ -n "$LOCAL_IP" ] && [ "$LOCAL_IP" != "$PUBLIC_IP" ]; then
    EXT="external-ip=${PUBLIC_IP}/${LOCAL_IP}"   # VPS за NAT провайдера
  else
    EXT="external-ip=${PUBLIC_IP}"
  fi
fi
sed -e "s|__PORT__|${TURN_PORT}|g" \
    -e "s|__MIN_PORT__|${MIN_PORT}|g" \
    -e "s|__MAX_PORT__|${MAX_PORT}|g" \
    -e "s|__DOMAIN__|${DOMAIN}|g" \
    -e "s|__SECRET__|${SECRET}|g" \
    -e "s|__EXTERNAL_IP__|${EXT}|g" \
    deploy/turnserver.conf.template > deploy/turnserver.conf
chmod 644 deploy/turnserver.conf   # контейнер coturn работает не от root и должен прочитать файл
echo "OK: deploy/turnserver.conf (${EXT:-внешний IP не определён})"

say "Запускаю coturn и перезапускаю сервер"
docker compose pull coturn || warn "Не удалось скачать образ coturn — повторите позже (см. «Docker Hub недоступен» в DEPLOY.md)"
docker compose up -d coturn tainik
sleep 3

say "Проверка"
if ss -Hlun "sport = :${TURN_PORT}" | grep -q .; then echo "OK: coturn слушает ${TURN_PORT}/udp"; else warn "coturn не слушает порт ${TURN_PORT}. Журнал: docker compose logs coturn"; fi
PORT="$(grep '^TAINIK_PORT=' .env | cut -d= -f2 || true)"
curl -fsS --max-time 5 "http://127.0.0.1:${PORT:-8787}/healthz" >/dev/null && echo "OK: сервер Тайника перезапущен" || warn "Сервер не отвечает: docker compose logs tainik"

cat <<EOF

Готово. Звонки будут проходить через ${DOMAIN}:${TURN_PORT}, если прямое соединение невозможно.

Если у провайдера VPS есть свой файрвол (в панели управления), откройте в нём:
  ${TURN_PORT}/udp, ${TURN_PORT}/tcp, ${MIN_PORT}-${MAX_PORT}/udp

Проверить TURN снаружи: https://webrtc.github.io/samples/src/content/peerconnection/trickle-ice/
  (логин и пароль получите командой: ./deploy/turn-test-credentials.sh)
EOF
