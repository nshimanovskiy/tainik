import { test } from 'node:test';
import assert from 'node:assert/strict';
import { linkify, hrefOf } from '../shared/linkify.js';

const links = (s) => linkify(s).filter((p) => p.href).map((p) => p.text);

test('находит http(s), www и t.me', () => {
  assert.deepEqual(links('см. https://example.com/a?b=1 и www.site.ru, t.me/durov'), ['https://example.com/a?b=1', 'www.site.ru', 't.me/durov']);
  assert.equal(linkify('www.site.ru')[0].href, 'https://www.site.ru/');
});
test('знаки препинания и скобки не входят в ссылку', () => {
  assert.deepEqual(links('(https://a.com/x)'), ['https://a.com/x']);
  assert.deepEqual(links('Ссылка: https://a.com/x_(y).'), ['https://a.com/x_(y)']);
  assert.deepEqual(links('что https://a.com/?q=1!!!'), ['https://a.com/?q=1']);
});
test('текст вокруг сохраняется', () => {
  assert.equal(linkify('до https://a.com после').map((p) => p.text).join(''), 'до https://a.com после');
});
test('опасные и поддельные адреса не становятся ссылками', () => {
  assert.equal(hrefOf('javascript:alert(1)'), null);
  assert.equal(hrefOf('https://bank.com@evil.ru'), null);
  assert.deepEqual(links('javascript:alert(1) data:text/html,x file:///etc/passwd'), []);
  assert.deepEqual(links('foohttps://a.com user@www.a.com'), []);
});
test('ссылка на канал Тайника помечается', () => {
  const p = linkify('https://tainik.example/app#ch=@news')[0];
  assert.equal(p.ch, true);
  assert.equal(linkify('https://a.com')[0].ch, false);
});
