// Пересылка и закрепление сообщений.
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
const gotIn = (c, chat, pred) => waitFor(c, 'message', (d) => d.contact === chat && d.message.dir === 'in' && pred(d.message));

test('пересылка: текст и файл с пометкой «Переслано от», в личный чат и в группу; закрепление у обоих', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tainik-fwd-'));
  const srv = await startServer({ port: 0, host: '127.0.0.1', dataDir, log: false });
  const mk = () => new MessengerClient({ url: `ws://127.0.0.1:${srv.port}/ws`, storage: new MemoryStorage() });
  const [alice, bob, carol] = [mk(), mk(), mk()];
  t.after(async () => {
    [alice, bob, carol].forEach((c) => c.disconnect());
    await srv.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  await alice.register('alice');
  await bob.register('bob');
  await carol.register('carol');
  await alice.setProfile({ name: 'Алиса' });
  await alice.addContact('bob');

  const g1 = gotIn(bob, 'alice', (m) => m.content.body === 'важное');
  await alice.sendText('bob', 'важное');
  const g2 = gotIn(bob, 'alice', (m) => m.content.t === 'file');
  await alice.sendFile('bob', new Uint8Array([5, 6, 7]), { name: 'a.bin', mime: 'application/octet-stream' }, { caption: 'файл' });
  const [{ message: m1 }, { message: m2 }] = await Promise.all([g1, g2]);

  await bob.addContact('carol');
  await carol.addContact('alice');
  // Bob пересылает Carol
  const c1 = gotIn(carol, 'bob', (m) => m.content.body === 'важное');
  const c2 = gotIn(carol, 'bob', (m) => m.content.t === 'file');
  await bob.forwardMessages('carol', [m1, m2], 'alice');
  const [{ message: f1 }, { message: f2 }] = await Promise.all([c1, c2]);
  assert.equal(f1.content.fwd, 'Алиса');
  assert.equal(f2.content.fwd, 'Алиса');
  assert.deepEqual([...(await carol.fetchFile(f2.content.file))], [5, 6, 7], 'файл — тот же, без повторной загрузки');
  // Пересланное дальше — сохраняет исходного автора
  const back = gotIn(alice, 'carol', (m) => m.content.body === 'важное');
  await carol.forwardMessages('alice', [f1], 'bob');
  assert.equal((await back).message.content.fwd, 'Алиса');

  // Закрепление в личном чате видят оба
  const pinned = waitFor(alice, 'pinned', (d) => d.chat === 'bob');
  await bob.pinMessage('alice', m1.id);
  assert.equal((await pinned).id, m1.id);
  assert.equal((await alice.contacts()).bob.pinned.id, m1.id);
  const unpinned = waitFor(bob, 'pinned', (d) => d.chat === 'alice' && d.id === null);
  await alice.pinMessage('bob', null);
  await unpinned;

  // В группе — у всех участников
  const chat = await alice.createGroup('Г', ['bob', 'carol']);
  await waitFor(carol, 'group', (d) => d.chat === chat);
  const gm = gotIn(carol, chat, (m) => m.content.body === 'закрепи');
  await alice.sendText(chat, 'закрепи');
  const { message } = await gm;
  const cp = waitFor(alice, 'pinned', (d) => d.chat === chat);
  await carol.pinMessage(chat, message.id);
  assert.equal((await cp).id, message.id);
});
