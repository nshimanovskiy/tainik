// Каналы: публичные (по @имени) и приватные (по ссылке с ключом), посты на сервере — шифротекст.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server/server.js';
import { MessengerClient, MemoryStorage, isChannelChat, parseChannelRef } from '../shared/client-core.js';

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
const post = (client, chat, body) => waitFor(client, 'message', (d) => d.contact === chat && d.message.content.body === body);
const bodies = async (client, chat) => (await client.messages(chat)).map((m) => m.content?.body);

async function setup(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tainik-channels-'));
  const srv = await startServer({ port: 0, host: '127.0.0.1', dataDir, log: false });
  const clients = [];
  const mk = (storage = new MemoryStorage()) => {
    const c = new MessengerClient({ url: `ws://127.0.0.1:${srv.port}/ws`, storage });
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

async function link(newClient, existing) {
  let gotCode;
  const codeP = new Promise((r) => (gotCode = r));
  const { done } = newClient.linkAsNewDevice({ deviceName: 'Второе', onCode: ({ code }) => gotCode(code) });
  await existing.linkDevice(await codeP);
  return done;
}

test('ссылки на канал разбираются', () => {
  assert.deepEqual(parseChannelRef('@News_Room'), { handle: 'news_room' });
  assert.deepEqual(parseChannelRef('https://chat.example/app#ch=@news_room'), { handle: 'news_room' });
  const key = Buffer.alloc(32, 1).toString('base64url');
  const r = parseChannelRef(`https://chat.example/app#ch=${'a'.repeat(32)}.${key}`);
  assert.equal(r.id, 'a'.repeat(32));
  assert.equal(Buffer.from(r.key, 'base64').length, 32);
  assert.equal(parseChannelRef('#ch=???'), null);
});

test('публичный канал: создание, поиск по @имени, посты, удаление, догоняние после офлайна', async (t) => {
  const { srv, mk, dataDir } = await setup(t);
  const [alice, bob, carol] = [mk(), mk(), mk()];
  await alice.register('alice');
  await bob.register('bob');
  await carol.register('carol');
  await mk().register('robert');

  await assert.rejects(alice.createChannel({ title: 'Новости', isPublic: true, handle: 'robert' }), (e) => e.code === 'channel_handle_taken');
  await assert.rejects(alice.createChannel({ title: 'Новости', isPublic: true, handle: '1x' }), (e) => e.code === 'bad_channel_handle');
  const chat = await alice.createChannel({ title: '  Новости ', about: 'Главное за день', isPublic: true, handle: '@News_Room' });
  assert.ok(isChannelChat(chat));
  assert.equal(alice.nameOf(chat), 'Новости');
  const ch = await alice.channelOf(chat);
  assert.deepEqual([ch.role, ch.handle, ch.public], ['owner', 'news_room', true]);
  assert.equal(alice.channelLink(ch, 'https://x.y'), 'https://x.y/app#ch=@news_room');

  // Имя канала нельзя занять юзернеймом
  const dup = mk();
  await assert.rejects(dup.register('news_room'), (e) => e.code === 'username_taken');

  await alice.sendText(chat, 'Первый пост');
  const pre = await bob.channelPreview('@news_room');
  assert.equal(pre.title, 'Новости');
  assert.equal(pre.about, 'Главное за день');
  assert.deepEqual(pre.posts.map((p) => p.content.body), ['Первый пост']);
  assert.equal(pre.role, null);
  const bChat = await bob.joinChannel(pre);
  assert.equal(bChat, chat);
  assert.deepEqual(await bodies(bob, chat), ['Первый пост'], 'при подписке — последние посты');
  assert.equal((await bob.channelOf(chat)).subs, 2);

  // Подписчик не пишет
  await assert.rejects(bob.sendText(chat, 'можно?'), (e) => e.code === 'channel_not_admin');

  // Живой пост
  const got = post(bob, chat, 'Второй пост');
  await alice.sendText(chat, 'Второй пост');
  await got;
  assert.equal((await bob.contacts())[chat].unread, 1);

  // Удаление поста «у всех»
  const second = (await alice.messages(chat)).find((m) => m.content.body === 'Второй пост');
  const gone = waitFor(bob, 'deleted', (d) => d.contact === chat && d.ids.includes(second.id));
  await alice.deleteMessages(chat, [second.id], { forAll: true });
  await gone;

  // Bob не в сети: пост и удаление старого — догоняет при входе
  await carol.joinChannel('https://chat.example/app#ch=@news_room');
  bob.disconnect();
  await alice.sendText(chat, 'Пока тебя не было');
  const first = (await alice.messages(chat)).find((m) => m.content.body === 'Первый пост');
  await alice.deleteMessages(chat, [first.id], { forAll: true });
  const back = post(bob, chat, 'Пока тебя не было');
  bob.connect();
  await back;
  await sleep(300);
  assert.deepEqual(await bodies(bob, chat), ['Пока тебя не было']);
  assert.equal((await bob.channelOf(chat)).subs, 3);

  // Файл в посте: доходит и не удаляется по сроку, пока пост есть
  const gotFile = waitFor(bob, 'message', (d) => d.contact === chat && d.message.content.t === 'file');
  const f = await alice.sendFile(chat, new Uint8Array([1, 2, 3, 4]), { name: 'a.png', mime: 'image/png' }, { caption: 'картинка' });
  const fm = (await gotFile).message;
  assert.deepEqual([...(await bob.fetchFile(fm.content.file))], [1, 2, 3, 4]);
  assert.deepEqual(srv.store.expiredBlobs(Date.now() + 1e12, Date.now() + 1e12), [], 'вложение поста закреплено');
  await alice.deleteMessages(chat, [fm.id], { forAll: true });
  await sleep(200);
  assert.deepEqual(srv.store.expiredBlobs(Date.now(), Date.now()), [f.id], 'пост удалён — вложение уйдёт при чистке');

  // Отписка
  const fewer = waitFor(alice, 'channel', (d) => d.chat === chat);
  await bob.leaveChannel(chat);
  await fewer;
  assert.equal(await bob.channelOf(chat), null);
  assert.equal((await alice.channelOf(chat)).subs, 2);
  await assert.rejects(alice.leaveChannel(chat), (e) => e.code === 'channel_owner');

  // На сервере — только шифротекст
  const db = ['', '-wal'].map((s) => srv.store.file + s).filter((f) => fs.existsSync(f)).map((f) => fs.readFileSync(f).toString('utf8')).join('');
  assert.ok(!db.includes('Пока тебя не было') && !db.includes('Новости'));
  assert.ok(dataDir);
});

test('приватный канал: ссылка с ключом, администраторы, второе устройство, удаление канала', async (t) => {
  const { srv, mk } = await setup(t);
  const [alice, bob, eve] = [mk(), mk(), mk()];
  await alice.register('alice');
  await bob.register('bob');
  await eve.register('eve');
  const chat = await alice.createChannel({ title: 'Свои', about: 'только по ссылке' });
  const ch = await alice.channelOf(chat);
  assert.equal(ch.public, false);
  const url = alice.channelLink(ch, 'https://x.y');
  assert.match(url, /#ch=[0-9a-f]{32}\.[A-Za-z0-9_-]{43}$/);
  assert.equal(srv.store.getChannel({ id: ch.id }).key, null, 'ключ приватного канала сервер не знает');

  // Без ключа (или с чужим) — не прочитать
  const wrong = url.replace(/\.[A-Za-z0-9_-]{43}$/, '.' + Buffer.alloc(32, 7).toString('base64url'));
  await assert.rejects(eve.channelPreview(wrong), (e) => e.code === 'bad_channel_link');
  await assert.rejects(eve.channelPreview('@nonexistent'), (e) => e.code === 'channel_not_found');

  await alice.sendText(chat, 'секретный анонс');
  await bob.joinChannel(url);
  assert.deepEqual(await bodies(bob, chat), ['секретный анонс']);

  // Второе устройство Bob узнаёт канал (и ключ) от первого
  const bob2 = mk();
  await link(bob2, bob);
  await sleep(500);
  assert.equal((await bob2.channelOf(chat))?.title, 'Свои');
  const b2 = post(bob2, chat, 'всем устройствам');
  await alice.sendText(chat, 'всем устройствам');
  await b2;

  // Администратор
  await assert.rejects(alice.setChannelAdmin(chat, 'eve'), (e) => e.code === 'channel_not_subscriber');
  const promoted = waitFor(bob, 'channel', (d) => d.chat === chat);
  await alice.setChannelAdmin(chat, 'bob');
  await promoted;
  assert.equal((await bob.channelOf(chat)).role, 'admin');
  const fromBob = post(alice, chat, 'пишет админ');
  await bob.sendText(chat, 'пишет админ');
  await fromBob;
  await bob.updateChannel(chat, { title: 'Свои люди' });
  await sleep(300);
  assert.equal(alice.nameOf(chat), 'Свои люди');

  // Удаление канала — у всех пропадает возможность читать
  const removed = waitFor(bob, 'channel-removed', (d) => d.chat === chat);
  await assert.rejects(bob.deleteChannel(chat), (e) => e.code === 'channel_not_admin');
  await alice.deleteChannel(chat);
  await removed;
  assert.ok((await bob.channelOf(chat)).gone);
  assert.equal(srv.store.getChannel({ id: ch.id }), null);
});
