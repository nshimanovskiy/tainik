// Главный процесс десктопа с поддельным модулем electron: трей, работа в фоне,
// уведомления, счётчик, автозапуск. Настоящий Electron проверяется сборкой в CI.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Module = require('node:module');
const MAIN = require.resolve('../desktop/main.cjs');

function fakeElectron({ userData, appData, platform }) {
  const log = { notices: [], badge: [], login: [], trays: [], windows: [], errors: [] };
  const handlers = {};
  const ipcHandle = {};
  const ipcOn = {};
  let ready;
  const readyP = new Promise((r) => (ready = r));
  let loginOpen = false;

  class Emitter {
    constructor() {
      this.h = {};
    }
    on(e, f) {
      (this.h[e] ||= []).push(f);
      return this;
    }
    once(e, f) {
      return this.on(e, f);
    }
    emit(e, ...a) {
      for (const f of this.h[e] || []) f(...a);
    }
  }
  class BrowserWindow extends Emitter {
    constructor(opts) {
      super();
      this.opts = opts;
      this.visible = false;
      this.focused = false;
      this.minimized = false;
      this.sent = [];
      this.flash = null;
      this.overlay = undefined;
      const wc = new Emitter();
      Object.assign(wc, {
        send: (...a) => this.sent.push(a),
        getURL: () => 'app://app/index.html',
        zoom: 1,
        setZoomFactor: (z) => (wc.zoom = z),
        setVisualZoomLevelLimits: async () => {},
      });
      this.webContents = wc;
      log.windows.push(this);
    }
    static getAllWindows() {
      return log.windows.filter((w) => !w.destroyed);
    }
    loadURL(u) {
      this.url = u;
    }
    show() {
      this.visible = true;
    }
    showInactive() {
      this.visible = true;
      this.inactive = true;
    }
    hide() {
      this.visible = false;
      this.focused = false;
    }
    focus() {
      this.focused = true;
    }
    isVisible() {
      return this.visible;
    }
    isFocused() {
      return this.focused;
    }
    isMinimized() {
      return this.minimized;
    }
    restore() {
      this.minimized = false;
    }
    isDestroyed() {
      return !!this.destroyed;
    }
    flashFrame(f) {
      this.flash = f;
    }
    setOverlayIcon(img, desc) {
      this.overlay = { img, desc };
    }
    // имитация нажатия на крестик
    tryClose() {
      let prevented = false;
      this.emit('close', { preventDefault: () => (prevented = true) });
      if (!prevented) {
        this.destroyed = true;
        this.emit('closed');
      }
      return prevented;
    }
  }
  class Notification extends Emitter {
    constructor(o) {
      super();
      Object.assign(this, o);
      this.closed = false;
    }
    static isSupported() {
      return true;
    }
    show() {
      log.notices.push(this);
    }
    close() {
      this.closed = true;
      this.emit('close');
    }
  }
  class Tray extends Emitter {
    constructor(img) {
      super();
      this.img = img;
      this.tip = '';
      log.trays.push(this);
    }
    setToolTip(t) {
      this.tip = t;
    }
    setContextMenu(m) {
      this.menu = m;
    }
    destroy() {
      this.destroyed = true;
    }
  }
  const img = (p) => ({ path: p, resize() {
    return this;
  }, setTemplateImage() {} });
  const app = {
    isPackaged: true,
    requestSingleInstanceLock: () => true,
    whenReady: () => readyP,
    on: (e, f) => ((handlers[e] ||= []).push(f), app),
    emit: (e, ...a) => (handlers[e] || []).forEach((f) => f(...a)),
    getPath: (k) => (k === 'userData' ? userData : appData),
    getVersion: () => '0.7.0',
    setAppUserModelId() {},
    getLoginItemSettings: () => ({ openAtLogin: loginOpen }),
    setLoginItemSettings: (o) => (log.login.push(o), (loginOpen = o.openAtLogin)),
    setBadgeCount: (n) => log.badge.push(n),
    quit: () => app.emit('before-quit'),
    exit() {},
  };
  const electron = {
    app,
    BrowserWindow,
    Notification,
    Tray,
    Menu: { buildFromTemplate: (t) => t },
    nativeImage: { createFromPath: img },
    powerMonitor: new Emitter(),
    protocol: { registerSchemesAsPrivileged() {}, handle() {} },
    ipcMain: {
      handle: (n, f) => (ipcHandle[n] = f),
      on: (n, f) => (ipcOn[n] = f),
      removeListener() {},
    },
    safeStorage: {
      isEncryptionAvailable: () => true,
      getSelectedStorageBackend: () => 'gnome_libsecret',
      encryptString: (s) => Buffer.from(s),
      decryptString: (b) => b.toString(),
    },
    session: { defaultSession: { setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, setDisplayMediaRequestHandler() {}, async setProxy(c) { log.proxy = c; }, async closeAllConnections() {} } },
    shell: { openExternal() {} },
    dialog: { showErrorBox: (t, m) => log.errors.push(m), showMessageBoxSync: () => 1 },
    desktopCapturer: { getSources: async () => [] },
    systemPreferences: {},
  };
  const ours = { senderFrame: { url: 'app://app/index.html' } };
  const evil = { senderFrame: { url: 'https://evil.example/' } };
  return { electron, log, ready, ipcHandle, ipcOn, ours, evil, platform };
}

