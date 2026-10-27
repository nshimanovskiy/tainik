// Сообщества: каналы, роли, приглашения по ссылке, удаление модератором, сигналы голосовых каналов.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server/server.js';
import { MessengerClient, MemoryStorage, isCommunity, canModerate, cleanChanName } from '../shared/client-core.js';

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

async function setup(tt) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tainik-comm-'));
  const srv = await startServer({ port: 0, host: '127.0.0.1', dataDir, log: false });
  const clients = [];
  const mk = () => {
    const c = new MessengerClient({ url: `ws://127.0.0.1:${srv.port}/ws`, storage: new MemoryStorage() });
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

test('сообщество: каналы, сообщения по каналам, модератор, приглашение по ссылке', async (tt) => {
  const { mk } = await setup(tt);
  const [alice, bob, carol, dan] = [mk(), mk(), mk(), mk()];
  for (const [c, n] of [[alice, 'alice'], [bob, 'bob'], [carol, 'carol'], [dan, 'dan']]) await c.register(n);

  const got = Promise.all([waitFor(bob, 'group', (d) => d.group.name === 'Клуб'), waitFor(carol, 'group', (d) => d.group.name === 'Клуб')]);
  const chat = await alice.createGroup('Клуб', ['bob', 'carol'], { community: true });
  await got;
  const g = await bob.groupOf(chat);
  assert.ok(isCommunity(g));
  assert.deepEqual(g.chans.map((c) => c.type), ['text', 'voice']);
  const general = g.chans[0].id;

  // Новый текстовый канал и голосовой; переименование — служебные строки у участников
  const chans = [...g.chans, { id: 'abcdef01', name: '#Офф топ', type: 'text' }];
  const upd = waitFor(bob, 'group', (d) => d.chat === chat && d.group.chans.length === 3);
  await alice.updateGroup(chat, { chans });
  await upd;
  const off = (await bob.groupOf(chat)).chans.find((c) => c.id === 'abcdef01');
  assert.equal(off.name, 'офф-топ');
  assert.equal(cleanChanName('  Музыка ', 'voice'), 'Музыка');
  assert.ok((await bob.messages(chat)).some((m) => m.content?.ev === 'chan-add' && m.content.name === 'офф-топ'));

  // Сообщение в канал: пометка ch доходит
  const inOff = waitFor(carol, 'message', (d) => d.contact === chat && d.message.content.body === 'привет оффтоп');
  await bob.sendText(chat, 'привет оффтоп', { ch: 'abcdef01' });
  const msg = (await inOff).message;
  assert.equal(msg.content.ch, 'abcdef01');
  const inGen = waitFor(carol, 'message', (d) => d.contact === chat && d.message.content.body === 'в общий');
  await bob.sendText(chat, 'в общий', { ch: general });
  assert.equal((await inGen).message.content.ch, general);

  // Обычный участник чужое «у всех» не удаляет; модератор — удаляет
  await carol.deleteMessages(chat, [msg.id], { forAll: true });
  await sleep(500);
  assert.ok((await alice.messages(chat)).some((m) => m.id === msg.id), 'не модератор — у других осталось');
  const modded = waitFor(carol, 'group', (d) => d.chat === chat && (d.group.mods || []).includes('carol'));
  await alice.updateGroup(chat, { mods: ['carol'] });
  await modded;
  assert.ok(canModerate(await alice.groupOf(chat), 'carol'));
  const gone = waitFor(alice, 'deleted', (d) => d.contact === chat).catch(() => null);
  const target = (await carol.messages(chat)).find((m) => m.content?.body === 'в общий');
  await carol.deleteMessages(chat, [target.id], { forAll: true });
  await gone;
  await sleep(300);
  assert.ok(!(await alice.messages(chat)).some((m) => m.id === target.id), 'модератор удалил у всех');

  // Приглашение по ссылке: заявка администратору, он добавляет автоматически
  const link = await alice.createInvite(chat, 'https://chat.example');
  assert.match(link, /\/app#join=[0-9a-f]{24}-[0-9a-f]{16}-alice$/);
  assert.equal(MessengerClient.parseInvite('ссылка: ' + link + ' ').admins[0], 'alice');
  const joined = waitFor(dan, 'group', (d) => d.chat === chat && d.group.members.includes('dan'));
  assert.equal(await dan.joinByInvite(link), null);
  await joined;
  assert.ok(isCommunity(await dan.groupOf(chat)));
  // Отозванное приглашение больше не работает
  const g2 = await alice.groupOf(chat);
  await alice.revokeInvite(chat, g2.invites[0].s);
  const eve = mk();
  await eve.register('evee');
  await eve.joinByInvite(link);
  await sleep(800);
  assert.ok(!(await alice.groupOf(chat)).members.includes('evee'));
  await assert.rejects(eve.joinByInvite('https://x/app#join=bad'), (e) => e.code === 'bad_invite');
});

test('сообщество: состояние без каналов (старая версия) сообщество не ломает', async (tt) => {
  const { mk } = await setup(tt);
  const [alice, bob] = [mk(), mk()];
  await alice.register('alice');
  await bob.register('bob');
  const got = waitFor(bob, 'group', (d) => d.group.name === 'К');
  const chat = await alice.createGroup('К', ['bob'], { community: true });
  await got;
  const g = await alice.groupOf(chat);
  // Как если бы администратор со старой версией прислал состояние без kind/chans
  const upd = waitFor(bob, 'group', (d) => d.chat === chat && d.group.name === 'К2');
  await alice._serial(async () => {
    const all = await alice.contacts();
    const outbox = (await alice.storage.get('outbox')) || [];
    outbox.push({ id: 'x' + Date.now(), to: 'bob', kind: 'ctl', content: { t: 'group', g: g.id, name: 'К2', members: g.members, admins: g.admins, v: g.v + 1, ts: Date.now() }, attempts: 0 });
    await alice.storage.set('outbox', outbox);
    await alice._saveContacts(all);
  });
  alice._pumpOutbox();
  await upd;
  const gb = await bob.groupOf(chat);
  assert.ok(isCommunity(gb));
  assert.equal(gb.chans.length, 2);
});

test('голосовой канал: сигналы с пометкой канала доходят участникам', async (tt) => {
  const { mk } = await setup(tt);
  const [alice, bob] = [mk(), mk()];
  await alice.register('alice');
  await bob.register('bob');
  const got = waitFor(bob, 'group', (d) => d.group.name === 'Голос');
  const chat = await alice.createGroup('Голос', ['bob'], { community: true });
  await got;
  const vc = (await alice.groupOf(chat)).chans.find((c) => c.type === 'voice').id;
  const sig = waitFor(bob, 'gcall-signal', (s) => s.data.kind === 'join');
  await alice.sendGroupCall(chat, { kind: 'join', callId: 'aaaabbbbcccc', vc }, { others: 'all' });
  assert.equal((await sig).data.vc, vc);
});
