// Магазин: рамки и фоны профиля из панели, покупка за монеты, «бесплатно с Премиум»,
// надетое видно собеседникам через статус; своё видео на фон профиля (Премиум, сквозное шифрование).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server/server.js';
import { sniffMime, SHOP_CHUNK } from '../server/shop.js';
import { MessengerClient, MemoryStorage, cleanLook, PROFILE_VIDEO_MAX } from '../shared/client-core.js';

const ADMIN_PASSWORD = 'очень-длинный-пароль-123';

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
async function until(cond, ms = 8000) {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 20));
  }
}

// Файлы с правильными «подписями» форматов
const png = (n = 1000) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(n, 3)]);
const mp4 = (n = 1000) => Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(n, 5)]);

async function setup(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tainik-shop-'));
  const srv = await startServer({ port: 0, host: '127.0.0.1', dataDir, log: false, admin: { password: ADMIN_PASSWORD } });
  const base = `http://127.0.0.1:${srv.port}`;
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
  let cookie = null;
  const login = async () => {
    if (cookie) return;
    const r = await fetch(`${base}/adminadminadmin/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ password: ADMIN_PASSWORD }),
    });
    cookie = r.headers.get('set-cookie').split(';')[0];
  };
  const adminApi = async (name, body) => {
    await login();
    const r = await fetch(`${base}/adminadminadmin/api/${name}`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json', 'X-Tainik-Admin': '1' },
      body: JSON.stringify(body),
    });
    return { status: r.status, ...(await r.json()) };
  };
  const adminGet = async (name) => {
    await login();
    return (await fetch(`${base}/adminadminadmin/api/${name}`, { headers: { Cookie: cookie } })).json();
  };
  // Загрузка товара так, как это делает панель: частями по SHOP_CHUNK
  const upload = async (kind, file, { name = 'Товар', price = 0, premium = false } = {}) => {
    const n = await adminApi('shop-new', { kind, name, price, premium, size: file.length });
    assert.equal(n.status, 200, n.error);
    for (let off = 0; off < file.length; off += SHOP_CHUNK) {
      const r = await adminApi('shop-chunk', { id: n.id, offset: off, data: file.subarray(off, off + SHOP_CHUNK).toString('base64') });
      assert.equal(r.status, 200, r.error);
    }
    return adminApi('shop-done', { id: n.id });
  };
  return { srv, base, dataDir, mk, adminApi, adminGet, upload };
}

test('тип файла товара — по содержимому', () => {
  assert.equal(sniffMime(png()), 'image/png');
  assert.equal(sniffMime(mp4()), 'video/mp4');
  assert.equal(sniffMime(Buffer.from('GIF89a......')), 'image/gif');
  assert.equal(sniffMime(Buffer.from('RIFF\0\0\0\0WEBPVP8 ')), 'image/webp');
  assert.equal(sniffMime(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 1, 2])), 'video/webm');
  assert.equal(sniffMime(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg">')), null);
  assert.equal(sniffMime(Buffer.from('<html><script>')), null);
  assert.deepEqual(cleanLook({ frame: '0123456789abcdef', bg: 'nope', x: 1 }), { frame: '0123456789abcdef' });
});

test('магазин: загрузка в панели, покупка за монеты, надетая рамка видна собеседнику', async (t) => {
  const { srv, base, mk, adminApi, adminGet, upload } = await setup(t);
  const [alice, bob] = [mk(), mk()];
  await alice.register('alice');
  await bob.register('bob');
  assert.equal(alice.shopOn, true);
  await bob.addContact('alice');

  // Картинка вместо видео и наоборот, SVG — не принимаются; файл больше части грузится по частям
  assert.equal((await upload('frame', mp4())).status, 400);
  assert.equal((await upload('frame', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).status, 400);
  const big = png(SHOP_CHUNK + 1000);
  const frame = (await upload('frame', big, { name: 'Золотая', price: 50 })).item;
  assert.equal(frame.mime, 'image/png');
  const bg = (await upload('bg', mp4(), { name: 'Звёзды', price: 0, premium: true })).item;
  const free = (await upload('frame', png(), { name: 'Простая', price: 0 })).item;
  // Панель видит все товары с числом продаж
  const ov = await adminGet('overview');
  assert.deepEqual(ov.shop.map((i) => [i.name, i.ready, i.sold]).sort(), [['Звёзды', true, 0], ['Золотая', true, 0], ['Простая', true, 0]]);

  // Файл товара открыт всем, кэшируется навсегда, тип — от сервера
  const res = await fetch(`${base}/api/shop/${frame.id}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');
  assert.match(res.headers.get('cache-control'), /immutable/);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), big);
  assert.equal((await fetch(`${base}/api/shop/0000000000000000`)).status, 404);
  const blob = await alice.fetchShopFile(bg.id);
  assert.equal(blob.type, 'video/mp4');

  // Витрина
  let shop = await alice.shopList();
  assert.deepEqual(shop.items.map((i) => i.name).sort(), ['Звёзды', 'Золотая', 'Простая']);
  assert.deepEqual(shop.owned, []);

  // Не куплено — не надеть; монет нет — не купить; цена сменилась — ничего не списано
  await assert.rejects(alice.equipShopItem('frame', frame.id), (e) => e.code === 'shop_not_owned');
  await assert.rejects(alice.buyShopItem(frame.id, 50), (e) => e.code === 'not_enough_coins');
  await adminApi('coins', { name: 'alice', delta: 70 });
  await until(() => alice.coins === 70);
  await assert.rejects(alice.buyShopItem(frame.id, 5), (e) => e.code === 'price_changed');
  await assert.rejects(alice.buyShopItem(free.id, 0), (e) => e.code === 'shop_free');
  const r = await alice.buyShopItem(frame.id, 50);
  assert.equal(r.coins, 20);
  assert.equal(srv.store.coinsOf('alice'), 20);
  await assert.rejects(alice.buyShopItem(frame.id, 50), (e) => e.code === 'shop_owned');
  assert.deepEqual(srv.store.coinLog('alice').map((l) => [l.delta, l.reason]), [[-50, 'shop'], [70, 'admin']]);

  // Надеть: рамка видна Бобу через статус
  const seen = waitFor(bob, 'presence', (p) => p.username === 'alice' && p.look.frame === frame.id);
  const eq = await alice.equipShopItem('frame', frame.id);
  assert.equal(eq.look.frame, frame.id);
  await seen;
  assert.deepEqual(bob.lookOf('alice'), { frame: frame.id });
  assert.deepEqual(alice.lookOf('alice'), { frame: frame.id });
  // Бесплатная рамка надевается без покупки
  await alice.equipShopItem('frame', free.id);
  await alice.equipShopItem('frame', frame.id);

  // «Бесплатно с Премиум»: без подписки нельзя, с подпиской можно, подписка кончилась — фон пропал
  await assert.rejects(alice.equipShopItem('bg', bg.id), (e) => e.code === 'premium_shop');
  await adminApi('premium', { name: 'alice', days: 30 });
  await until(() => alice.isPremium());
  await alice.equipShopItem('bg', bg.id);
  await until(() => bob.lookOf('alice').bg === bg.id);
  const gone = waitFor(bob, 'presence', (p) => p.username === 'alice' && !p.look.bg);
  const ownGone = waitFor(alice, 'look', (l) => !l.bg);
  await adminApi('premium', { name: 'alice', days: 0 });
  await gone;
  await ownGone;
  assert.equal(bob.lookOf('alice').frame, frame.id, 'купленная рамка остаётся');
  shop = await alice.shopList();
  assert.equal(shop.chosen.bg, bg.id, 'выбор сохранён и вернётся с подпиской');
  assert.equal(shop.look.bg, undefined);

  // Скрытый товар не продаётся, но у купивших остаётся
  const hidden = await adminApi('shop-update', { id: frame.id, name: 'Золотая', price: 50, hidden: true });
  assert.equal(hidden.item.hidden, true);
  assert.ok(!(await alice.shopList()).items.some((i) => i.id === frame.id));
  assert.equal(srv.store.lookOf('alice').frame, frame.id);

  // Удалён — пропадает у всех
  const removed = waitFor(bob, 'presence', (p) => p.username === 'alice' && !p.look.frame);
  assert.equal((await adminApi('shop-delete', { id: frame.id })).status, 200);
  await removed;
  assert.equal((await fetch(`${base}/api/shop/${frame.id}`)).status, 404);
  assert.deepEqual(srv.store.shopOwned('alice'), []);
});

