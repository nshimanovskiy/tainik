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

test('профиль: свои каналы (не больше двух) видят собеседники; переименование доходит', async (t) => {
  const { mk } = await setup(t);
  const [alice, bob] = [mk(), mk()];
  await alice.register('alice');
  await bob.register('bob');
  const pub = await alice.createChannel({ title: 'Заметки', isPublic: true, handle: 'alice_notes' });
  const priv = await alice.createChannel({ title: 'Для своих', isPublic: false });
  const third = await alice.createChannel({ title: 'Третий', isPublic: false });
  const own = await alice.ownChannels();
  assert.equal(own.length, 3);
  const ref = (chat) => own.find((c) => c.chat === chat).ref;
  assert.equal(ref(pub), '@alice_notes');

  await assert.rejects(alice.setProfileChannels([ref(pub), ref(priv), ref(third)]), (e) => e.code === 'profile_channels_max');
  // Чужой канал прикрепить нельзя — он просто не попадёт в профиль
  const bobs = await bob.createChannel({ title: 'Боба', isPublic: true, handle: 'bob_channel' });
  await alice.setProfileChannels([ref(pub), '@bob_channel', ref(priv)]);
  assert.deepEqual(alice.profile.channels.map((c) => c.title), ['Заметки', 'Для своих']);
  assert.ok(bobs);

  // Собеседник видит каналы в профиле и может по ним подписаться
  await alice.addContact('bob');
  const got = incoming(bob, 'привет');
  await alice.sendText('bob', 'привет');
  await got;
  const prof = await bob.profileOf('alice');
  assert.deepEqual(prof.channels.map((c) => c.ref), [ref(pub), ref(priv)]);
  await bob.joinChannel(prof.channels[1].ref);
  assert.ok((await bob.contacts())[priv], 'подписался на приватный канал по ссылке из профиля');

  // Переименовали канал — в профиле новое название
  const renamed = waitFor(bob, 'profile-changed', (d) => d.profile.channels?.[0]?.title === 'Заметки Алисы');
  await alice.updateChannel(pub, { title: 'Заметки Алисы' });
  await renamed;

  assert.equal((await bob.profileOf('alice')).channels.length, 2);
});
