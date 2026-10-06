// Чёрный список и удаление чата.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server/server.js';
import { MessengerClient, MemoryStorage } from '../shared/client-core.js';

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
const incoming = (client, body) => waitFor(client, 'message', (d) => d.message.dir === 'in' && d.message.content.body === body);

async function setup(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tainik-blocks-'));
  const srv = await startServer({ port: 0, host: '127.0.0.1', dataDir, log: false });
  const clients = [];
  const mk = (storage = new MemoryStorage()) => {
    const c = new MessengerClient({ url: `ws://127.0.0.1:${srv.port}/ws`, storage });
    clients.push(c);
    return c;
  };
  t.after(async () => {
    clients.forEach((c) => c.disconnect());
    await srv.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  return { srv, mk };
}

async function link(newClient, existing) {
  let gotCode;
  const codeP = new Promise((r) => (gotCode = r));
  const { done } = newClient.linkAsNewDevice({ deviceName: 'Телефон', onCode: ({ code }) => gotCode(code) });
  await existing.linkDevice(await codeP);
  return done;
}

test('блокировка: сообщения, звонки и статус не доходят, синхронизация, разблокировка', async (t) => {
  const { srv, mk } = await setup(t);
  const alice = mk();
  const bob = mk();
  await alice.register('alice');
  await bob.register('bob');
  const alice2 = mk();
  await link(alice2, alice);
  await alice.addContact('bob');
  await bob.addContact('alice');
  const hi = incoming(alice, 'привет');
  await bob.sendText('alice', 'привет');
  await hi;

  // Алиса блокирует Боба — второе устройство Алисы узнаёт сразу
  const synced = waitFor(alice2, 'blocks', (l) => l.includes('bob'));
  const bobSees = waitFor(bob, 'presence', (p) => p.username === 'alice' && p.hidden);
  await alice.setBlocked('bob', true);
  assert.ok(alice.isBlocked('bob'));
  await synced;
  await bobSees; // Боб больше не видит, в сети ли Алиса
  assert.deepEqual(srv.store.blocksOf('alice'), ['bob']);

  // Сообщение Боба: у него «отправлено», но Алисе не доставляется и в очередь не ставится
  const sent = waitFor(bob, 'status-change', (d) => d.status === 'sent');
  await bob.sendText('alice', 'ты где?');
  await sent;
  await sleep(200);
  assert.ok(!(await alice.messages('bob')).some((m) => m.content.body === 'ты где?'));
  assert.equal(srv.store.queueSize('alice', 1), 0);
  // Звонок не доходит
  assert.deepEqual(await bob.sendEphemeral('alice', { t: 'call', kind: 'offer', callId: 'c1', ts: Date.now() }), []);
  // Алиса сама не может написать заблокированному
  await assert.rejects(alice.sendText('bob', 'эй'), { code: 'you_blocked' });

  // После перезапуска список приходит с сервером
  const alice3 = mk(alice2.storage);
  alice2.disconnect();
  const loaded = waitFor(alice3, 'blocks');
  await alice3.load();
  await alice3.connect();
  await loaded;
  assert.ok(alice3.isBlocked('bob'));

  // Разблокировали — переписка работает, сессия не сбилась
  await alice.setBlocked('bob', false);
  const again = incoming(alice, 'снова пишу');
  await bob.sendText('alice', 'снова пишу');
  await again;
  const back = incoming(bob, 'вижу');
  await alice.sendText('bob', 'вижу');
  await back;
  await assert.rejects(alice.setBlocked('alice', true), { code: 'bad_username' });
});

test('удаление чата: у себя на всех устройствах, у собеседника, чат возвращается с новым сообщением', async (t) => {
  const { mk } = await setup(t);
  const alice = mk();
  const bob = mk();
  await alice.register('alice');
  await bob.register('bob');
  const alice2 = mk();
  await link(alice2, alice);
  await alice.addContact('bob');
  const got = incoming(bob, 'раз');
  await alice.sendText('bob', 'раз');
  await got;
  const got2 = incoming(alice, 'два');
  await bob.sendText('alice', 'два');
  await got2;
  await sleep(200);
  assert.equal((await alice2.messages('bob')).length, 2);

  // Только у себя
  const a2 = waitFor(alice2, 'deleted', (d) => d.chat);
  await alice.deleteChat('bob');
  await a2;
  for (const c of [alice, alice2]) {
    assert.equal((await c.messages('bob')).length, 0);
    const contact = (await c.contacts()).bob;
    assert.equal(contact.hidden, true, 'чат скрыт из списка');
    assert.ok(contact.keys, 'ключ собеседника сохранён');
  }
  await sleep(200);
  assert.equal((await bob.messages('alice')).length, 2, 'у Боба переписка осталась');

  // Боб пишет снова — чат возвращается
  const got3 = incoming(alice, 'три');
  await bob.sendText('alice', 'три');
  await got3;
  assert.equal((await alice.contacts()).bob.hidden, undefined);
  assert.deepEqual((await alice.messages('bob')).map((m) => m.content.body), ['три']);

  // У всех: у Боба переписка стирается, контакт остаётся
  const bobCleared = waitFor(bob, 'deleted', (d) => d.chat);
  await alice.deleteChat('bob', { forAll: true });
  await bobCleared;
  assert.equal((await bob.messages('alice')).length, 0);
  assert.ok((await bob.contacts()).alice);
  assert.ok(!(await bob.contacts()).alice.hidden);
});

test('архив: только у себя, синхронизируется между устройствами и переносится на новое', async (t) => {
  const { mk } = await setup(t);
  const [alice, bob] = [mk(), mk()];
  await alice.register('alice');
  await bob.register('bob');
  const alice2 = mk();
  await link(alice2, alice);
  await alice.addContact('bob');
  await bob.addContact('alice');
  const hi = incoming(alice2, 'привет');
  await bob.sendText('alice', 'привет');
  await hi;

  const synced = waitFor(alice2, 'archived', (d) => d.chat === 'bob' && d.on);
  await alice.setArchived('bob', true);
  assert.equal(alice.isArchived('bob'), true);
  await synced;
  assert.equal(alice2.isArchived('bob'), true);
  assert.equal(bob.isArchived('alice'), false, 'собеседник об архиве не знает');

  // Новое сообщение в архивный чат: чат остаётся в архиве, счётчик растёт
  const more = incoming(alice, 'ещё');
  await bob.sendText('alice', 'ещё');
  await more;
  assert.equal(alice.isArchived('bob'), true);
  assert.ok((await alice.contacts()).bob.unread >= 1);

  // Третье устройство получает архив при привязке
  const alice3 = mk();
  await link(alice3, alice);
  assert.equal(alice3.isArchived('bob'), true);

  // Вернули из архива на втором — на первом тоже
  const back = waitFor(alice, 'archived', (d) => d.chat === 'bob' && !d.on);
  await alice2.setArchived('bob', false);
  await back;
  assert.equal(alice.isArchived('bob'), false);
  // Старая отметка не перебивает новую
  assert.equal(await alice._applyArchive(await alice.contacts(), 'bob', true, 1), false);
  assert.equal(alice.isArchived('bob'), false);
});
