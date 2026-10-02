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
} = require('electron');
const { SecureStore, resolveAppPath, MIME, CSP } = require('./lib.cjs');
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
let settings = {};
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
    return new SecureStore({
      file,
      encrypt: (s) => safeStorage.encryptString(s),
      decrypt: (b) => safeStorage.decryptString(b),
    });
  } catch (e) {
    dialog.showErrorBox('Тайник', 'Не удалось расшифровать локальные данные: ' + e.message);
    app.exit(1);
    return null;
  }
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
  ipcMain.handle('store:get', guard((k) => store.get(key(k))));
  ipcMain.handle('store:set', guard((k, v) => store.set(key(k), v)));
  ipcMain.handle('store:del', guard((k) => store.del(key(k))));
  ipcMain.handle('store:clear', guard(() => store.clear()));
  ipcMain.handle('settings:get', guard((k) => (typeof k === 'string' ? settings[k] ?? null : null)));
  ipcMain.handle(
    'settings:set',
    guard((k, v) => {
      if (typeof k !== 'string' || (v !== null && typeof v !== 'string')) throw new Error('bad setting');
      settings[k] = v;
      saveSettings();
    })
  );
  ipcMain.on('notify', (event, body) => {
    if (!fromApp(event) || !Notification.isSupported()) return;
    if (win && win.isFocused()) return;
    const n = new Notification({ title: 'Тайник', body: String(body).slice(0, 120), silent: false });
    n.on('click', () => {
      if (!win) return;
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    });
    n.show();
  });
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

function createWindow() {
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
    },
  });
  win.once('ready-to-show', () => win.show());
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
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
});

app.whenReady().then(() => {
  if (process.platform === 'win32') app.setAppUserModelId('dev.tainik.desktop');
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
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  if (store) store.flushSync();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
