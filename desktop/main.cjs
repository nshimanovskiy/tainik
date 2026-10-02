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
} = require('electron');
const { SecureStore, resolveAppPath, MIME, CSP, linuxAutostartEntry } = require('./lib.cjs');
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
function saveSettings() {
  fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2), { mode: 0o600 });
}

function openStore() {
  if (!safeStorage.isEncryptionAvailable()) {
    dialog.showErrorBox('Тайник', 'Системное хранилище ключей недоступно. Запуск невозможен.');
    app.exit(1);
    return null;
  }
  // На Linux без связки ключей (gnome-keyring / kwallet) Electron шифрует
  // фиксированным паролем — честно предупреждаем пользователя.
  if (process.platform === 'linux' && safeStorage.getSelectedStorageBackend?.() === 'basic_text') {
    const choice = dialog.showMessageBoxSync({
      type: 'warning',
      buttons: ['Выйти', 'Продолжить без защиты'],
      defaultId: 0,
      cancelId: 0,
      title: 'Тайник',
      message: 'Не найдена системная связка ключей',
      detail:
        'Без gnome-keyring или KWallet ключи шифрования будут защищены слабо: любой, у кого есть доступ к вашим файлам, сможет их прочитать. Установите связку ключей и перезапустите приложение.',
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
    dialog.showErrorBox('Тайник', 'Не удалось расшифровать локальные данные: ' + e.message);
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
  if (!autostartSupported()) throw new Error('Автозапуск доступен в собранном приложении');
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
  tray.setToolTip('Тайник');
  if (!isMac) tray.on('click', showWindow);
  updateTrayMenu();
}

function updateTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Открыть Тайник', click: showWindow },
      { type: 'separator' },
      {
        label: 'Запускать при входе в систему',
        type: 'checkbox',
        checked: getAutostart(),
        enabled: autostartSupported(),
        click: (item) => {
          try {
            setAutostart(item.checked);
          } catch (e) {
            dialog.showErrorBox('Тайник', e.message);
          }
        },
      },
      { type: 'separator' },
      { label: 'Выйти', click: quitApp },
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
function showNotice({ title, body, chat, call }) {
  if (!Notification.isSupported()) return;
  const key = (call ? 'call:' : 'msg:') + chat;
  notices.get(key)?.close();
  const n = new Notification({
    title,
    body,
    silent: false,
    urgency: call ? 'critical' : 'normal',
    timeoutType: call ? 'never' : 'default',
    icon: isLinux ? path.join(BUILD, 'icon.png') : undefined,
  });
  n.on('click', () => {
    showWindow();
    if (chat) win?.webContents.send('open-chat', chat);
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
    win.setOverlayIcon(count ? overlay : null, count ? `Непрочитанных: ${count}` : '');
  }
  tray?.setToolTip(count ? `Тайник — непрочитанных: ${count}` : 'Тайник');
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
  ipcMain.handle('store:get', guard((k, ns) => storeFor(ns).get(key(k))));
  ipcMain.handle('store:set', guard((k, v, ns) => storeFor(ns).set(key(k), v)));
  ipcMain.handle('store:del', guard((k, ns) => storeFor(ns).del(key(k))));
  ipcMain.handle('store:clear', guard((ns) => storeFor(ns).clear()));
  ipcMain.handle('settings:get', guard((k) => (typeof k === 'string' ? settings[k] ?? null : null)));
  ipcMain.handle(
    'settings:set',
    guard((k, v) => {
      if (typeof k !== 'string' || (v !== null && typeof v !== 'string')) throw new Error('bad setting');
      settings[k] = v;
      saveSettings();
    })
  );
  ipcMain.on('notify', (event, n) => {
    if (!fromApp(event) || !n || typeof n !== 'object') return;
    if (win && win.isVisible() && win.isFocused()) return;
    const chat = /^[a-z0-9_]{3,32}$/.test(n.chat) ? n.chat : '';
    showNotice({ title: String(n.title || 'Тайник').slice(0, 64), body: String(n.body || '').slice(0, 200), chat, call: !!n.call });
    if (win) {
      // Входящий звонок: показываем окно из трея (без перехвата фокуса), иначе мигаем на панели задач
      if (n.call && !win.isVisible()) win.showInactive();
      win.flashFrame(true);
    }
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
      clearTimeout(t);
      resolve(typeof chosen === 'string' ? chosen : null);
    };
    const t = setTimeout(() => {
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
    title: 'Тайник',
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
        title: 'Тайник работает в фоне',
        body: tray ? 'Открыть или выйти — через значок в трее. Отключить: меню ⋯ → «Работа в фоне».' : 'Открыть снова — запустите Тайник. Отключить: меню ⋯ → «Работа в фоне».',
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
    if (url.startsWith('https://')) shell.openExternal(url);
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

app.whenReady().then(() => {
  if (process.platform === 'win32') app.setAppUserModelId('dev.tainik.desktop');
  if (isMac) {
    const li = app.getLoginItemSettings();
    startHidden ||= !!(li.wasOpenedAtLogin || li.wasOpenedAsHidden);
  }
  loadSettings();
  store = openStore();
  if (!store) return;
  // Разрешены только уведомления, микрофон/камера (звонки, QR) и захват экрана —
  // и только для страницы самого приложения
  const allowed = new Set(['notifications', 'media', 'display-capture']);
  const ours = (wc, origin) => {
    const u = origin || wc?.getURL?.() || '';
    return u.startsWith(APP_ORIGIN);
  };
  session.defaultSession.setPermissionRequestHandler(async (wc, permission, cb, details) => {
    if (!allowed.has(permission) || !ours(wc, details?.requestingUrl)) return cb(false);
    if (permission === 'media' && process.platform === 'darwin') {
      // macOS: системный запрос доступа к микрофону/камере
      for (const t of details?.mediaTypes || []) {
        const kind = t === 'audio' ? 'microphone' : 'camera';
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
      const visible = sources.filter((s) => !s.name.includes('Tainik') && !s.name.includes('Тайник') || s.id.startsWith('screen:'));
      const id = await pickSource(
        visible.map((s) => ({
          id: s.id,
          name: s.id.startsWith('screen:') ? (sources.filter((x) => x.id.startsWith('screen:')).length > 1 ? s.name : 'Весь экран') : s.name,
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
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
