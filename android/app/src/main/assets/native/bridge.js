// Мост Android-приложения. Даёт странице тот же window.desktop, что и десктоп
// (Electron preload.cjs), но поверх нативного объекта TainikNative.
// Подключается первым скриптом в index.html (его добавляет AssetServer.kt).
(() => {
  'use strict';
  const N = window.TainikNative;
  if (!N || window.desktop) return;

  let seq = 0;
  const waiting = new Map();

  // Асинхронный вызов: ответ придёт через __tainikNative.done(id, ok, text).
  // text — JSON-текст результата (или null), при ошибке — сообщение.
  function call(method, ...args) {
    return new Promise((resolve, reject) => {
      const id = ++seq;
      waiting.set(id, { resolve, reject });
      try {
        N.post(id, method, JSON.stringify(args));
      } catch (e) {
        waiting.delete(id);
        reject(e);
      }
    });
  }
  const parsed = (missing) => (text) => (text == null ? missing : JSON.parse(text));

  function storageFor(ns) {
    ns = ns ? String(ns) : '';
    return Object.freeze({
      get: (k) => call('storage.get', String(k), ns).then(parsed(undefined)),
      set: (k, v) => call('storage.set', String(k), JSON.stringify(v ?? null), ns).then(() => undefined),
      del: (k) => call('storage.del', String(k), ns).then(() => undefined),
      clear: () => call('storage.clear', ns).then(() => undefined),
    });
  }

  let updHandler = null;
  let openChatHandler = null;
  function deliver() {
    if (!openChatHandler) return;
    const chat = N.takePendingChat();
    if (chat) openChatHandler(chat);
  }

  const api = {
    platform: 'android',
    storage: storageFor(''),
    // Хранилище дополнительного аккаунта (своя папка, свой ключ данных)
    storageFor,
    settings: Object.freeze({
      get: (k) => call('settings.get', String(k)).then(parsed(null)),
      set: (k, v) => call('settings.set', String(k), JSON.stringify(v ?? null)).then(() => undefined),
    }),
    // Системное уведомление: { title, body, chat, call }. Нажатие открывает приложение и чат.
    notify: (n) =>
      N.notify(
        JSON.stringify({
          title: String(n?.title ?? 'Тайник'),
          body: String(n?.body ?? ''),
          chat: String(n?.chat ?? ''),
          call: !!n?.call,
          force: !!n?.force, // сообщение другому аккаунту — показать, даже если окно открыто
        })
      ),
    dismissNotice: (n) => N.dismissNotice(JSON.stringify({ call: !!n?.call, chat: String(n?.chat ?? '') })),
    onOpenChat: (handler) => {
      openChatHandler = handler;
      deliver();
    },
    // На Android счётчик на значке рисует сама система по уведомлениям
    setBadge: (n) => N.setBadge(Number(n) || 0),
    // Идёт звонок: служба держит микрофон и камеру, даже если свернуть приложение
    callActive: (active, peer) => N.callActive(!!active, String(peer ?? '')),
    // Работа в фоне: { tray, autostart, autostartSupported, batteryOptimized }
    background: Object.freeze({
      get: () => call('bg.get').then(parsed(null)),
      set: (key, value) => call('bg.set', String(key), !!value).then(() => undefined),
    }),
    version: () => call('version').then(parsed('')),
    // Окно на экране (а не в фоне): от этого зависит «в сети». Изменения — window.__tainikActive(bool)
    isActive: () => !!N.isActive?.(),
    // Прокси: { enabled, type, host, port, user, hasPass, active, supported } — как в десктопе
    proxy: Object.freeze({
      get: () => call('proxy.get').then(parsed(null)),
      set: (cfg) => call('proxy.set', cfg ?? {}).then(parsed(null)),
      test: (cfg, serverUrl) => call('proxy.test', cfg ?? {}, String(serverUrl)).then(parsed(null)),
    }),
    // Самообновление: { status, version, progress, error, auto, … } — как в десктопе
    updates: Object.freeze({
      get: () => call('upd.get').then(parsed(null)),
      check: () => call('upd.check').then(() => true),
      download: () => call('upd.download').then(() => true),
      install: () => call('upd.install').then(parsed(null)),
      setAuto: (on) => call('upd.auto', !!on).then(() => true),
      onChange: (handler) => {
        updHandler = handler;
      },
    }),
    // Сохранить вложение (Uint8Array) через системное окно «Сохранить как».
    // true — сохранено, false — отменили. Скачивание blob:-ссылок WebView не умеет.
    async saveFile(name, mime, bytes) {
      const token = await call('save.begin', String(name ?? 'file'), String(mime ?? '')).then(parsed(''));
      try {
        const STEP = 384 * 1024; // кратно 3: части base64 без «=» в середине
        for (let i = 0; i < bytes.length || i === 0; i += STEP) {
          const part = bytes.subarray(i, i + STEP);
          let s = '';
          for (let j = 0; j < part.length; j += 0x8000) s += String.fromCharCode.apply(null, part.subarray(j, j + 0x8000));
          await call('save.chunk', token, btoa(s));
          if (!bytes.length) break;
        }
      } catch (e) {
        call('save.cancel', token).catch(() => {});
        throw e;
      }
      return call('save.end', token).then(parsed(false));
    },
  };

  Object.defineProperty(window, '__tainikNative', {
    value: Object.freeze({
      done(id, ok, text) {
        const w = waiting.get(id);
        if (!w) return;
        waiting.delete(id);
        if (ok) w.resolve(text);
        else w.reject(new Error(text || 'Ошибка приложения'));
      },
      deliver,
      updState(text) {
        if (!updHandler) return;
        try {
          updHandler(JSON.parse(text));
        } catch {}
      },
    }),
  });
  Object.defineProperty(window, 'desktop', { value: Object.freeze(api) });
  N.hello();
})();
