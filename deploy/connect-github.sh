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
#   3) ключ для GitHub Actions, который может ТОЛЬКО запустить обновление
#      (forced command в authorized_keys), и печатает значения для секретов.
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
say "Ключ для кнопки «Деплой сервера»"
ACT_KEY="$(mktemp -d)/tainik_actions"
ssh-keygen -t ed25519 -N '' -C "tainik-actions" -f "$ACT_KEY" >/dev/null
AUTH="$SSH_DIR/authorized_keys"
touch "$AUTH" && chmod 600 "$AUTH"
sed -i '/ tainik-actions$/d' "$AUTH"   # старый ключ Actions, если был
echo "command=\"${DIR}/deploy/remote-deploy.sh\",no-port-forwarding,no-X11-forwarding,no-agent-forwarding,no-pty $(cat "$ACT_KEY.pub")" >> "$AUTH"

SSH_PORT="$(sshd -T 2>/dev/null | awk '/^port /{print $2; exit}')"
SSH_PORT="${SSH_PORT:-22}"
ROOT_LOGIN="$(sshd -T 2>/dev/null | awk '/^permitrootlogin /{print $2; exit}')"
[ "$ROOT_LOGIN" = "no" ] && warn "В sshd запрещён вход root (PermitRootLogin no) — включите 'prohibit-password' или 'forced-commands-only'."
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
  DEPLOY_USER          root
  DEPLOY_KNOWN_HOSTS   (весь блок ниже, все строки)
${KNOWN}
  DEPLOY_KEY           (весь блок ниже, включая строки BEGIN/END)
$(cat "$ACT_KEY")
────────────────────────────────────────────────────────────────────
Этот ключ умеет только запускать обновление Тайника. На сервере он не сохраняется —
если потеряете, просто запустите скрипт снова.
EOF
rm -rf "$(dirname "$ACT_KEY")"

cat <<EOF

Готово. Теперь обновление сервера:
  GitHub → Actions → «Деплой сервера» → Run workflow
или вручную на сервере:
  ${DIR}/deploy/update.sh
EOF
