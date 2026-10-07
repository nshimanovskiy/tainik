// Тема оформления (client/theme.js): выбор сохраняется, «как в системе» следует за системой,
// своя тема — только известные переменные и цвета #rgb/#rrggbb (никакого произвольного CSS).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const code = fs.readFileSync(new URL('../client/theme.js', import.meta.url), 'utf8');

function boot({ stored = null, systemDark = false } = {}) {
  const store = new Map(stored == null ? [] : [['tainik:theme', stored]]);
  const attrs = {};
  const props = {};
  const meta = { attrs: { media: '(prefers-color-scheme: light)' }, setAttribute(k, v) { this.attrs[k] = v; }, removeAttribute(k) { delete this.attrs[k]; } };
  const listeners = [];
  const mq = { matches: systemDark, addEventListener: (_, f) => listeners.push(f) };
  const root = {
    setAttribute: (k, v) => (attrs[k] = v),
    style: { setProperty: (k, v) => (props[k] = v), removeProperty: (k) => delete props[k] },
  };
  const window = {
    matchMedia: () => mq,
    addEventListener: () => {},
  };
  const ctx = {
    window,
    document: { documentElement: root, querySelectorAll: () => [meta] },
    localStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) },
    getComputedStyle: () => ({ getPropertyValue: () => (attrs['data-theme'] === 'dark' ? '#111513' : '#f3f1ec') }),
  };
  vm.runInNewContext(code, ctx);
  return { api: window.tainikTheme, attrs, props, meta, store, mq, flip: (dark) => ((mq.matches = dark), listeners.forEach((f) => f())) };
}

test('тема: по умолчанию как в системе, выбор сохраняется, строка состояния под цвет фона', () => {
  let b = boot({ systemDark: true });
  assert.equal(b.api.get().id, 'system');
  assert.equal(b.attrs['data-theme'], 'dark');
  assert.equal(b.meta.attrs.content, '#111513');
  assert.equal(b.meta.attrs.media, undefined, 'цвет строки состояния — по выбранной теме, а не по системе');
  b.flip(false);
  assert.equal(b.attrs['data-theme'], 'light', '«как в системе» следует за сменой темы системы');

  b.api.set('dark');
  assert.equal(b.attrs['data-theme'], 'dark');
  b.flip(false);
  assert.equal(b.attrs['data-theme'], 'dark', 'выбранная вручную тема не зависит от системы');
  const saved = b.store.get('tainik:theme');
  b = boot({ stored: saved, systemDark: false });
  assert.equal(b.attrs['data-theme'], 'dark', 'после перезапуска');
  assert.equal(boot({ stored: 'light', systemDark: true }).attrs['data-theme'], 'light');
  assert.equal(boot({ stored: '{сломано', systemDark: false }).api.get().id, 'system');
});

test('своя тема: только известные переменные и цвета', () => {
  const b = boot();
  const t = b.api.set({ id: 'custom', base: 'dark', vars: { '--accent': '#d35d8b', '--bg': '#000', '--text': 'red; background: url(x)', '--evil': '#fff', '--in': '#12345' } });
  const plain = (x) => JSON.parse(JSON.stringify(x)); // объекты из vm — из другого «мира»
  assert.deepEqual(plain(t), { id: 'custom', base: 'dark', vars: { '--accent': '#d35d8b', '--bg': '#000' } });
  assert.equal(b.attrs['data-theme'], 'dark');
  assert.deepEqual(plain(b.props), { '--accent': '#d35d8b', '--bg': '#000' });
  b.api.set('light');
  assert.deepEqual(plain(b.props), {}, 'цвета своей темы снимаются');
});
