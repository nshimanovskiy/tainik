// Главный процесс Electron: окно, защищённое хранилище, протокол app://.
'use strict';
const path = require('node:path');
const fs = require('node:fs');
const {
  app,
  BrowserWindow,
  protocol,
  ipcMain,
  safeStorage,
  session,
  shell,
  dialog,
  Notification,
  desktopCapturer,
  systemPreferences,
  Tray,
  Menu,
  nativeImage,
  powerMonitor,
  net,
} = require('electron');
const { spawn } = require('node:child_process');
const { Updater, updateKind, serverBase, macInstallScript } = require('./updater.cjs');
const { t, setLangSource, langFromLocale, knownLang } = require('./i18n.cjs');
const { SecureStore, resolveAppPath, MIME, CSP, linuxAutostartEntry } = require('./lib.cjs');
const { cleanProxy, startRelay, testProxy } = require('./proxy.cjs');
// Хранилище v3 (несколько устройств) несовместимо с v2 — отдельный файл

const RENDERER_DIR = path.join(__dirname, 'renderer');
const APP_ORIGIN = 'app://app';

// app:// — «защищённый» источник: в нём доступны WebCrypto и IndexedDB
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

// Только один экземпляр: состояние Double Ratchet нельзя менять из двух процессов
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

let win = null;
let store = null;
// Хранилища дополнительных аккаунтов: свой файл на каждый (tainik-store-v3-<ns>.bin)
const extraStores = new Map();
const newStore = (file) =>
  new SecureStore({
    file,
    encrypt: (s) => safeStorage.encryptString(s),
    decrypt: (b) => safeStorage.decryptString(b),
  });
function storeFor(ns) {
  if (ns == null || ns === '') return store;
  if (!SecureStore.validNs(ns)) throw new Error('bad namespace');
  if (!extraStores.has(ns)) extraStores.set(ns, newStore(path.join(app.getPath('userData'), `tainik-store-v3-${ns}.bin`)));
  return extraStores.get(ns);
}
function flushStores() {
  store?.flushSync();
  for (const s of extraStores.values()) s.flushSync();
}
let settings = {};
let tray = null;
let quitting = false; // true — окно действительно закрывается (выход), а не прячется в трей
const isMac = process.platform === 'darwin';
const isWin = process.platform === 'win32';
const isLinux = process.platform === 'linux';
const BUILD = path.join(__dirname, 'build');
// Запуск при входе в систему — сразу в фоне, без окна (определяется после app.whenReady)
let startHidden = process.argv.includes('--hidden');
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');

function loadSettings() {
  try {
    settings = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
  } catch {
    settings = {};
  }
}
// Язык трея и системных окон: выбор в приложении, иначе язык системы
setLangSource(() => knownLang(settings.lang) || langFromLocale(app.getLocale?.()));
function saveSettings() {
  fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2), { mode: 0o600 });
}

function openStore() {
  if (!safeStorage.isEncryptionAvailable()) {
    dialog.showErrorBox(t('Тайник'), t('Системное хранилище ключей недоступно. Запуск невозможен.'));
    app.exit(1);
    return null;
  }
  // На Linux без связки ключей (gnome-keyring / kwallet) Electron шифрует
  // фиксированным паролем — честно предупреждаем пользователя.
  if (process.platform === 'linux' && safeStorage.getSelectedStorageBackend?.() === 'basic_text') {
    const choice = dialog.showMessageBoxSync({
      type: 'warning',
      buttons: [t('Выйти'), t('Продолжить без защиты')],
      defaultId: 0,
      cancelId: 0,
      title: t('Тайник'),
      message: t('Не найдена системная связка ключей'),
      detail:
        t('Без gnome-keyring или KWallet ключи шифрования будут защищены слабо: любой, у кого есть доступ к вашим файлам, сможет их прочитать. Установите связку ключей и перезапустите приложение.'),
    });
    if (choice === 0) {
      app.exit(0);
      return null;
    }
  }
  const file = path.join(app.getPath('userData'), 'tainik-store-v3.bin');
  try {
    return newStore(file);
  } catch (e) {
    dialog.showErrorBox(t('Тайник'), t('Не удалось расшифровать локальные данные: ') + e.message);
    app.exit(1);
    return null;
  }
}

