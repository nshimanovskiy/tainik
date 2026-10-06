// Перевод текстов главного процесса десктопа (трей, системные окна, ошибки обновления).
// Язык: выбор в приложении (settings.lang — его сохраняет страница) или язык системы.
// Страница переводится сама (shared/i18n.js); здесь — только то, что рисует Electron.
'use strict';

const EN = {
  'Тайник': 'Tainik',
  'Ответить…': 'Reply…',
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

const ES = {
  "Тайник": "Tainik",
  "Ответить…": "Responder…",
  "Системное хранилище ключей недоступно. Запуск невозможен.": "El llavero del sistema no está disponible. Tainik no puede iniciarse.",
  "Выйти": "Salir",
  "Продолжить без защиты": "Continuar sin protección",
  "Не найдена системная связка ключей": "No se encontró el llavero del sistema",
  "Без gnome-keyring или KWallet ключи шифрования будут защищены слабо: любой, у кого есть доступ к вашим файлам, сможет их прочитать. Установите связку ключей и перезапустите приложение.": "Sin gnome-keyring o KWallet, las claves de cifrado quedan poco protegidas: cualquiera con acceso a tus archivos podría leerlas. Instala un llavero y reinicia la app.",
  "Не удалось расшифровать локальные данные: ": "No se pudieron descifrar los datos locales: ",
  "Автозапуск доступен в собранном приложении": "El inicio automático está disponible en la app instalada",
  "Открыть Тайник": "Abrir Tainik",
  "Перезапустить и обновить до {0}": "Reiniciar y actualizar a {0}",
  "Запускать при входе в систему": "Iniciar al iniciar sesión",
  "Непрочитанных: {0}": "Sin leer: {0}",
  "Тайник — непрочитанных: {0}": "Tainik — sin leer: {0}",
  "Тайник работает в фоне": "Tainik se está ejecutando en segundo plano",
  "Открыть или выйти — через значок в трее. Отключить: меню ⋯ → «Работа в фоне».": "Abre o sal desde el icono de la bandeja. Para desactivarlo: menú ⋯ → «Segundo plano».",
  "Открыть снова — запустите Тайник. Отключить: меню ⋯ → «Работа в фоне».": "Para volver a abrirlo, inicia Tainik de nuevo. Para desactivarlo: menú ⋯ → «Segundo plano».",
  "Весь экран": "Pantalla completa",
  "сервер ответил {0}": "el servidor respondió {0}",
  "Не задан сервер": "No hay servidor configurado",
  "Не удалось проверить обновления: ": "No se pudieron buscar actualizaciones: ",
  "Для этой системы в выпуске нет файла": "La versión no incluye un archivo para este sistema",
  "Выпуск не подписан — установите вручную": "La versión no está firmada — instálala manualmente",
  "подпись выпуска не прошла проверку": "la firma de la versión no superó la verificación",
  "файла нет в подписанном списке": "el archivo no está en la lista firmada",
  "недопустимое имя файла": "nombre de archivo no válido",
  "контрольная сумма не совпала — файл повреждён или подменён": "la suma de verificación no coincide — el archivo está dañado o ha sido manipulado",
  "Обновление не скачалось: ": "La actualización no se descargó: ",
};
const JA = {
  "Тайник": "Tainik",
  "Ответить…": "返信…",
  "Системное хранилище ключей недоступно. Запуск невозможен.": "システムのキーチェーンを利用できません。Tainikを起動できません。",
  "Выйти": "終了",
  "Продолжить без защиты": "保護なしで続行",
  "Не найдена системная связка ключей": "システムのキーリングが見つかりません",
  "Без gnome-keyring или KWallet ключи шифрования будут защищены слабо: любой, у кого есть доступ к вашим файлам, сможет их прочитать. Установите связку ключей и перезапустите приложение.": "gnome-keyringまたはKWalletがないと、暗号鍵の保護が弱くなります：あなたのファイルにアクセスできる人なら誰でも読めてしまいます。キーリングをインストールしてアプリを再起動してください。",
  "Не удалось расшифровать локальные данные: ": "ローカルデータを復号できませんでした：",
  "Автозапуск доступен в собранном приложении": "ログイン時の自動起動はインストール版アプリで利用できます",
  "Открыть Тайник": "Tainikを開く",
  "Перезапустить и обновить до {0}": "再起動して {0} にアップデート",
  "Запускать при входе в систему": "ログイン時に起動",
  "Непрочитанных: {0}": "未読：{0}",
  "Тайник — непрочитанных: {0}": "Tainik — 未読：{0}",
  "Тайник работает в фоне": "Tainikはバックグラウンドで動作しています",
  "Открыть или выйти — через значок в трее. Отключить: меню ⋯ → «Работа в фоне».": "開く・終了はトレイアイコンから。オフにするには：メニュー ⋯ →「バックグラウンド動作」。",
  "Открыть снова — запустите Тайник. Отключить: меню ⋯ → «Работа в фоне».": "再び開くにはTainikを起動してください。オフにするには：メニュー ⋯ →「バックグラウンド動作」。",
  "Весь экран": "画面全体",
  "сервер ответил {0}": "サーバーの応答: {0}",
  "Не задан сервер": "サーバーが設定されていません",
  "Не удалось проверить обновления: ": "アップデートを確認できませんでした：",
  "Для этой системы в выпуске нет файла": "リリースにこのシステム用のファイルがありません",
  "Выпуск не подписан — установите вручную": "リリースが署名されていません — 手動でインストールしてください",
  "подпись выпуска не прошла проверку": "リリースの署名の検証に失敗しました",
  "файла нет в подписанном списке": "ファイルが署名済みの一覧にありません",
  "недопустимое имя файла": "無効なファイル名",
  "контрольная сумма не совпала — файл повреждён или подменён": "チェックサムが一致しません — ファイルが破損しているか、改ざんされています",
  "Обновление не скачалось: ": "アップデートをダウンロードできませんでした：",
};
const DICTS = { en: EN, es: ES, ja: JA };
const LANG_CODES = ['ru', 'en', 'es', 'ja'];

let langSource = () => 'ru';
/** Откуда брать язык: функция, возвращающая 'ru', 'en', 'es' или 'ja'. */
function setLangSource(fn) {
  langSource = fn;
}
/** Язык по коду системы: русский и близкие — 'ru', испанский — 'es', японский — 'ja', остальные — 'en'. */
function langFromLocale(locale) {
  if (!locale) return 'ru'; // язык системы неизвестен — исходный язык интерфейса
  const l = String(locale);
  if (/^(ru|be|uk|kk|ky|uz|tg|hy|az|ka)\b/i.test(l)) return 'ru';
  if (/^es\b/i.test(l)) return 'es';
  if (/^ja\b/i.test(l)) return 'ja';
  return 'en';
}
/** Выбранный в приложении язык, если он известен, иначе null. */
const knownLang = (l) => (LANG_CODES.includes(l) ? l : null);
function t(s, ...args) {
  const lang = langSource();
  const out = lang === 'ru' ? s : (DICTS[lang]?.[s] ?? EN[s] ?? s);
  return args.length ? out.replace(/\{(\d+)\}/g, (m, i) => String(args[i] ?? '')) : out;
}

module.exports = { t, setLangSource, langFromLocale, knownLang, EN, ES, JA };
