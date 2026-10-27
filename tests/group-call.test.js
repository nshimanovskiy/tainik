// Групповые звонки: сигналы ходят только между участниками группы, запись в истории — групповая.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server/server.js';
import { MessengerClient, MemoryStorage, cleanCallLog } from '../shared/client-core.js';

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

test('групповой звонок: сигналы получают только участники группы', async (tt) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tainik-gcall-'));
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

  const alice = mk();
  const bob = mk();
  const carol = mk();
  const eve = mk();
  for (const [c, n] of [[alice, 'alice'], [bob, 'bob'], [carol, 'carol'], [eve, 'eve']]) await c.register(n);
  const got = Promise.all([waitFor(bob, 'group', (d) => d.group.name === 'Созвон'), waitFor(carol, 'group', (d) => d.group.name === 'Созвон')]);
  const chat = await alice.createGroup('Созвон', ['bob', 'carol']);
  await got;

  const seen = { bob: [], carol: [], eve: [] };
  for (const [n, c] of [['bob', bob], ['carol', carol], ['eve', eve]]) c.on('gcall-signal', (s) => seen[n].push(s));

  // Начали звонок — звонит у всех участников, в чате группы, от alice
  const ringB = waitFor(bob, 'gcall-signal', (s) => s.data.kind === 'ring');
  const ringC = waitFor(carol, 'gcall-signal', (s) => s.data.kind === 'ring');
  await alice.sendGroupCall(chat, { kind: 'ring', callId: 'a1b2c3d4e5f6', video: true }, { others: 'all' });
  const [rb, rc] = await Promise.all([ringB, ringC]);
  assert.equal(rb.chat, chat);
  assert.equal(rb.from, 'alice');
  assert.equal(rb.fromDevice, alice.account.deviceId);
  assert.equal(rb.data.video, true);
  assert.equal(rc.chat, chat);

  // Точечный сигнал — только нужному устройству
  const offer = waitFor(bob, 'gcall-signal', (s) => s.data.kind === 'offer');
  await carol.sendGroupCall(chat, { kind: 'offer', callId: 'a1b2c3d4e5f6', sdp: 'v=0' }, { devices: { bob: [bob.account.deviceId] } });
  assert.equal((await offer).from, 'carol');
  await sleep(300);
  assert.equal(seen.carol.filter((s) => s.data.kind === 'offer').length, 0);

  // Не участник не может «позвонить» в чужую группу, даже зная её номер
  await eve.addContact('bob');
  await eve.sendEphemeral('bob', { t: 'gcall', g: chat.slice(1), ts: Date.now(), kind: 'ring', callId: 'ffffffffffff' });
  await sleep(500);
  assert.equal(seen.bob.filter((s) => s.data.callId === 'ffffffffffff').length, 0);
  assert.equal(seen.eve.length, 0);

  // Вышедший из группы сигналов больше не получает и не может их слать
  await carol.leaveGroup(chat);
  await sleep(500);
  const before = seen.carol.length;
  await alice.sendGroupCall(chat, { kind: 'alive', callId: 'a1b2c3d4e5f6', parts: [] }, { others: 'online' });
  await sleep(500);
  assert.equal(seen.carol.length, before);

  // Запись о звонке: пометка «групповой» сохраняется, лишние поля — нет
  assert.deepEqual(cleanCallLog({ t: 'call', result: 'answered', duration: 61, group: true, x: 1 }), { t: 'call', direction: 'in', result: 'answered', duration: 61, video: false, group: true });
  await bob.logCall(chat, { callId: 'a1b2c3d4e5f6', direction: 'in', result: 'answered', duration: 5, video: true, group: true });
  const log = (await bob.messages(chat)).find((m) => m.id === 'call-a1b2c3d4e5f6');
  assert.equal(log?.content.group, true);
});
