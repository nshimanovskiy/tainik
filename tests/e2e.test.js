import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server/server.js';
import { MessengerClient, MemoryStorage } from '../shared/client-core.js';
import { generateIdentity, publicIdentity, createLinkKeys, makeLinkCode, toB64, randomBytes } from '../shared/protocol/index.js';

function waitFor(emitter, event, pred = () => true, ms = 8000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => (off(), reject(new Error('timeout: ' + event))), ms);
    const off = emitter.on(event, (d) => {
      if (pred(d)) {
        clearTimeout(t);
        off();
        resolve(d);
      }
    });
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const incoming = (client, body) => waitFor(client, 'message', (d) => d.message.dir === 'in' && d.message.content.body === body);

async function setup(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tainik-'));
  let srv = await startServer({ port: 0, host: '127.0.0.1', dataDir, log: false });
  const url = `ws://127.0.0.1:${srv.port}/ws`;
  const clients = [];
  const mk = (storage = new MemoryStorage()) => {
    const c = new MessengerClient({ url, storage });
    clients.push(c);
    return c;
  };
  t.after(async () => {
    clients.forEach((c) => c.disconnect());
    await srv.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  return { srv, mk, dataDir };
}

async function link(newClient, existing, deviceName = 'Ноутбук') {
  let gotCode;
  const codeP = new Promise((r) => (gotCode = r));
  const { done } = newClient.linkAsNewDevice({ deviceName, onCode: ({ code }) => gotCode(code) });
  await existing.linkDevice(await codeP);
  return done;
}

test('клиент↔сервер: X3DH офлайн, Double Ratchet, доставка, защита имени', async (t) => {
  const { srv, mk, dataDir } = await setup(t);
  const alice = mk();
  const bobStorage = new MemoryStorage();
  const bob = mk(bobStorage);
  await alice.register('alice');
  await bob.register('bob');
  assert.equal(alice.account.deviceId, 1);
  assert.equal(srv.store.opkCount('bob', 1), 100);
  bob.disconnect(); // Боб офлайн — X3DH работает без его участия

  await alice.addContact('bob');
  const sent = waitFor(alice, 'status-change', (d) => d.status === 'sent');
  await alice.sendText('bob', 'Первое сообщение');
  await alice.sendText('bob', 'Второе: сверхсекретно');
  await sent;
  await sleep(100);
  assert.equal(srv.store.opkCount('bob', 1), 99, 'сервер выдал один одноразовый ключ');
  assert.deepEqual(srv.store.queueFor('bob', 1).map((x) => x.envelope.type), ['prekey', 'prekey']);

  const onDisk = ['tainik.db', 'tainik.db-wal']
    .map((f) => path.join(dataDir, f))
    .filter((f) => fs.existsSync(f))
    .map((f) => fs.readFileSync(f).toString('utf8'))
    .join('');
  assert.ok(onDisk.includes('prekey'), 'база действительно содержит очередь');
  assert.ok(!onDisk.includes('сверхсекретно') && !onDisk.includes('Первое'));

  const bob2 = mk(bobStorage);
  await bob2.load();
  const got = [];
  const done = new Promise((resolve) =>
    bob2.on('message', (d) => {
      got.push(d.message.content.body);
      if (got.length === 2) resolve();
    })
  );
  const delivered = waitFor(alice, 'status-change', (d) => d.status === 'delivered');
  await bob2.connect();
  await done;
  assert.deepEqual(got, ['Первое сообщение', 'Второе: сверхсекретно']);
  await delivered;
  assert.equal(Object.keys((await bobStorage.get('prekeys')).opks).length, 99, 'приватный OPK уничтожен у Боба');

  for (let i = 0; i < 6; i++) {
    const [from, to, name] = i % 2 ? [alice, bob2, 'bob'] : [bob2, alice, 'alice'];
    const p = incoming(to, 'r' + i);
    await from.sendText(name, 'r' + i);
    await p;
  }
  await sleep(150);
  assert.equal(srv.store.queueSize('bob', 1), 0, 'очередь очищена после подтверждения');
  assert.deepEqual((await alice.storage.get('outbox')) || [], []);
  assert.deepEqual(await alice.safetyNumber('bob'), await bob2.safetyNumber('alice'));

  const impostor = mk();
  await assert.rejects(impostor.register('alice'), { code: 'username_taken' });
});

test('несколько устройств: привязка по коду, рассылка, синхронизация, отвязка', async (t) => {
  const { srv, mk } = await setup(t);
  const alice = mk();
  const bob = mk();
  await alice.register('alice', { deviceName: 'Компьютер' });
  await bob.register('bob');
  await alice.addContact('bob');
  await alice.markVerified('bob');

  // Второе устройство Алисы
  const alice2 = mk();
  await link(alice2, alice);
  assert.equal(alice2.account.username, 'alice');
  assert.equal(alice2.account.deviceId, 2);
  assert.deepEqual(alice2.account.pub, alice.account.pub, 'личность общая');
  const c2 = (await alice2.contacts()).bob;
  assert.ok(c2 && c2.verified, 'контакты и отметка «проверен» перенесены');
  const devices = await alice.listDevices();
  assert.deepEqual(devices.map((d) => [d.id, d.name]), [[1, 'Компьютер'], [2, 'Ноутбук']]);

  // Боб пишет — получают оба устройства Алисы
  const p1 = incoming(alice, 'обоим');
  const p2 = incoming(alice2, 'обоим');
  await bob.addContact('alice');
  await bob.sendText('alice', 'обоим');
  await Promise.all([p1, p2]);

  // Алиса пишет со второго устройства — Боб получает, первое устройство видит копию
  const atBob = incoming(bob, 'с ноутбука');
  const syncCopy = waitFor(alice, 'message', (d) => d.message.dir === 'out' && d.message.content.body === 'с ноутбука');
  await alice2.sendText('bob', 'с ноутбука');
  await Promise.all([atBob, syncCopy]);

  // Ответ Боба снова приходит на оба устройства (сессии с каждым устройством)
  const q1 = incoming(alice, 'ответ');
  const q2 = incoming(alice2, 'ответ');
  await bob.sendText('alice', 'ответ');
  await Promise.all([q1, q2]);
  assert.deepEqual((await bob.storage.get('devices:alice')).sort(), [1, 2]);

  // Отвязка: устройство 2 выбрасывается, дальше Боб пишет только первому
  const removed = waitFor(alice2, 'error', (e) => e.code === 'device_removed');
  await alice.unlinkDevice(2);
  await removed;
  const r = incoming(alice, 'после отвязки');
  await bob.sendText('alice', 'после отвязки');
  await r;
  await sleep(100);
  assert.deepEqual(await bob.storage.get('devices:alice'), [1]);
  assert.equal(srv.store.queueSize('alice', 2), 0);
  assert.equal(srv.store.getDevice('alice', 2), null);
});

test('неверный или устаревший код привязки отклоняется', async (t) => {
  const { mk } = await setup(t);
  const alice = mk();
  await alice.register('alice');
  await assert.rejects(alice.linkDevice('ABCD-1234'), { code: 'bad_link_code' });
  await assert.rejects(alice.linkDevice('0'.repeat(64)), { code: 'bad_link_code' }); // нулевой ключ
  const keys = await createLinkKeys();
  await assert.rejects(alice.linkDevice(makeLinkCode(toB64(randomBytes(8)), keys.pub)), { code: 'provision_not_found' });
});

test('подмена ключа сервером обнаруживается, сообщение не уходит', async (t) => {
  const { srv, mk } = await setup(t);
  const alice = mk();
  const bob = mk();
  await alice.register('alice');
  await bob.register('bob');
  await alice.addContact('bob');

  const evil = publicIdentity(await generateIdentity()); // «злой сервер» подменяет ключ
  srv.store.db.prepare('UPDATE users SET identity_dh = ?, identity_sign = ? WHERE name = ?').run(evil.dh, evil.sign, 'bob');
  const warn = waitFor(alice, 'key-changed');
  const failed = waitFor(alice, 'status-change', (d) => d.status === 'failed');
  await alice.sendText('bob', 'не должно уйти');
  await warn;
  await failed;
  assert.equal(srv.store.queueSize('bob', 1), 0, 'ничего не отправлено');
  await assert.rejects(alice.sendText('bob', 'и это'), { code: 'key_changed' });
});

test('одноразовые ключи пополняются автоматически', async (t) => {
  const { srv, mk } = await setup(t);
  const bob = mk();
  await bob.register('bob');
  srv.store.db.prepare('DELETE FROM opks WHERE user = ? AND device = 1 AND id > 5').run('bob'); // ключи почти закончились
  const u = mk();
  await u.register('user0');
  await u.addContact('bob');
  await u.sendText('bob', 'hi');
  await sleep(1500);
  assert.ok(srv.store.opkCount('bob', 1) >= 100, 'клиент Боба догрузил новую партию');
});

test('сервер: данные переживают перезапуск, /healthz отвечает', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tainik-'));
  try {
    let srv = await startServer({ port: 0, host: '127.0.0.1', dataDir, log: false });
    const res = await fetch(`http://127.0.0.1:${srv.port}/healthz`);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).ok, true);

    const mkc = (s, storage = new MemoryStorage()) => new MessengerClient({ url: `ws://127.0.0.1:${s.port}/ws`, storage });
    const aliceStore = new MemoryStorage();
    const bobStore = new MemoryStorage();
    let alice = mkc(srv, aliceStore);
    let bob = mkc(srv, bobStore);
    await alice.register('alice');
    await bob.register('bob');
    bob.disconnect();
    await alice.addContact('bob');
    const sent = waitFor(alice, 'status-change', (d) => d.status === 'sent');
    await alice.sendText('bob', 'переживёт перезапуск');
    await sent;
    alice.disconnect();
    await srv.close();

    // Новый процесс сервера на тех же данных
    srv = await startServer({ port: 0, host: '127.0.0.1', dataDir, log: false });
    assert.equal(srv.store.queueSize('bob', 1), 1);
    bob = mkc(srv, bobStore);
    await bob.load();
    const got = incoming(bob, 'переживёт перезапуск');
    await bob.connect();
    await got;
    alice = mkc(srv, aliceStore);
    await alice.load();
    await alice.connect();
    const back = incoming(alice, 'ответ после перезапуска');
    await bob.sendText('alice', 'ответ после перезапуска');
    await back;
    alice.disconnect();
    bob.disconnect();
    await srv.close();
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('сервер: лимит подключений с одного IP (за прокси — по X-Forwarded-For)', async () => {
  const { default: http } = await import('node:http');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tainik-'));
  const srv = await startServer({ port: 0, host: '127.0.0.1', dataDir, log: false, trustProxy: true, maxConnPerIp: 2 });
  const upgrade = (ip, realIp) =>
    new Promise((resolve) => {
      const req = http.request({
        port: srv.port,
        host: '127.0.0.1',
        path: '/ws',
        headers: {
          Connection: 'Upgrade',
          Upgrade: 'websocket',
          'Sec-WebSocket-Version': '13',
          'Sec-WebSocket-Key': Buffer.from('0123456789abcdef').toString('base64'),
          'X-Forwarded-For': `${ip}, 10.0.0.1`,
          ...(realIp ? { 'X-Real-IP': realIp } : {}),
        },
      });
      let upgraded = false;
      req.on('upgrade', (res, socket, head) => {
        upgraded = true;
        // Сверх лимита сервер открывает соединение, присылает причину и закрывает его
        let text = head ? head.toString('latin1') : '';
        socket.on('data', (d) => (text += d.toString('latin1')));
        setTimeout(() => resolve({ status: 101, socket, refused: text.includes('too_many_connections') }), 300);
      });
      req.on('response', (res) => resolve({ status: res.statusCode }));
      req.on('error', () => resolve({ status: 'error' }));
      req.on('close', () => !upgraded && resolve({ status: 'closed' }));
      setTimeout(() => resolve({ status: 'timeout' }), 3000);
      req.end();
    });
  try {
    const a = await upgrade('203.0.113.5');
    const b = await upgrade('203.0.113.5');
    const c = await upgrade('203.0.113.5');
    const other = await upgrade('198.51.100.7');
    // nginx: X-Real-IP важнее поддельного X-Forwarded-For от клиента
    const viaNginx = await upgrade('198.51.100.99', '203.0.113.5');
    assert.deepEqual([a, b, c, other, viaNginx].map((x) => x.refused), [false, false, true, false, true]);
    for (const x of [a, b, c, other, viaNginx]) x.socket?.destroy();
  } finally {
    await srv.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('звонки: эфемерная сигнализация, все устройства, без очереди, TURN-учётки', async () => {
  const { createHmac } = await import('node:crypto');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tainik-'));
  const srv = await startServer({
    port: 0,
    host: '127.0.0.1',
    dataDir,
    log: false,
    turn: { secret: 's3cret', host: 'turn.example.com' },
  });
  const url = `ws://127.0.0.1:${srv.port}/ws`;
  const clients = [];
  const mk = (storage = new MemoryStorage()) => {
    const c = new MessengerClient({ url, storage });
    clients.push(c);
    return c;
  };
  try {
    const alice = mk();
    const bob1 = mk();
    await alice.register('alice');
    await bob1.register('bob');
    const bob2 = mk();
    await link(bob2, bob1);
    const bob3 = mk();
    await link(bob3, bob1);
    bob3.disconnect(); // третье устройство Боба офлайн

    await alice.addContact('bob');
    const ring1 = waitFor(bob1, 'call-signal');
    const ring2 = waitFor(bob2, 'call-signal');
    // Алиса ещё не знает устройств Боба — сервер подскажет, клиент дошлёт сам
    const delivered = await alice.sendEphemeral('bob', { t: 'call', kind: 'offer', callId: 'c1', ts: Date.now() });
    assert.deepEqual(delivered.sort(), [1, 2], 'доставлено только устройствам в сети');
    const [s1, s2] = await Promise.all([ring1, ring2]);
    assert.equal(s1.data.kind, 'offer');
    assert.equal(s1.from, 'alice');
    assert.equal(s2.fromDevice, 1);
    assert.equal(srv.store.queueSize('bob', 3), 0, 'офлайн-устройству ничего не поставлено в очередь');

    // Ответ — только конкретному устройству звонящего
    const ans = waitFor(alice, 'call-signal');
    const d2 = await bob2.sendEphemeral('alice', { t: 'call', kind: 'answer', callId: 'c1', ts: Date.now() }, { deviceIds: [s2.fromDevice] });
    assert.deepEqual(d2, [1]);
    const a = await ans;
    assert.equal(a.data.kind, 'answer');
    assert.equal(a.fromDevice, 2);

    // Сигнализация не попадает в историю чата, обычные сообщения после неё работают
    assert.equal((await bob1.messages('alice')).length, 0);
    const p = incoming(bob2, 'текст после звонка');
    await alice.sendText('bob', 'текст после звонка');
    await p;

    // Устаревший сигнал (старше 2 минут) отбрасывается
    let stale = false;
    const off = bob1.on('call-signal', () => (stale = true));
    await alice.sendEphemeral('bob', { t: 'call', kind: 'offer', callId: 'old', ts: Date.now() - 300_000 });
    await sleep(300);
    off();
    assert.equal(stale, false);

    // ICE: временные учётные данные TURN по схеме coturn use-auth-secret
    const ice = await alice.getIceServers();
    const turnEntry = ice.find((x) => x.username);
    assert.ok(turnEntry.urls.some((u) => u.startsWith('turn:turn.example.com:3478')));
    assert.ok(turnEntry.urls.some((u) => u.startsWith('turns:turn.example.com:5349')));
    const [exp] = turnEntry.username.split(':');
    assert.ok(Number(exp) > Date.now() / 1000 + 3600, 'срок действия в будущем');
    assert.ok(!turnEntry.username.includes('alice'), 'имя пользователя не уходит на TURN');
    assert.equal(turnEntry.credential, createHmac('sha1', 's3cret').update(turnEntry.username).digest('base64'));
  } finally {
    clients.forEach((c) => c.disconnect());
    await srv.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('ответы и удаление: у меня, у всех, синхронизация между устройствами', async (t) => {
  const { mk } = await setup(t);
  const alice = mk();
  const bob = mk();
  await alice.register('alice');
  await bob.register('bob');
  const alice2 = mk();
  await link(alice2, alice);
  await alice.addContact('bob');

  // Ответ с цитатой
  const got1 = incoming(bob, 'исходное');
  await alice.sendText('bob', 'исходное');
  const orig = (await got1).message;
  const got2 = incoming(alice, 'ответ на него');
  await bob.sendText('alice', 'ответ на него', { replyTo: orig.id });
  const reply = (await got2).message;
  assert.deepEqual(reply.content.reply, { id: orig.id, from: 'alice', body: 'исходное' });
  await sleep(200);
  const a2reply = (await alice2.messages('bob')).find((m) => m.content.body === 'ответ на него');
  assert.equal(a2reply.content.reply.id, orig.id, 'второе устройство тоже видит цитату');

  // Синхронизированная копия исходящего с цитатой
  const syncP = waitFor(alice2, 'message', (d) => d.message.content.body === 'ещё ответ');
  await alice.sendText('bob', 'ещё ответ', { replyTo: reply.id });
  assert.equal((await syncP).message.content.reply.from, 'bob');

  // «Удалить у меня»: пропадает на всех моих устройствах, у собеседника остаётся
  const delMine = waitFor(alice2, 'deleted');
  await alice.deleteMessages('bob', [orig.id]);
  await delMine;
  assert.ok(!(await alice.messages('bob')).some((m) => m.id === orig.id));
  assert.ok(!(await alice2.messages('bob')).some((m) => m.id === orig.id));
  await sleep(200);
  assert.ok((await bob.messages('alice')).some((m) => m.id === orig.id), 'у Боба осталось');

  // «Удалить у всех» чужое сообщение (как в Telegram)
  const delBob = waitFor(bob, 'deleted');
  const delA2 = waitFor(alice2, 'deleted', (d) => d.ids.includes(reply.id));
  await alice.deleteMessages('bob', [reply.id], { forAll: true });
  await Promise.all([delBob, delA2]);
  for (const c of [alice, alice2]) assert.ok(!(await c.messages('bob')).some((m) => m.id === reply.id));
  assert.ok(!(await bob.messages('alice')).some((m) => m.id === reply.id));

  // Удаление ещё не отправленного сообщения отменяет отправку
  bob.disconnect();
  alice.disconnect();
  await alice.sendText('bob', 'передумал');
  const pending = (await alice.messages('bob')).find((m) => m.content.body === 'передумал');
  await alice.deleteMessages('bob', [pending.id], { forAll: true });
  assert.ok(!((await alice.storage.get('outbox')) || []).some((x) => x.id === pending.id));
});

test('статус «в сети»: подписка, «был(а)», скрытие', async (t) => {
  const { mk } = await setup(t);
  const alice = mk();
  const bob = mk();
  await alice.register('alice');
  await bob.register('bob');
  await alice.addContact('bob');
  await waitFor(alice, 'presence', (p) => p.username === 'bob' && p.online);
  assert.equal(alice.presenceOf('bob').online, true);

  // Боб уходит — Алиса сразу видит «был(а) …»
  const off = waitFor(alice, 'presence', (p) => p.username === 'bob' && !p.online);
  bob.disconnect();
  const p = await off;
  assert.ok(p.lastSeen && Date.now() - p.lastSeen < 5000);

  // Боб возвращается
  const on = waitFor(alice, 'presence', (q) => q.username === 'bob' && q.online);
  await bob.connect();
  await on;

  // Боб скрывает статус
  const hid = waitFor(alice, 'presence', (q) => q.username === 'bob' && q.hidden);
  await bob.setPresenceVisible(false);
  const h = await hid;
  assert.equal(h.online, false);
  assert.equal(h.lastSeen, null);

  // После переподключения Алисы подписка восстанавливается сама
  alice.disconnect();
  const again = waitFor(alice, 'presence', (q) => q.username === 'bob');
  await alice.connect();
  assert.equal((await again).hidden, true);
  await bob.setPresenceVisible(true);
});

test('переподключение по сигналу: смена сети, «мёртвое» соединение', async (t) => {
  const { mk } = await setup(t);
  const alice = mk();
  const bob = mk();
  await alice.register('alice');
  await bob.register('bob');
  await bob.addContact('alice');

  assert.equal(await alice.checkConnection(), true, 'живое соединение отвечает на ping');
  assert.equal(alice.reconnectNow(), false, 'без restart живое соединение не трогаем');

  // Сменилась сеть: закрываем соединение и сразу подключаемся заново, без таймера
  const before = alice.ws;
  const back = waitFor(alice, 'status', (s) => s === 'online');
  assert.equal(alice.reconnectNow({ restart: true }), true);
  await back;
  assert.notEqual(alice.ws, before);
  const got = incoming(alice, 'после смены сети');
  await bob.sendText('alice', 'после смены сети');
  await got;

  // «Повисшее» соединение: ping уходит в пустоту — переподключаемся
  alice.pingTimeout = 300;
  alice.ws.send = () => {};
  const again = waitFor(alice, 'status', (s) => s === 'online');
  assert.equal(await alice.checkConnection(), false);
  await again;
  assert.equal(await alice.checkConnection(), true);

  // Соединения нет и таймер переподключения ещё ждёт — подключаемся сразу
  alice.ws.close();
  await waitFor(alice, 'status', (s) => s === 'offline');
  alice._retry = 10; // следующая попытка была бы через 15 с
  const fast = waitFor(alice, 'status', (s) => s === 'online', 3000);
  assert.equal(await alice.checkConnection(), false);
  await fast;

  // После disconnect() сигналы ничего не делают
  alice.disconnect();
  assert.equal(alice.reconnectNow({ restart: true }), false);
  assert.equal(await alice.checkConnection(), false);
});

test('прочтение синхронизируется между своими устройствами', async (t) => {
  const { mk } = await setup(t);
  const alice = mk();
  const bob = mk();
  await alice.register('alice');
  await bob.register('bob');
  const alice2 = mk();
  await link(alice2, alice);
  await bob.addContact('alice');

  // Два сообщения — непрочитаны на обоих устройствах
  let both = Promise.all([incoming(alice, 'раз'), incoming(alice2, 'раз')]);
  await bob.sendText('alice', 'раз');
  await both;
  both = Promise.all([incoming(alice, 'два'), incoming(alice2, 'два')]);
  await bob.sendText('alice', 'два');
  await both;
  const unread = async (c) => (await c.contacts()).bob?.unread || 0;
  assert.equal(await unread(alice), 2);
  assert.equal(await unread(alice2), 2);

  // Прочитали на первом — на втором счётчик обнулился сам
  const synced = waitFor(alice2, 'read-sync', (e) => e.contact === 'bob');
  await alice.markRead('bob');
  assert.deepEqual(await synced, { contact: 'bob', unread: 0 });
  assert.equal(await unread(alice2), 0);

  // Новое сообщение снова непрочитано на обоих; отметка не обнуляет то, что пришло позже
  both = Promise.all([incoming(alice, 'три'), incoming(alice2, 'три')]);
  await bob.sendText('alice', 'три');
  await both;
  assert.equal(await unread(alice2), 1);
  await alice2._applyReadSync('bob', 0); // старая отметка ничего не меняет
  assert.equal(await unread(alice2), 1);

  // Прочитали на втором — на первом тоже прочитано; без непрочитанных отметка не уходит
  const back = waitFor(alice, 'read-sync', (e) => e.contact === 'bob');
  await alice2.markRead('bob');
  await back;
  assert.equal(await unread(alice), 0);
  const before = ((await alice2.storage.get('outbox')) || []).length;
  await alice2.markRead('bob');
  assert.equal(((await alice2.storage.get('outbox')) || []).length, before);

  // Собеседнику отметки о прочтении между вашими устройствами не приходят
  const peer = [];
  bob.on('read-sync', (e) => peer.push(e));
  await sleep(300);
  assert.deepEqual(peer, []);
});