// ---------- Окно, трей, автозапуск ----------
const backgroundOn = () => settings.tray !== '0'; // по умолчанию при закрытии окна остаёмся в фоне

function showWindow() {
  if (!win) createWindow(true);
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function quitApp() {
  quitting = true;
  app.quit();
}

// ---------- Самообновление (см. updater.cjs) ----------
let updater = null;
let pendingInstall = null; // { relaunch } — установить при выходе
const autoUpdate = () => settings.autoUpdate !== '0';

// Сервер, с которого брать обновления: тот, к которому подключён мессенджер
function updateServer() {
  let ws = settings.server;
  if (!ws) {
    try {
      const list = JSON.parse(settings.accounts || '[]');
      ws = list.find((a) => a && a.server)?.server;
    } catch {}
  }
  if (!ws) {
    try {
      const cfg = fs.readFileSync(path.join(RENDERER_DIR, 'config.js'), 'utf8');
      ws = /"defaultServer":\s*"([^"]+)"/.exec(cfg)?.[1];
    } catch {}
  }
  return ws ? serverBase(ws) : null;
}

function setupUpdater() {
  let publicKey = null;
  try {
    publicKey = fs.readFileSync(path.join(__dirname, 'release-key.pem'), 'utf8');
  } catch {}
  // В несобранном виде (npm start) не обновляемся: устанавливать некуда
  const kind = app.isPackaged ? updateKind({ platform: process.platform, arch: process.arch, env: process.env }) : null;
  updater = new Updater({
    current: app.getVersion(),
    kind,
    dir: path.join(app.getPath('userData'), 'updates'),
    base: updateServer,
    publicKey,
    fetch: (url, opts) => (net?.fetch ? net.fetch(url, opts) : fetch(url, opts)),
    auto: autoUpdate,
    onChange: (st) => {
      win?.webContents.send('upd:state', { ...st, auto: autoUpdate() });
      updateTrayMenu();
    },
  });
  // Остатки прошлой замены файла (переносная версия Windows)
  if (kind === 'win-portable') fs.rmSync(process.env.PORTABLE_EXECUTABLE_FILE + '.old', { force: true });
  updater.start();
}

/** Перезапустить с новой версией (relaunch) или поставить её при выходе. */
function installUpdate(relaunch) {
  const r = updater?.ready;
  if (!r) return false;
  if (updater.kind === 'linux-deb') {
    // .deb ставится с правами администратора — открываем его в установщике пакетов системы
    shell.openPath(r.file);
    return 'opened';
  }
  if (updater.kind.startsWith('mac')) {
    const bundle = path.resolve(app.getPath('exe'), '../../..');
    try {
      fs.accessSync(path.dirname(bundle), fs.constants.W_OK);
    } catch {
      shell.openPath(r.file); // нет прав на папку с приложением — пусть пользователь перетащит сам
      return 'opened';
    }
  }
  pendingInstall = { relaunch };
  if (relaunch && (updater.kind === 'win-portable' || updater.kind === 'linux-appimage')) {
    app.relaunch({ execPath: updater.kind === 'win-portable' ? process.env.PORTABLE_EXECUTABLE_FILE : process.env.APPIMAGE, args: [] });
  }
  quitApp();
  return true;
}