test('своё видео на фон профиля: только с Премиум, зашифровано, файл не удаляется по сроку', async (t) => {
  const { srv, dataDir, mk, adminApi } = await setup(t);
  const [alice, bob] = [mk(), mk()];
  await alice.register('alice');
  await bob.register('bob');
  await bob.addContact('alice');
  await alice.addContact('bob');
  const video = Buffer.concat([mp4(), Buffer.from('секретный фон')]);

  await assert.rejects(alice.setProfileVideo(video, { mime: 'video/mp4', dur: 5 }), (e) => e.code === 'premium_video');
  await adminApi('premium', { name: 'alice', days: 30 });
  await until(() => alice.isPremium());
  await assert.rejects(alice.setProfileVideo(video, { mime: 'video/mp4', dur: 40 }), (e) => e.code === 'video_too_long');
  await assert.rejects(alice.setProfileVideo({ size: PROFILE_VIDEO_MAX + 1, type: 'video/mp4' }, {}), (e) => e.code === 'video_too_large');
  await assert.rejects(alice.setProfileVideo(video, { mime: 'application/pdf' }), (e) => e.code === 'bad_media');

  // Надетый фон из магазина снимается, когда ставят своё видео
  const n = await adminApi('shop-new', { kind: 'bg', name: 'Фон', price: 0, size: mp4().length });
  await adminApi('shop-chunk', { id: n.id, offset: 0, data: mp4().toString('base64') });
  await adminApi('shop-done', { id: n.id });
  await alice.equipShopItem('bg', n.id);

  const v = await alice.setProfileVideo(video, { mime: 'video/mp4', dur: 5, w: 720, h: 1280 });
  assert.equal(alice.profileVideoOf('alice').id, v.id);
  assert.equal(srv.store.profileVideoOf('alice'), v.id, 'файл закреплён на сервере');
  await until(() => !alice.look.bg);

  // Видео уходит собеседнику в зашифрованном профиле; файл на сервере — шифротекст
  await alice.sendText('bob', 'привет');
  await until(async () => (await bob.profileOf('alice'))?.video?.id === v.id);
  const vb = bob.profileVideoOf('alice');
  assert.deepEqual([vb.w, vb.h, vb.dur], [720, 1280, 5]);
  assert.deepEqual(Buffer.from(await bob.fetchFile(vb)), video);
  const raw = fs.readFileSync(path.join(dataDir, 'blobs', v.id), { encoding: 'latin1' });
  assert.ok(!raw.includes('ftypisom'), 'сервер видео не видит');

  // Без подписки собеседники видео не видят
  await adminApi('premium', { name: 'alice', days: 0 });
  await until(() => !bob.hasPremium('alice'));
  assert.equal(bob.profileVideoOf('alice'), null);

  // Новое видео — прежнее открепляется (удалится при чистке); убрать — открепить
  await adminApi('premium', { name: 'alice', days: 30 });
  await until(() => alice.isPremium());
  const v2 = await alice.setProfileVideo(mp4(), { mime: 'video/mp4', dur: 3 });
  assert.equal(srv.store.profileVideoOf('alice'), v2.id);
  assert.equal(srv.store.getBlob(v.id).pin, null);
  await alice.setProfileVideo(null);
  assert.equal(srv.store.profileVideoOf('alice'), null);
  assert.equal(alice.profile.video, undefined);
});

