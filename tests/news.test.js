// Канал «Обновления Тайника»: создаётся сервером, патчноут версии — один раз, подписаны все.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server/server.js';
import { changelogSection, NEWS_OWNER } from '../server/news.js';
import { MessengerClient, MemoryStorage } from '../shared/client-core.js';

const VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const ADMIN_PASSWORD = 'очень-длинный-пароль-123';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000) {
  const end = Date.now() + ms;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > end) throw new Error('timeout');
    await sleep(50);
  }
}

test('патчноут из CHANGELOG: раздел версии простым текстом', () => {
  const md = '# История\n\n## 1.2.0\n\n- **Новое**: штука `x`.\n- Ещё\n\n## 1.1.0\n\n- старое\n';
  assert.equal(changelogSection(md, '1.2.0'), '• Новое: штука x.\n• Ещё');
  assert.equal(changelogSection(md, '9.9.9'), null);
});

test('канал обновлений: создаётся, патчноут один раз, подписаны все, пост из панели', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tainik-news-'));
  const changelogPath = path.join(dataDir, 'CHANGELOG.md');
  fs.writeFileSync(changelogPath, `# История\n\n## ${VERSION}\n\n- **Кнопка**: теперь работает.\n\n## 0.0.1\n\n- старьё\n`);
  const opts = { port: 0, host: '127.0.0.1', dataDir, log: false, news: true, changelogPath, admin: { password: ADMIN_PASSWORD } };
  let srv = await startServer(opts);
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
  await until(() => srv.store.db.prepare("SELECT value FROM meta WHERE key = 'news_version'").get()?.value === VERSION);
  const id = srv.store.db.prepare("SELECT value FROM meta WHERE key = 'news_channel'").get().value;
  const ch = srv.store.getChannel({ id });
  assert.equal(ch.owner, NEWS_OWNER);
  assert.equal(ch.public, true);
  assert.equal(ch.verified, true);
  assert.equal(ch.handle, 'tainik');
  assert.equal(ch.seq, 1, 'патчноут опубликован');

  // Новый пользователь сразу подписан и видит патчноут
  const alice = mk();
  await alice.register('alice');
  const chat = '!' + id;
  await until(async () => (await alice.messages(chat)).length === 1);
  const [post] = await alice.messages(chat);
  assert.match(post.content.body, new RegExp(`^🆕 Тайник ${VERSION.replace(/\./g, '\\.')}\\n\\n• Кнопка: теперь работает\\.$`));
  assert.equal(alice.isVerified(chat), true);
  assert.equal(alice.nameOf(chat), 'Обновления Тайника');

  // Пост из панели администратора
  const base = `http://127.0.0.1:${srv.port}`;
  const r = await fetch(`${base}/adminadminadmin/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ password: ADMIN_PASSWORD }),
  });
  const cookie = r.headers.get('set-cookie').split(';')[0];
  const api = (name, body) =>
    fetch(`${base}/adminadminadmin/api/${name}`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json', 'X-Tainik-Admin': '1' }, body: JSON.stringify(body) });
  assert.equal((await api('news', { text: '  ' })).status, 400);
  assert.equal((await api('news', { text: 'Плановые работы в 3:00' })).status, 200);
  await until(async () => (await alice.messages(chat)).some((m) => m.content.body === 'Плановые работы в 3:00'));

  // Служебный владелец не виден среди пользователей панели
  const o = await (await fetch(`${base}/adminadminadmin/api/overview`, { headers: { Cookie: cookie } })).json();
  assert.ok(!o.users.some((u) => u.name === NEWS_OWNER));
  assert.equal(o.totals.users, 1);
  assert.equal(o.news.handle, 'tainik');
  // Имя владельца нельзя занять и нельзя «написать» ему
  await assert.rejects(mk().register(NEWS_OWNER));

  // Перезапуск сервера: канал тот же, патчноут не повторяется
  clients.forEach((c) => c.disconnect());
  await srv.close();
  srv = await startServer(opts);
  await sleep(300);
  assert.equal(srv.store.db.prepare("SELECT value FROM meta WHERE key = 'news_channel'").get().value, id);
  assert.equal(srv.store.getChannel({ id }).seq, 2);

  // Сервер обновили сразу через несколько версий — в канале все пропущенные, по порядку
  fs.writeFileSync(changelogPath, `# История\n\n## ${VERSION}\n\n- текущая\n\n## 0.0.3\n\n- третья\n\n## 0.0.2\n\n- вторая\n\n## 0.0.1\n\n- первая\n`);
  srv.store.db.prepare("UPDATE meta SET value = '0.0.1' WHERE key = 'news_version'").run();
  clients.forEach((c) => c.disconnect());
  await srv.close();
  srv = await startServer(opts);
  await until(() => srv.store.getChannel({ id }).seq === 5);
  const bodies = srv.store.channelHistory(id, 2).posts.length;
  assert.equal(bodies, 3, 'опубликованы 0.0.2, 0.0.3 и текущая');
  assert.equal(srv.store.db.prepare("SELECT value FROM meta WHERE key = 'news_version'").get().value, VERSION);

  // Отписаться можно, как от любого канала
  const bob = mk();
  await bob.register('bob');
  await until(async () => !!(await bob.contacts())[chat]);
  await bob.leaveChannel(chat);
  assert.equal(srv.store.isSubscribed(id, 'bob'), false);
});
