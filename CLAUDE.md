# Тайник — заметки для ассистента

Полное резюме проекта (архитектура, решения, состояние, структура, известные проблемы): **[docs/HANDOFF.md](docs/HANDOFF.md)** — прочитать в начале работы.

Коротко:
- E2E-мессенджер (X3DH + Double Ratchet, multi-device как в Signal). Общий UI `client/` + ядро `shared/` для веба, Electron (`desktop/`) и Android-WebView (`android/`); сервер `server/` на Node 22 без npm-зависимостей.
- Ноль runtime-зависимостей — принцип проекта.
- `npm test` должен быть зелёным; после push — проверить CI (`build.yml`: test, docker, desktop×3, android). Android здесь не компилируется — только в CI.
- Каждая новая русская строка интерфейса → `shared/i18n-en.js` (иначе падает `tests/i18n.test.js`). Никогда не объявлять локальную переменную `t` там, где используется `t()`.
- CSP без инлайна; новые источники — в трёх местах: `server/server.js`, `desktop/lib.cjs`, `android/.../AssetServer.kt`. Пользовательский текст — только через `textContent`.
- Версия в `package.json`, `desktop/package.json` и `shared/version.js`, раздел в `CHANGELOG.md` на каждую версию.
- Сервер обновляется `sudo ./deploy/update.sh` в `/opt/tainik/e2e-messenger`. На VPS **не трогать ufw**, root-логин по SSH запрещён, другие сайты на сервере должны работать.
- Ответы пользователю — по-русски.