// Сама установка — в последний момент, когда окно закрыто и данные сохранены
function runPendingInstall() {
  const r = updater?.ready;
  if (!r || !pendingInstall) return;
  const { relaunch } = pendingInstall;
  pendingInstall = null;
  try {
    const kind = updater.kind;
    if (kind === 'win') {
      // Установщик NSIS в тихом режиме ставит поверх; --force-run — запустить после установки
      spawn(r.file, relaunch ? ['/S', '--force-run'] : ['/S'], { detached: true, stdio: 'ignore' }).unref();
    } else if (kind === 'win-portable' || kind === 'linux-appimage') {
      // Запущенный файл нельзя перезаписать, но можно переименовать: кладём новый на его место
      const target = kind === 'win-portable' ? process.env.PORTABLE_EXECUTABLE_FILE : process.env.APPIMAGE;
      const old = target + '.old';
      fs.rmSync(old, { force: true });
      fs.renameSync(target, old);
      try {
        fs.copyFileSync(r.file, target);
        fs.chmodSync(target, 0o755);
      } catch (e) {
        fs.renameSync(old, target);
        throw e;
      }
      if (kind === 'linux-appimage') fs.rmSync(old, { force: true });
      fs.rmSync(r.file, { force: true });
    } else if (kind.startsWith('mac')) {
      const script = path.join(updater.dir, 'install.sh');
      const bundle = path.resolve(app.getPath('exe'), '../../..');
      fs.writeFileSync(script, macInstallScript({ pid: process.pid, dmg: r.file, bundle, relaunch }), { mode: 0o755 });
      spawn('/bin/sh', [script], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch (e) {
    console.error('update install', e);
  }
}

// Автозапуск. В несобранном виде (npm start) не включаем: в систему записался бы путь к electron.
const autostartSupported = () => app.isPackaged && (isWin || isMac || isLinux);
const winExe = () => process.env.PORTABLE_EXECUTABLE_FILE || process.execPath; // переносная версия — свой .exe
const linuxAutostartFile = () => path.join(app.getPath('appData'), 'autostart', 'tainik.desktop'); // ~/.config/autostart

function getAutostart() {
  if (!autostartSupported()) return false;
  if (isLinux) return fs.existsSync(linuxAutostartFile());
  if (isWin) return app.getLoginItemSettings({ path: winExe(), args: ['--hidden'] }).openAtLogin;
  return app.getLoginItemSettings().openAtLogin;
}

function setAutostart(on) {
  if (!autostartSupported()) throw new Error(t('Автозапуск доступен в собранном приложении'));
  if (isLinux) {
    const file = linuxAutostartFile();
    if (on) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, linuxAutostartEntry(process.env.APPIMAGE || process.execPath), { mode: 0o644 });
    } else {
      fs.rmSync(file, { force: true });
    }
  } else if (isWin) {
    app.setLoginItemSettings({ openAtLogin: on, path: winExe(), args: ['--hidden'] });
  } else {
    app.setLoginItemSettings({ openAtLogin: on, openAsHidden: true });
  }
  updateTrayMenu();
}

function trayIcon() {
  if (isMac) {
    const img = nativeImage.createFromPath(path.join(BUILD, 'trayTemplate.png')); // @2x подхватывается сам
    img.setTemplateImage(true);
    return img;
  }
  const img = nativeImage.createFromPath(path.join(BUILD, 'tray.png'));
  return isWin ? img.resize({ width: 16, height: 16, quality: 'best' }) : img;
}

function createTray() {
  if (tray) return;
  try {
    tray = new Tray(trayIcon());
  } catch (e) {
    console.error('tray', e); // нет области уведомлений (например, GNOME без расширения) — окно откроет повторный запуск
    tray = null;
    return;
  }
  tray.setToolTip(t('Тайник'));
  if (!isMac) tray.on('click', showWindow);
  updateTrayMenu();
}

function updateTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: t('Открыть Тайник'), click: showWindow },
      ...(updater?.ready && updater.kind !== 'linux-deb'
        ? [{ label: t('Перезапустить и обновить до {0}', updater.ready.version), click: () => installUpdate(true) }]
        : []),
      { type: 'separator' },
      {
        label: t('Запускать при входе в систему'),
        type: 'checkbox',
        checked: getAutostart(),
        enabled: autostartSupported(),
        click: (item) => {
          try {
            setAutostart(item.checked);
          } catch (e) {
            dialog.showErrorBox(t('Тайник'), e.message);
          }
        },
      },
      { type: 'separator' },
      { label: t('Выйти'), click: quitApp },
    ])
  );
}

function setBackground(on) {
  settings.tray = on ? '1' : '0';
  saveSettings();
  if (on) createTray();
  else if (tray) {
    tray.destroy();
    tray = null;
  }
}

