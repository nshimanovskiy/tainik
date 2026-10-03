# Выпуск приложений на GitHub

Сборка полностью автоматическая: вы ставите тег версии, GitHub Actions собирает приложения под Windows, macOS, Linux и Android и публикует релиз с файлами. При ручном запуске можно отметить «Черновик» — тогда релиз нужно будет опубликовать вручную.

## Один раз: создать репозиторий

1. На GitHub: **New repository** → например `tainik`. Можно приватный: Actions в приватных репозиториях работают в пределах бесплатных минут, хотя сборка под macOS расходует их в 10 раз быстрее.
2. На компьютере, в папке проекта:
   ```bash
   git init
   git add .
   git commit -m "Тайник 0.4.0"
   git branch -M main
   git remote add origin https://github.com/ВАШ_ЛОГИН/tainik.git
   git push -u origin main
   ```
   `.gitignore` уже исключает `.env`, базу, бэкапы и сборки, поэтому секреты в репозиторий не попадут.
3. Необязательно: **Settings → Secrets and variables → Actions → Variables → New variable** `TAINIK_SERVER` = адрес вашего сервера. Без этой переменной в приложение вшивается `chat.sdsds.top`.

## Один раз: ключ подписи Android

Android устанавливает обновление поверх старой версии, только если оба APK подписаны **одним и тем же ключом**. Поэтому ключ создаётся один раз и хранится в секретах репозитория.

1. Создайте ключ (нужен JDK — `keytool` входит в него):
   ```bash
   keytool -genkeypair -keystore tainik-release.jks -storetype PKCS12 -alias tainik \
     -keyalg RSA -keysize 4096 -validity 10000 -dname "CN=Tainik"
   base64 -w0 tainik-release.jks > tainik-release.b64   # на macOS: base64 -i tainik-release.jks
   ```
2. **Settings → Secrets and variables → Actions → New repository secret:**
   - `ANDROID_KEYSTORE_BASE64` — содержимое `tainik-release.b64` (одной строкой);
   - `ANDROID_KEYSTORE_PASSWORD` — пароль, который спросил `keytool`.

   Необязательные: `ANDROID_KEY_ALIAS` (по умолчанию `tainik`) и `ANDROID_KEY_PASSWORD` (по умолчанию — пароль хранилища).
3. Сохраните `tainik-release.jks` и пароль в надёжном месте. **Если ключ потерять, обновления перестанут устанавливаться**: пользователям придётся удалить приложение (с ключами и перепиской на телефоне) и привязать устройство заново.

Без этих секретов выпуск всё равно соберётся, но APK будет подписан одноразовым отладочным ключом (в Actions появится предупреждение) — годится только для проверки.

## Один раз: ключ подписи выпусков (самообновление)

Приложения обновляются сами, но ставят новую версию, только если список контрольных сумм выпуска подписан **ключом выпусков**. Открытый ключ уже лежит в `desktop/release-key.pem`, закрытый нужно добавить в секреты:

**Settings → Secrets and variables → Actions → New repository secret** → имя `RELEASE_SIGNING_KEY`, значение — весь текст файла `release-signing-key.pem` (от `-----BEGIN PRIVATE KEY-----` до `-----END PRIVATE KEY-----`).

Workflow подписывает `SHA256SUMS.txt` и кладёт в выпуск `SHA256SUMS.txt.sig`. Если ключ не совпадает с `desktop/release-key.pem`, выпуск остановится с ошибкой «Неверный ключ выпусков». Без секрета выпуск выйдет, но приложения будут только сообщать о новой версии.

Храните `release-signing-key.pem` надёжно. Потеряли — создайте новую пару (`node -e "…generateKeyPairSync('ed25519')…"`, см. историю этого файла), положите новый открытый ключ в `desktop/release-key.pem` и выпустите версию: установленные приложения примут обновление со старым ключом только до неё, дальше — с новым. Утёк — то же самое, и как можно скорее.

## Каждый выпуск

1. Допишите раздел в `CHANGELOG.md`:
   ```markdown
   ## 0.4.1
   - Что изменилось
   ```
2. Закоммитьте и поставьте тег:
   ```bash
   git commit -am "Выпуск 0.4.1"
   git tag v0.4.1
   git push origin main v0.4.1
   ```
3. **Actions → «Выпуск приложений»** сам прогонит тесты и соберёт приложения (около 10–15 минут).
4. **Releases** → появится релиз «Тайник 0.4.1» с файлами:
   - `Tainik-0.4.1-win-x64.exe` (установщик) и `Tainik-0.4.1-win-x64-portable.exe` (без установки)
   - `Tainik-0.4.1-mac-arm64.dmg`, `Tainik-0.4.1-mac-x64.dmg`
   - `Tainik-0.4.1-linux-x86_64.AppImage`, `Tainik-0.4.1-linux-amd64.deb`
   - `Tainik-0.4.1-android.apk`
   - `SHA256SUMS.txt.sig` — подпись для самообновления
   - `SHA256SUMS.txt`

   Описание собирается из `CHANGELOG.md` и `.github/release-notes.md`, где лежит инструкция по установке.
5. Если что-то не так с выпуском — **Edit → Delete release**, исправьте и поставьте новый тег (например, `v0.4.2`).

Версию в `desktop/package.json` вручную менять не нужно: её берёт из тега сам workflow (он же задаёт версию APK; `versionCode` считается из номера: 0.8.0 → 8000). Выпуск можно запустить и без тега: **Actions → «Выпуск приложений» → Run workflow**, указав версию (например, `0.6.0`). Тег `v0.6.0` создастся сам. Если отметить «Черновик», проверьте файлы и нажмите **Publish release**.

## Деплой сервера

Сервер обновляется из того же репозитория: **Actions → «Деплой сервера» → Run workflow**. Подключение описано в разделе «Обновление из GitHub» в [DEPLOY.md](DEPLOY.md).

## Подпись (позже, когда понадобится)

Сейчас сборки **не подписаны**. Работать это не мешает, но:
- Windows SmartScreen показывает «Неизвестный издатель», пока у файла мало загрузок;
- macOS не даёт открыть приложение обычным двойным щелчком. Обход описан в описании релиза.

Чтобы убрать предупреждения:
- **Windows:** сертификат подписи кода (OV/EV) или Azure Trusted Signing. Его передают в секретах `CSC_LINK` / `CSC_KEY_PASSWORD`, а `CSC_IDENTITY_AUTO_DISCOVERY` в `release.yml` нужно убрать.
- **macOS:** Apple Developer Program (99 $/год). Нужны сертификат «Developer ID Application» и нотаризация (секреты `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`). Ещё нужно убрать `"identity": null` из `desktop/package.json`.

## Если сборка упала

Откройте упавший шаг в Actions. Частые причины:
- **ошибка в тестах:** сборка не начнётся, пока `npm test` не пройдёт;
- **macOS / dmg:** временные сбои на раннерах GitHub, помогает «Re-run failed jobs»;
- **неверный тег:** нужен формат `v1.2.3`;
- **Android:** причина ошибки видна прямо в аннотации «Сборка Android не удалась» на странице запуска. Если ключ подписи не подходит — проверьте, что `ANDROID_KEYSTORE_BASE64` вставлен целиком, а пароль совпадает.
