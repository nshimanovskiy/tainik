// Мост Android-приложения (android/app/src/main/assets/native/bridge.js) без телефона:
// исполняем его в изолированном контексте с поддельным TainikNative.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const SRC = fs.readFileSync(new URL('../android/app/src/main/assets/native/bridge.js', import.meta.url), 'utf8');

function load() {
  const calls = [];
  const sync = [];
  const store = new Map();
  let pending = '';
  const win = {};
  win.TainikNative = {
    hello: () => sync.push(['hello']),
    // Как настоящий Bridge.kt: отвечает позже, JSON-текстом или сообщением об ошибке
    post(id, method, args) {
      const a = JSON.parse(args);
      calls.push([method, a]);
      setTimeout(() => {
        if (method === 'storage.get') return win.__tainikNative.done(id, true, store.has(a[0]) ? store.get(a[0]) : null);
        if (method === 'storage.set') return store.set(a[0], a[1]), win.__tainikNative.done(id, true, null);
        if (method === 'storage.clear') return win.__tainikNative.done(id, true, null);
        if (method === 'version') return win.__tainikNative.done(id, true, JSON.stringify('0.8.0'));
        if (method === 'bg.get') return win.__tainikNative.done(id, true, JSON.stringify({ tray: true }));
        win.__tainikNative.done(id, false, 'Неизвестный вызов: ' + method);
      }, 1);
    },
    notify: (j) => sync.push(['notify', JSON.parse(j)]),
    dismissNotice: (j) => sync.push(['dismiss', JSON.parse(j)]),
    callActive: (a, p) => sync.push(['call', a, p]),
    setBadge: (n) => sync.push(['badge', n]),
    takePendingChat() {
      const c = pending;
      pending = '';
      return c;
    },
  };
  vm.runInNewContext(SRC, { window: win, JSON, Promise, Error, String, Number, Object, Map });
  return { win, calls, sync, store, setPending: (c) => (pending = c) };
}

test('android-мост: window.desktop с тем же интерфейсом, что у десктопа', async () => {
  const { win, sync } = load();
  const d = win.desktop;
  assert.equal(d.platform, 'android');
  for (const k of ['get', 'set', 'del', 'clear']) assert.equal(typeof d.storage[k], 'function');
  for (const k of ['get', 'set']) assert.equal(typeof d.settings[k], 'function');
  for (const k of ['notify', 'onOpenChat', 'setBadge', 'version', 'callActive', 'dismissNotice']) assert.equal(typeof d[k], 'function');
  for (const k of ['get', 'check', 'download', 'install', 'setAuto', 'onChange']) assert.equal(typeof d.updates[k], 'function');
  const seen = [];
  d.updates.onChange((st) => seen.push(st));
  win.__tainikNative.updState(JSON.stringify({ status: 'ready', version: '9.9.9' }));
  win.__tainikNative.updState('не json');
  assert.deepEqual(seen, [{ status: 'ready', version: '9.9.9' }], 'состояние обновления доходит до страницы');
  assert.equal(typeof d.background.get, 'function');
  assert.deepEqual(sync[0], ['hello']);
  assert.ok(Object.isFrozen(d) && Object.isFrozen(d.storage), 'страница не может подменить мост');
  assert.throws(() => {
    'use strict';
    win.desktop = null;
  });
});

test('android-мост: хранилище — значения JSON туда и обратно, ошибки — исключения', async () => {
  const { win, store, calls } = load();
  const s = win.desktop.storage;
  assert.equal(await s.get('нет'), undefined, 'отсутствующий ключ — undefined, как в IndexedDB');
  const value = { a: [1, 2, 3], b: 'привет </script>', c: null };
  await s.set('k', value);
  assert.equal(store.get('k'), JSON.stringify(value));
  assert.deepEqual(await s.get('k'), value);
  assert.equal(await win.desktop.version(), '0.8.0');
  assert.deepEqual(await win.desktop.background.get(), { tray: true });
  await assert.rejects(win.desktop.settings.get('x'), /Неизвестный вызов: settings.get/);
  assert.deepEqual(calls.map((c) => c[0]), ['storage.get', 'storage.set', 'storage.get', 'version', 'bg.get', 'settings.get']);
});

test('android-мост: уведомления, звонок и открытие чата из уведомления', () => {
  const { win, sync, setPending } = load();
  const d = win.desktop;
  d.notify({ title: 'bob', body: 'текст', chat: 'bob', call: 1, extra: 'лишнее' });
  d.dismissNotice({ call: true });
  d.callActive(true, 'bob');
  assert.deepEqual(sync.slice(1, 4), [
    ['notify', { title: 'bob', body: 'текст', chat: 'bob', call: true, force: false }],
    ['dismiss', { call: true, chat: '' }],
    ['call', true, 'bob'],
  ]);

  const opened = [];
  setPending('alice'); // нажали на уведомление до загрузки страницы
  d.onOpenChat((c) => opened.push(c));
  assert.deepEqual(opened, ['alice'], 'чат, ожидавший загрузки, открывается при подписке');
  win.__tainikNative.deliver();
  assert.deepEqual(opened, ['alice'], 'повторно не открывается');
  setPending('carol');
  win.__tainikNative.deliver();
  assert.deepEqual(opened, ['alice', 'carol']);
});

test('android-мост: хранилища аккаунтов разделены', async () => {
  const { win, calls } = load();
  const main = win.desktop.storage;
  const other = win.desktop.storageFor('a1b2c3d4');
  await main.get('account');
  await other.get('account');
  await other.set('account', { u: 'carol' });
  await other.clear();
  assert.deepEqual(calls, [
    ['storage.get', ['account', '']],
    ['storage.get', ['account', 'a1b2c3d4']],
    ['storage.set', ['account', '{"u":"carol"}', 'a1b2c3d4']],
    ['storage.clear', ['a1b2c3d4']],
  ]);
  assert.ok(Object.isFrozen(other));
});
