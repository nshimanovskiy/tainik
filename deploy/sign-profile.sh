#!/usr/bin/env bash
# Подписывает профиль iPhone (/tainik.mobileconfig) сертификатом Let's Encrypt вашего домена.
# После этого iOS показывает профиль как «Подтверждён» с именем домена, а не «Не подтверждён».
#
#   sudo ./deploy/sign-profile.sh
#
# Что делает:
#   1) берёт у сервера неподписанный профиль (в нём только адрес, название и значок);
#   2) подписывает его ключом сертификата домена (openssl, формат PKCS#7 — как требует iOS);
#   3) кладёт подписанный файл в данные контейнера — сервер начинает отдавать его;
#   4) ставит хук certbot: после каждого продления сертификата профиль переподписывается сам.
#
# Закрытый ключ сертификата читает только этот скрипт (нужен root); в контейнер он не попадает.
# Файрвол, nginx и сертификаты скрипт не меняет.
#
# Переменные (необязательно): CERT_DIR — папка сертификата (по умолчанию /etc/letsencrypt/live/<DOMAIN>);
# DOMAIN, TAINIK_PORT — вместо значений из .env; OUT — записать подписанный файл сюда, а не в контейнер.
# Ключи: --no-hook — не ставить хук certbot; --quiet — без лишнего вывода (для хука).
set -euo pipefail
cd "$(dirname "$0")/.."
PROJECT="$(pwd)"

QUIET=0
HOOK=1
for a in "$@"; do
  case "$a" in
    --quiet) QUIET=1 ;;
    --no-hook) HOOK=0 ;;
    *) echo "Неизвестный ключ: $a" >&2; exit 2 ;;
  esac
done

say()  { [ "$QUIET" = 1 ] || printf '\n\033[1;32m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m[!] %s\033[0m\n' "$*" >&2; }
die()  { printf '\033[1;31m[x] %s\033[0m\n' "$*" >&2; exit 1; }
envval() { { grep -E "^$1=" .env 2>/dev/null || true; } | tail -1 | cut -d= -f2-; }

DOMAIN="${DOMAIN:-$(envval DOMAIN)}"
PORT="${TAINIK_PORT:-$(envval TAINIK_PORT)}"
PORT="${PORT:-8787}"
[ -n "$DOMAIN" ] || die "Не задан DOMAIN (в .env)"
CERT_DIR="${CERT_DIR:-/etc/letsencrypt/live/$DOMAIN}"

# Хук certbot срабатывает после продления любого сертификата — подписываем только для своего
if [ -n "${RENEWED_LINEAGE:-}" ] && [ "$(readlink -f "$RENEWED_LINEAGE")" != "$(readlink -f "$CERT_DIR")" ]; then
  exit 0
fi

command -v openssl >/dev/null || die "Нет openssl: sudo apt install openssl"
command -v curl >/dev/null || die "Нет curl: sudo apt install curl"
for f in cert.pem privkey.pem chain.pem; do
  if [ ! -r "$CERT_DIR/$f" ]; then
    [ -e "$CERT_DIR/$f" ] && die "Нет доступа к $CERT_DIR/$f — запустите через sudo"
    die "Не найден $CERT_DIR/$f. Сертификат выпускает certbot (deploy/setup.sh); другая папка — CERT_DIR=/etc/letsencrypt/live/имя"
  fi
done

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

say "Беру профиль у сервера (127.0.0.1:${PORT})"
curl -fsS --max-time 10 -H "Host: ${DOMAIN}" "http://127.0.0.1:${PORT}/tainik.mobileconfig?unsigned=1" -o "$TMP/profile.mobileconfig" \
  || die "Сервер не отдал профиль. Он запущен? Обновлён до 0.11+? (./deploy/update.sh)"
grep -q "https://${DOMAIN}/" "$TMP/profile.mobileconfig" || die "В профиле не тот адрес — проверьте DOMAIN в .env"

say "Подписываю сертификатом ${DOMAIN}"
openssl smime -sign -nodetach -binary -outform der \
  -in "$TMP/profile.mobileconfig" \
  -signer "$CERT_DIR/cert.pem" -inkey "$CERT_DIR/privkey.pem" -certfile "$CERT_DIR/chain.pem" \
  -out "$TMP/signed.mobileconfig"

# Проверка: подпись верна, цепочка доверенная (как её проверит iPhone), содержимое не изменилось
openssl smime -verify -inform der -in "$TMP/signed.mobileconfig" -purpose any \
  ${CA_FILE:+-CAfile "$CA_FILE"} -out "$TMP/check.mobileconfig" 2>"$TMP/verify.log" \
  || die "Подпись не проверяется: $(tr '\n' ' ' < "$TMP/verify.log")"
cmp -s "$TMP/profile.mobileconfig" "$TMP/check.mobileconfig" || die "Подписанный профиль отличается от исходного"
EXPIRES="$(openssl x509 -in "$CERT_DIR/cert.pem" -noout -enddate | cut -d= -f2)"
chmod 644 "$TMP/signed.mobileconfig"

if [ -n "${OUT:-}" ]; then
  cp "$TMP/signed.mobileconfig" "$OUT"
else
  command -v docker >/dev/null || die "Нет docker"
  docker compose cp "$TMP/signed.mobileconfig" tainik:/data/tainik-signed.mobileconfig >/dev/null \
    || die "Не удалось положить файл в контейнер (docker compose cp). Контейнер запущен? docker compose ps"
fi
say "Готово: профиль подписан, сертификат действует до ${EXPIRES}"

if [ "$HOOK" = 1 ] && [ -z "${OUT:-}" ] && [ -z "${RENEWED_LINEAGE:-}" ]; then
  HOOK_DIR=/etc/letsencrypt/renewal-hooks/deploy
  if [ -d /etc/letsencrypt ] && [ -w /etc/letsencrypt ]; then
    mkdir -p "$HOOK_DIR"
    cat > "$HOOK_DIR/tainik-sign-profile.sh" <<EOF
#!/bin/sh
# Тайник: переподписать профиль iPhone после продления сертификата (deploy/sign-profile.sh)
cd "$PROJECT" && exec ./deploy/sign-profile.sh --quiet
EOF
    chmod 755 "$HOOK_DIR/tainik-sign-profile.sh"
    say "Хук certbot установлен: после продления сертификата профиль переподпишется сам"
  else
    warn "Хук certbot не установлен (нет доступа к /etc/letsencrypt). После продления сертификата запустите скрипт снова."
  fi
fi

if [ "$QUIET" != 1 ]; then
  echo
  echo "Проверьте на iPhone: https://${DOMAIN}/ios → «Установить Тайник» → в Настройках профиль будет «Подтверждён»."
fi
