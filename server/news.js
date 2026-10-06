// Официальный канал «Обновления Тайника»: сервер сам публикует в него патчноуты новых версий
// (раздел из CHANGELOG.md) и, по кнопке в панели, сообщения администратора.
//
// Канал публичный: его ключ у сервера, как у любого публичного канала, поэтому сервер может
// сам зашифровать пост. Владелец — служебная запись '~tainik' (такое имя нельзя
// зарегистрировать: юзернеймы — только латиница, цифры и «_»), с галочкой. На канал
// подписываются все пользователи (и новые — при регистрации); отписаться можно, как от любого.
import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import { aeadEncrypt, te, toB64 } from '../shared/protocol/primitives.js';

export const NEWS_OWNER = '~tainik';
export const NEWS_TITLE = 'Обновления Тайника';
export const NEWS_ABOUT = 'Что нового в каждой версии Тайника: патчноуты обновлений. Канал официальный, публикует сам сервер.';
const HANDLES = ['tainik', 'tainik_news', 'tainik_updates', 'tainik_changelog'];
export const NEWS_POST_MAX = 3800;

/** Зашифровать объект ключом канала — как channelSeal в shared/client-core.js. */
async function seal(keyB64, id, obj) {
  const iv = new Uint8Array(randomBytes(12));
  const ct = await aeadEncrypt(Buffer.from(keyB64, 'base64'), iv, te.encode(JSON.stringify(obj)), te.encode('tainik/channel/' + id));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv);
  out.set(ct, 12);
  return toB64(out);
}

/** Раздел «## <версия>» из CHANGELOG.md — простым текстом (без разметки Markdown). */
export function changelogSection(text, version) {
  const lines = String(text || '').split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === `## ${version}`);
  if (start < 0) return null;
  const out = [];
  for (const l of lines.slice(start + 1)) {
    if (/^##\s/.test(l)) break;
    out.push(l);
  }
  const body = out
    .join('\n')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^(\s*)[-*] /gm, '$1• ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return body || null;
}

/**
 * Канал обновлений: создать при первом запуске, подписать всех, опубликовать патчноут версии.
 * o: { store, version, changelogPath, notify(id, post) — разослать новый пост подписчикам, say }
 */
export function createNews({ store, version, changelogPath, notify, say = () => {} }) {
  const db = store.db;
  const meta = (k) => db.prepare('SELECT value FROM meta WHERE key = ?').get(k)?.value ?? null;
  const setMeta = (k, v) => db.prepare('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, String(v));

  // Служебный владелец канала: без устройств и ключей (войти им нельзя)
  if (!db.prepare('SELECT 1 FROM users WHERE name = ?').get(NEWS_OWNER)) {
    db.prepare("INSERT INTO users(name, identity_dh, identity_sign, next_device_id, created_at) VALUES (?, '', '', 1, ?)").run(NEWS_OWNER, Date.now());
  }

  let channel = meta('news_channel') ? store.getChannel({ id: meta('news_channel') }) : null;
  async function ensure() {
    if (channel) return channel;
    const id = randomBytes(16).toString('hex');
    const key = randomBytes(32).toString('base64');
    const handle = HANDLES.find((h) => !store.channelHandleTaken(h) && !store.getUser(h)) || null;
    if (!handle) {
      say('канал обновлений: все имена заняты — не создан');
      return null;
    }
    store.createChannel({ id, owner: NEWS_OWNER, handle, isPublic: true, key, meta: await seal(key, id, { title: NEWS_TITLE, about: NEWS_ABOUT }) });
    store.setChannelVerified(id, true);
    // Подписать всех, кто уже есть
    const now = Date.now();
    for (const r of db.prepare("SELECT name FROM users WHERE name NOT LIKE '~%'").all()) store.subscribe(id, r.name, now);
    setMeta('news_channel', id);
    channel = store.getChannel({ id });
    say(`создан канал обновлений @${handle}`);
    return channel;
  }

  /** Опубликовать пост от имени канала. Возвращает { seq, ts } или null. */
  async function post(text) {
    const c = await ensure();
    text = String(text ?? '').replace(/\r\n?/g, '\n').trim();
    if (!c || !text) return null;
    if (text.length > NEWS_POST_MAX) text = text.slice(0, NEWS_POST_MAX - 1) + '…';
    const ts = Date.now();
    const data = await seal(c.key, c.id, { t: 'text', body: text, ts });
    const res = store.addChannelPost(c.id, NEWS_OWNER, data, [], ts);
    notify(c.id, { ...res, data });
    return res;
  }

  /** Патчноут текущей версии — один раз на версию. */
  async function publishRelease() {
    if (meta('news_version') === version) return null;
    let text = null;
    try {
      text = changelogSection(fs.readFileSync(changelogPath, 'utf8'), version);
    } catch {}
    if (!text) return null; // нет раздела — ждём следующей версии
    const res = await post(`🆕 Тайник ${version}\n\n${text}`);
    if (res) {
      setMeta('news_version', version);
      say(`канал обновлений: опубликован патчноут ${version}`);
    }
    return res;
  }

  return {
    ensure,
    post,
    publishRelease,
    /** Новый пользователь — подписать на канал. */
    subscribe(user) {
      if (channel) store.subscribe(channel.id, user);
    },
    /** Канал удалили (в панели): забыть его. Новый создастся при следующем запуске сервера. */
    forget() {
      channel = null;
      db.prepare("DELETE FROM meta WHERE key = 'news_channel'").run();
    },
    get id() {
      return channel?.id || null;
    },
  };
}