// Уведомления: по одному на чат (новое заменяет старое); ссылки держим, иначе сборщик мусора
// уберёт объект и клик по уведомлению перестанет работать.
const notices = new Map();
function showNotice({ title, body, chat, call, reply, msg = '' }) {
  if (!Notification.isSupported()) return;
  const key = (call ? 'call:' : 'msg:') + chat;
  notices.get(key)?.close();
  // Ответ прямо из уведомления — поле ввода есть у уведомлений macOS
  const canReply = !!reply && !!chat && !call && isMac;
  const n = new Notification({
    title,
    body,
    hasReply: canReply,
    replyPlaceholder: canReply ? t('Ответить…') : undefined,
    silent: false,
    urgency: call ? 'critical' : 'normal',
    timeoutType: call ? 'never' : 'default',
    icon: isLinux ? path.join(BUILD, 'icon.png') : undefined,
  });
  n.on('click', () => {
    showWindow();
    if (chat) win?.webContents.send('open-chat', chat);
  });
  n.on('reply', (_e, text) => {
    text = String(text || '').trim().slice(0, 20000);
    if (text && chat) win?.webContents.send('notice-reply', { chat, text, msg });
  });
  n.on('close', () => notices.get(key) === n && notices.delete(key));
  notices.set(key, n);
  n.show();
}

let overlay = null;
function setBadge(count) {
  if (isMac || isLinux) app.setBadgeCount(count); // док macOS, Unity/KDE на Linux
  if (isWin && win) {
    overlay ||= nativeImage.createFromPath(path.join(BUILD, 'badge.png'));
    win.setOverlayIcon(count ? overlay : null, count ? t('Непрочитанных: {0}', count) : '');
  }
  tray?.setToolTip(count ? t('Тайник — непрочитанных: {0}', count) : t('Тайник'));
}

// IPC принимаем только от нашей страницы
function fromApp(event) {
  const url = event.senderFrame && event.senderFrame.url;
  return typeof url === 'string' && url.startsWith(APP_ORIGIN + '/');
}

