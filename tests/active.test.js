// «В сети» — только пока приложение на экране; в фоне соединение есть, а статуса нет.
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

test('статус: приложение в фоне — не «в сети», но сообщения приходят; второе устройство на экране — «в сети»', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tainik-active-'));
  const srv = await startServer({ port: 0, host: '127.0.0.1', dataDir, log: false });
  const url = `ws://127.0.0.1:${srv.port}/ws`;
  const clients = [];
  const mk = () => {
    const c = new MessengerClient({ url, storage: new MemoryStorage() });
    clients.push(c);
    return c;
  };
  t.after(async () => {
    clients.forEach((c) => c.disconnect());
    await srv.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const alice = mk();
  const bob = mk();
  await alice.register('alice');
  await bob.register('bob');
  await bob.addContact('alice');
  await alice.addContact('bob');
  assert.equal(bob.presenceOf('alice').online, true);

  // Алиса свернула приложение
  const away = waitFor(bob, 'presence', (p) => p.username === 'alice' && !p.online);
  alice.setActive(false);
  const p = await away;
  assert.ok(p.lastSeen && Date.now() - p.lastSeen < 5000, '«был(а) только что»');
  // …но сообщения доходят
  const got = waitFor(alice, 'message', (d) => d.message.dir === 'in' && d.message.content.body === 'ты тут?');
  await bob.sendText('alice', 'ты тут?');
  await got;
  // Вернулась на экран
  const back = waitFor(bob, 'presence', (q) => q.username === 'alice' && q.online);
  alice.setActive(true);
  await back;

  // Подключение сразу в фоне (например, запуск Android после перезагрузки)
  alice.setActive(false);
  await waitFor(bob, 'presence', (q) => q.username === 'alice' && !q.online);
  alice.disconnect();
  await new Promise((r) => setTimeout(r, 100));
  await alice.connect();
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(bob.presenceOf('alice').online, false);
  assert.equal(srv.store.listDevices('alice').length, 1);
});
