// Номера каналов и групп, вкладка «Каналы и группы» в панели и галочки для них.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server/server.js';
import { MessengerClient, MemoryStorage } from '../shared/client-core.js';

const ADMIN_PASSWORD = 'очень-длинный-пароль-123';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 6000) {
  const end = Date.now() + ms;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > end) throw new Error('timeout');
    await sleep(50);
  }
}

async function setup(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tainik-chatids-'));
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
    if (cookie) return cookie;
    const r = await fetch(`${base}/adminadminadmin/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ password: ADMIN_PASSWORD }),
    });
    return (cookie = r.headers.get('set-cookie').split(';')[0]);
  };
  const adminApi = async (name, body) =>
    fetch(`${base}/adminadminadmin/api/${name}`, {
      method: 'POST',
      headers: { Cookie: await login(), 'Content-Type': 'application/json', 'X-Tainik-Admin': '1' },
      body: JSON.stringify(body),
    });
  const overview = async () => (await fetch(`${base}/adminadminadmin/api/overview`, { headers: { Cookie: await login() } })).json();
  return { srv, mk, adminApi, overview };
}

test('каналы и группы: номера, вкладка в панели, галочки у участников и подписчиков', async (t) => {
  const { srv, mk, adminApi, overview } = await setup(t);
  const [alice, bob, carol] = [mk(), mk(), mk()];
  await alice.register('alice');
  await bob.register('bob');
  await carol.register('carol');

  // Канал: публичный (название видно в панели) и приватный (не видно)
  const pub = await alice.createChannel({ title: 'Новости', isPublic: true, handle: 'newsroom' });
  const priv = await alice.createChannel({ title: 'Секретный', isPublic: false });
  // Группа: создатель сообщает о ней серверу, участники — тоже
  const grp = await alice.createGroup('Дача', ['bob', 'carol']);
  await until(async () => (await bob.contacts())[grp] && (await carol.contacts())[grp]);
  await until(() => srv.store.groupMembers(grp.slice(1)).length === 3);

  const o = await overview();
  const ch = o.chats.channels;
  assert.equal(ch.length, 2);
  const pubRow = ch.find((c) => c.id === pub.slice(1));
  const privRow = ch.find((c) => c.id === priv.slice(1));
  assert.equal(pubRow.title, 'Новости', 'название публичного канала видно');
  assert.equal(pubRow.handle, 'newsroom');
  assert.equal(privRow.title, null, 'название приватного канала зашифровано');
  assert.ok(!('key' in pubRow) && !('meta' in pubRow), 'ключ и шифротекст в панель не отдаются');
  const g = o.chats.groups.find((x) => x.id === grp.slice(1));
  assert.equal(g.owner, 'alice');
  assert.equal(g.members, 3);
  assert.equal(g.registered, 3);
  // Номера — по порядку, общие для каналов и групп, без повторов
  const uids = [pubRow.uid, privRow.uid, g.uid];
  assert.deepEqual(uids, [1, 2, 3]);

  // Галочка каналу — у владельца сразу
  assert.equal(alice.isVerified(pub), false);
  assert.equal((await adminApi('chat-verify', { id: pub.slice(1), verified: true })).status, 200);
  await until(() => alice.isVerified(pub));
  assert.equal(alice.isVerified(priv), false);
  // Подписчик по @имени видит галочку и в превью, и после подписки
  const pre = await bob.channelPreview('@newsroom');
  assert.equal(pre.verified, true);
  await bob.joinChannel('@newsroom');
  await until(() => bob.isVerified(pub));

  // Галочка группе — у всех участников
  assert.equal((await adminApi('chat-verify', { id: grp.slice(1), verified: true })).status, 200);
  await until(() => alice.isVerified(grp) && bob.isVerified(grp) && carol.isVerified(grp));
  // Переподключение: галочка приходит при входе
  carol.disconnect();
  await carol.connect();
  await sleep(200);
  assert.equal(carol.isVerified(grp), true);
  // Снятие
  await adminApi('chat-verify', { id: grp.slice(1), verified: false });
  await until(() => !bob.isVerified(grp));

  // Вышел из группы — больше не участник на сервере, а администратор группы обновит число участников
  await carol.leaveGroup(grp);
  await until(() => !srv.store.groupMembers(grp.slice(1)).includes('carol'));
  await until(() => srv.store.getGroup(grp.slice(1)).members === 2);

  // Чужой id и неверный запрос
  assert.equal((await adminApi('chat-verify', { id: 'f'.repeat(24), verified: true })).status, 400);
  assert.equal((await adminApi('chat-verify', { id: 'xx', verified: true })).status, 400);
  // Владелец — администратор группы; участник не администратор — владельца и число не сменит
  srv.store.syncGroups('bob', [{ id: grp.slice(1), members: 99, admin: false }]);
  assert.equal(srv.store.getGroup(grp.slice(1)).owner, 'alice');
  assert.equal(srv.store.getGroup(grp.slice(1)).members, 2);
});

test('панель: название группы, удаление канала и группы', async (t) => {
  const { srv, mk, adminApi, overview } = await setup(t);
  const [alice, bob, carol] = [mk(), mk(), mk()];
  await alice.register('alice');
  await bob.register('bob');
  await carol.register('carol');
  const grp = await alice.createGroup('Дача', ['bob', 'carol']);
  await until(() => srv.store.groupMembers(grp.slice(1)).length === 3);
  await until(async () => (await overview()).chats.groups[0]?.name === 'Дача');

  // Переименовали — новое название в панели (сообщает администратор группы)
  await alice.updateGroup(grp, { name: 'Дача у озера' });
  await until(async () => (await overview()).chats.groups[0]?.name === 'Дача у озера');

  // Канал: подписчик видит удаление сразу
  const ch = await alice.createChannel({ title: 'Новости', isPublic: true, handle: 'newsroom' });
  await bob.joinChannel('@newsroom');
  const gone = waitEv(bob, 'channel-removed', (d) => d.chat === ch);
  assert.equal((await adminApi('chat-delete', { id: ch.slice(1) })).status, 200);
  await gone;
  assert.equal(srv.store.getChannel({ id: ch.slice(1) }), null);
  assert.equal((await overview()).chats.channels.length, 0);

  // Группа: участники в сети выходят из неё сразу, офлайн — при следующем входе
  carol.disconnect();
  const bobOut = waitEv(bob, 'group', (d) => d.chat === grp && d.group.left);
  assert.equal((await adminApi('chat-delete', { id: grp.slice(1) })).status, 200);
  await bobOut;
  await until(async () => (await alice.contacts())[grp].group.left);
  assert.equal((await bob.messages(grp)).at(-1).content.ev, 'deleted');
  await assert.rejects(bob.sendText(grp, 'привет'));
  assert.equal((await overview()).chats.groups.length, 0, 'удалённой группы нет в панели');
  await carol.connect();
  await until(async () => (await carol.contacts())[grp]?.group.left);
  // Повторно удалить нельзя, неверный id — ошибка
  assert.equal((await adminApi('chat-delete', { id: grp.slice(1) })).status, 400);
  assert.equal((await adminApi('chat-delete', { id: 'xx' })).status, 400);
});

test('пользователь удаляет свой аккаунт: устройства стирают данные, каналы пропадают, имя свободно', async (t) => {
  const { srv, mk } = await setup(t);
  const [alice, bob] = [mk(), mk()];
  await alice.register('alice');
  await bob.register('bob');
  let gotCode;
  const codeP = new Promise((r) => (gotCode = r));
  const alice2 = mk();
  const { done } = alice2.linkAsNewDevice({ deviceName: 'Телефон', onCode: ({ code }) => gotCode(code) });
  await alice.linkDevice(await codeP);
  await done;
  const ch = await alice.createChannel({ title: 'Мой канал', isPublic: true, handle: 'alice_chan' });
  await bob.joinChannel('@alice_chan');

  await assert.rejects(alice.deleteAccount('bob'), (e) => e.code === 'bad_confirm');
  assert.ok(srv.store.getUser('alice'), 'неверное подтверждение — ничего не удалено');

  const wiped = waitEv(alice2, 'error', (e) => e.code === 'account_deleted' && e.self === true);
  const chGone = waitEv(bob, 'channel-removed', (d) => d.chat === ch);
  await alice.deleteAccount('@Alice');
  await Promise.all([wiped, chGone]);
  assert.equal(srv.store.getUser('alice'), null);
  assert.equal(srv.store.getChannel({ id: ch.slice(1) }), null);
  // Юзернейм свободен
  const again = mk();
  await again.register('alice');
});

function waitEv(emitter, event, pred = () => true, ms = 8000) {
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
