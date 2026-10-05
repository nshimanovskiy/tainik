// Групповые чаты: E2E-рассылка по парным сессиям, состав и админы — у участников.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server/server.js';
import { MessengerClient, MemoryStorage, isGroupChat } from '../shared/client-core.js';
import { randomId } from '../shared/protocol/index.js';

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
const gotIn = (client, chat, body) => waitFor(client, 'message', (d) => d.contact === chat && d.message.dir === 'in' && d.message.content.body === body);
const groupState = (client, chat, pred = () => true) => waitFor(client, 'group', (d) => d.chat === chat && pred(d.group));

async function setup(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tainik-groups-'));
  const srv = await startServer({ port: 0, host: '127.0.0.1', dataDir, log: false });
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
  return { srv, mk };
}

async function link(newClient, existing) {
  let gotCode;
  const codeP = new Promise((r) => (gotCode = r));
  const { done } = newClient.linkAsNewDevice({ deviceName: 'Второе', onCode: ({ code }) => gotCode(code) });
  await existing.linkDevice(await codeP);
  return done;
}

test('группа: создание, сообщения всем участникам, имена, свои устройства', async (t) => {
  const { mk } = await setup(t);
  const [alice, bob, carol] = [mk(), mk(), mk()];
  await alice.register('alice');
  await bob.register('bob');
  await carol.register('carol');
  const alice2 = mk();
  await link(alice2, alice);
  await alice.setProfile({ name: 'Алиса' });

  // Bob и Carol не знакомы друг с другом и с Алисой — группа всё равно работает
  const bobGot = waitFor(bob, 'group', (d) => d.group.name === 'Дача');
  const carolGot = waitFor(carol, 'group', (d) => d.group.name === 'Дача');
  const a2Got = waitFor(alice2, 'group', (d) => d.group.name === 'Дача');
  const chat = await alice.createGroup('  Дача ', ['@Bob', 'carol', 'alice']);
  assert.ok(isGroupChat(chat));
  const [{ group }] = await Promise.all([bobGot, carolGot, a2Got]);
  assert.deepEqual(group.members, ['alice', 'bob', 'carol']);
  assert.deepEqual(group.admins, ['alice']);
  assert.equal(bob.nameOf(chat), 'Дача');
  // Личный чат с создателем не появляется сам по себе
  assert.ok((await bob.contacts()).alice.hidden);

  // Сообщение — всем участникам и копия на второе устройство Алисы
  const bGot = gotIn(bob, chat, 'всем привет');
  const cGot = gotIn(carol, chat, 'всем привет');
  const a2Sent = waitFor(alice2, 'message', (d) => d.contact === chat && d.message.dir === 'out' && d.message.content.body === 'всем привет');
  const delivered = waitFor(alice, 'status-change', (d) => d.contact === chat && d.status === 'delivered');
  await alice.sendText(chat, 'всем привет');
  const [b, c] = await Promise.all([bGot, cGot, a2Sent]);
  assert.equal(b.message.from, 'alice');
  assert.equal(c.message.from, 'alice');
  assert.equal(bob.nameOf('alice'), 'Алиса', 'участники получают профиль');
  await delivered;

  // Ответ Bob с цитатой — видят Алиса (оба устройства) и Carol
  const aGot = gotIn(alice, chat, 'и тебе');
  const cGot2 = gotIn(carol, chat, 'и тебе');
  const a2Got2 = gotIn(alice2, chat, 'и тебе');
  await bob.sendText(chat, 'и тебе', { replyTo: b.message.id });
  const [r] = await Promise.all([aGot, cGot2, a2Got2]);
  assert.equal(r.message.from, 'bob');
  assert.equal(r.message.content.reply.from, 'alice');
  assert.equal((await alice.contacts())[chat].unread, 1);

  // Новое устройство при привязке получает группу (без истории)
  const alice3 = mk();
  await link(alice3, alice);
  const g3 = await alice3.groupOf(chat);
  assert.equal(g3.name, 'Дача');
  const a3Got = gotIn(alice3, chat, 'с нового устройства видно');
  await carol.sendText(chat, 'с нового устройства видно');
  await a3Got;
});

