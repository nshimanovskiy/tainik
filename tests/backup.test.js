// Перенос переписки: экспорт в файл и импорт на другом устройстве того же аккаунта.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server/server.js';
import { MessengerClient, MemoryStorage } from '../shared/client-core.js';
import { backupHeader } from '../shared/backup.js';

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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tainik-backup-'));
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

test('перенос переписки: экспорт, импорт на новом устройстве, только в свой аккаунт', async (t) => {
  const { srv, mk } = await setup(t);
  const [alice, bob, carol] = [mk(), mk(), mk()];
  await alice.register('alice');
  await bob.register('bob');
  await carol.register('carol');
  await alice.addContact('bob');
  const got = incoming(bob, 'секретное сообщение');
  await alice.sendText('bob', 'секретное сообщение');
  await got;
  const back = incoming(alice, 'ответ боба');
  await bob.sendText('alice', 'ответ боба');
  await back;
  const doomed = incoming(alice, 'удалить меня');
  await bob.sendText('alice', 'удалить меня');
  const { message: gone } = await doomed;
  await alice.deleteMessages('bob', [gone.id]);

  const exp = await alice.exportBackup(Date.UTC(2026, 9, 6));
  assert.equal(exp.name, 'tainik-alice-2026-10-06.tainik');
  assert.ok(exp.messages >= 2);
  const text = new TextDecoder().decode(exp.bytes);
  assert.ok(!text.includes('секретное') && !text.includes('боба'), 'в файле нет открытого текста');
  const h = backupHeader(exp.bytes);
  assert.equal(h.user, 'alice');
  assert.match(h.account, /^[0-9a-f]{32}$/);

  // Новое устройство alice: чат с bob есть, истории нет
  const alice2 = mk();
  await link(alice2, alice);
  assert.equal((await alice2.messages('bob')).length, 0);
  const imported = waitFor(alice2, 'imported');
  const r = await alice2.importBackup(exp.bytes);
  await imported;
  assert.equal(r.messages, 2);
  const bodies = (await alice2.messages('bob')).map((m) => m.content.body);
  assert.deepEqual(bodies, ['секретное сообщение', 'ответ боба']);
  assert.ok((await alice2.contacts())['bob']);
  // Повторный импорт ничего не дублирует
  assert.deepEqual(await alice2.importBackup(exp.bytes), { chats: 0, messages: 0 });
  // Новая переписка после импорта продолжается как обычно
  const after = incoming(alice2, 'после переноса');
  await bob.sendText('alice', 'после переноса');
  await after;

  // Чужой аккаунт открыть копию не может
  await assert.rejects(bob.importBackup(exp.bytes), (e) => e.code === 'wrong_account' && e.user === 'alice');
  await assert.rejects(carol.importBackup(exp.bytes), (e) => e.code === 'wrong_account');
  assert.equal((await carol.messages('bob')).length, 0);

  // Подмена заголовка или содержимого
  const f = JSON.parse(text);
  const forged = (o) => new TextEncoder().encode(JSON.stringify({ ...f, ...o }));
  await assert.rejects(carol.importBackup(forged({ user: 'carol', account: backupHeader(new TextEncoder().encode(JSON.stringify(f))).account })), (e) => e.code === 'wrong_account');
  await assert.rejects(alice2.importBackup(forged({ created: f.created + 1 })), (e) => e.code === 'bad_backup');
  const data = Buffer.from(f.data, 'base64');
  data[10] ^= 1;
  await assert.rejects(alice2.importBackup(forged({ data: data.toString('base64') })), (e) => e.code === 'bad_backup');
  await assert.rejects(alice2.importBackup(new TextEncoder().encode('не json')), (e) => e.code === 'bad_backup');
  await assert.rejects(alice2.importBackup(forged({ v: 99 })), (e) => e.code === 'backup_version');

  // Аккаунт удалён и создан заново с тем же юзернеймом — это другой аккаунт
  alice.disconnect();
  alice2.disconnect();
  srv.store.deleteUser('alice');
  const alice3 = mk();
  await alice3.register('alice');
  await assert.rejects(alice3.importBackup(exp.bytes), (e) => e.code === 'wrong_account');
});