test('примеры рамок: выставляются один раз, удалённые не возвращаются', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tainik-shop-samples-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  let srv = await startServer({ port: 0, host: '127.0.0.1', dataDir, log: false, shopSamples: true });
  const items = srv.store.shopItems();
  assert.deepEqual(items.map((i) => i.name).sort(), ['Звёздная пыль', 'Золото', 'Неон', 'Сакура']);
  assert.ok(items.every((i) => i.kind === 'frame' && i.mime === 'image/png'));
  const r = await fetch(`http://127.0.0.1:${srv.port}/api/shop/${items[0].id}`);
  assert.equal(r.headers.get('content-type'), 'image/png');
  assert.equal(sniffMime(Buffer.from(await r.arrayBuffer()).subarray(0, 16)), 'image/png');
  srv.store.deleteShopItem(items[0].id);
  await srv.close();
  srv = await startServer({ port: 0, host: '127.0.0.1', dataDir, log: false, shopSamples: true });
  assert.equal(srv.store.shopItems().length, 3, 'второй запуск ничего не добавляет');
  await srv.close();

  // Сервер 0.47.6 успел выставить объёмные рамки — в 0.47.7 они убраны и снимаются (один раз);
  // переименованную администратором рамку не трогаем
  const old = fs.mkdtempSync(path.join(os.tmpdir(), 'tainik-shop-old-'));
  t.after(() => fs.rmSync(old, { recursive: true, force: true }));
  srv = await startServer({ port: 0, host: '127.0.0.1', dataDir: old, log: false, shopSamples: true });
  const add = (id, name) => {
    srv.store.addShopItem({ id, kind: 'frame', name, price: 150, premium: false, size: 10 });
    srv.store.shopReceived(id, 10);
    srv.store.shopReady(id, 'image/png');
  };
  add('aaaaaaaaaaaaaaa1', 'Хром 3D');
  add('aaaaaaaaaaaaaaa2', 'Мой жемчуг'); // был «Жемчуг», администратор переименовал
  const seeded = JSON.parse(srv.store.getMeta('shop_samples_seeded'));
  srv.store.setMeta('shop_samples_seeded', JSON.stringify([...seeded, 'chrome-3d.png', 'pearl-3d.png']));
  await srv.close();
  srv = await startServer({ port: 0, host: '127.0.0.1', dataDir: old, log: false, shopSamples: true });
  const last = srv;
  t.after(() => last.close().catch(() => {}));
  const names = srv.store.shopItems().map((i) => i.name);
  assert.ok(!names.includes('Хром 3D'), 'объёмная рамка снята');
  assert.ok(names.includes('Мой жемчуг'), 'переименованная — остаётся');
  assert.equal(names.length, 5);
});

