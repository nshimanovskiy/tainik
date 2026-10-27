// Уведомления Тайника на компьютере (desktop/toasts.cjs): свои карточки в углу экрана, как в Telegram.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Toasts, layoutToasts, cleanToast } = require('../desktop/toasts.cjs');
const { resolveAppPath } = require('../desktop/lib.cjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fakes() {
  const wins = [];
  const handlers = {};
  let wcId = 0;
  class Emitter {
    constructor() {
      this.h = {};
    }
    on(e, f) {
      (this.h[e] ||= []).push(f);
    }
    once(e, f) {
      this.on(e, f);
    }
    emit(e, ...a) {
      for (const f of this.h[e] || []) f(...a);
    }
  }
  class BrowserWindow extends Emitter {
    constructor(opts) {
      super();
      this.opts = opts;
      this.bounds = { x: opts.x, y: opts.y, width: opts.width, height: opts.height };
      this.sent = [];
      this.destroyed = false;
      const wc = new Emitter();
      wc.id = ++wcId;
      wc.send = (...a) => this.sent.push(a);
      wc.setWindowOpenHandler = () => {};
      this.webContents = wc;
      wins.push(this);
    }
    loadURL(u) {
      this.url = u;
      setTimeout(() => this.webContents.emit('did-finish-load'), 0);
    }
    showInactive() {
      this.shown = 'inactive';
    }
    focus() {
      this.focused = true;
    }
    setBounds(b) {
      this.bounds = b;
    }
    setAlwaysOnTop(on, level) {
      this.top = level;
    }
    isDestroyed() {
      return this.destroyed;
    }
    destroy() {
      this.destroyed = true;
      this.emit('closed');
    }
  }
  const ipcMain = { on: (n, f) => (handlers[n] = f) };
  const screen = { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }) };
  const actions = [];
  const toasts = new Toasts({
    BrowserWindow,
    screen,
    ipcMain,
    preload: '/p/toast-preload.cjs',
    url: 'app://toast/toast.html',
    onAction: (...a) => actions.push(a),
    labels: () => ({ close: 'Закрыть', reply: 'Ответить' }),
  });
  const from = (w) => ({ sender: { id: w.webContents.id } });
  return { toasts, wins, handlers, actions, from };
}

test('уведомления: раскладка стопкой у правого нижнего угла, проверка данных', () => {
  const pos = layoutToasts({ x: 0, y: 0, width: 1000, height: 800 }, [84, 120], { width: 300, gap: 2, margin: 10 });
  assert.deepEqual(pos[0], { x: 690, y: 706, width: 300, height: 84 });
  assert.deepEqual(pos[1], { x: 690, y: 584, width: 300, height: 120 });
  const d = cleanToast({ title: 'x'.repeat(100), body: 'b', avatar: 'javascript:alert(1)', hue: -400.4, letter: 'Привет', call: true, canReply: true, extra: 1 });
  assert.equal(d.title.length, 64);
  assert.equal(d.avatar, null, 'только data:-URL картинки');
  assert.equal(d.hue, 40);
  assert.equal(d.letter, 'П');
  assert.equal(d.canReply, false, 'на звонок текстом не отвечают');
  assert.ok(!('extra' in d));
  assert.equal(cleanToast({ avatar: 'data:image/jpeg;base64,AAAA' }).avatar, 'data:image/jpeg;base64,AAAA');
  // Страница карточки — отдельный источник app://toast, выйти за её папку нельзя
  assert.equal(resolveAppPath('/r/toast', 'app://toast/toast.html', 'toast'), '/r/toast/toast.html');
  assert.equal(resolveAppPath('/r/toast', 'app://app/toast.html', 'toast'), null);
  assert.equal(resolveAppPath('/r/toast', 'app://toast/%2e%2e%2frenderer%2findex.html', 'toast'), null);
});

test('уведомления: карточка показывается без фокуса, обновляется, отвечает, пропадает', async () => {
  const { toasts, wins, handlers, actions, from } = fakes();
  toasts.show('msg:alice', { title: 'Алиса', body: 'привет', letter: 'А', hue: 10, canReply: true });
  assert.equal(wins.length, 1);
  const w = wins[0];
  assert.equal(w.url, 'app://toast/toast.html');
  assert.equal(w.opts.frame, false);
  assert.equal(w.opts.skipTaskbar, true);
  assert.equal(w.opts.webPreferences.sandbox, true);
  assert.equal(w.opts.webPreferences.contextIsolation, true);
  assert.equal(w.top, 'screen-saver');
  await sleep(5);
  assert.equal(w.shown, 'inactive', 'фокус не отнимается');
  assert.equal(w.sent[0][0], 'toast:data');
  assert.equal(w.sent[0][1].title, 'Алиса');
  // Второе сообщение из того же чата — та же карточка с новым текстом
  toasts.show('msg:alice', { title: 'Алиса', body: 'как дела?' });
  assert.equal(wins.length, 1);
  assert.equal(w.sent.at(-1)[1].body, 'как дела?');
  // Высота подстраивается под карточку (поле ответа), окно остаётся у угла
  handlers['toast:size'](from(w), 130);
  assert.equal(w.bounds.height, 130);
  assert.equal(w.bounds.y + w.bounds.height, 1040 - 10);
  // Чужое окно не может управлять карточкой
  handlers['toast:act']({ sender: { id: 999 } }, 'open');
  assert.equal(actions.length, 0);
  // Ответ из карточки
  handlers['toast:act'](from(w), 'focus');
  assert.ok(w.focused);
  handlers['toast:reply'](from(w), '  хорошо  ');
  assert.deepEqual(actions.at(-1), ['msg:alice', 'reply', 'хорошо']);
  await sleep(250);
  assert.ok(w.destroyed);
});

test('уведомления: стопка не больше 4, звонок не пропадает сам, «Принять» и закрытие по ключу', async () => {
  const { toasts, wins, handlers, actions, from } = fakes();
  toasts.show('call:bob', { title: 'Боб', body: 'Входящий звонок', call: true });
  for (const n of ['a1', 'a2', 'a3', 'a4']) toasts.show('msg:' + n, { title: n, body: 'x' });
  await sleep(250);
  const live = wins.filter((w) => !w.destroyed);
  assert.equal(live.length, 4, 'не больше четырёх карточек');
  assert.ok(!wins[0].destroyed, 'звонок не уступает место');
  assert.ok(wins[1].destroyed, 'уступает самая старая обычная');
  // Новые — снизу, старые поднимаются
  const ys = live.map((w) => w.bounds.y);
  assert.equal(new Set(ys).size, 4);
  handlers['toast:act'](from(wins[0]), 'accept');
  assert.deepEqual(actions.at(-1), ['call:bob', 'accept']);
  toasts.show('msg:z', { title: 'z', body: 'y' });
  assert.ok(toasts.keys().includes('msg:z'));
  toasts.dismiss('msg:z');
  await sleep(250);
  assert.ok(!toasts.keys().includes('msg:z'));
  toasts.dismissAll();
  await sleep(250);
  assert.deepEqual(toasts.keys(), []);
});
