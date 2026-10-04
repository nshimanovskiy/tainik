// Лимиты на один IP: отказ не молчаливый — клиент узнаёт причину и переподключается.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server/server.js';
import { MessengerClient, MemoryStorage } from '../shared/client-core.js';

const waitFor = (emitter, event, pred = () => true, ms = 8000) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => (off(), reject(new Error('timeout: ' + event))), ms);
    const off = emitter.on(event, (d) => {
      if (pred(d)) {
        clearTimeout(timer);
        off();
        resolve(d);
      }
    });
  });

test('слишком много подключений с одного IP: клиент получает причину и подключается, когда место освободилось', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tainik-limits-'));
  const srv = await startServer({ port: 0, host: '127.0.0.1', dataDir, log: false, maxConnPerIp: 2 });
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
  const a = mk();
  const b = mk();
  await a.register('alice');
  await b.register('bob');
  const c = mk();
  const err = waitFor(c, 'error', (e) => e.code === 'too_many_connections');
  const reg = c.register('carol').catch((e) => e);
  assert.equal((await err).code, 'too_many_connections');
  assert.equal((await reg).code, 'too_many_connections', 'регистрация завершается понятной ошибкой');

  // Место освободилось — вошедший ранее клиент переподключается сам
  b.disconnect();
  await new Promise((r) => setTimeout(r, 200));
  const d = mk();
  await d.register('dave');
  assert.equal(d.status, 'online');
});