function registerIpc() {
  const guard = (fn) => (event, ...args) => {
    if (!fromApp(event)) throw new Error('forbidden');
    return fn(...args);
  };
  const key = (k) => {
    if (!SecureStore.validKey(k)) throw new Error('bad key');
    return k;
  };
  ipcMain.handle('app:version', guard(() => app.getVersion()));
  // Обновления
  ipcMain.handle('upd:get', guard(() => ({ ...(updater?.state || { status: 'unsupported' }), auto: autoUpdate() })));
  ipcMain.handle('upd:check', guard(() => updater?.check().then(() => true)));
  ipcMain.handle('upd:download', guard(() => updater?.download().then(() => true)));
  ipcMain.handle('upd:install', guard(() => installUpdate(true)));
  ipcMain.handle(
    'upd:auto',
    guard((on) => {
      settings.autoUpdate = on ? '1' : '0';
      saveSettings();
      if (on && updater?.state.status === 'available') updater.download();
      return true;
    })
  );
  ipcMain.handle('store:get', guard((k, ns) => storeFor(ns).get(key(k))));
  ipcMain.handle('store:set', guard((k, v, ns) => storeFor(ns).set(key(k), v)));
  ipcMain.handle('store:del', guard((k, ns) => storeFor(ns).del(key(k))));
  ipcMain.handle('store:clear', guard((ns) => storeFor(ns).clear()));
  // Ключи на «_» — служебные (прокси с зашифрованным паролем): странице недоступны
  ipcMain.handle('settings:get', guard((k) => (typeof k === 'string' && !k.startsWith('_') ? settings[k] ?? null : null)));
  ipcMain.handle(
    'settings:set',
    guard((k, v) => {
      if (typeof k !== 'string' || k.startsWith('_') || (v !== null && typeof v !== 'string')) throw new Error('bad setting');
      settings[k] = v;
      saveSettings();
      if (k === 'lang') updateTrayMenu(); // трей — на новом языке
    })
  );
  // Прокси: настройки, применение, проверка (пароль странице не возвращается)
  ipcMain.handle('proxy:get', guard(() => proxyPublic()));
  ipcMain.handle(
    'proxy:set',
    guard(async (cfg) => {
      const next = cleanProxy({ ...cfg, pass: cfg?.pass == null ? proxyCfg.pass : cfg.pass });
      saveProxyConfig(next);
      await applyProxy();
      return proxyPublic();
    })
  );
  ipcMain.handle(
    'proxy:test',
    guard(async (cfg, serverUrl) => {
      try {
        const c = cleanProxy({ ...cfg, enabled: true, pass: cfg?.pass == null ? proxyCfg.pass : cfg.pass });
        const u = new URL(String(serverUrl));
        const port = Number(u.port) || (u.protocol === 'wss:' || u.protocol === 'https:' ? 443 : 80);
        return { ok: true, ms: await testProxy(c, u.hostname, port) };
      } catch (e) {
        return { ok: false, code: e.code && String(e.code).startsWith('proxy_') ? e.code : 'proxy_unreachable' };
      }
    })
  );
  ipcMain.on('notify', (event, n) => {
    if (!fromApp(event) || !n || typeof n !== 'object') return;
    // force — сообщение другому аккаунту: в окне его не видно, показываем и при открытом окне
    if (!n.force && win && win.isVisible() && win.isFocused()) return;
    // Чат: юзернейм, группа '#…' или канал '!…' (у другого аккаунта — с '@id')
    const chat = /^([a-z0-9_]{3,32}|#[0-9a-f]{24}|![0-9a-f]{32}|~tainik)(@(main|a[0-9a-f]{8}))?$/.test(n.chat) ? n.chat : '';
    const msg = typeof n.msg === 'string' && /^[A-Za-z0-9+/=_-]{1,64}$/.test(n.msg) ? n.msg : '';
    showNotice({ title: String(n.title || t('Тайник')).slice(0, 64), body: String(n.body || '').slice(0, 200), chat, call: !!n.call, reply: !!n.reply, msg });
    if (win) {
      // Входящий звонок: показываем окно из трея (без перехвата фокуса), иначе мигаем на панели задач
      if (n.call && !win.isVisible()) win.showInactive();
      win.flashFrame(true);
    }
  });
  // Чат прочитан (здесь или на другом устройстве) — его уведомление больше не нужно
  ipcMain.on('dismiss-notice', (event, n) => {
    if (!fromApp(event) || !n || typeof n !== 'object') return;
    const key = (n.call ? 'call:' : 'msg:') + String(n.chat || '');
    notices.get(key)?.close();
    notices.delete(key);
  });
  ipcMain.on('badge', (event, n) => {
    if (!fromApp(event)) return;
    setBadge(Math.max(0, Math.min(9999, Math.floor(Number(n) || 0))));
  });
  ipcMain.handle('bg:get', guard(() => ({ tray: backgroundOn(), autostart: getAutostart(), autostartSupported: autostartSupported() })));
  ipcMain.handle(
    'bg:set',
    guard((k, v) => {
      if (k === 'tray') return setBackground(!!v);
      if (k === 'autostart') return setAutostart(!!v);
      throw new Error('bad key');
    })
  );
}

function registerAppProtocol() {
  protocol.handle('app', async (request) => {
    const file = resolveAppPath(RENDERER_DIR, request.url);
    if (!file) return new Response('Forbidden', { status: 403 });
    try {
      const body = await fs.promises.readFile(file);
      return new Response(body, {
        headers: {
          'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
          'Content-Security-Policy': CSP,
          'X-Content-Type-Options': 'nosniff',
          'Cache-Control': 'no-cache',
        },
      });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
}

// Запрос выбора источника у страницы (preload: desktop.onPickSource)
let pickSeq = 0;
function pickSource(list) {
  return new Promise((resolve) => {
    if (!win || win.isDestroyed()) return resolve(null);
    const reqId = ++pickSeq;
    const onResult = (event, id, chosen) => {
      if (id !== reqId || !fromApp(event)) return;
      ipcMain.removeListener('pick-source-result', onResult);
      clearTimeout(timer);
      resolve(typeof chosen === 'string' ? chosen : null);
    };
    const timer = setTimeout(() => {
      ipcMain.removeListener('pick-source-result', onResult);
      resolve(null);
    }, 120_000);
    ipcMain.on('pick-source-result', onResult);
    if (win.isMinimized()) win.restore();
    win.focus();
    win.webContents.send('pick-source', reqId, list);
  });
}

function createWindow(forceShow = false) {
  win = new BrowserWindow({
    width: 1100,
    height: 740,
    minWidth: 380,
    minHeight: 500,
    title: t('Тайник'),
    backgroundColor: '#f3f1ec',
    autoHideMenuBar: true,
    icon: path.join(__dirname, 'build', 'icon.png'),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: true,
      devTools: !app.isPackaged,
      // В фоне (окно спрятано) таймеры переподключения и пинга не должны засыпать
      backgroundThrottling: false,
    },
  });
  win.once('ready-to-show', () => {
    if (forceShow || !startHidden) win.show();
  });
  // Масштаб интерфейса всегда 100%: без Ctrl+колесо, Ctrl +/−/0 и щипка на тачпаде (раньше
  // случайно увеличенный масштаб запоминался Chromium для страницы и оставался навсегда)
  const wc = win.webContents;
  const resetZoom = () => {
    wc.setZoomFactor(1);
    wc.setVisualZoomLevelLimits(1, 1).catch(() => {});
  };
  wc.on('did-finish-load', resetZoom);
  wc.on('zoom-changed', resetZoom);
  wc.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && (input.control || input.meta) && ['+', '=', '-', '_', '0', 'Add', 'Subtract', 'NumpadAdd', 'NumpadSubtract', 'Numpad0'].includes(input.key)) event.preventDefault();
  });
  win.on('focus', () => win.flashFrame(false));
  // Закрытие окна — уход в фон: соединение остаётся, сообщения и звонки приходят
  win.on('close', (e) => {
    if (quitting || !backgroundOn()) return;
    e.preventDefault();
    win.hide();
    if (!settings.backgroundHintShown) {
      settings.backgroundHintShown = '1';
      saveSettings();
      showNotice({
        title: t('Тайник работает в фоне'),
        body: tray ? t('Открыть или выйти — через значок в трее. Отключить: меню ⋯ → «Работа в фоне».') : t('Открыть снова — запустите Тайник. Отключить: меню ⋯ → «Работа в фоне».'),
        chat: '',
      });
    }
  });
  // Windows: выход из системы / выключение — не мешаем закрыться
  win.on('session-end', () => {
    quitting = true;
    flushStores();
  });
  win.on('closed', () => (win = null));
  win.loadURL(APP_ORIGIN + '/index.html');
}

