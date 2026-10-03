// Профиль: имя и «о себе» — зашифрованы, только тем, кому вы пишете.
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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tainik-profile-'));
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

test('профиль: имя видят те, кому вы пишете; изменения доходят; свои устройства и привязка', async (t) => {
  const { srv, mk } = await setup(t);
  const alice = mk();
  const bob = mk();
  const eve = mk();
  await alice.register('alice');
  await bob.register('bob');
  await eve.register('eve');
  const alice2 = mk();
  await link(alice2, alice);

  // Имя до первого сообщения: Боб его ещё не знает
  await alice.setProfile({ name: 'Алиса‮ Смирнова', bio: 'Пишу код\n\n\n\nи пью чай' });
  assert.equal(alice.nameOf('alice'), 'Алиса Смирнова', 'управляющие символы вырезаны');
  assert.equal(alice.profile.bio, 'Пишу код\n\nи пью чай');
  await waitFor(alice2, 'profile', (p) => p.name === 'Алиса Смирнова'); // второе устройство Алисы
  assert.equal(bob.nameOf('alice'), 'alice');

  // Первое сообщение — вместе с профилем
  await alice.addContact('bob');
  const got = incoming(bob, 'привет');
  await alice.sendText('bob', 'привет');
  await got;
  assert.equal(bob.nameOf('alice'), 'Алиса Смирнова');
  assert.equal((await bob.profileOf('alice')).bio, 'Пишу код\n\nи пью чай');

  // Изменение доходит, Ева (ей не писали) не получает ничего
  await eve.addContact('alice');
  const changed = waitFor(bob, 'profile-changed', (d) => d.profile.name === 'Алиса');
  await alice2.setProfile({ name: 'Алиса', bio: '' });
  await changed;
  await sleep(200);
  assert.equal(eve.nameOf('alice'), 'alice');
  assert.equal(alice.nameOf('alice'), 'Алиса', 'синхронизировано с другого устройства');

  // Старая версия профиля не перезаписывает новую
  const before = await bob.profileOf('alice');
  assert.equal(before.name, 'Алиса');

  // Новое устройство при привязке получает свой профиль и имена собеседников
  const alice3 = mk();
  await link(alice3, alice);
  assert.equal(alice3.profile.name, 'Алиса');
  const bob2 = mk();
  await link(bob2, bob);
  assert.equal(bob2.nameOf('alice'), 'Алиса');
});
