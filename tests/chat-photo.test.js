// Фото групп и каналов: ставит администратор с Премиум, видят все участники и подписчики.
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
const photo = (n = 1) => 'data:image/jpeg;base64,' + Buffer.alloc(3000, n).toString('base64');

async function setup(tt) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tainik-cphoto-'));
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

test('фото группы: только администратор с Премиум, доходит участникам', async (tt) => {
  const { srv, mk } = await setup(tt);
  const [alice, bob] = [mk(), mk()];
  await alice.register('alice');
  await bob.register('bob');
  const got = waitFor(bob, 'group', (d) => d.group.name === 'Фото');
  const chat = await alice.createGroup('Фото', ['bob']);
  await got;
  await assert.rejects(alice.updateGroup(chat, { avatar: photo() }), (e) => e.code === 'premium_chat_photo');
  srv.store.extendPremium('alice', 30);
  await alice.checkPremium();
  const changed = waitFor(bob, 'group', (d) => d.chat === chat && d.group.avatar);
  await alice.updateGroup(chat, { avatar: photo() });
  await changed;
  assert.equal(bob.avatarOf(chat), photo());
  assert.equal(alice.avatarOf(chat), photo());
  // Переименование фото не теряет; убрать может и без Премиум
  const renamed = waitFor(bob, 'group', (d) => d.chat === chat && d.group.name === 'Фото 2');
  await alice.updateGroup(chat, { name: 'Фото 2' });
  await renamed;
  assert.equal(bob.avatarOf(chat), photo());
  const cleared = waitFor(bob, 'group', (d) => d.chat === chat && !d.group.avatar);
  await alice.updateGroup(chat, { avatar: null });
  await cleared;
  assert.equal(bob.avatarOf(chat), null);
  // Не администратор фото поставить не может
  srv.store.extendPremium('bob', 30);
  await bob.checkPremium();
  await assert.rejects(bob.updateGroup(chat, { avatar: photo(2) }), (e) => e.code === 'group_not_admin');
  const evs = (await bob.messages(chat)).filter((m) => m.content?.ev === 'photo').map((m) => m.content.on);
  assert.deepEqual(evs, [true, false]);
});

test('фото канала: сервер требует Премиум, хранит зашифрованным, подписчики видят', async (tt) => {
  const { srv, mk } = await setup(tt);
  const [alice, bob] = [mk(), mk()];
  await alice.register('alice');
  await bob.register('bob');
  const chat = await alice.createChannel({ title: 'Новости', isPublic: false });
  const ch = await alice.channelOf(chat);
  await bob.joinChannel(alice.channelLink(ch, 'https://x'));
  await assert.rejects(alice.updateChannel(chat, { avatar: photo() }), (e) => e.code === 'premium_chat_photo');
  // В обход клиента сервер тоже не даёт
  await assert.rejects(alice._request({ type: 'channel-update', id: ch.id, avatar: 'QUJD' }), (e) => e.code === 'premium_chat_photo');
  srv.store.extendPremium('alice', 30);
  await alice.checkPremium();
  const meta = waitFor(bob, 'contacts', (all) => !!all[chat]?.channel?.avatar);
  await alice.updateChannel(chat, { avatar: photo() });
  await meta;
  assert.equal(bob.avatarOf(chat), photo());
  assert.ok(!srv.store.getChannel({ id: ch.id }).avatar.includes('base64'), 'на сервере — только шифротекст');
  await alice.updateChannel(chat, { avatar: null });
  assert.equal(alice.avatarOf(chat), null);
});
