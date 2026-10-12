// «Печатает…», ссылки на профиль (/@имя) и переводчик сообщений.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server/server.js';
import { MessengerClient, MemoryStorage } from '../shared/client-core.js';
import { linkify, profileLinkOf } from '../shared/linkify.js';
import { translateText } from '../client/translate.js';

function waitFor(emitter, event, pred = () => true, ms = 8000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => (off(), reject(new Error('timeout: ' + event))), ms);
    const off = emitter.on(event, (d) => {
      if (pred(d)) {
        clearTimeout(timer);
        off();
        resolve(d);
      }
    });
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function setup(tt) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tainik-typing-'));
  const srv = await startServer({ port: 0, host: '127.0.0.1', dataDir, log: false });
  const clients = [];
  const mk = () => {
    const c = new MessengerClient({ url: `ws://127.0.0.1:${srv.port}/ws`, storage: new MemoryStorage() });
    clients.push(c);
    return c;
  };
  tt.after(async () => {
    clients.forEach((c) => c.disconnect());
    await srv.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  return { srv, mk };
}

test('печатает: в личном чате, гаснет с сообщением, не от незнакомых, в группе', async (tt) => {
  const { mk } = await setup(tt);
  const alice = mk();
  const bob = mk();
  const eve = mk();
  await alice.register('alice');
  await bob.register('bob');
  await eve.register('eve');
  await alice.addContact('bob');
  await bob.addContact('alice');

  const typing = waitFor(bob, 'typing', (d) => d.chat === 'alice' && d.users.includes('alice'));
  alice.sendTyping('bob');
  await typing;
  assert.deepEqual(bob.typingIn('alice'), ['alice']);
  // Повтор сразу же отбрасывается (не чаще раза в несколько секунд)
  alice.sendTyping('bob');

  // Пришло сообщение — уже не печатает
  const stopped = waitFor(bob, 'typing', (d) => d.chat === 'alice' && d.users.length === 0);
  await alice.sendText('bob', 'привет');
  await stopped;
  assert.deepEqual(bob.typingIn('alice'), []);

  // От незнакомого — не показывается и чат не создаётся
  await eve.addContact('bob');
  eve.sendTyping('bob');
  await sleep(400);
  assert.deepEqual(bob.typingIn('eve'), []);
  assert.equal((await bob.contacts()).eve, undefined);

  // Группа: сигнал от участника видят остальные в чате группы
  const carol = mk();
  await carol.register('carol');
  const got = waitFor(carol, 'group', (d) => d.group.name === 'Тест');
  const gotB = waitFor(bob, 'group', (d) => d.group.name === 'Тест');
  const chat = await alice.createGroup('Тест', ['bob', 'carol']);
  await Promise.all([got, gotB]);
  // Боб узнаёт ключ Кэрол из её сообщения в группе (до этого сигнал ей не уходит)
  const hello = waitFor(bob, 'message', (d) => d.contact === chat && d.message.content.body === 'я тут');
  await carol.sendText(chat, 'я тут');
  await hello;
  const inGroup = waitFor(carol, 'typing', (d) => d.chat === chat && d.users.includes('bob'));
  bob.sendTyping(chat);
  await inGroup;
  assert.deepEqual(carol.typingIn(chat), ['bob']);
  assert.deepEqual(carol.typingIn('bob'), [], 'в личном чате не показывается');
});

test('ссылка /@имя ведёт в приложение', async (tt) => {
  const { srv } = await setup(tt);
  const r = await fetch(`http://127.0.0.1:${srv.port}/@Admin`, { redirect: 'manual' });
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), '/app#u=admin');
  const bad = await fetch(`http://127.0.0.1:${srv.port}/@a`, { redirect: 'manual' });
  assert.notEqual(bad.status, 302);
});

test('profileLinkOf распознаёт ссылки на профиль', () => {
  assert.deepEqual(profileLinkOf('https://tainik.sdsds.top/@admin'), { host: 'tainik.sdsds.top', name: 'admin' });
  assert.deepEqual(profileLinkOf('https://tainik.sdsds.top/@Admin/'), { host: 'tainik.sdsds.top', name: 'admin' });
  assert.equal(profileLinkOf('https://tainik.sdsds.top/@admin?x=1'), null);
  assert.equal(profileLinkOf('https://tainik.sdsds.top/u/@admin'), null);
  assert.equal(profileLinkOf('https://tainik.sdsds.top/@a'), null);
  assert.equal(profileLinkOf('не ссылка'), null);
  const p = linkify('пиши мне: https://tainik.sdsds.top/@admin')[1];
  assert.deepEqual(p.at, { host: 'tainik.sdsds.top', name: 'admin' });
});

test('переводчик: без согласия в облако не ходит, с согласием — разбирает ответ', async () => {
  await assert.rejects(translateText('Hello world', 'ru'), { code: 'translate_cloud_needed' });
  await assert.rejects(translateText('   ', 'ru', { cloud: true }), { code: 'translate_empty' });
  let asked = '';
  const fetchImpl = async (url, opts) => {
    asked = url;
    assert.equal(opts.credentials, 'omit');
    return { ok: true, json: async () => ({ sentences: [{ trans: 'Привет, ' }, { trans: 'мир' }], src: 'en' }) };
  };
  const r = await translateText('Hello, world', 'ru', { cloud: true, fetchImpl });
  assert.deepEqual(r, { text: 'Привет, мир', from: 'en', via: 'cloud', same: false });
  assert.match(asked, /^https:\/\/translate\.googleapis\.com\/translate_a\/single\?.*tl=ru&q=Hello%2C%20world$/);
  const same = await translateText('Привет', 'ru', { cloud: true, fetchImpl: async () => ({ ok: true, json: async () => ({ sentences: [{ trans: 'Привет' }], src: 'ru' }) }) });
  assert.equal(same.same, true);
  await assert.rejects(translateText('x y', 'ru', { cloud: true, fetchImpl: async () => ({ ok: false }) }), { code: 'translate_failed' });
});
