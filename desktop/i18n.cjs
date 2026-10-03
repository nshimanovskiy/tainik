// Перевод текстов главного процесса десктопа (трей, системные окна, ошибки обновления).
// Язык: выбор в приложении (settings.lang — его сохраняет страница) или язык системы.
// Страница переводится сама (shared/i18n.js); здесь — только то, что рисует Electron.
'use strict';

const EN = {
  'Тайник': 'Tainik',
  'Системное хранилище ключей недоступно. Запуск невозможен.': 'The system keychain is unavailable. Tainik can’t start.',
  'Выйти': 'Quit',
  'Продолжить без защиты': 'Continue without protection',
  'Не найдена системная связка ключей': 'System keyring not found',
  'Без gnome-keyring или KWallet ключи шифрования будут защищены слабо: любой, у кого есть доступ к вашим файлам, сможет их прочитать. Установите связку ключей и перезапустите приложение.':
    'Without gnome-keyring or KWallet, encryption keys are poorly protected: anyone with access to your files could read them. Install a keyring and restart the app.',
  'Не удалось расшифровать локальные данные: ': 'Couldn’t decrypt local data: ',
  'Автозапуск доступен в собранном приложении': 'Start at login is available in the installed app',
  'Открыть Тайник': 'Open Tainik',
  'Перезапустить и обновить до {0}': 'Restart and update to {0}',
  'Запускать при входе в систему': 'Start at login',
  'Непрочитанных: {0}': 'Unread: {0}',
  'Тайник — непрочитанных: {0}': 'Tainik — unread: {0}',
  'Тайник работает в фоне': 'Tainik is running in the background',
  'Открыть или выйти — через значок в трее. Отключить: меню ⋯ → «Работа в фоне».': 'Open or quit from the tray icon. To turn this off: menu ⋯ → “Background”.',
  'Открыть снова — запустите Тайник. Отключить: меню ⋯ → «Работа в фоне».': 'To reopen, launch Tainik again. To turn this off: menu ⋯ → “Background”.',
  'Весь экран': 'Entire screen',
  // Обновления (updater.cjs)
  'сервер ответил {0}': 'the server responded {0}',
  'Не задан сервер': 'No server is set',
  'Не удалось проверить обновления: ': 'Couldn’t check for updates: ',
  'Для этой системы в выпуске нет файла': 'The release has no file for this system',
  'Выпуск не подписан — установите вручную': 'The release isn’t signed — install it manually',
  'подпись выпуска не прошла проверку': 'the release signature failed verification',
  'файла нет в подписанном списке': 'the file isn’t in the signed list',
  'недопустимое имя файла': 'invalid file name',
  'контрольная сумма не совпала — файл повреждён или подменён': 'checksum mismatch — the file is damaged or was tampered with',
  'Обновление не скачалось: ': 'The update didn’t download: ',
};

let langSource = () => 'ru';
/** Откуда брать язык: функция, возвращающая 'ru' или 'en'. */
function setLangSource(fn) {
  langSource = fn;
}
/** Язык по коду системы: русский и близкие — 'ru', остальные — 'en'. */
function langFromLocale(locale) {
  if (!locale) return 'ru'; // язык системы неизвестен — исходный язык интерфейса
  return /^(ru|be|uk|kk|ky|uz|tg|hy|az|ka)\b/i.test(String(locale)) ? 'ru' : 'en';
}
function t(s, ...args) {
  const out = langSource() === 'en' ? (EN[s] ?? s) : s;
  return args.length ? out.replace(/\{(\d+)\}/g, (m, i) => String(args[i] ?? '')) : out;
}

module.exports = { t, setLangSource, langFromLocale, EN };
