// Подписка «Тайник Премиум»: счета xRocket Pay, вебхук с подписью, сверка, фото профиля.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server/server.js';
import { parsePlans, parseCurrencies, parsePacks, convertPrice, sameAmount, verifyWebhookSignature, signWebhook, WEBHOOK_PATH } from '../server/billing.js';
import { MessengerClient, MemoryStorage, AVATAR_MAX, validAvatar, SYSTEM_CHAT, cleanNotice } from '../shared/client-core.js';

const SECRET = 'webhook-secret-for-tests';
const TOKEN = 'api-token-for-tests';
const ADMIN_PASSWORD = 'очень-длинный-пароль-123';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
const incoming = (client, body) => waitFor(client, 'message', (d) => d.message.dir === 'in' && d.message.content.body === body);

/** Поддельный xRocket Pay: хранит счета, отвечает как настоящий API. */
function fakeXRocket() {
  const invoices = new Map(); // clientInvoiceId → invoice
  const calls = [];
  let seq = 100;
  const json = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
  const problem = (status, code) => json(status, { type: `/api/problems/${code}`, title: code, status, detail: code, instance: '/api/problems/instances/x', kind: 'validation' });
  async function fetch(url, opts = {}) {
    const u = new URL(url);
    calls.push({ method: opts.method, path: u.pathname, auth: opts.headers?.Authorization, body: opts.body ? JSON.parse(opts.body) : null });
    if (opts.headers?.Authorization !== `Bearer ${TOKEN}`) return problem(401, 'unauthorized');
    if (opts.method === 'POST' && u.pathname === '/api/v1/invoices') {
      const b = JSON.parse(opts.body);
      if (invoices.has(b.clientInvoiceId)) return problem(400, 'client_id_already_taken');
      if (b.priceCurrency === 'TONCOIN' && Number(b.priceAmount) < 5) {
        return json(400, { type: '/api/problems/amount_too_small', title: 'Amount too small', status: 400, detail: 'Minimum invoice amount is 5 TONCOIN', kind: 'client_data_validation' });
      }
      const id = `inv_${++seq}`;
      const inv = {
        id,
        priceAmount: b.priceAmount,
        priceCurrency: b.priceCurrency,
        clientInvoiceId: b.clientInvoiceId,
        description: b.description,
        expiresIn: b.expiresIn,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + b.expiresIn).toISOString(),
        status: 'active',
        callback: b.callback,
        links: { telegramBotLink: `https://t.me/xRocket?start=${id}` },
      };
      invoices.set(b.clientInvoiceId, inv);
      return json(201, inv);
    }
    if (opts.method === 'GET' && u.pathname === '/api/v1/currencies') {
      return json(200, ['USDT', 'TRX', 'GRAM', 'TONCOIN'].map((code) => ({ code, title: code, kind: 'crypto', networks: [] })));
    }
    if (opts.method === 'GET' && u.pathname === '/api/v1/rates') {
      // Сколько base стоит единица актива
      const table = { TRX: '0.3', GRAM: '0.0021', TONCOIN: '2.5' };
      const assets = u.searchParams.getAll('assets');
      return json(200, assets.filter((a) => table[a]).map((a) => ({ currency: a, rate: table[a] })));
    }
    if (opts.method === 'GET' && u.pathname === '/api/v1/invoice') {
      const inv = invoices.get(u.searchParams.get('clientInvoiceId'));
      return inv ? json(200, inv) : problem(404, 'not_found');
    }
    return problem(404, 'not_found');
  }
  return { fetch, invoices, calls };
}