// Запрещаем любые переходы и новые окна; https-ссылки открываем в браузере
app.on('web-contents-created', (_e, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  contents.on('will-navigate', (event, url) => {
    if (!url.startsWith(APP_ORIGIN + '/')) event.preventDefault();
  });
  contents.on('will-attach-webview', (event) => event.preventDefault());
});

app.on('second-instance', () => {
  if (store) showWindow();
});

// ---------- Прокси ----------
// Chromium ходит в локальный ретранслятор (proxy.cjs), а тот — через прокси пользователя,
// в том числе SOCKS5 с паролем, которого Chromium сам не умеет. Пароль хранится зашифрованным
// через safeStorage, как и переписка.
let proxyCfg = cleanProxy({});
let proxyRelay = null;
function loadProxyConfig() {
  try {
    const p = JSON.parse(settings._proxy || 'null');
    if (!p) return cleanProxy({});
    const pass = p.pass64 ? safeStorage.decryptString(Buffer.from(p.pass64, 'base64')) : '';
    return cleanProxy({ ...p, pass });
  } catch {
    return cleanProxy({});
  }
}
function saveProxyConfig(cfg) {
  const { pass, ...rest } = cfg;
  settings._proxy = JSON.stringify({ ...rest, pass64: pass ? safeStorage.encryptString(pass).toString('base64') : '' });
  saveSettings();
}
const proxyPublic = () => ({ ...proxyCfg, pass: undefined, hasPass: !!proxyCfg.pass, active: !!proxyRelay });
async function applyProxy() {
  proxyCfg = loadProxyConfig();
  if (proxyRelay) {
    await proxyRelay.close().catch(() => {});
    proxyRelay = null;
  }
  if (proxyCfg.enabled) {
    proxyRelay = await startRelay(() => proxyCfg, { onError: (e) => console.warn('proxy:', e.code) });
    await session.defaultSession.setProxy({ proxyRules: `127.0.0.1:${proxyRelay.port}` });
  } else {
    await session.defaultSession.setProxy({ mode: 'system' });
  }
  await session.defaultSession.closeAllConnections?.().catch?.(() => {});
}

