#!/usr/bin/env bash
# Установка Тайника на VPS, где уже есть Docker и nginx.
# Ничего не меняет в файрволе и не трогает существующие сайты nginx.
#   sudo ./deploy/setup.sh chat.example.com you@example.com
#
# Что делает:
#   1) запускает сервер в Docker на 127.0.0.1:TAINIK_PORT (по умолчанию 8787);
#   2) добавляет в nginx отдельный сайт для домена (с поддержкой WebSocket);
#   3) выпускает сертификат Let's Encrypt через certbot;
#   4) включает ежедневный бэкап базы.
set -euo pipefail

DOMAIN="${1:-}"
EMAIL="${2:-}"
cd "$(dirname "$0")/.."
PROJECT_DIR="$(pwd)"

say()  { printf '\n\033[1;32m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m[!] %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m[x] %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Запустите от root: sudo $0 <домен> <email>"
[ -n "$DOMAIN" ] || read -rp "Домен (например, chat.example.com): " DOMAIN
[ -n "$EMAIL" ]  || read -rp "Email для Let's Encrypt: " EMAIL
[[ "$DOMAIN" =~ ^[A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ]] || die "Неверный домен: $DOMAIN"
[[ "$EMAIL" == *@* ]] || die "Неверный email: $EMAIL"

command -v docker >/dev/null && docker compose version >/dev/null 2>&1 || die "Нужны docker и docker compose"
command -v nginx >/dev/null || die "nginx не найден: установите его (apt install nginx) и запустите скрипт снова"

# ---------- Порт ----------
if [ -f .env ] && grep -q '^TAINIK_PORT=' .env; then
  PORT="$(grep '^TAINIK_PORT=' .env | cut -d= -f2)"
else
  PORT="${TAINIK_PORT:-8787}"
fi
port_busy() { ss -Hltn "sport = :$1" 2>/dev/null | grep -q .; }
is_tainik() { curl -fsS --max-time 2 "http://127.0.0.1:$1/healthz" 2>/dev/null | grep -q '"ok":true'; }
# порт занят чем-то другим — ищем свободный
if port_busy "$PORT" && ! is_tainik "$PORT"; then
  for p in $(seq 8787 8899); do port_busy "$p" || { PORT="$p"; break; }; done
fi

# ---------- DNS ----------
say "Проверяю DNS"
SERVER_IP="$(curl -4fsS --max-time 10 https://api.ipify.org || true)"
DNS_IP="$(getent ahostsv4 "$DOMAIN" | awk 'NR==1{print $1}' || true)"
if [ -z "$DNS_IP" ]; then
  warn "Домен $DOMAIN не резолвится. Создайте A-запись на ${SERVER_IP:-IP сервера}, иначе сертификат не выпустится."
elif [ -n "$SERVER_IP" ] && [ "$DNS_IP" != "$SERVER_IP" ]; then
  warn "$DOMAIN указывает на $DNS_IP, а у сервера IP $SERVER_IP."
else
  echo "OK: $DOMAIN → $DNS_IP"
fi

# ---------- .env ----------
say "Записываю .env (порт сервера: 127.0.0.1:$PORT)"
[ -f .env ] || cp .env.example .env
set_env() { if grep -q "^$1=" .env; then sed -i "s|^$1=.*|$1=$2|" .env; else echo "$1=$2" >> .env; fi; }
set_env DOMAIN "$DOMAIN"
set_env ACME_EMAIL "$EMAIL"
set_env TAINIK_PORT "$PORT"
chmod 600 .env

# ---------- Docker ----------
say "Собираю и запускаю сервер"
# Docker Hub иногда отвечает с таймаутом — несколько попыток, затем сборка
# классическим сборщиком из локального кэша базового образа
built=""
for attempt in 1 2 3; do
  if docker compose build tainik; then built=1; break; fi
  warn "Сборка не удалась (попытка $attempt из 3) — повтор через 10 секунд"
  sleep 10
done
if [ -z "$built" ]; then
  warn "Пробую собрать без обращения к Docker Hub (из локального кэша)"
  DOCKER_BUILDKIT=0 docker build -t tainik-server:latest . \
    || die "Не удалось собрать образ: нет связи с Docker Hub. См. раздел «Docker Hub недоступен» в DEPLOY.md"
fi
docker compose up -d --no-build --remove-orphans tainik
for i in $(seq 1 30); do
  curl -fsS --max-time 3 "http://127.0.0.1:${PORT}/healthz" >/dev/null 2>&1 && { echo "OK: сервер отвечает на 127.0.0.1:${PORT}"; break; }
  [ "$i" -eq 30 ] && die "Сервер не отвечает. Журнал: docker compose logs tainik"
  sleep 1
done

# ---------- nginx ----------
say "Добавляю сайт в nginx"
if grep -RIlsE "server_name[^;]*\b${DOMAIN//./\\.}\b" /etc/nginx/ 2>/dev/null | grep -v 'tainik' | grep -q .; then
  die "В nginx уже есть сайт с server_name $DOMAIN (см. grep -R \"$DOMAIN\" /etc/nginx). Уберите его или выберите другой поддомен."
fi
if [ -d /etc/nginx/sites-available ] && grep -q 'sites-enabled' /etc/nginx/nginx.conf; then
  CONF="/etc/nginx/sites-available/tainik.conf"
  LINK="/etc/nginx/sites-enabled/tainik.conf"
else
  CONF="/etc/nginx/conf.d/tainik.conf"
  LINK=""
fi
BACKUP=""
if [ -f "$CONF" ]; then BACKUP="$(mktemp)"; cp "$CONF" "$BACKUP"; fi

if [ -f "$CONF" ] && grep -q 'listen 443' "$CONF"; then
  echo "Сайт уже настроен с HTTPS ($CONF) — обновляю только порт."
  sed -i "s|proxy_pass http://127.0.0.1:[0-9]*;|proxy_pass http://127.0.0.1:${PORT};|" "$CONF"
else
  sed -e "s|__DOMAIN__|${DOMAIN}|g" -e "s|__PORT__|${PORT}|g" deploy/nginx-site.conf > "$CONF"
fi
[ -n "$LINK" ] && ln -sf "$CONF" "$LINK"

if ! nginx -t 2>&1; then
  warn "Проверка конфигурации nginx не прошла — откатываю изменения"
  if [ -n "$BACKUP" ]; then cp "$BACKUP" "$CONF"; else rm -f "$CONF"; [ -n "$LINK" ] && rm -f "$LINK"; fi
  die "nginx не изменён. Пришлите вывод выше."
fi
systemctl reload nginx || systemctl restart nginx
echo "OK: $CONF"

# ---------- HTTPS ----------
say "Сертификат Let's Encrypt"
if grep -q 'listen 443' "$CONF"; then
  echo "HTTPS уже настроен."
else
  if ! command -v certbot >/dev/null; then
    echo "Устанавливаю certbot (python3-certbot-nginx)…"
    apt-get update -y >/dev/null
    apt-get install -y certbot python3-certbot-nginx >/dev/null
  fi
  if certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "$EMAIL" --redirect; then
    echo "OK: сертификат выпущен, http → https включён"
  else
    warn "certbot не смог выпустить сертификат. Сайт работает по http. Частые причины: нет A-записи, закрыт порт 80."
    warn "Повторить: certbot --nginx -d $DOMAIN"
  fi
fi

# ---------- Бэкап ----------
say "Ежедневный бэкап (03:30)"
chmod +x deploy/backup.sh deploy/update.sh
cat > /etc/cron.d/tainik-backup <<EOF
30 3 * * * root ${PROJECT_DIR}/deploy/backup.sh >> /var/log/tainik-backup.log 2>&1
EOF

say "Проверка"
if curl -fsS --max-time 10 "https://${DOMAIN}/healthz"; then echo; READY=1; fi
[ -n "${READY:-}" ] || warn "https://${DOMAIN}/healthz пока не отвечает — см. сообщения выше."

cat <<EOF

Готово.
  Веб-клиент:         https://${DOMAIN}
  Адрес для десктопа: ${DOMAIN}   (или wss://${DOMAIN}/ws)
  Сайт nginx:         ${CONF}
  Журнал сервера:     docker compose logs -f tainik
  Обновление:         ./deploy/update.sh
  Бэкап вручную:      ./deploy/backup.sh   (копии в ${PROJECT_DIR}/backups)
EOF
