// Вложения: шифрование на устройстве, загрузка частями, доставка ключа в сообщении,
// синхронизация на свои устройства, проверки сервера (токен, смещение, Range, сроки).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server/server.js';
import { MessengerClient, MemoryStorage } from '../shared/client-core.js';
import { SEG, encryptedSize, decryptFile, newFileKey, encryptSegment, cleanFile, safeName, kindOf, fmtSize } from '../shared/media.js';
import { randomBytes, toB64 } from '../shared/protocol/index.js';

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

async function setup(t, opts = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tainik-media-'));
  const srv = await startServer({ port: 0, host: '127.0.0.1', dataDir, log: false, ...opts });
  const base = `http://127.0.0.1:${srv.port}`;
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
  return { srv, mk, dataDir, base };
}

function bytes(n) {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i += 65536) out.set(randomBytes(Math.min(65536, n - i)), i);
  return out;
}

async function link(newClient, existing) {
  let gotCode;
  const codeP = new Promise((r) => (gotCode = r));
  const { done } = newClient.linkAsNewDevice({ deviceName: 'Телефон', onCode: ({ code }) => gotCode(code) });
  await existing.linkDevice(await codeP);
  return done;
}

test('вложения: шифрование частями, обрезка и подмена обнаруживаются', async () => {
  for (const size of [1, 1000, SEG, SEG + 1, 2 * SEG + 5]) {
    const data = bytes(size);
    const { keyB64, key } = await newFileKey();
    const n = Math.max(1, Math.ceil(size / SEG));
    const parts = [];
    for (let i = 0; i < n; i++) parts.push(await encryptSegment(key, i, n, data.subarray(i * SEG, Math.min(size, (i + 1) * SEG))));
    const enc = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
    let at = 0;
    for (const p of parts) enc.set(p, at), (at += p.length);
    assert.equal(enc.length, encryptedSize(size));
    assert.deepEqual(await decryptFile(keyB64, enc, size), data);
    const bad = enc.slice();
    bad[bad.length - 1] ^= 1;
    await assert.rejects(decryptFile(keyB64, bad, size), { code: 'bad_media' });
    if (n > 1) {
      // Сервер отдал только первые части и выдаёт файл за меньший — не пройдёт (признак последней части)
      await assert.rejects(decryptFile(keyB64, parts[0], SEG), { code: 'bad_media' });
    }
  }
});

test('вложения: описание файла проверяется', () => {
  const key = toB64(randomBytes(32));
  const id = 'a'.repeat(32);
  assert.equal(cleanFile({ id: 'x', key, size: 5 }), null);
  assert.equal(cleanFile({ id, key: 'abc', size: 5 }), null);
  assert.equal(cleanFile({ id, key, size: 0 }), null);
  const f = cleanFile({ id, key, size: 5, name: '../../etc/passwd', mime: 'text/html', kind: 'image', thumb: 'javascript:alert(1)', evil: 1 });
  assert.deepEqual(f, { id, key, size: 5, name: '_.._etc_passwd', mime: 'text/html', kind: 'file' });
  assert.equal(cleanFile({ id, key, size: 5, mime: 'image/svg+xml', kind: 'image' }).kind, 'file', 'SVG не показываем как картинку');
  assert.equal(cleanFile({ id, key, size: 5, mime: 'image/jpeg', kind: 'image', w: 10, h: 20, thumb: 'data:image/jpeg;base64,AAAA' }).thumb, 'data:image/jpeg;base64,AAAA');
  assert.equal(safeName('a‮gnp.exe'), 'agnp.exe');
  assert.equal(safeName(''), 'file');
  assert.equal(kindOf('video/mp4'), 'video');
  assert.equal(kindOf('application/pdf'), 'file');
  assert.equal(fmtSize(1536, undefined, 'ru'), '1,5 КБ');
});