app.whenReady().then(async () => {
  if (process.platform === 'win32') app.setAppUserModelId('dev.tainik.desktop');
  if (isMac) {
    const li = app.getLoginItemSettings();
    startHidden ||= !!(li.wasOpenedAtLogin || li.wasOpenedAsHidden);
  }
  loadSettings();
  store = openStore();
  if (!store) return;
  // Разрешены только уведомления, микрофон/камера (звонки, QR), захват экрана и выбор
  // устройства вывода звука — и только для страницы самого приложения
  const allowed = new Set(['notifications', 'media', 'display-capture', 'speaker-selection']);
  const ours = (wc, origin) => {
    const u = origin || wc?.getURL?.() || '';
    return u.startsWith(APP_ORIGIN);
  };
  session.defaultSession.setPermissionRequestHandler(async (wc, permission, cb, details) => {
    if (!allowed.has(permission) || !ours(wc, details?.requestingUrl)) return cb(false);
    if (permission === 'media' && process.platform === 'darwin') {
      // macOS: системный запрос доступа к микрофону/камере
      for (const mt of details?.mediaTypes || []) {
        const kind = mt === 'audio' ? 'microphone' : 'camera';
        if (systemPreferences.getMediaAccessStatus(kind) !== 'granted') {
          const ok = await systemPreferences.askForMediaAccess(kind).catch(() => false);
          if (!ok) return cb(false);
        }
      }
    }
    cb(true);
  });
  session.defaultSession.setPermissionCheckHandler((wc, permission, origin) => allowed.has(permission) && ours(wc, origin));

  // Трансляция экрана: getDisplayMedia() → список экранов и окон → выбор в окне приложения
  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    try {
      if (!win || !String(request.securityOrigin || request.frame?.url || APP_ORIGIN).startsWith(APP_ORIGIN)) return callback({});
      const sources = await desktopCapturer.getSources({
        types: ['screen', 'window'],
        thumbnailSize: { width: 320, height: 180 },
        fetchWindowIcons: false,
      });
      const visible = sources.filter((s) => !s.name.includes('Tainik') && !s.name.includes(t('Тайник')) || s.id.startsWith('screen:'));
      const id = await pickSource(
        visible.map((s) => ({
          id: s.id,
          name: s.id.startsWith('screen:') ? (sources.filter((x) => x.id.startsWith('screen:')).length > 1 ? s.name : t('Весь экран')) : s.name,
          thumb: s.thumbnail.toDataURL(),
        }))
      );
      const chosen = sources.find((s) => s.id === id);
      callback(chosen ? { video: chosen } : {});
    } catch (e) {
      console.error('display media', e);
      callback({});
    }
  });
  registerAppProtocol();
  registerIpc();
  // Прокси — до первого подключения страницы
  await applyProxy().catch((e) => console.error('proxy', e));
  setupUpdater();
  createWindow();
  if (backgroundOn()) createTray();
  powerMonitor.on('shutdown', () => {
    quitting = true; // macOS/Linux: выключение компьютера
    flushStores();
  });
  app.on('activate', showWindow); // клик по значку в доке macOS
});

app.on('before-quit', () => {
  quitting = true;
  if (store) flushStores();
  // Обновление скачано, а пользователь просто вышел — поставить его сейчас, без перезапуска
  if (!pendingInstall && updater?.ready && updater.kind !== 'linux-deb') {
    const macOk = !updater.kind.startsWith('mac') || (() => {
      try {
        fs.accessSync(path.dirname(path.resolve(app.getPath('exe'), '../../..')), fs.constants.W_OK);
        return true;
      } catch {
        return false;
      }
    })();
    if (macOk) pendingInstall = { relaunch: false };
  }
});

app.on('will-quit', runPendingInstall);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