async function setup(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tainik-premium-'));
  const x = fakeXRocket();
  const srv = await startServer({
    port: 0,
    host: '127.0.0.1',
    dataDir,
    log: false,
    admin: { password: ADMIN_PASSWORD },
    billing: {
      token: TOKEN,
      webhookSecret: SECRET,
      plans: parsePlans('30:3, 365:30.5', 'usdt'),
      currencies: parseCurrencies('gram, TRX, TON, NOPE', 'USDT'),
      packs: parsePacks('100:1, 550:5, 1200:10', 'usdt'),
      publicUrl: 'https://chat.example',
      fetch: x.fetch,
    },
  });
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
  // Вебхук так, как его шлёт xRocket: подпись по сырому телу и метке времени
  const webhook = (event, { secret = SECRET, ts = Date.now(), version = 'v1' } = {}) => {
    const raw = JSON.stringify(event);
    return fetch(base + WEBHOOK_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Signature: signWebhook(secret, raw, ts), 'Signature-Version': version, 'Signature-Timestamp': String(ts) },
      body: raw,
    });
  };
  const paidEvent = (inv, id = String(Math.random())) => ({
    id,
    type: 'invoice',
    timestamp: new Date().toISOString(),
    data: { event: 'invoice_status_changed', invoice: { ...inv, status: 'paid' } },
  });
  const adminApi = async (name, body) => {
    const r = await fetch(`${base}/adminadminadmin/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ password: ADMIN_PASSWORD }),
    });
    const cookie = r.headers.get('set-cookie').split(';')[0];
    return fetch(`${base}/adminadminadmin/api/${name}`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json', 'X-Tainik-Admin': '1' },
      body: JSON.stringify(body),
    });
  };
  return { srv, x, mk, webhook, paidEvent, adminApi };
}

// Маленькая картинка в формате data:-URL
const avatar = (n = 300) => 'data:image/png;base64,' + Buffer.alloc(n, 7).toString('base64');

test('тарифы, суммы и подпись вебхука', () => {
  assert.deepEqual(parsePlans('365:30.5, 30:3', 'usdt'), [
    { id: '30d', days: 30, price: '3', currency: 'USDT' },
    { id: '365d', days: 365, price: '30.5', currency: 'USDT' },
  ]);
  assert.throws(() => parsePlans('30:abc'));
  assert.throws(() => parsePlans('30:3,30:4'));
  assert.throws(() => parsePlans('0:3'));
  assert.throws(() => parsePlans('30:3', 'не валюта'));
  assert.ok(sameAmount('3', '3.00') && sameAmount('30.50', '30.5'));
  assert.ok(!sameAmount('3', '3.01') && !sameAmount('3', '') && !sameAmount('-3', '-3'));

  const raw = '{"id":"1","type":"invoice"}';
  const ts = Date.now();
  const sig = signWebhook(SECRET, raw, ts);
  assert.ok(verifyWebhookSignature({ secret: SECRET, rawBody: raw, signature: sig, version: 'v1', timestamp: ts }));
  assert.ok(!verifyWebhookSignature({ secret: SECRET, rawBody: raw + ' ', signature: sig, version: 'v1', timestamp: ts }), 'тело изменено');
  assert.ok(!verifyWebhookSignature({ secret: 'другой', rawBody: raw, signature: sig, version: 'v1', timestamp: ts }));
  assert.ok(!verifyWebhookSignature({ secret: SECRET, rawBody: raw, signature: sig, version: 'v2', timestamp: ts }), 'незнакомая схема');
  const old = ts - 10 * 60_000;
  assert.ok(!verifyWebhookSignature({ secret: SECRET, rawBody: raw, signature: signWebhook(SECRET, raw, old), version: 'v1', timestamp: old }), 'старый вебхук');

  assert.deepEqual(parseCurrencies('gram, TRX,usdt', 'USDT'), ['USDT', 'GRAM', 'TRX']);
  assert.throws(() => parseCurrencies('не валюта', 'USDT'));
  assert.equal(convertPrice('3', '0.3'), '10');
  assert.equal(convertPrice('3', '0.0021'), '1428.58', 'округление вверх');
  assert.equal(convertPrice('8', '2.5'), '3.2');
  assert.equal(convertPrice('3', '0'), null);

  assert.ok(validAvatar(avatar()));
  assert.ok(!validAvatar('data:image/svg+xml;base64,PHN2Zz4='), 'SVG нельзя');
  assert.ok(!validAvatar('data:image/png;base64,AAA"onerror'), 'только base64');
  assert.ok(!validAvatar(avatar(AVATAR_MAX)), 'слишком большое');
});

test('подписка: счёт, оплата через вебхук, фото профиля у собеседника', async (t) => {
  const { srv, x, mk, webhook, paidEvent } = await setup(t);
  const alice = mk();
  const bob = mk();
  await alice.register('alice');
  await bob.register('bob');
  assert.deepEqual(alice.billing.plans.map((p) => p.id), ['30d', '365d']);
  assert.equal(alice.isPremium(), false);

  // Без подписки фото не поставить
  await assert.rejects(alice.setProfile({ avatar: avatar() }), (e) => e.code === 'premium_required');

  // Счёт: в xRocket уходит сумма, валюта, наш id и адрес вебхука — без юзернейма
  await assert.rejects(alice.buyPremium('7d'), (e) => e.code === 'bad_plan');
  const inv = await alice.buyPremium('30d');
  assert.match(inv.url, /^https:\/\/t\.me\/xRocket\?start=inv_/);
  assert.equal(inv.price, '3');
  const req = x.calls.find((c) => c.method === 'POST');
  assert.equal(req.body.priceAmount, '3');
  assert.equal(req.body.priceCurrency, 'USDT');
  assert.equal(req.body.callback.callbackUrl, 'https://chat.example/api/pay/xrocket');
  assert.ok(!JSON.stringify(req.body).includes('alice'), 'юзернейм не передаётся платёжному сервису');
  assert.equal((await alice.buyPremium('30d')).id, inv.id, 'неоплаченный счёт выдаётся повторно');

  // Подделки и чужое не засчитываются
  const xinv = x.invoices.get(inv.id);
  assert.equal((await webhook(paidEvent(xinv), { secret: 'чужой' })).status, 401);
  assert.equal((await webhook(paidEvent({ ...xinv, priceAmount: '0.01' }))).status, 200);
  await sleep(100);
  assert.equal(srv.store.premiumUntil('alice'), 0, 'сумма не совпала — не засчитано');

  // Bob добавляет Алису: значок подписки придёт к нему через статус
  await bob.addContact('alice');
  await alice.addContact('bob');
  const gotPremium = waitFor(alice, 'premium', (p) => p.active);
  const seen = waitFor(bob, 'presence', (p) => p.username === 'alice' && p.premium);
  assert.equal((await webhook(paidEvent(xinv, 'evt-1'))).status, 200);
  await gotPremium;
  await seen;
  assert.ok(alice.isPremium());
  const until = srv.store.premiumUntil('alice');
  assert.ok(Math.abs(until - (Date.now() + 30 * 86400_000)) < 60_000);

  // Повтор того же уведомления не продлевает второй раз
  assert.equal((await webhook(paidEvent(xinv, 'evt-1'))).status, 200);
  await sleep(100);
  assert.equal(srv.store.premiumUntil('alice'), until);
  assert.equal(srv.store.getPayment(inv.id).status, 'paid');

  // Фото уходит собеседнику в зашифрованном профиле
  await alice.setProfile({ avatar: avatar() });
  assert.equal(alice.avatarOf('alice'), avatar());
  const got = incoming(bob, 'смотри, фото');
  await alice.sendText('bob', 'смотри, фото');
  await got;
  await sleep(100);
  assert.equal((await bob.profileOf('alice')).avatar, avatar());
  assert.equal(bob.avatarOf('alice'), avatar());
  const db = ['', '-wal'].map((s) => srv.store.file + s).filter((f) => fs.existsSync(f)).map((f) => fs.readFileSync(f).toString('latin1')).join('');
  assert.ok(!db.includes(Buffer.alloc(300, 7).toString('base64')), 'сервер фото не видит');
});

test('подписка: сверка без вебхука, отключение администратором, удаление фото', async (t) => {
  const { srv, x, mk, adminApi } = await setup(t);
  const alice = mk();
  const bob = mk();
  await alice.register('alice');
  await bob.register('bob');
  await bob.addContact('alice');

  // Вебхук потерялся: оплату находит «Проверить оплату»
  const inv = await alice.buyPremium('365d');
  assert.equal((await alice.checkPremium()).active, false);
  x.invoices.get(inv.id).status = 'paid';
  assert.equal((await alice.checkPremium()).active, true);
  assert.ok(srv.store.premiumUntil('alice') > Date.now() + 364 * 86400_000);

  // Фото ставится и доходит
  await alice.addContact('bob');
  await alice.setProfile({ name: 'Алиса', avatar: avatar(500) });
  const got = incoming(bob, 'привет');
  await alice.sendText('bob', 'привет');
  await got;
  await sleep(100);
  await bob._subscribePresence();
  assert.equal(bob.avatarOf('alice'), avatar(500));

  // Администратор отключает подписку: у Боба фото пропадает, имя остаётся
  const lost = waitFor(bob, 'presence', (p) => p.username === 'alice' && !p.premium);
  const ownLost = waitFor(alice, 'premium', (p) => !p.active);
  assert.equal((await adminApi('premium', { name: 'alice', days: 0 })).status, 200);
  await lost;
  await ownLost;
  assert.equal(bob.avatarOf('alice'), null);
  assert.equal(bob.nameOf('alice'), 'Алиса');
  assert.equal(alice.avatarOf('alice'), null);
  // Новое фото без подписки не поставить, убрать старое — можно
  await assert.rejects(alice.setProfile({ avatar: avatar(600) }), (e) => e.code === 'premium_required');
  await alice.setProfile({ avatar: null });
  assert.equal(alice.profile.avatar, undefined);

  // Подарок от администратора: продлить на 7 дней
  const back = waitFor(alice, 'premium', (p) => p.active);
  assert.equal((await adminApi('premium', { name: 'alice', days: 7 })).status, 200);
  await back;
  assert.equal((await adminApi('premium', { name: 'alice', days: -1 })).status, 400);
  assert.equal((await adminApi('premium', { name: 'nobody', days: 7 })).status, 400);
});

test('подписка выключена: сервер без токена xRocket', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tainik-premium-off-'));
  const srv = await startServer({ port: 0, host: '127.0.0.1', dataDir, log: false });
  const c = new MessengerClient({ url: `ws://127.0.0.1:${srv.port}/ws`, storage: new MemoryStorage() });
  t.after(async () => {
    c.disconnect();
    await srv.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  await c.register('carol');
  assert.equal(c.billing, null);
  await assert.rejects(c.buyPremium('30d'), (e) => e.code === 'billing_disabled');
  assert.equal((await c.checkPremium()).active, false);
  assert.equal((await fetch(`http://127.0.0.1:${srv.port}${WEBHOOK_PATH}`, { method: 'POST', body: '{}' })).status, 405, 'вебхука нет');
});

test('фото, потерянное старой версией приложения, приходит снова по запросу', async (t) => {
  const { x, mk } = await setup(t);
  const alice = mk();
  const bob = mk();
  await alice.register('alice');
  await bob.register('bob');
  await alice.addContact('bob');
  await bob.addContact('alice');
  const inv = await alice.buyPremium('30d');
  x.invoices.get(inv.id).status = 'paid';
  await alice.checkPremium();
  await alice.setProfile({ name: 'Алиса', avatar: avatar(14_800) }); // фото почти предельного размера
  const got = incoming(bob, 'привет');
  await alice.sendText('bob', 'привет');
  await got;
  await sleep(100);
  assert.equal((await bob.profileOf('alice')).avatar, avatar(14_800));

  // Старая версия Боба (до 0.20) сохранила профиль без фото — та же версия профиля
  const all = await bob.contacts();
  delete all.alice.profile.avatar;
  await bob.storage.set('contacts', all);
  bob._indexNames(all);
  assert.equal(bob.avatarOf('alice'), null);

  // Обновлённый Боб видит подписку Алисы и просит профиль заново — фото возвращается
  const back = waitFor(bob, 'profile-changed', (d) => d.username === 'alice' && d.profile.avatar);
  await bob._subscribePresence();
  await back;
  assert.equal(bob.avatarOf('alice'), avatar(14_800));
  assert.equal(bob.nameOf('alice'), 'Алиса');
  // Повторно не просит, если фото уже есть
  const before = ((await bob.storage.get('outbox')) || []).length;
  await bob._subscribePresence();
  await sleep(200);
  assert.ok(!((await bob.storage.get('outbox')) || []).slice(before).some((i) => i.content?.t === 'profile-req'));
});

test('версия приложения видна в списке устройств и в панели', async (t) => {
  const { mk, srv } = await setup(t);
  const a = new MessengerClient({ url: `ws://127.0.0.1:${srv.port}/ws`, storage: new MemoryStorage(), appVersion: '0.21.0' });
  const b = new MessengerClient({ url: `ws://127.0.0.1:${srv.port}/ws`, storage: new MemoryStorage(), appVersion: '<script>' });
  t.after(() => (a.disconnect(), b.disconnect()));
  await a.register('dora');
  await b.register('erin');
  assert.equal((await a.listDevices())[0].appVersion, '0.21.0');
  assert.equal((await b.listDevices())[0].appVersion, null, 'мусор вместо версии не сохраняется');
  void mk;
});

test('подписка: оплата в TRX и Gram по курсу xRocket', async (t) => {
  const { srv, x, mk, webhook, paidEvent } = await setup(t);
  const alice = mk();
  await alice.register('alice');
  await sleep(100); // список валют xRocket сверяется при запуске
  await alice.disconnect();
  await alice.connect();
  assert.deepEqual(alice.billing.currencies, ['USDT', 'GRAM', 'TRX', 'TONCOIN'], 'TON → код xRocket TONCOIN; неизвестной валюты нет');

  await assert.rejects(alice.buyPremium('30d', 'NOPE'), (e) => e.code === 'bad_currency');
  // xRocket отказал — причина доходит до пользователя
  await assert.rejects(alice.buyPremium('30d', 'TONCOIN'), (e) => e.code === 'billing_failed' && /Minimum invoice amount is 5 TONCOIN/.test(e.data.detail));
  const trx = await alice.buyPremium('30d', 'trx');
  assert.equal(trx.currency, 'TRX');
  assert.equal(trx.price, '10'); // 3 USDT / 0.3
  const body = x.calls.filter((c) => c.method === 'POST').pop().body;
  assert.equal(body.priceCurrency, 'TRX');
  assert.equal(body.priceAmount, '10');
  const gram = await alice.buyPremium('30d', 'GRAM');
  assert.equal(gram.price, '1428.58');
  assert.notEqual(gram.id, trx.id, 'счёт в другой валюте — отдельный');
  assert.equal((await alice.buyPremium('30d', 'TRX')).id, trx.id);

  // Оплачен счёт в TRX: сумма сверяется в TRX, в USDT не засчитывается
  const inv = x.invoices.get(trx.id);
  await webhook(paidEvent({ ...inv, priceCurrency: 'USDT', priceAmount: '3' }));
  await sleep(100);
  assert.equal(srv.store.premiumUntil('alice'), 0);
  const on = waitFor(alice, 'premium', (p) => p.active);
  await webhook(paidEvent(inv));
  await on;
});

test('подписка в подарок: платит один, получает другой; отметка в чате у обоих', async (t) => {
  const { srv, x, mk, webhook, paidEvent } = await setup(t);
  const [alice, bob, carol] = [mk(), mk(), mk()];
  await alice.register('alice');
  await bob.register('bob');
  await carol.register('carol');

  // Проверки получателя
  await assert.rejects(alice.buyPremium('30d', 'USDT', 'nobody_here'), (e) => e.code === 'gift_unknown_user');
  await carol.setBlocked('alice', true);
  await assert.rejects(alice.buyPremium('30d', 'USDT', 'carol'), (e) => e.code === 'gift_unavailable');
  // Себе через «подарок» — обычная покупка
  assert.equal((await alice.buyPremium('30d', 'USDT', '@Alice')).giftTo, null);

  // Bob у Алисы в контактах нет — подарить всё равно можно
  const inv = await alice.buyPremium('30d', 'USDT', '@Bob');
  assert.equal(inv.giftTo, 'bob');
  assert.notEqual(inv.id, (await alice.buyPremium('30d')).id, 'счёт себе и подарок — разные');
  assert.equal((await alice.buyPremium('30d', 'USDT', 'bob')).id, inv.id, 'неоплаченный подарок выдаётся повторно');
  const req = x.calls.filter((c) => c.method === 'POST').find((c) => c.body.clientInvoiceId === inv.id);
  assert.match(req.body.description, /подарок/);
  assert.ok(!JSON.stringify(req.body).includes('bob') && !JSON.stringify(req.body).includes('alice'), 'юзернеймы не уходят в xRocket');

  const bobGift = waitFor(bob, 'gift');
  const bobPremium = waitFor(bob, 'premium', (p) => p.active);
  const aliceGift = waitFor(alice, 'gift');
  assert.equal((await webhook(paidEvent(x.invoices.get(inv.id)))).status, 200);
  const [g] = await Promise.all([bobGift, bobPremium, aliceGift]);
  assert.deepEqual([g.from, g.to, g.days], ['alice', 'bob', 30]);
  assert.ok(bob.isPremium());
  assert.equal(srv.store.premiumUntil('alice'), 0, 'дарителю подписка не добавилась');

  // Отметка в чате: у получателя чат с дарителем появляется сам
  const bobChat = (await bob.messages('alice')).filter((m) => m.content?.t === 'gift');
  assert.equal(bobChat.length, 1);
  assert.ok(!(await bob.contacts()).alice.hidden);
  assert.equal((await bob.contacts()).alice.unread, 1);
  assert.equal((await alice.messages('bob')).filter((m) => m.content?.t === 'gift').length, 1);

  // Новое устройство получателя узнаёт о подарке при входе; повторно отметка не появляется
  let gotCode;
  const codeP = new Promise((r) => (gotCode = r));
  const bob2 = mk();
  const { done } = bob2.linkAsNewDevice({ deviceName: 'Второе', onCode: ({ code }) => gotCode(code) });
  const b2Gift = waitFor(bob2, 'gift');
  await bob.linkDevice(await codeP);
  await done;
  assert.equal((await b2Gift).id, inv.id);
  bob.disconnect();
  bob.connect();
  await sleep(500);
  assert.equal((await bob.messages('alice')).filter((m) => m.content?.t === 'gift').length, 1);
});

test('монеты: покупка пакета, Премиум за монеты себе и в подарок, начисление администратором', async (t) => {
  const { srv, x, mk, webhook, paidEvent, adminApi } = await setup(t);
  const [alice, bob] = [mk(), mk()];
  await alice.register('alice');
  await bob.register('bob');
  assert.equal(alice.coins, 0);
  assert.deepEqual(alice.billing.packs.map((p) => p.id), ['100c', '550c', '1200c']);
  assert.deepEqual(alice.billing.plans.map((p) => p.coins), [300, 3050]);

  // Пакет монет — счёт в xRocket, монеты не дарятся
  await assert.rejects(alice.buyPremium('550c', 'USDT', 'bob'), (e) => e.code === 'bad_plan');
  const inv = await alice.buyCoins('550c');
  assert.equal(inv.coins, 550);
  assert.equal(inv.price, '5');
  const req = x.calls.filter((c) => c.method === 'POST').find((c) => c.body.clientInvoiceId === inv.id);
  assert.match(req.body.description, /550 монет/);
  const got = waitFor(alice, 'coins', (n) => n === 550);
  assert.equal((await webhook(paidEvent(x.invoices.get(inv.id), 'evt-c'))).status, 200);
  await got;
  assert.equal((await webhook(paidEvent(x.invoices.get(inv.id), 'evt-c'))).status, 200);
  await sleep(100);
  assert.equal(srv.store.coinsOf('alice'), 550, 'повтор уведомления не начисляет второй раз');
  assert.equal(srv.store.premiumUntil('alice'), 0, 'пакет монет — не подписка');

  // Премиум за монеты себе
  await assert.rejects(alice.premiumForCoins('30d', 1), (e) => e.code === 'price_changed');
  const prem = waitFor(alice, 'premium', (p) => p.active);
  const r = await alice.premiumForCoins('30d', 300);
  await prem;
  assert.equal(r.coins, 250);
  assert.equal(alice.coins, 250);
  assert.equal(r.gift, null);

  // Не хватает — ничего не списывается
  await assert.rejects(alice.premiumForCoins('365d', 3050), (e) => e.code === 'not_enough_coins');
  assert.equal(srv.store.coinsOf('alice'), 250);

  // В подарок за монеты
  const bobGift = waitFor(bob, 'gift');
  const bobPrem = waitFor(bob, 'premium', (p) => p.active);
  const topped = waitFor(alice, 'coins', (n) => n === 350);
  await (await adminApi('coins', { name: 'alice', delta: 100 })).json();
  await topped;
  const g = await alice.premiumForCoins('30d', 300, 'bob');
  assert.equal(g.coins, 50);
  const [gift] = await Promise.all([bobGift, bobPrem]);
  assert.deepEqual([gift.from, gift.to, gift.days], ['alice', 'bob', 30]);
  assert.equal((await bob.messages('alice')).filter((m) => m.content?.t === 'gift').length, 1);

  // Администратор не уводит баланс в минус
  const bad = await adminApi('coins', { name: 'alice', delta: -1000 });
  assert.equal(bad.status, 400);
  assert.equal(srv.store.coinsOf('alice'), 50);
  assert.deepEqual(srv.store.coinLog('alice').map((l) => l.delta), [-300, 100, -300, 550]);
});

test('фото профиля: большое для просмотра идёт рядом с маленьким, хранится отдельно', async (t) => {
  const { srv, mk } = await setup(t);
  const [alice, bob] = [mk(), mk()];
  await alice.register('alice');
  await bob.register('bob');
  srv.store.extendPremium('alice', 30);
  await alice.checkPremium();
  await alice.addContact('bob');
  await bob.addContact('alice');
  const big = 'data:image/jpeg;base64,' + Buffer.alloc(60_000, 9).toString('base64'); // ~80 КБ
  await assert.rejects(alice.setProfile({ avatar: avatar(), photo: 'data:image/jpeg;base64,' + 'A'.repeat(200_000) }), (e) => e.code === 'too_large');
  const changed = waitFor(bob, 'profile-changed', (d) => d.username === 'alice' && d.profile.avatar);
  await alice.setProfile({ avatar: avatar(), photo: big });
  const got = incoming(bob, 'привет');
  await alice.sendText('bob', 'привет');
  await got;
  await changed;
  assert.equal(await bob.photoOf('alice'), big, 'большое фото дошло (конверт больше 64 КБ)');
  assert.equal(bob.avatarOf('alice'), avatar());
  assert.ok(!('photo' in (await bob.contacts()).alice.profile), 'в контактах — только маленькое');
  assert.equal(await alice.photoOf('alice'), big);
  // Очередь хранит ссылку на профиль, а не сам профиль с фото
  assert.ok(!JSON.stringify((await alice.storage.get('outbox')) || []).includes(big.slice(30, 80)));

  // Сменили фото без большого — у собеседника большое пропадает, показывается маленькое
  const small2 = avatar(400);
  const changed2 = waitFor(bob, 'profile-changed', (d) => d.username === 'alice' && d.profile.avatar === small2);
  await alice.setProfile({ avatar: small2 });
  await changed2;
  assert.equal(await bob.photoOf('alice'), small2);
});

test('служебный чат «Тайник»: монеты, Премиум, подарок, галочка, сообщения администратора', async (t) => {
  const { srv, x, mk, webhook, paidEvent, adminApi } = await setup(t);
  const [alice, bob] = [mk(), mk()];
  const notices = async (c) => (await c.messages(SYSTEM_CHAT)).map((m) => m.content);
  const notice = (c, kind, pred = () => true) =>
    waitFor(c, 'message', (d) => d.contact === SYSTEM_CHAT && d.message.content.kind === kind && pred(d.message.content));

  const welcome = notice(alice, 'welcome');
  await alice.register('alice');
  await welcome;
  await bob.register('bob');
  const sys = (await alice.contacts())[SYSTEM_CHAT];
  assert.equal(sys.system, true);
  assert.equal(sys.unread, 1, 'приветствие — непрочитанное');
  assert.equal(alice.nameOf(SYSTEM_CHAT), 'Тайник');
  assert.equal(alice.isVerified(SYSTEM_CHAT), true);
  await assert.rejects(alice.sendText(SYSTEM_CHAT, 'привет'));

  // Покупка монет
  const inv = await alice.buyCoins('550c');
  const bought = notice(alice, 'coins-buy');
  await webhook(paidEvent(x.invoices.get(inv.id), 'evt-n'));
  const cb = (await bought).message?.content ?? (await notices(alice)).find((n) => n.kind === 'coins-buy');
  assert.equal(cb.amount, 550);
  assert.equal(cb.balance, 550);

  // Премиум за монеты себе и в подарок
  const own = notice(alice, 'premium');
  await alice.premiumForCoins('30d', 300);
  await own;
  const toBob = notice(bob, 'premium-gift', (c) => c.from === 'alice');
  const sent = notice(alice, 'gift-sent', (c) => c.to === 'bob');
  await adminApi('coins', { name: 'alice', delta: 100 });
  await alice.premiumForCoins('30d', 300, 'bob');
  await Promise.all([toBob, sent]);

  // Администратор: галочка, монеты, сообщение одному и всем
  const ver = notice(bob, 'verified', (c) => c.on);
  await adminApi('verify', { name: 'bob', verified: true });
  await ver;
  const one = notice(bob, 'admin', (c) => c.body === 'Лично для bob https://a.com');
  assert.equal((await adminApi('notice', { name: 'bob', text: 'Лично для bob https://a.com' })).status, 200);
  await one;
  assert.equal((await adminApi('notice', { name: 'bob', text: '   ' })).status, 400);
  assert.equal((await adminApi('notice', { name: 'nobody_here', text: 'x' })).status, 400);
  const allA = notice(alice, 'admin', (c) => c.body === 'Всем привет');
  const allB = notice(bob, 'admin', (c) => c.body === 'Всем привет');
  await adminApi('notice', { name: '', text: 'Всем привет' });
  await Promise.all([allA, allB]);

  assert.deepEqual(
    (await notices(alice)).map((n) => n.kind),
    ['welcome', 'coins-buy', 'premium', 'coins-admin', 'gift-sent', 'admin']
  );
  assert.deepEqual((await notices(alice)).find((n) => n.kind === 'gift-sent'), { t: 'notice', kind: 'gift-sent', to: 'bob', days: 30, cost: 300 });
  assert.equal((await notices(bob)).filter((n) => n.kind === 'admin').length, 2);
  assert.equal((await notices(alice)).filter((n) => n.kind === 'admin').length, 1, 'личное сообщение bob не видно alice');

  // Повторный вход не дублирует уведомления
  alice.disconnect();
  await alice.connect();
  await sleep(300);
  assert.equal((await notices(alice)).length, 6);

  // Кто зарегистрировался позже, не получает старые общие сообщения
  const carol = mk();
  const carolWelcome = notice(carol, 'welcome');
  await carol.register('carol');
  await carolWelcome;
  await sleep(300);
  assert.deepEqual((await notices(carol)).map((n) => n.kind), ['welcome']);
  assert.ok(srv.store.noticesOf('carol').length === 1);

  // Чужие поля и неизвестные виды отбрасываются
  assert.equal(cleanNotice({ id: 1, kind: 'hack', data: {} }), null);
  assert.equal(cleanNotice({ id: 2, kind: 'premium-gift', data: { from: '<b>', days: 30 } }), null);
  assert.deepEqual(cleanNotice({ id: 3, kind: 'verified', data: { on: true, extra: 1 } }), { t: 'notice', kind: 'verified', on: true });
});

async function until(fn, ms = 8000) {
  const end = Date.now() + ms;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > end) throw new Error('timeout');
    await sleep(50);
  }
}

