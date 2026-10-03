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
  assert.deepEqual(o.totals, { users: 2, online: 2, devices: 2, connections: 2, queued: 0, media: { n: 0, bytes: 0 } });
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

const waitFor = (emitter, event, pred = () => true, ms = 8000) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => (off(), reject(new Error('timeout: ' + event))), ms);
    const off = emitter.on(event, (d) => pred(d) && (clearTimeout(t), off(), resolve(d)));
  });

test('панель администратора: последний IP, удаление аккаунта, блокировка IP', async (t) => {
  const { base, mk, srv } = await setup(t);
  const alice = mk();
  const bob = mk();
  await alice.register('alice');
  await bob.register('bob');
  const session = (await login(base, PASSWORD)).headers.get('set-cookie').split(';')[0];
  const api = (name, body, headers = { 'X-Tainik-Admin': '1' }) =>
    fetch(`${base}/adminadminadmin/api/${name}`, {
      method: 'POST',
      headers: { Cookie: session, 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
  const overview = async () => (await fetch(`${base}/adminadminadmin/api/overview`, { headers: { Cookie: session } })).json();

  // Последний IP сохраняется и после отключения; пользователь видит IP своих устройств
  const devs = await alice.listDevices();
  assert.equal(devs[0].ip, '127.0.0.1');
  assert.equal(srv.store.listDevices('alice')[0].lastIp, '127.0.0.1');
  const o = await overview();
  assert.equal(o.users.find((u) => u.name === 'alice').devices[0].lastIp, '127.0.0.1');

  // Без своего заголовка (как у формы с чужого сайта) действие не выполняется
  assert.equal((await api('delete-user', { name: 'bob' }, {})).status, 403);
  assert.equal((await fetch(`${base}/adminadminadmin/api/ban`, { method: 'POST', headers: { 'X-Tainik-Admin': '1', 'Content-Type': 'application/json' }, body: '{"ip":"1.2.3.4"}' })).status, 401, 'без сессии нельзя');
  assert.ok(srv.store.getUser('bob'));

  // Удаление аккаунта: устройство получает сигнал, данные на сервере удалены, войти нельзя
  const gone = waitFor(bob, 'error', (e) => e.code === 'account_deleted');
  let r = await api('delete-user', { name: 'bob' });
  assert.equal(r.status, 200);
  await gone;
  assert.equal(srv.store.getUser('bob'), null);
  assert.equal(srv.store.listDevices('bob').length, 0);
  assert.equal((await api('delete-user', { name: 'bob' })).status, 400);
  const bob2 = mk();
  bob2.account = bob.account; // то же устройство после перезапуска
  await assert.rejects(bob2.connect({ timeout: 5000 }), (e) => e.code === 'account_deleted');
  const newBob = mk();
  await newBob.register('bob'); // имя освободилось

  // Блокировка IP: текущие подключения обрываются, сайт и WebSocket закрыты, панель доступна
  assert.equal((await api('ban', { ip: 'не адрес' })).status, 400);
  const kicked = waitFor(alice, 'error', (e) => e.code === 'ip_banned');
  r = await api('ban', { ip: '::ffff:127.0.0.1', note: 'спам' });
  assert.equal(r.status, 200);
  await kicked;
  assert.deepEqual((await overview()).bans.map((b) => [b.ip, b.note]), [['127.0.0.1', 'спам']]);
  assert.equal((await fetch(`${base}/`)).status, 403);
  const blocked = mk();
  blocked.account = alice.account;
  await assert.rejects(blocked.connect({ timeout: 3000 }));
  assert.equal(srv.store.listBans().length, 1, 'блокировка хранится в базе');

  r = await api('unban', { ip: '127.0.0.1' });
  assert.equal(r.status, 200);
  assert.equal((await fetch(`${base}/`)).status, 200);
  const again = mk();
  again.account = alice.account;
  await again.connect({ timeout: 5000 });
  assert.equal(again.status, 'online');
});

test('официальная галочка: у admin по умолчанию, ставится и снимается в панели', async (t) => {
  const { base, mk, srv } = await setup(t);
  const admin = mk();
  const alice = mk();
  const bob = mk();
  await admin.register('admin');
  await alice.register('alice');
  await bob.register('bob');
  assert.equal(admin.verified, true, 'admin получает галочку при регистрации');
  assert.equal(alice.verified, false);

  // Собеседник видит галочку admin, даже если тот скрыл статус «в сети»
  await admin.setPresenceVisible(false);
  await bob.addContact('admin');
  await bob.addContact('alice');
  await sleep(200);
  assert.equal(bob.isVerified('admin'), true);
  assert.equal(bob.isVerified('alice'), false);

  const session = (await login(base, PASSWORD)).headers.get('set-cookie').split(';')[0];
  const api = (name, body) =>
    fetch(`${base}/adminadminadmin/api/${name}`, {
      method: 'POST',
      headers: { Cookie: session, 'Content-Type': 'application/json', 'X-Tainik-Admin': '1' },
      body: JSON.stringify(body),
    });
  const overview = async () => (await fetch(`${base}/adminadminadmin/api/overview`, { headers: { Cookie: session } })).json();
  assert.deepEqual((await overview()).users.filter((u) => u.verified).map((u) => u.name), ['admin']);

  // Поставить: собеседник и сама alice узнают сразу
  const seen = waitFor(bob, 'presence', (p) => p.username === 'alice' && p.verified);
  const own = waitFor(alice, 'verified', (v) => v === true);
  assert.equal((await api('verify', { name: 'alice', verified: true })).status, 200);
  await Promise.all([seen, own]);
  assert.equal(bob.isVerified('alice'), true);
  assert.equal(alice.verified, true);

  // Снять
  const gone = waitFor(bob, 'presence', (p) => p.username === 'alice' && !p.verified);
  assert.equal((await api('verify', { name: 'alice', verified: false })).status, 200);
  await gone;
  assert.equal(bob.isVerified('alice'), false);
  assert.equal(srv.store.getPresence('alice').verified, false);

  // Только true ставит галочку; неизвестный пользователь — ошибка
  assert.equal((await api('verify', { name: 'alice', verified: 'yes' })).status, 200);
  assert.equal(srv.store.getPresence('alice').verified, false);
  assert.equal((await api('verify', { name: 'nobody', verified: true })).status, 400);

  // После переподключения своя галочка приходит в ready
  admin.disconnect();
  const again = mk();
  again.account = admin.account;
  await again.connect({ timeout: 5000 });
  assert.equal(again.verified, true);
});

test('официальная галочка: старая база получает галочку у admin при обновлении', async (t) => {
  const { DatabaseSync } = await import('node:sqlite');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tainik-mig-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  // База версии без колонки verified
  const db = new DatabaseSync(path.join(dataDir, 'tainik.db'));
  db.exec(`CREATE TABLE users (name TEXT PRIMARY KEY, identity_dh TEXT NOT NULL, identity_sign TEXT NOT NULL, next_device_id INTEGER NOT NULL, created_at INTEGER NOT NULL, presence_hidden INTEGER NOT NULL DEFAULT 0);
    INSERT INTO users VALUES ('admin', 'x', 'y', 2, 1, 0), ('alice', 'x', 'y', 2, 1, 0);`);
  db.close();
  const { Store } = await import('../server/store.js');
  const store = new Store(dataDir);
  t.after(() => store.close());
  assert.equal(store.getPresence('admin').verified, true);
  assert.equal(store.getPresence('alice').verified, false);
});
