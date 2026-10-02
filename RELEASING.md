# Выпуск десктопной версии на GitHub

Сборка установщиков полностью автоматическая: вы ставите тег версии, GitHub Actions собирает приложения под Windows, macOS и Linux и публикует релиз с файлами. При ручном запуске можно отметить «Черновик» — тогда релиз нужно будет опубликовать вручную.

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
3. **Actions → «Выпуск десктопа»** сам прогонит тесты и соберёт приложения (около 10–15 минут).
4. **Releases** → появится релиз «Тайник 0.4.1» с файлами:
   - `Tainik-0.4.1-win-x64.exe` (установщик) и `Tainik-0.4.1-win-x64-portable.exe` (без установки)
   - `Tainik-0.4.1-mac-arm64.dmg`, `Tainik-0.4.1-mac-x64.dmg`
   - `Tainik-0.4.1-linux-x86_64.AppImage`, `Tainik-0.4.1-linux-amd64.deb`
   - `SHA256SUMS.txt`

   Описание собирается из `CHANGELOG.md` и `.github/release-notes.md`, где лежит инструкция по установке.
5. Если что-то не так с выпуском — **Edit → Delete release**, исправьте и поставьте новый тег (например, `v0.4.2`).

Версию в `desktop/package.json` вручную менять не нужно: её берёт из тега сам workflow. Выпуск можно запустить и без тега: **Actions → «Выпуск десктопа» → Run workflow**, указав версию (например, `0.6.0`). Тег `v0.6.0` создастся сам. Если отметить «Черновик», проверьте файлы и нажмите **Publish release**.

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
- **неверный тег:** нужен формат `v1.2.3`.
