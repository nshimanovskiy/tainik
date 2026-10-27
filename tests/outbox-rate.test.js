// Очередь отправки не застревает на лимите сервера (30 сообщений в секунду на соединение):
// рассылка в большую группу или пачка сообщений доходит целиком, без переподключения.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server/server.js';
import { MessengerClient, MemoryStorage } from '../shared/client-core.js';

test('очередь: 60 сообщений подряд доходят все, отправка не упирается в лимит', async (tt) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tainik-rate-'));
  const srv = await startServer({ port: 0, host: '127.0.0.1', dataDir, log: false });
  const mk = () => new MessengerClient({ url: `ws://127.0.0.1:${srv.port}/ws`, storage: new MemoryStorage() });
  const [alice, bob] = [mk(), mk()];
  tt.after(async () => {
    alice.disconnect();
    bob.disconnect();
    await srv.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  await alice.register('alice');
  await bob.register('bob');
  await alice.addContact('bob');
  const N = 60;
  const got = new Set();
  const all = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`дошло ${got.size} из ${N}`)), 30_000);
    bob.on('message', ({ message }) => {
      if (message.dir !== 'in') return;
      got.add(message.content.body);
      if (got.size === N) clearTimeout(timer), resolve();
    });
  });
  const errors = [];
  alice.on('error', (e) => errors.push(e.code));
  for (let i = 0; i < N; i++) await alice.sendText('bob', 'm' + i);
  await all;
  assert.ok(!errors.includes('rate_limited'), 'пользователь не видит «слишком много запросов»');
  // Подтверждения «отправлено» могут прийти чуть позже последнего сообщения
  for (let i = 0; i < 100 && ((await alice.storage.get('outbox')) || []).length; i++) await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual((await alice.storage.get('outbox')) || [], [], 'очередь пуста');
});
