// GIF: поиск через сервер (провайдер — подделка), подписанные адреса картинок, сохранённые GIF
// на всех своих устройствах и их файлы, которые сервер не удаляет по сроку.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server/server.js';
import { createGifs, gifProviderName } from '../server/gifs.js';
import { MessengerClient, MemoryStorage } from '../shared/client-core.js';
import { cleanFile } from '../shared/media.js';

const GIF = Buffer.from('R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==', 'base64');
const waitFor = (em, ev, pred = () => true, ms = 8000) =>
  new Promise((res, rej) => {
    const timer = setTimeout(() => (off(), rej(new Error('timeout ' + ev))), ms);
    const off = em.on(ev, (d) => pred(d) && (clearTimeout(timer), off(), res(d)));
  });

function fakeProvider() {
  const calls = [];
  const fetch = async (url) => {
    url = String(url);
    calls.push(url);
    if (url.startsWith('https://api.klipy.com/v2/')) {
      const u = new URL(url);
      const q = u.searchParams.get('q') || 'featured';
      return new Response(
        JSON.stringify({
          next: 'p2',
          results: [
            { id: '1', content_description: 'кот ' + q, media_formats: { tinygif: { url: 'https://media.klipy.com/t/1.gif', dims: [100, 80], size: 900 }, gif: { url: 'https://media.klipy.com/1.gif', dims: [400, 320], size: 9000 }, mp4: { url: 'https://media.klipy.com/1.mp4', dims: [400, 320], size: 3000 } } },
            { id: 'bad', media_formats: { gif: { url: 'javascript:alert(1)' } } },
          ],
        }),
        { headers: { 'content-type': 'application/json' } }
      );
    }
    if (url === 'https://media.klipy.com/t/1.gif' || url === 'https://media.klipy.com/1.gif') return new Response(GIF, { headers: { 'content-type': 'image/gif' } });
    if (url === 'https://media.klipy.com/evil.html') return new Response('<script>', { headers: { 'content-type': 'text/html' } });
    return new Response('no', { status: 404 });
  };
  return { fetch, calls };
}

