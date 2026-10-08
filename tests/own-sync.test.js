// Синхронизация между своими устройствами: записи о звонках (sync-call) и полное состояние
// настроек после обновления (sync-state) — папки, архив, закрепления, свои имена.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server/server.js';
import { MessengerClient, MemoryStorage } from '../shared/client-core.js';

async function until(cond, ms = 8000) {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 20));
  }
}
async function setup(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tainik-own-sync-'));
  const srv = await startServer({ port: 0, host: '127.0.0.1', dataDir, log: false });
  const clients = [];
  const mk = () => {
    const c = new MessengerClient({ url: `ws://127.0.0.1:${srv.port}/ws`, storage: new MemoryStorage() });
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
const calls = async (c, chat) => (await c.messages(chat)).filter((m) => m.content?.t === 'call');

test('записи о звонках — на всех своих устройствах, одна на звонок', async (t) => {
  const { mk } = await setup(t);
  const [alice, bob] = [mk(), mk()];
  await alice.register('alice');
  await bob.register('bob');
  const alice2 = mk();
  await link(alice2, alice);
  await alice.addContact('bob');
  await until(async () => !!(await alice2.contacts()).bob || (await alice2.addContact('bob'), true));

  // Исходящий с первого устройства — появляется и на втором
  await alice.logCall('bob', { callId: 'a1b2c3d4e5f6a1b2c3d4e5f6', direction: 'out', result: 'answered', duration: 135, video: false });
  await until(async () => (await calls(alice2, 'bob')).length === 1);
  const [rec] = await calls(alice2, 'bob');
  assert.equal(rec.id, 'call-a1b2c3d4e5f6a1b2c3d4e5f6');
  assert.deepEqual([rec.content.direction, rec.content.result, rec.content.duration], ['out', 'answered', 135]);

  // Входящий звонил на обоих: на одном ответили, на другом — «отвечен на другом устройстве».
  // Остаётся одна запись — точная, с длительностью; непрочитанным не считается
  const id = 'ffeeddccbbaa00112233aabb';
  await alice2.logCall('bob', { callId: id, direction: 'in', result: 'elsewhere', duration: 0 });
  await alice.logCall('bob', { callId: id, direction: 'in', result: 'answered', duration: 42, video: true });
  await until(async () => (await calls(alice2, 'bob')).find((m) => m.id === 'call-' + id)?.content.result === 'answered');
  await new Promise((r) => setTimeout(r, 200));
  for (const c of [alice, alice2]) {
    const list = (await calls(c, 'bob')).filter((m) => m.id === 'call-' + id);
    assert.equal(list.length, 1, 'одна запись на звонок');
    assert.deepEqual([list[0].content.result, list[0].content.duration, list[0].content.video], ['answered', 42, true]);
  }

  // Пропущенный: на втором устройстве (оно звонок не видело) — тоже пропущенный и непрочитанный
  const before = (await alice2.contacts()).bob.unread || 0;
  await alice.logCall('bob', { callId: '0123456789abcdef01234567', direction: 'in', result: 'missed' });
  await until(async () => (await calls(alice2, 'bob')).some((m) => m.content.result === 'missed'));
  assert.equal((await alice2.contacts()).bob.unread, before + 1);
  // Мусор в синхронизации не принимается
  assert.equal(await alice2._applyCallLog('bob', { id: 'call-xx', ts: Date.now(), content: { t: 'call', result: 'hack' } }), false);
});

test('после обновления свои устройства обмениваются папками, архивом, закреплениями и своими именами', async (t) => {
  const { srv, mk } = await setup(t);
  const [alice, bob, carol] = [mk(), mk(), mk()];
  await alice.register('alice');
  await bob.register('bob');
  await carol.register('carol');
  const alice2 = mk();
  await link(alice2, alice);
  for (const c of [alice, alice2]) {
    await c.addContact('bob');
    await c.addContact('carol');
  }
  // На первом устройстве настроили, пока второе было на старой версии и всё это отбросило
  alice2.disconnect();
  await alice.setFolders([{ id: 'w', name: 'Работа', chats: ['bob'] }]);
  await alice.setArchived('carol', true);
  await alice.setChatPinned('bob', true);
  await alice.setAlias('bob', { name: 'Бобби' });
  // Старая версия второго устройства получила эти сообщения и выбросила (незнакомые): очередь
  // на сервере для него пуста, у самого устройства ничего нет
  const dev2 = alice2.account.deviceId;
  await until(() => srv.store.queueFor('alice', dev2).length >= 4);
  srv.store.db.prepare('DELETE FROM queue WHERE user = ? AND device = ?').run('alice', dev2);
  await alice2.storage.del('state-schema'); // теперь на нём новая версия, обмена ещё не было
  // Своя папка второго устройства, сделанная позже, — она и должна остаться на обоих
  await alice2.storage.set('folders', { v: Date.now() + 1000, list: [{ id: 'm', name: 'Моё', chats: ['carol'] }] });

  await alice2.connect();
  await until(async () => (await alice2.contacts()).carol?.archived === true && alice2.nameOf('bob') === 'Бобби' && !!(await alice2.contacts()).bob?.top, 10000);
  // Папки: побеждает последнее изменение — у второго устройства оно новее, и оно приходит на первое
  await until(async () => (await alice.folders())[0]?.name === 'Моё', 10000);
  assert.deepEqual((await alice2.folders()).map((f) => f.name), ['Моё']);
});
