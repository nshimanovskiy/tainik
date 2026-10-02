#!/usr/bin/env bash
# Подключает папку сервера к приватному репозиторию GitHub и готовит
# обновление кнопкой Actions → «Деплой сервера».
#
#   sudo ./deploy/connect-github.sh ВЛАДЕЛЕЦ/РЕПОЗИТОРИЙ [ветка]
#
# Что делает (файрвол и nginx не трогает):
#   1) ключ «только чтение» для скачивания кода с GitHub (Deploy key);
#   2) превращает текущую папку в git-копию репозитория — .env, база, бэкапы и
#      настройки TURN остаются на месте;
#   3) пользователь tainik-deploy и ключ для GitHub Actions, который может ТОЛЬКО
#      запустить обновление (forced command + одно правило sudo), и печатает
#      значения для секретов. Вход root по SSH не требуется.
set -euo pipefail

REPO="${1:-}"
BRANCH="${2:-main}"
cd "$(dirname "$0")/.."
DIR="$(pwd)"

say()  { printf '\n\033[1;32m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m[!] %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m[x] %s\033[0m\n' "$*" >&2; exit 1; }
pause() { read -rp "$1 — затем нажмите Enter… " _ </dev/tty; }

[ "$(id -u)" -eq 0 ] || die "Запустите от root: sudo $0 ВЛАДЕЛЕЦ/РЕПОЗИТОРИЙ"
[[ "$REPO" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || die "Укажите репозиторий: $0 ВЛАДЕЛЕЦ/РЕПОЗИТОРИЙ (например, pilot/tainik)"
[ -f docker-compose.yml ] || die "Запускайте из папки проекта (там, где docker-compose.yml)"
command -v git >/dev/null || { apt-get update -y >/dev/null; apt-get install -y git >/dev/null; }

SSH_DIR=/root/.ssh
mkdir -p "$SSH_DIR" && chmod 700 "$SSH_DIR"

# ---------- 1. Ключ для чтения репозитория ----------
say "Ключ для скачивания кода (только чтение)"
READ_KEY="$SSH_DIR/tainik_github"
[ -f "$READ_KEY" ] || ssh-keygen -t ed25519 -N '' -C "tainik-server@$(hostname)" -f "$READ_KEY" >/dev/null
touch "$SSH_DIR/config" && chmod 600 "$SSH_DIR/config"
if ! grep -q '^Host github-tainik$' "$SSH_DIR/config"; then
  cat >> "$SSH_DIR/config" <<EOF

Host github-tainik
  HostName github.com
  User git
  IdentityFile $READ_KEY
  IdentitiesOnly yes
EOF
fi
ssh-keygen -F github.com >/dev/null 2>&1 || ssh-keyscan -t ed25519,ecdsa,rsa github.com 2>/dev/null >> "$SSH_DIR/known_hosts"

URL="git@github-tainik:${REPO}.git"
if ! git ls-remote "$URL" >/dev/null 2>&1; then
  cat <<EOF

Добавьте этот ключ в GitHub:
  https://github.com/${REPO}/settings/keys → «Add deploy key»
  Title: tainik-server     «Allow write access» — НЕ отмечать

$(cat "$READ_KEY.pub")
EOF
  pause "Добавьте ключ"
  git ls-remote "$URL" >/dev/null 2>&1 || die "Нет доступа к ${REPO}. Проверьте имя репозитория и что ключ добавлен в Deploy keys."
fi
echo "OK: доступ к ${REPO} есть"
git ls-remote --exit-code --heads "$URL" "$BRANCH" >/dev/null || die "В репозитории нет ветки ${BRANCH}"

# ---------- 2. Папка → git-копия репозитория ----------
say "Подключаю ${DIR} к ${REPO} (${BRANCH})"
if [ ! -d .git ]; then
  git init -q -b "$BRANCH"
  git remote add origin "$URL"
else
  git remote set-url origin "$URL" 2>/dev/null || git remote add origin "$URL"
fi
git fetch -q origin "$BRANCH"
CHANGED="$(git diff --name-only "origin/${BRANCH}" 2>/dev/null | head -20 || true)"
if [ -n "$CHANGED" ]; then
  echo "Эти файлы будут заменены версией из GitHub:"
  echo "$CHANGED" | sed 's/^/  /'
fi
git reset -q --hard "origin/${BRANCH}"
git branch -q --set-upstream-to="origin/${BRANCH}" 2>/dev/null || true
chmod +x deploy/*.sh
grep -q '^DEPLOY_BRANCH=' .env 2>/dev/null && sed -i "s|^DEPLOY_BRANCH=.*|DEPLOY_BRANCH=${BRANCH}|" .env || echo "DEPLOY_BRANCH=${BRANCH}" >> .env
echo "OK: версия $(git rev-parse --short HEAD). Файлы вне репозитория (.env, backups/, deploy/turnserver.conf) не тронуты."

# ---------- 3. Ключ для GitHub Actions ----------
# Отдельный пользователь tainik-deploy: вход root по SSH не нужен. Его ключ
# привязан к одной команде (forced command), а sudo разрешает ему только
# deploy/remote-deploy.sh — ни консоли, ни других команд.
say "Пользователь и ключ для кнопки «Деплой сервера»"
DUSER=tainik-deploy
if ! id "$DUSER" >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash --comment "Tainik deploy (GitHub Actions)" "$DUSER"
fi
usermod -p '*' "$DUSER"   # без пароля (вход только по ключу; '*' — не «заблокирован», sshd пускает по ключу)
DHOME="$(getent passwd "$DUSER" | cut -d: -f6)"
install -d -m 700 -o "$DUSER" -g "$DUSER" "$DHOME/.ssh"
AUTH="$DHOME/.ssh/authorized_keys"
touch "$AUTH"

ACT_KEY="$(mktemp -d)/tainik_actions"
ssh-keygen -t ed25519 -N '' -C "tainik-actions" -f "$ACT_KEY" >/dev/null
sed -i '/ tainik-actions$/d' "$AUTH"
echo "command=\"sudo -n ${DIR}/deploy/remote-deploy.sh\",no-port-forwarding,no-X11-forwarding,no-agent-forwarding,no-pty $(cat "$ACT_KEY.pub")" >> "$AUTH"
chown "$DUSER:$DUSER" "$AUTH" && chmod 600 "$AUTH"
# старый вариант (ключ у root) больше не нужен
[ -f /root/.ssh/authorized_keys ] && sed -i '/ tainik-actions$/d' /root/.ssh/authorized_keys

SUDOERS=/etc/sudoers.d/tainik-deploy
echo "${DUSER} ALL=(root) NOPASSWD: ${DIR}/deploy/remote-deploy.sh \"\"" > "$SUDOERS.tmp"   # "" — без аргументов
chmod 440 "$SUDOERS.tmp"
if visudo -cf "$SUDOERS.tmp" >/dev/null; then mv "$SUDOERS.tmp" "$SUDOERS"; else rm -f "$SUDOERS.tmp"; die "Не удалось создать правило sudo"; fi

# Порт SSH: sshd -T (может не работать при запуске через ssh.socket) → ssh.socket → конфиг → 22
SSH_PORT="$( { sshd -T 2>/dev/null || true; } | awk '/^port /{print $2; exit}' || true)"
if [ -z "$SSH_PORT" ]; then
  SSH_PORT="$( { systemctl show ssh.socket -p Listen 2>/dev/null || true; } | grep -oE '[0-9]+ \(Stream\)' | head -1 | cut -d' ' -f1 || true)"
fi
if [ -z "$SSH_PORT" ]; then
  SSH_PORT="$( { cat /etc/ssh/sshd_config /etc/ssh/sshd_config.d/*.conf 2>/dev/null || true; } | awk 'tolower($1)=="port"{print $2; exit}' || true)"
fi
SSH_PORT="${SSH_PORT:-22}"
# Если вход ограничен списком AllowUsers/AllowGroups — нового пользователя надо туда добавить
ALLOW="$( { sshd -T 2>/dev/null || true; } | awk '/^(allowusers|allowgroups) /{print}' || true)"
if [ -n "$ALLOW" ]; then
  warn "В sshd задан список разрешённых пользователей:"
  echo "$ALLOW" | sed 's/^/    /'
  warn "Добавьте ${DUSER} в AllowUsers (файл /etc/ssh/sshd_config) и выполните: systemctl reload ssh"
fi
HOST="$(grep '^DOMAIN=' .env 2>/dev/null | cut -d= -f2- || true)"
IP="$(curl -4fsS --max-time 8 https://api.ipify.org || true)"
HOST_FOR_SSH="${IP:-$HOST}"
KNOWN=""
for f in /etc/ssh/ssh_host_ed25519_key.pub /etc/ssh/ssh_host_ecdsa_key.pub /etc/ssh/ssh_host_rsa_key.pub; do
  [ -f "$f" ] || continue
  if [ "$SSH_PORT" = "22" ]; then H="$HOST_FOR_SSH"; else H="[${HOST_FOR_SSH}]:${SSH_PORT}"; fi
  KNOWN+="$H $(cut -d' ' -f1,2 "$f")"$'\n'
done

cat <<EOF

────────────────────────────────────────────────────────────────────
Добавьте секреты в GitHub:
  https://github.com/${REPO}/settings/secrets/actions → «New repository secret»

  DEPLOY_HOST          ${HOST_FOR_SSH}
  DEPLOY_PORT          ${SSH_PORT}
  DEPLOY_USER          ${DUSER}
  DEPLOY_KNOWN_HOSTS   (весь блок ниже, все строки)
${KNOWN}
  DEPLOY_KEY           (весь блок ниже, включая строки BEGIN/END)
$(cat "$ACT_KEY")
────────────────────────────────────────────────────────────────────
Этот ключ умеет только запускать обновление Тайника (пользователь ${DUSER},
одна разрешённая команда). На сервере закрытая часть не сохраняется; при повторном
запуске скрипта выдаётся новый ключ, а старый перестаёт работать.
EOF
rm -rf "$(dirname "$ACT_KEY")"

cat <<EOF

Готово. Теперь обновление сервера:
  GitHub → Actions → «Деплой сервера» → Run workflow
или вручную на сервере:
  ${DIR}/deploy/update.sh
EOF