async function setup(tt, gifs) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tainik-gifs-'));
  const srv = await startServer({ port: 0, host: '127.0.0.1', dataDir, log: false, gifs });
  const clients = [];
  const mk = (storage = new MemoryStorage()) => {
    const c = new MessengerClient({ url: `ws://127.0.0.1:${srv.port}/ws`, storage });
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

test('GIF: поиск через сервер, ключ провайдера не уходит в приложение, картинки — только подписанные', async (tt) => {
  const p = fakeProvider();
  const { srv, mk } = await setup(tt, { api: 'https://api.klipy.com', key: 'SECRET-KEY', fetch: p.fetch });
  const alice = mk();
  await alice.register('alice');
  assert.deepEqual(alice.gifSearch, { provider: 'KLIPY' });
  const r = await alice.searchGifs('котики', null, 'ru');
  assert.equal(r.next, 'p2');
  assert.equal(r.results.length, 1, 'кривой результат отброшен');
  const it = r.results[0];
  assert.equal(it.desc, 'кот котики');
  assert.deepEqual([it.mp4.w, it.mp4.h], [400, 320]);
  assert.ok(!JSON.stringify(r).includes('SECRET-KEY'));
  assert.ok(!JSON.stringify(r).includes('media.klipy.com'), 'адреса провайдера скрыты за сервером');
  const call = new URL(p.calls.at(-1));
  assert.equal(call.pathname, '/v2/search');
  assert.equal(call.searchParams.get('q'), 'котики');
  assert.equal(call.searchParams.get('locale'), 'ru');
  // Без запроса — подборка
  await alice.searchGifs('');
  assert.equal(new URL(p.calls.at(-1)).pathname, '/v2/featured');
  // Картинка через сервер
  const blob = await alice.fetchGifMedia(it.preview.u);
  assert.equal(blob.type, 'image/gif');
  assert.equal(blob.size, GIF.length);
  // Подделанный адрес (другая ссылка с чужой подписью) — 404, к провайдеру не ходим
  const forged = it.preview.u.replace(/\/m\/[^.]+/, '/m/' + Buffer.from('https://media.klipy.com/evil.html').toString('base64url'));
  const n = p.calls.length;
  assert.equal((await fetch(`http://127.0.0.1:${srv.port}${forged}`)).status, 404);
  assert.equal(p.calls.length, n);
  assert.equal(alice.gifMediaUrl('https://evil.example/x'), null);
});

test('GIF: подписанный адрес не проксирует не-картинки; без ключа поиск выключен', async () => {
  const p = fakeProvider();
  const g = createGifs({ api: 'https://api.klipy.com', key: 'k', fetch: p.fetch });
  const out = {};
  const res = { headersSent: false, writeHead(st, h) { out.status = st; out.h = h; this.headersSent = true; return this; }, end(b) { out.body = b; out.done(); } };
  await new Promise((done) => {
    out.done = done;
    g.handleHttp({ method: 'GET', url: g.mediaPath('https://media.klipy.com/evil.html') }, res, '1.2.3.4');
  });
  assert.equal(out.status, 415);
  const off = createGifs({});
  assert.equal(off.enabled, false);
  await assert.rejects(off.search({ q: 'x' }), (e) => e.code === 'gifs_off');
  assert.equal(gifProviderName('https://api.giphy.com'), 'GIPHY');
});

test('GIF: пометка as: gif у вложения — только для анимаций и роликов', () => {
  const base = { id: 'a'.repeat(32), key: Buffer.alloc(32, 1).toString('base64'), size: 10 };
  assert.equal(cleanFile({ ...base, mime: 'image/gif', kind: 'image', as: 'gif' }).as, 'gif');
  assert.equal(cleanFile({ ...base, mime: 'video/mp4', kind: 'video', as: 'gif' }).as, 'gif');
  assert.equal(cleanFile({ ...base, mime: 'image/jpeg', kind: 'image', as: 'gif' }).as, undefined);
  assert.equal(cleanFile({ ...base, mime: 'audio/ogg', kind: 'audio', as: 'gif' }).as, undefined);
});

test('GIF: свои сохранённые — на всех своих устройствах, отправка без повторной загрузки, файл не удаляется по сроку', async (tt) => {
  const { srv, mk } = await setup(tt, null);
  const alice = mk();
  const bob = mk();
  await alice.register('alice');
  await bob.register('bob');
  assert.equal(alice.gifSearch, null, 'без ключа поиска нет');
  await assert.rejects(alice.searchGifs('x'), (e) => e.code === 'gifs_off');
  // Второе устройство alice
  const alice2 = mk();
  let gotCode;
  const codeP = new Promise((r) => (gotCode = r));
  const { done } = alice2.linkAsNewDevice({ deviceName: 'Ноутбук', onCode: ({ code }) => gotCode(code) });
  await alice.linkDevice(await codeP);
  await done;

  const synced = waitFor(alice2, 'gifs', (l) => l.length === 1);
  const f = await alice.uploadGif(new Uint8Array(GIF), { mime: 'image/gif', name: 'my.gif', w: 1, h: 1 });
  assert.equal(f.as, 'gif');
  assert.ok(alice.isGifSaved(f.id));
  await synced;
  assert.deepEqual((await alice2.savedGifs()).map((x) => x.id), [f.id]);
  assert.deepEqual(srv.store.keptBlobs('alice'), [f.id]);
  // Старше срока хранения вложений — всё равно не удаляется
  srv.store.db.prepare('UPDATE blobs SET created_at = 0 WHERE id = ?').run(f.id);
  assert.ok(!srv.store.expiredBlobs(Date.now(), Date.now()).includes(f.id));

  // Отправка из сохранённых — то же вложение
  await alice.addContact('bob');
  const got = waitFor(bob, 'message', (d) => d.message.content.file);
  await alice.sendGif('bob', f);
  const m = (await got).message;
  assert.equal(m.content.file.id, f.id);
  assert.equal(m.content.file.as, 'gif');
  // Боб сохраняет полученную GIF себе — её файл держат оба
  await bob.saveGif(m.content.file);
  assert.deepEqual(srv.store.keptBlobs('bob'), [f.id]);

  // Удаление у alice: держит ещё bob — файл остаётся
  const removed = waitFor(alice2, 'gifs', (l) => l.length === 0);
  await alice.removeGif(f.id);
  await removed;
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual(srv.store.keptBlobs('alice'), []);
  assert.ok(!srv.store.expiredBlobs(Date.now(), Date.now()).includes(f.id));
  // Не GIF сохранить нельзя; несуществующий файл — ошибка сервера
  await assert.rejects(alice.saveGif({ ...f, mime: 'image/jpeg' }), (e) => e.code === 'not_gif');
  await assert.rejects(alice.saveGif({ ...f, id: 'b'.repeat(32) }), (e) => e.code === 'bad_blob');
});
