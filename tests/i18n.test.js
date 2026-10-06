// Перевод: у каждой строки интерфейса есть английский вариант, параметры {0}… совпадают.
// Если тест упал — добавьте перевод в shared/i18n-en.js (или desktop/i18n.cjs для десктопа).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import EN from '../shared/i18n-en.js';
import ES from '../shared/i18n-es.js';
import JA from '../shared/i18n-ja.js';
import { t, LANG } from '../shared/i18n.js';

const require = createRequire(import.meta.url);
const desktopI18n = require('../desktop/i18n.cjs');

const CYR = /[А-Яа-яЁё]/;
const read = (f) => fs.readFileSync(new URL('../' + f, import.meta.url), 'utf8');
const norm = (s) => s.replace(/\s+/g, ' ').trim();
const unq = (s) => s.replace(/\\'/g, "'").replace(/\\\\/g, '\\').replace(/\\n/g, '\n');

function tKeys(file) {
  return [...read(file).matchAll(/\bt\('((?:[^'\\]|\\.)*)'/g)].map((m) => unq(m[1]));
}

// Текст страниц: текстовые узлы и подписи, которые переводит translateDom()
function htmlKeys(file) {
  const html = read(file).replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '');
  const keys = [];
  for (const m of html.matchAll(/>([^<]+)</g)) keys.push(m[1]);
  for (const m of html.matchAll(/\s(?:placeholder|title|aria-label|alt)="([^"]*)"/g)) keys.push(m[1]);
  const desc = /<meta name="description" content="([^"]*)"/.exec(html);
  if (desc) keys.push(desc[1]);
  return keys
    .map((k) => norm(k.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')))
    .filter((k) => CYR.test(k));
}

const placeholders = (s) => (s.match(/\{\d+\}/g) || []).sort().join();

test('перевод: все строки интерфейса переведены на английский', () => {
  const missing = [];
  for (const f of ['client/app.js', 'client/call.js', 'shared/client-core.js', 'client/landing.js', 'client/install.js']) {
    for (const k of tKeys(f)) if (!(k in EN)) missing.push(`${f}: ${k}`);
  }
  for (const f of ['client/index.html', 'client/landing.html', 'client/ios.html']) {
    for (const k of htmlKeys(f)) if (!(norm(k.replace(/ /g, ' ')) in EN) && !(k in EN)) missing.push(`${f}: ${k}`);
  }
  assert.deepEqual(missing, [], 'нет перевода');
});

test('перевод: параметры {0}… в переводе те же, что в оригинале', () => {
  for (const [k, v] of Object.entries(EN)) {
    assert.equal(placeholders(v), placeholders(k), k);
    assert.ok(!CYR.test(v), `в переводе осталась кириллица: ${v}`);
  }
  for (const [k, v] of Object.entries(desktopI18n.EN)) {
    assert.equal(placeholders(v), placeholders(k), k);
    assert.ok(!CYR.test(v), v);
  }
});

test('перевод: строки десктопа (трей, окна, обновления)', () => {
  const missing = [];
  for (const f of ['desktop/main.cjs', 'desktop/updater.cjs']) {
    for (const k of tKeys(f)) if (!(k in desktopI18n.EN)) missing.push(`${f}: ${k}`);
  }
  assert.deepEqual(missing, []);
  desktopI18n.setLangSource(() => 'en');
  assert.equal(desktopI18n.t('Перезапустить и обновить до {0}', '1.0.0'), 'Restart and update to 1.0.0');
  desktopI18n.setLangSource(() => 'ru');
  assert.equal(desktopI18n.t('Перезапустить и обновить до {0}', '1.0.0'), 'Перезапустить и обновить до 1.0.0');
  assert.equal(desktopI18n.langFromLocale('ru-RU'), 'ru');
  assert.equal(desktopI18n.langFromLocale('uk'), 'ru');
  assert.equal(desktopI18n.langFromLocale('en-US'), 'en');
  assert.equal(desktopI18n.langFromLocale('de-DE'), 'en');
});

test('перевод: вне браузера — русский, параметры подставляются', () => {
  assert.equal(LANG, 'ru', 'сервер и тесты работают по-русски');
  assert.equal(t('был(а) {0} мин. назад', 5), 'был(а) 5 мин. назад');
  assert.equal(t('Скачиваем версию {0}… {1}%', '1.0', 42), 'Скачиваем версию 1.0… 42%');
});

test('перевод: в файлах с t() нет локальных переменных t (они ломают перевод)', () => {
  // Так сломалась 0.14.0: `const t = …; t.textContent = t('…')` — ошибка при показе галочки
  const files = ['client/app.js', 'client/call.js', 'shared/client-core.js', 'client/landing.js', 'client/install.js', 'desktop/main.cjs', 'desktop/updater.cjs'];
  const bad = [];
  for (const f of files) {
    read(f)
      .split('\n')
      .forEach((line, i) => {
        if (/^\s*\/\//.test(line)) return;
        if (/\b(const|let|var)\s+t\s*=|\(\s*t\s*\)\s*=>|\bfor\s*\(\s*(const|let)\s+t\s+of\b|\bfunction\s*\w*\s*\(\s*t\s*[,)]/.test(line)) bad.push(`${f}:${i + 1}: ${line.trim()}`);
      });
  }
  assert.deepEqual(bad, []);
});

test('перевод: испанский и японский — те же строки, что и английский, параметры совпадают', () => {
  for (const [name, dict] of [['es', ES], ['ja', JA]]) {
    assert.deepEqual(Object.keys(dict), Object.keys(EN), `${name}: набор строк не совпадает с английским — добавьте перевод`);
    for (const [k, v] of Object.entries(dict)) {
      assert.ok(typeof v === 'string' && v.trim(), `${name}: пустой перевод: ${k}`);
      assert.equal(placeholders(v), placeholders(k), `${name}: ${k}`);
      assert.ok(!CYR.test(v), `${name}: в переводе осталась кириллица: ${v}`);
    }
  }
  for (const [name, dict] of [['es', desktopI18n.ES], ['ja', desktopI18n.JA]]) {
    assert.deepEqual(Object.keys(dict).sort(), Object.keys(desktopI18n.EN).sort(), `десктоп ${name}`);
    for (const [k, v] of Object.entries(dict)) assert.equal(placeholders(v), placeholders(k), `десктоп ${name}: ${k}`);
  }
  desktopI18n.setLangSource(() => 'es');
  assert.equal(desktopI18n.t('Перезапустить и обновить до {0}', '1.0.0').includes('1.0.0'), true);
  assert.notEqual(desktopI18n.t('Открыть Тайник'), 'Открыть Тайник');
  desktopI18n.setLangSource(() => 'ru');
  assert.equal(desktopI18n.langFromLocale('es-MX'), 'es');
  assert.equal(desktopI18n.langFromLocale('ja-JP'), 'ja');
  assert.equal(desktopI18n.knownLang('ja'), 'ja');
  assert.equal(desktopI18n.knownLang('xx'), null);
});

test('перевод: Android — испанский и японский для всех нативных строк', () => {
  const kt = read('android/app/src/main/java/dev/tainik/android/I18n.kt');
  const map = (name) => new Set([...kt.split(`private val ${name} = mapOf(`)[1].split('\n    )')[0].matchAll(/^\s*"((?:[^"\\]|\\.)*)" to "/gm)].map((m) => JSON.parse(`"${m[1]}"`)));
  const es = map('ES');
  const ja = map('JA');
  const missing = [];
  for (const f of fs.readdirSync(new URL('../android/app/src/main/java/dev/tainik/android/', import.meta.url))) {
    const src = read('android/app/src/main/java/dev/tainik/android/' + f);
    for (const m of src.matchAll(/I18n\.tr\(\s*\w+\s*,\s*"(?:[^"\\]|\\.)*"\s*,\s*"((?:[^"\\]|\\.)*)"\s*,?\s*\)/g)) {
      const en = JSON.parse(`"${m[1]}"`);
      if (!es.has(en) || !ja.has(en)) missing.push(`${f}: ${en}`);
    }
  }
  assert.deepEqual(missing, []);
});
