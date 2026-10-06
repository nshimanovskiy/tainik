// Иконки интерфейса: набор /icons.json цел, каждая используемая иконка в нём есть, чужое отбрасывается.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { cleanIconSet } from '../client/icons.js';

const read = (f) => fs.readFileSync(new URL('../' + f, import.meta.url), 'utf8');
const SET = JSON.parse(read('client/icons.json'));

test('иконки: набор проходит проверку, все иконки на месте', () => {
  const clean = cleanIconSet(SET);
  assert.ok(clean);
  assert.deepEqual(Object.keys(clean.icons).sort(), Object.keys(SET.icons).sort(), 'ни одна иконка не отброшена');
  const used = new Set();
  for (const m of read('client/index.html').matchAll(/data-icon="([a-z0-9-]+)"/g)) used.add(m[1]);
  for (const f of ['client/app.js']) {
    const src = read(f);
    for (const m of src.matchAll(/\bicon\('([a-z0-9-]+)'/g)) used.add(m[1]);
    for (const m of src.matchAll(/\bicon(?:Text)?\([^)]*?\?\s*'([a-z0-9-]+)'\s*:\s*'([a-z0-9-]+)'/g)) used.add(m[1]).add(m[2]);
    for (const m of src.matchAll(/iconText\([^,]+,\s*'([a-z0-9-]+)'/g)) used.add(m[1]);
    for (const m of src.matchAll(/withIcon\([^,]+,\s*'([a-z0-9-]+)'/g)) used.add(m[1]);
    for (const m of src.matchAll(/galleryTile\('[a-z]+',\s*'([a-z0-9-]+)'/g)) used.add(m[1]);
  }
  for (const v of ['clock', 'check', 'check2', 'music', 'file', 'mic', 'play', 'pause', 'monitor', 'smartphone', 'globe']) used.add(v);
  const missing = [...used].filter((n) => !SET.icons[n]);
  assert.deepEqual(missing, [], 'нет в /icons.json');
  assert.ok(used.size > 40);
});

test('иконки: чужой набор с сервера — только разрешённые элементы и атрибуты', () => {
  const evil = {
    viewBox: '0 0 24 24',
    icons: {
      ok: [['path', { d: 'M1 1L2 2', onclick: 'alert(1)', style: 'x' }]],
      script: [['script', { src: 'x' }]],
      foreign: [['foreignObject', {}]],
      href: [['path', { d: 'url(javascript:alert(1))' }]],
      'BAD NAME': [['path', { d: 'M1 1' }]],
    },
  };
  const c = cleanIconSet(evil);
  assert.deepEqual(Object.keys(c.icons), ['ok']);
  assert.deepEqual(c.icons.ok, [['path', { d: 'M1 1L2 2' }]]);
  assert.equal(cleanIconSet({ icons: { a: [['script', {}]] } }), null);
  assert.equal(cleanIconSet('мусор'), null);
});