test('группа: админ добавляет и исключает, не-админ не может, выход, удаление у всех', async (t) => {
  const { mk } = await setup(t);
  const [alice, bob, carol, dave] = [mk(), mk(), mk(), mk()];
  for (const [c, n] of [[alice, 'alice'], [bob, 'bob'], [carol, 'carol'], [dave, 'dave']]) await c.register(n);
  const chat = await alice.createGroup('Работа', ['bob', 'carol']);
  await groupState(bob, chat);
  await groupState(carol, chat);

  // Не-админ не может менять группу
  await assert.rejects(bob.updateGroup(chat, { name: 'Захват' }), (e) => e.code === 'group_not_admin');
  // …и подделанное состояние от него никто не примет
  await bob._serial(async () => {
    const outbox = (await bob.storage.get('outbox')) || [];
    const forged = { t: 'group', g: chat.slice(1), name: 'Захват', members: ['alice', 'bob', 'carol'], admins: ['bob'], v: Date.now() + 1e6 };
    outbox.push({ id: randomId(), to: 'carol', kind: 'ctl', content: forged, attempts: 0 });
    await bob.storage.set('outbox', outbox);
  });
  bob._pumpOutbox();
  await sleep(400);
  assert.equal((await carol.groupOf(chat)).name, 'Работа');

  // Админ добавляет Dave и исключает Carol, переименовывает
  const daveGot = groupState(dave, chat, (g) => g.members.includes('dave'));
  const carolOut = groupState(carol, chat, (g) => !!g.left);
  const bobSees = groupState(bob, chat, (g) => g.members.includes('dave'));
  await alice.updateGroup(chat, { name: 'Работа 2', add: ['dave'], remove: ['carol'] });
  await Promise.all([daveGot, carolOut, bobSees]);
  assert.deepEqual((await bob.groupOf(chat)).members, ['alice', 'bob', 'dave']);
  assert.equal((await dave.groupOf(chat)).name, 'Работа 2');
  const events = (await bob.messages(chat)).filter((m) => m.dir === 'sys').map((m) => m.content.ev);
  assert.deepEqual(events, ['created', 'renamed', 'added', 'removed']);
  // Исключённая не может писать в группу
  await assert.rejects(carol.sendText(chat, 'я ещё тут'), (e) => e.code === 'group_left');

  // Сообщение — только текущему составу
  const dGot = gotIn(dave, chat, 'новый состав');
  await bob.sendText(chat, 'новый состав');
  await dGot;
  await sleep(200);
  assert.ok(!(await carol.messages(chat)).some((m) => m.content?.body === 'новый состав'));

  // Удаление у всех: только свои сообщения
  const msgs = await dave.messages(chat);
  const bobMsg = msgs.find((m) => m.content?.body === 'новый состав');
  const gone = waitFor(dave, 'deleted', (d) => d.contact === chat && d.ids.includes(bobMsg.id));
  await bob.deleteMessages(chat, [bobMsg.id], { forAll: true });
  await gone;
  const aliceMsg = gotIn(dave, chat, 'не удалить чужое');
  await alice.sendText(chat, 'не удалить чужое');
  const am = await aliceMsg;
  await bob.deleteMessages(chat, [am.message.id], { forAll: true }); // у себя удалит, у других — нет
  await sleep(300);
  assert.ok((await dave.messages(chat)).some((m) => m.id === am.message.id));

  // Выход: остальные видят, что Bob вышел; Bob больше не участник
  const left = groupState(alice, chat, (g) => !g.members.includes('bob'));
  const leftD = groupState(dave, chat, (g) => !g.members.includes('bob'));
  await bob.leaveGroup(chat);
  await Promise.all([left, leftD]);
  assert.ok((await bob.groupOf(chat)).left);
  await assert.rejects(bob.sendText(chat, 'привет'), (e) => e.code === 'group_left');

  // Последний админ вышел — админом становится первый оставшийся участник
  const promoted = groupState(dave, chat, (g) => g.admins.includes('dave'));
  await alice.leaveGroup(chat);
  await promoted;
  assert.deepEqual((await dave.groupOf(chat)).members, ['dave']);
});

test('группа: сообщение раньше состава — откладывается и показывается потом', async (t) => {
  const { mk } = await setup(t);
  const [alice, bob] = [mk(), mk()];
  await alice.register('alice');
  await bob.register('bob');
  const chat = await alice.createGroup('Порядок', ['bob']);
  await groupState(bob, chat);
  // Bob получает сообщение от нового участника раньше, чем состояние с ним
  const gid = chat.slice(1);
  const all = await bob.contacts();
  await bob._onGroupContent(all, 'zed', { id: 'early-1', content: { t: 'gmsg', g: gid, m: { t: 'text', body: 'я первый', ts: Date.now() } } });
  assert.ok(!(await bob.messages(chat)).some((m) => m.id === 'early-1'));
  const zed = mk();
  await zed.register('zed');
  const shown = gotIn(bob, chat, 'я первый');
  await alice.updateGroup(chat, { add: ['zed'] });
  const d = await shown;
  assert.equal(d.message.from, 'zed');
});
