// Подписка «Тайник Премиум»: счета xRocket Pay, вебхук с подписью, сверка, фото профиля.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server/server.js';
import { parsePlans, sameAmount, verifyWebhookSignature, signWebhook, WEBHOOK_PATH } from '../server/billing.js';
import { MessengerClient, MemoryStorage, AVATAR_MAX, validAvatar } from '../shared/client-core.js';

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
    billing: { token: TOKEN, webhookSecret: SECRET, plans: parsePlans('30:3, 365:30.5', 'usdt'), publicUrl: 'https://chat.example', fetch: x.fetch },
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