async function boot(t, { platform = 'linux', argv = [], env = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tainik-main-'));
  const userData = path.join(dir, 'userData');
  const appData = path.join(dir, 'config');
  fs.mkdirSync(userData, { recursive: true });
  const f = fakeElectron({ userData, appData, platform });
  const origLoad = Module._load;
  const origPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  const origArgv = process.argv;
  const origEnv = { ...process.env };
  Module._load = function (req, ...rest) {
    if (req === 'electron') return f.electron;
    return origLoad.call(this, req, ...rest);
  };
  Object.defineProperty(process, 'platform', { value: platform });
  process.argv = [process.argv[0], 'main.cjs', ...argv];
  Object.assign(process.env, env);
  delete require.cache[MAIN];
  require(MAIN);
  f.ready();
  await new Promise((r) => setTimeout(r, 20));
  t.after(() => {
    Module._load = origLoad;
    Object.defineProperty(process, 'platform', origPlatform);
    process.argv = origArgv;
    for (const k of Object.keys(env)) if (k in origEnv) process.env[k] = origEnv[k];
    else delete process.env[k];
    delete require.cache[MAIN];
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const win = () => f.log.windows.at(-1);
  win().emit('ready-to-show');
  return { ...f, win, appData, userData };
}

test('десктоп (Linux): закрытие окна — уход в трей, уведомление с переходом в чат, счётчик, автозапуск', async (t) => {
  const d = await boot(t, { platform: 'linux', env: { APPIMAGE: '/home/u/Apps/Tainik.AppImage' } });
  const w = d.win();
  assert.equal(w.opts.webPreferences.backgroundThrottling, false, 'в фоне таймеры не засыпают');
  assert.ok(w.visible, 'обычный запуск показывает окно');
  assert.equal(d.log.trays.length, 1, 'значок в трее');
  assert.match(d.log.trays[0].img.path, /tray\.png$/);
  const menu = d.log.trays[0].menu.map((i) => i.label).filter(Boolean);
  assert.deepEqual(menu, ['Открыть Тайник', 'Запускать при входе в систему', 'Выйти']);

  // Крестик: окно прячется, приложение продолжает работать; один раз — подсказка
  w.focus();
  assert.equal(w.tryClose(), true);
  assert.equal(w.visible, false);
  assert.equal(d.log.notices.length, 1);
  assert.equal(d.log.notices[0].title, 'Тайник работает в фоне');
  w.show();
  w.tryClose();
  assert.equal(d.log.notices.length, 1, 'подсказка показывается один раз');

  // Уведомление о сообщении: только от нашей страницы, клик открывает окно и чат
  d.ipcOn.notify(d.evil, { title: 'x', body: 'y', chat: 'alice' });
  assert.equal(d.log.notices.length, 1, 'чужая страница не может показать уведомление');
  d.ipcOn.notify(d.ours, { title: 'alice', body: 'Новое сообщение', chat: 'alice' });
  const n1 = d.log.notices.at(-1);
  assert.equal(n1.title, 'alice');
  assert.equal(w.flash, true, 'мигание на панели задач');
  d.ipcOn.notify(d.ours, { title: 'alice', body: 'ещё', chat: 'alice' });
  assert.ok(n1.closed, 'новое уведомление из того же чата заменяет старое');
  d.log.notices.at(-1).emit('click');
  assert.ok(w.visible && w.focused);
  assert.deepEqual(w.sent.at(-1), ['open-chat', 'alice']);
  w.emit('focus');
  assert.equal(w.flash, false);
  // окно в фокусе — уведомлений нет
  const before = d.log.notices.length;
  d.ipcOn.notify(d.ours, { title: 'bob', body: 'Новое сообщение', chat: 'bob' });
  assert.equal(d.log.notices.length, before);
  // Группы и каналы тоже открываются; ответ из уведомления (macOS) уходит странице
  w.hide();
  d.ipcOn.notify(d.ours, { title: 'Дача', body: 'привет', chat: '#' + 'a'.repeat(24) + '@main', reply: true });
  d.log.notices.at(-1).emit('click');
  assert.deepEqual(w.sent.at(-1), ['open-chat', '#' + 'a'.repeat(24) + '@main']);
  d.log.notices.at(-1).emit('reply', {}, '  и тебе  ');
  assert.deepEqual(w.sent.at(-1), ['notice-reply', { chat: '#' + 'a'.repeat(24) + '@main', text: 'и тебе' }]);
  // мусор в имени чата не пропускаем
  w.hide();
  d.ipcOn.notify(d.ours, { title: 'z', body: 'b', chat: '../../x' });
  d.log.notices.at(-1).emit('click');
  assert.notDeepEqual(w.sent.at(-1), ['open-chat', '../../x']);

  // Масштаб: Ctrl+колесо сбрасывается, Ctrl + «+» не доходит до страницы
  w.webContents.zoom = 1.5;
  w.webContents.emit('zoom-changed');
  assert.equal(w.webContents.zoom, 1);
  let blocked = false;
  w.webContents.emit('before-input-event', { preventDefault: () => (blocked = true) }, { type: 'keyDown', control: true, key: '=' });
  assert.ok(blocked);

  // Счётчик непрочитанных
  d.ipcOn.badge(d.ours, 3);
  assert.equal(d.log.badge.at(-1), 3);
  assert.match(d.log.trays[0].tip, /3/);
  d.ipcOn.badge(d.ours, 0);
  assert.equal(d.log.trays[0].tip, 'Тайник');

  // Автозапуск: ~/.config/autostart/tainik.desktop с путём к AppImage
  const st = await d.ipcHandle['bg:get'](d.ours);
  assert.deepEqual(st, { tray: true, autostart: false, autostartSupported: true });
  await d.ipcHandle['bg:set'](d.ours, 'autostart', true);
  const file = path.join(d.appData, 'autostart', 'tainik.desktop');
  assert.match(fs.readFileSync(file, 'utf8'), /^Exec="\/home\/u\/Apps\/Tainik\.AppImage" --hidden$/m);
  assert.equal((await d.ipcHandle['bg:get'](d.ours)).autostart, true);
  await d.ipcHandle['bg:set'](d.ours, 'autostart', false);
  assert.ok(!fs.existsSync(file));
  assert.throws(() => d.ipcHandle['bg:get'](d.evil), /forbidden/);

  // Фон выключен: трей убирается, крестик закрывает окно
  await d.ipcHandle['bg:set'](d.ours, 'tray', false);
  assert.ok(d.log.trays[0].destroyed);
  const saved = JSON.parse(fs.readFileSync(path.join(d.userData, 'settings.json'), 'utf8'));
  assert.equal(saved.tray, '0');
  w.show();
  assert.equal(w.tryClose(), false, 'окно закрывается по-настоящему');
});

test('десктоп (Windows): запуск в фоне при входе, автозапуск через реестр, значок непрочитанных, звонок', async (t) => {
  const d = await boot(t, { platform: 'win32', argv: ['--hidden'], env: { PORTABLE_EXECUTABLE_FILE: 'D:\\Tainik-portable.exe' } });
  const w = d.win();
  assert.equal(w.visible, false, '--hidden: окно не показывается, но страница загружена и подключается');
  assert.equal(w.url, 'app://app/index.html');
  await d.ipcHandle['bg:set'](d.ours, 'autostart', true);
  assert.deepEqual(d.log.login.at(-1), { openAtLogin: true, path: 'D:\\Tainik-portable.exe', args: ['--hidden'] });
  d.ipcOn.badge(d.ours, 5);
  assert.match(d.log.windows[0].overlay.img.path, /badge\.png$/);
  assert.equal(d.log.badge.length, 0, 'на Windows — значок поверх иконки, не setBadgeCount');
  // Входящий звонок, окно в трее: показываем без перехвата фокуса
  d.ipcOn.notify(d.ours, { title: 'alice', body: 'Входящий звонок', chat: 'alice', call: true });
  assert.ok(w.visible && w.inactive);
  assert.equal(d.log.notices.at(-1).urgency, 'critical');
  // «Выйти» из меню трея — настоящий выход
  d.log.trays[0].menu.find((i) => i.label === 'Выйти').click();
  assert.equal(w.tryClose(), false);
});

test('десктоп: прокси — включение через ретранслятор, пароль не уходит странице, служебные настройки закрыты', async (t) => {
  const d = await boot(t, { platform: 'linux' });
  assert.deepEqual(d.log.proxy, { mode: 'system' }, 'по умолчанию — системные настройки');
  const st = await d.ipcHandle['proxy:set'](d.ours, { enabled: true, type: 'socks5', host: 'proxy.example.com', port: 1080, user: 'me', pass: 'секрет' });
  assert.equal(st.hasPass, true);
  assert.equal(st.pass, undefined, 'пароль странице не возвращается');
  assert.equal(st.active, true);
  assert.match(d.log.proxy.proxyRules, /^127\.0\.0\.1:\d+$/, 'Chromium ходит в локальный ретранслятор');
  const file = fs.readFileSync(path.join(d.userData, 'settings.json'), 'utf8');
  assert.ok(!file.includes('"pass"') && file.includes('pass64'), 'пароль хранится зашифрованным');
  assert.equal(await d.ipcHandle['settings:get'](d.ours, '_proxy'), null, 'страница не читает служебные настройки');
  await assert.rejects(async () => d.ipcHandle['settings:set'](d.ours, '_proxy', '{}'));
  // Изменение без пароля — пароль сохраняется прежний
  const again = await d.ipcHandle['proxy:set'](d.ours, { enabled: true, type: 'socks5', host: 'proxy.example.com', port: 1081, user: 'me' });
  assert.equal(again.hasPass, true);
  assert.equal(again.port, 1081);
  await assert.rejects(async () => d.ipcHandle['proxy:set'](d.ours, { enabled: true, host: 'плохой адрес', port: 1 }));
  assert.equal((await d.ipcHandle['proxy:test'](d.ours, { enabled: true, host: '127.0.0.1', port: 1 }, 'wss://chat.example.com/ws')).code, 'proxy_unreachable');
  const off = await d.ipcHandle['proxy:set'](d.ours, { enabled: false });
  assert.equal(off.active, false);
  assert.deepEqual(d.log.proxy, { mode: 'system' });
  assert.throws(() => d.ipcHandle['proxy:get'](d.evil), /forbidden/);
});