async function linkDevice(newClient, existing) {
  let gotCode;
  const codeP = new Promise((r) => (gotCode = r));
  const { done } = newClient.linkAsNewDevice({ deviceName: 'Телефон', onCode: ({ code }) => gotCode(code) });
  await existing.linkDevice(await codeP);
  return done;
}

test('синхронизация уведомлений между устройствами: «прочитано» и чат «Тайник»', async (t) => {
  const { mk, adminApi } = await setup(t);
  const [alice, bob] = [mk(), mk()];
  await alice.register('alice');
  await bob.register('bob');
  // Приветствие у нового аккаунта — непрочитанное
  await until(async () => (await alice.contacts())[SYSTEM_CHAT]?.unread === 1);
  await alice.markRead(SYSTEM_CHAT);

  // Второе устройство: старое в «Тайнике» (в том числе «вход с нового устройства» о нём самом) — прочитано и тихо
  const alice2 = mk();
  const loud = [];
  alice2.on('message', (d) => d.contact === SYSTEM_CHAT && !d.quiet && loud.push(d.message.content.kind));
  const devNotice = waitFor(alice, 'message', (d) => d.contact === SYSTEM_CHAT && d.message.content.kind === 'device');
  await linkDevice(alice2, alice);
  await devNotice;
  await until(async () => (await alice2.messages(SYSTEM_CHAT)).length === 2);
  assert.deepEqual((await alice2.messages(SYSTEM_CHAT)).map((m) => m.content.kind), ['welcome', 'device']);
  assert.equal((await alice2.contacts())[SYSTEM_CHAT].unread, 0);
  assert.deepEqual(loud, [], 'без всплывающих уведомлений');
  // А первое устройство о входе узнало
  await until(async () => (await alice.contacts())[SYSTEM_CHAT].unread === 1);

  // Сообщение приходит на оба устройства; прочитали на одном — на другом счётчик (и уведомление) снимаются
  await bob.addContact('alice');
  const on1 = incoming(alice, 'привет');
  const on2 = incoming(alice2, 'привет');
  await bob.sendText('alice', 'привет');
  await Promise.all([on1, on2]);
  assert.equal((await alice2.contacts()).bob.unread, 1);
  const cleared = waitFor(alice2, 'read-sync', (d) => d.contact === 'bob' && d.unread === 0);
  await alice.markRead('bob');
  await cleared;
  assert.equal((await alice2.contacts()).bob.unread, 0);

  // Уведомление «Тайника» — на оба устройства, прочитано на втором — снимается на первом
  const n1 = waitFor(alice, 'message', (d) => d.contact === SYSTEM_CHAT && d.message.content.body === 'новость');
  const n2 = waitFor(alice2, 'message', (d) => d.contact === SYSTEM_CHAT && d.message.content.body === 'новость' && !d.quiet);
  await adminApi('notice', { name: 'alice', text: 'новость' });
  const [m1, m2] = await Promise.all([n1, n2]);
  assert.equal(m1.message.ts, m2.message.ts, 'время уведомления одинаковое на всех устройствах');
  const sysCleared = waitFor(alice, 'read-sync', (d) => d.contact === SYSTEM_CHAT && d.unread === 0);
  await alice2.markRead(SYSTEM_CHAT);
  await sysCleared;

  // Устройство было не в сети: уведомление и «прочитано» придут при входе, счётчик — 0
  alice2.disconnect();
  const onFirst = waitFor(alice, 'message', (d) => d.contact === SYSTEM_CHAT && d.message.content.body === 'пока офлайн');
  await adminApi('notice', { name: 'alice', text: 'пока офлайн' });
  await onFirst;
  await alice.markRead(SYSTEM_CHAT);
  const back = waitFor(alice2, 'read-sync', (d) => d.contact === SYSTEM_CHAT && d.unread === 0);
  await alice2.connect();
  await back;
  assert.equal((await alice2.messages(SYSTEM_CHAT)).at(-1).content.body, 'пока офлайн');
  assert.equal((await alice2.contacts())[SYSTEM_CHAT].unread, 0);
});