test('вложения: отправка, получение, свои устройства, ответ на фото', async (t) => {
  const { srv, mk, dataDir } = await setup(t);
  const alice = mk();
  const bob = mk();
  await alice.register('alice');
  await bob.register('bob');
  const alice2 = mk();
  const linked = link(alice2, alice);
  await linked;
  await alice.addContact('bob');

  const data = bytes(SEG + 12345);
  const progress = [];
  const got = waitFor(bob, 'message', (d) => d.message.dir === 'in' && d.message.content.t === 'file');
  const synced = waitFor(alice2, 'message', (d) => d.message.dir === 'out' && d.message.content.t === 'file');
  const sent = await alice.sendFile('bob', data, { name: 'фото.jpg', mime: 'image/jpeg', w: 640, h: 480 }, { caption: 'Смотри', onProgress: (p) => progress.push(p) });
  assert.equal(progress.at(-1), 1);
  assert.equal(progress.length, 2, 'две части');
  const { message } = await got;
  assert.equal(message.content.body, 'Смотри');
  assert.equal(message.content.file.kind, 'image');
  assert.equal(message.content.file.name, 'фото.jpg');
  assert.equal(message.content.file.id, sent.id);
  assert.deepEqual(await bob.fetchFile(message.content.file), data);
  const mine = await synced;
  assert.deepEqual(await alice2.fetchFile(mine.message.content.file), data);

  // На сервере — только шифротекст
  const stored = fs.readFileSync(path.join(dataDir, 'blobs', sent.id));
  assert.equal(stored.length, encryptedSize(data.length));
  assert.ok(!stored.subarray(0, 1000).equals(Buffer.from(data.subarray(0, 1000))));
  assert.equal(srv.store.blobStats().n, 1);

  // Ответ на фото без подписи: в цитате — вид вложения
  const plain = await alice.sendFile('bob', new Uint8Array([1, 2, 3]), { name: 'a.png', mime: 'image/png' });
  const msgs = await alice.messages('bob');
  const photo = msgs.find((m) => m.content.file?.id === plain.id);
  const rep = waitFor(bob, 'message', (d) => d.message.content.body === 'Классно');
  await alice.sendText('bob', 'Классно', { replyTo: photo.id });
  const r = (await rep).message.content.reply;
  assert.equal(r.kind, 'image');
  assert.equal(r.body, '');
});

test('вложения: сервер проверяет токен, смещение, размер; Range; удаление по сроку', async (t) => {
  const { srv, mk, base } = await setup(t, { uploads: { maxMb: 1 } });
  const alice = mk();
  await alice.register('alice');
  await assert.rejects(alice._request({ type: 'blob-new', size: 2 * 1024 * 1024 }), { code: 'file_too_large' });
  await assert.rejects(alice._request({ type: 'blob-new', size: 0 }), { code: 'bad_size' });
  const r = await alice._request({ type: 'blob-new', size: 10 });
  const url = `${base}/api/blob/${r.id}`;
  assert.equal((await fetch(url)).status, 404, 'пока не загружен');
  assert.equal((await fetch(url + '?offset=0', { method: 'PUT', body: 'abc' })).status, 403, 'без токена');
  const h = { 'X-Blob-Token': r.token };
  assert.equal((await fetch(url + '?offset=0', { method: 'PUT', headers: { 'X-Blob-Token': 'nope' }, body: 'abc' })).status, 403);
  assert.equal((await fetch(url + '?offset=5', { method: 'PUT', headers: h, body: 'abc' })).status, 409, 'неверное смещение');
  assert.equal((await fetch(url + '?offset=0', { method: 'PUT', headers: h, body: '0123456789AB' })).status, 413, 'больше заявленного');
  let res = await fetch(url + '?offset=0', { method: 'PUT', headers: h, body: '01234' });
  assert.deepEqual(await res.json(), { received: 5, done: false });
  res = await fetch(url + '?offset=5', { method: 'PUT', headers: h, body: '56789' });
  assert.deepEqual(await res.json(), { received: 10, done: true });
  assert.equal((await fetch(url + '?offset=10', { method: 'PUT', headers: h, body: 'x' })).status, 403, 'готовый файл не меняется');
  res = await fetch(url);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  assert.equal(await res.text(), '0123456789');
  res = await fetch(url, { headers: { Range: 'bytes=3-5' } });
  assert.equal(res.status, 206);
  assert.equal(await res.text(), '345');
  assert.equal((await fetch(`${base}/api/blob/../../etc`)).status, 404);
  assert.equal((await fetch(url, { method: 'OPTIONS' })).status, 204);

  // Срок хранения истёк
  srv.store.db.prepare('UPDATE blobs SET created_at = 0').run();
  srv.purge();
  assert.equal((await fetch(url)).status, 404);
  assert.equal(srv.store.blobStats().n, 0);
});
