import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server/server.js';
import { MessengerClient, MemoryStorage } from '../shared/client-core.js';

const PASSWORD = 'очень-длинный-пароль-123';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function setup(t, admin = { password: PASSWORD }) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tainik-admin-'));
  const srv = await startServer({ port: 0, host: '127.0.0.1', dataDir, log: false, admin });
  const base = `http://127.0.0.1:${srv.port}`;
  const clients = [];
  t.after(async () => {
    clients.forEach((c) => c.disconnect());
    await srv.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const mk = () => {
    const c = new MessengerClient({ url: `ws://127.0.0.1:${srv.port}/ws`, storage: new MemoryStorage() });
    clients.push(c);
    return c;
  };
  return { srv, base, mk };
}

const login = (base, password, ip) =>
  fetch(`${base}/adminadminadmin/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(ip ? { 'X-Real-IP': ip } : {}) },
    body: new URLSearchParams({ password }),
  });

test('панель администратора: вход, сессия, пользователи и IP подключений', async (t) => {
  const { base, mk } = await setup(t);
  const alice = mk();
  const bob = mk();
  await alice.register('alice');
  await bob.register('bob');
  await bob.setPresenceVisible(false);

  // Без слэша — перенаправление, без сессии — страница входа, API закрыт
  let r = await fetch(`${base}/adminadminadmin`, { redirect: 'manual' });
  assert.equal(r.status, 303);
  assert.equal(r.headers.get('location'), '/adminadminadmin/');
  r = await fetch(`${base}/adminadminadmin/`);
  assert.equal(r.status, 200);
  assert.match(await r.text(), /name="password"/);
  assert.match(r.headers.get('content-security-policy'), /default-src 'none'/);
  assert.equal((await fetch(`${base}/adminadminadmin/api/overview`)).status, 401);
  assert.equal((await fetch(`${base}/adminadminadmin/admin.js`)).status, 404, 'код панели — только после входа');

  // Неверный пароль
  r = await login(base, 'не тот');
  assert.equal(r.status, 303);
  assert.equal(r.headers.get('location'), '/adminadminadmin/?e=bad');
  assert.equal(r.headers.get('set-cookie'), null);

  // Верный пароль — cookie сессии
  r = await login(base, PASSWORD);
  const cookie = r.headers.get('set-cookie');
  assert.match(cookie, /^tainik_admin=\d+\.[\w-]{43}; Max-Age=43200; Path=\/adminadminadmin; HttpOnly; SameSite=Strict/);
  const session = cookie.split(';')[0];

  r = await fetch(`${base}/adminadminadmin/api/overview`, { headers: { Cookie: session } });
  assert.equal(r.status, 200);
  const o = await r.json();
  assert.deepEqual(o.totals, { users: 2, online: 2, devices: 2, connections: 2, queued: 0 });
  const a = o.users.find((u) => u.name === 'alice');
  const b = o.users.find((u) => u.name === 'bob');
  assert.equal(a.online, true);
  assert.equal(a.devices[0].ip, '127.0.0.1');
  assert.ok(a.devices[0].since <= Date.now());
  assert.equal(b.presenceHidden, true, 'администратор видит и тех, кто скрыл статус');
  assert.equal(b.online, true);
  assert.ok(!JSON.stringify(o).includes('identity'), 'в ответе нет ключей');

  // Подделанная подпись сессии не проходит
  const forged = session.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A'));
  assert.equal((await fetch(`${base}/adminadminadmin/api/overview`, { headers: { Cookie: forged } })).status, 401);
  assert.equal((await fetch(`${base}/adminadminadmin/admin.js`, { headers: { Cookie: session } })).status, 200);

  // Устройство отключилось — IP больше не виден
  bob.disconnect();
  await sleep(200);
  const o2 = await (await fetch(`${base}/adminadminadmin/api/overview`, { headers: { Cookie: session } })).json();
  const b2 = o2.users.find((u) => u.name === 'bob');
  assert.equal(b2.online, false);
  assert.equal(b2.devices[0].ip, null);
  assert.ok(b2.lastSeen > 0);
  assert.equal(o2.totals.online, 1);

  // Выход стирает cookie
  r = await fetch(`${base}/adminadminadmin/logout`, { method: 'POST', redirect: 'manual', headers: { Cookie: session } });
  assert.match(r.headers.get('set-cookie'), /Max-Age=0/);
});

test('панель администратора: лимит попыток входа, выключена без пароля', async (t) => {
  const { base } = await setup(t);
  for (let i = 0; i < 10; i++) await login(base, 'нет');
  const r = await login(base, PASSWORD);
  assert.equal(r.headers.get('location'), '/adminadminadmin/?e=limit', 'после 10 ошибок не пускает даже с верным паролем');
  assert.equal(r.headers.get('set-cookie'), null);

  const off = await setup(t, null);
  assert.equal((await fetch(`${off.base}/adminadminadmin/`)).status, 404);
  const short = await setup(t, { password: 'коротко' });
  assert.equal((await fetch(`${short.base}/adminadminadmin/`)).status, 404);
  const custom = await setup(t, { password: PASSWORD, path: '/my-panel' });
  assert.equal((await fetch(`${custom.base}/my-panel/`)).status, 200);
  assert.equal((await fetch(`${custom.base}/adminadminadmin/`)).status, 404);
});