test('иконка двойной галочки — две полные галочки', async () => {
  const set = JSON.parse(fs.readFileSync(new URL('../client/icons.json', import.meta.url), 'utf8'));
  assert.equal(set.icons.check2.length, 2, 'каждая галочка — отдельный штрих из двух плеч');
  for (const [, a] of set.icons.check2) assert.match(a.d, /^M[\d.]+ [\d.]+l[\d.]+ [\d.]+ [\d.]+-[\d.]+$/);
});

test('панель: выдать товар бесплатно и забрать (надетый снимается), уведомления в чат «Тайник»', async (t) => {
  const { srv, mk, adminApi, upload } = await setup(t);
  const [alice, bob] = [mk(), mk()];
  await alice.register('alice');
  await bob.register('bob');
  await bob.addContact('alice');
  // Скрытый товар тоже можно выдать — как эксклюзив
  const frame = (await upload('frame', png(), { name: 'Эксклюзив', price: 500 })).item;
  await adminApi('shop-update', { id: frame.id, name: 'Эксклюзив', price: 500, hidden: true });

  assert.equal((await adminApi('shop-grant', { id: frame.id, name: 'nobody' })).status, 400);
  const gotShop = waitFor(alice, 'shop', (d) => d.owned === frame.id);
  const gotNotice = waitFor(alice, 'message', (d) => d.message.content?.kind === 'shop-admin' && d.message.content.on);
  const g = await adminApi('shop-grant', { id: frame.id, name: '@alice' });
  assert.equal(g.status, 200, g.error);
  assert.deepEqual(g.owners.map((o) => [o.user, o.price]), [['alice', 0]]);
  await gotShop;
  const n = (await gotNotice).message.content;
  assert.deepEqual([n.name, n.item], ['Эксклюзив', 'frame']);
  assert.equal((await adminApi('shop-grant', { id: frame.id, name: 'alice' })).status, 400, 'второй раз — уже есть');
  assert.equal(srv.store.coinsOf('alice'), 0, 'монеты не списываются');

  // Выданный надевается; Боб видит рамку
  await alice.equipShopItem('frame', frame.id);
  await until(() => bob.lookOf('alice').frame === frame.id);
  assert.deepEqual((await adminApi('shop-owners', { id: frame.id })).owners.map((o) => o.user), ['alice']);

  // Забрать: рамка снимается у всех, уведомление
  const revoked = waitFor(alice, 'shop', (d) => d.revoked === frame.id);
  const off = waitFor(bob, 'presence', (p) => p.username === 'alice' && !p.look.frame);
  const r = await adminApi('shop-revoke', { id: frame.id, name: 'alice' });
  assert.equal(r.status, 200, r.error);
  await revoked;
  await off;
  assert.equal(alice.look.frame, undefined);
  assert.deepEqual(srv.store.shopOwned('alice'), []);
  await until(async () => (await alice.messages('~tainik')).some((m) => m.content?.kind === 'shop-admin' && !m.content.on));
  assert.equal((await adminApi('shop-revoke', { id: frame.id, name: 'alice' })).status, 400, 'забирать нечего');
  await assert.rejects(alice.equipShopItem('frame', frame.id), (e) => e.code === 'shop_not_owned');
});

test('свой фон: GIF и статичное фото тоже можно', async (t) => {
  const { mk, adminApi } = await setup(t);
  const [alice, bob] = [mk(), mk()];
  await alice.register('alice');
  await bob.register('bob');
  await bob.addContact('alice');
  await alice.addContact('bob');
  await adminApi('premium', { name: 'alice', days: 30 });
  await until(() => alice.isPremium());
  const gif = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(500, 1)]);
  const v = await alice.setProfileVideo(gif, { mime: 'image/gif', w: 320, h: 320 });
  assert.deepEqual([v.mime, v.kind], ['image/gif', 'image']);
  await alice.sendText('bob', 'смотри фон');
  await until(async () => (await bob.profileOf('alice'))?.video?.id === v.id);
  assert.equal(bob.profileVideoOf('alice').mime, 'image/gif');
  assert.deepEqual(Buffer.from(await bob.fetchFile(bob.profileVideoOf('alice'))), gif);
  // Статичное фото — тоже можно (0.47.5); документ — нет
  const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(400, 2)]);
  const ph = await alice.setProfileVideo(jpg, { mime: 'image/jpeg', w: 1600, h: 900 });
  assert.deepEqual([ph.mime, ph.kind, ph.dur], ['image/jpeg', 'image', undefined]);
  await until(() => bob.profileVideoOf('alice')?.id === ph.id);
  assert.deepEqual(Buffer.from(await bob.fetchFile(bob.profileVideoOf('alice'))), jpg);
  await assert.rejects(alice.setProfileVideo(Buffer.alloc(10), { mime: 'application/pdf' }), (e) => e.code === 'bad_media');
});

test('фон, потерянный старой версией приложения, приходит снова после обновления (собеседнику и своему устройству)', async (t) => {
  const { mk, adminApi } = await setup(t);
  const [alice, bob] = [mk(), mk()];
  await alice.register('alice');
  await bob.register('bob');
  const alice2 = mk();
  {
    let gotCode;
    const codeP = new Promise((r) => (gotCode = r));
    const { done } = alice2.linkAsNewDevice({ deviceName: 'Телефон', onCode: ({ code }) => gotCode(code) });
    await alice.linkDevice(await codeP);
    await done;
  }
  await adminApi('premium', { name: 'alice', days: 30 });
  await until(() => alice.isPremium() && alice2.isPremium());
  await bob.addContact('alice');
  await alice.addContact('bob');
  await alice.sendText('bob', 'привет');
  const v = await alice.setProfileVideo(mp4(), { mime: 'video/mp4', dur: 3 });
  await until(async () => (await bob.profileOf('alice'))?.video?.id === v.id && alice2.profile.video?.id === v.id);

  // Так профиль сохранила бы версия до 0.47: без фона (незнакомое поле отброшено), та же версия профиля
  const strip = ({ video, ...rest }) => rest;
  bob.disconnect();
  const all = await bob.contacts();
  all.alice.profile = strip(all.alice.profile);
  delete all.alice.profileSchema;
  delete all.alice.profileAskedS;
  await bob._saveContacts(all);
  alice2.disconnect();
  alice2.profile = strip(alice2.profile);
  await alice2.storage.set('profile', alice2.profile);
  await alice2.storage.del('profile-schema');
  assert.equal(bob.profileVideoOf('alice'), null);
  assert.equal(alice2.profile.video, undefined);

  // Обновились и подключились: фон приходит сам, без изменений профиля у Алисы
  await bob.connect();
  await alice2.connect();
  await until(() => bob.profileVideoOf('alice')?.id === v.id && alice2.profile.video?.id === v.id, 10000);
});
