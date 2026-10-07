// Магазин: рамки вокруг фото профиля и фоны профиля (короткие видео или анимированные картинки).
//
// Товары загружает администратор в панели — частями (через nginx проходит не больше 1 МБ за
// запрос): shop-new → shop-chunk … → shop-done. Тип файла определяется по его содержимому, а не
// по тому, что прислал браузер; разрешены только картинки и видео (никакого SVG и HTML).
//
//   GET /api/shop/<id>   файл товара (открытый: рамку и фон видят все собеседники). id не
//                         переиспользуется, файл не меняется — кэшируется навсегда.
//
// Кто что купил и что надел — в базе (store.js); монеты списываются там же одной транзакцией.
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

// Примеры рамок: сервер выставляет их в магазин один раз, при первом запуске с магазином
// (дальше администратор меняет или удаляет их, как любые товары — удалённые не возвращаются)
const SAMPLES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'shop-samples');
export const SAMPLES = [
  { file: 'sakura.png', kind: 'frame', name: 'Сакура', price: 0, premium: false },
  { file: 'gold.png', kind: 'frame', name: 'Золото', price: 100, premium: false },
  { file: 'stardust.png', kind: 'frame', name: 'Звёздная пыль', price: 50, premium: true },
  { file: 'neon.png', kind: 'frame', name: 'Неон', price: 0, premium: true },
];

export const SHOP_ID_RE = /^[0-9a-f]{16}$/;
export const SHOP_NAME_MAX = 40;
export const SHOP_PRICE_MAX = 1_000_000;
export const SHOP_CHUNK = 512 * 1024; // байт за один запрос из панели (в base64 — около 700 КБ)
// Что можно загрузить: рамка — картинка с прозрачностью (может быть анимированной), фон — видео
// или картинка
export const SHOP_KINDS = {
  frame: { max: 2 * 1024 * 1024, mimes: ['image/png', 'image/webp', 'image/gif'] },
  bg: { max: 15 * 1024 * 1024, mimes: ['video/mp4', 'video/webm', 'image/png', 'image/webp', 'image/gif', 'image/jpeg'] },
};

/** Тип файла по первым байтам; null — не картинка и не видео из разрешённых. */
export function sniffMime(buf) {
  const b = Buffer.from(buf);
  const ascii = (from, to) => b.subarray(from, to).toString('latin1');
  if (b.length >= 8 && b[0] === 0x89 && ascii(1, 4) === 'PNG') return 'image/png';
  if (ascii(0, 4) === 'GIF8') return 'image/gif';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (ascii(4, 8) === 'ftyp') return 'video/mp4'; // MP4, M4V и MOV (QuickTime) — общий контейнер ISO BMFF
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'video/webm';
  return null;
}

const cleanName = (s) =>
  String(s ?? '')
    .replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩​-‏﻿]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, SHOP_NAME_MAX);

function fields({ name, price, premium, hidden }) {
  name = cleanName(name);
  if (!name) throw new Error('Введите название');
  price = Number(price);
  if (!Number.isSafeInteger(price) || price < 0 || price > SHOP_PRICE_MAX) throw new Error(`Цена — целое число монет от 0 до ${SHOP_PRICE_MAX}`);
  return { name, price, premium: premium === true, hidden: hidden === true };
}

export function createShop({ dataDir, store, say = () => {} }) {
  const dir = path.join(dataDir, 'shop');
  fs.mkdirSync(dir, { recursive: true });
  const fileOf = (id) => path.join(dir, id);

  /** Новый товар (пока без файла): { id }. */
  function newItem({ kind, name, price, premium, size }) {
    const k = SHOP_KINDS[kind];
    if (!k) throw new Error('Неизвестный вид товара');
    const f = fields({ name, price, premium });
    size = Number(size);
    if (!Number.isSafeInteger(size) || size <= 0) throw new Error('Пустой файл');
    if (size > k.max) throw new Error(`Файл больше ${Math.round(k.max / 1048576)} МБ`);
    const id = randomBytes(8).toString('hex');
    store.addShopItem({ id, kind, ...f, size });
    fs.writeFileSync(fileOf(id) + '.part', Buffer.alloc(0), { mode: 0o600 });
    return { id, chunk: SHOP_CHUNK };
  }

  /** Следующая часть файла (base64). Возвращает { received }. */
  function chunk(id, offset, data) {
    const item = SHOP_ID_RE.test(String(id)) ? store.shopItem(id) : null;
    if (!item || item.ready) throw new Error('Нет такой загрузки');
    if (Number(offset) !== item.received) throw new Error('Неверное смещение — начните загрузку заново');
    const buf = Buffer.from(String(data || ''), 'base64');
    if (!buf.length || buf.length > SHOP_CHUNK || item.received + buf.length > item.size) throw new Error('Неверный размер части');
    fs.appendFileSync(fileOf(id) + '.part', buf);
    store.shopReceived(id, item.received + buf.length);
    return { received: item.received + buf.length };
  }

  /** Файл загружен: проверить тип и выставить товар. */
  function finish(id) {
    const item = SHOP_ID_RE.test(String(id)) ? store.shopItem(id) : null;
    if (!item || item.ready) throw new Error('Нет такой загрузки');
    if (item.received !== item.size) throw new Error('Файл загружен не полностью');
    const head = Buffer.alloc(16);
    const fd = fs.openSync(fileOf(id) + '.part', 'r');
    try {
      fs.readSync(fd, head, 0, 16, 0);
    } finally {
      fs.closeSync(fd);
    }
    const mime = sniffMime(head);
    if (!mime || !SHOP_KINDS[item.kind].mimes.includes(mime)) {
      remove(id);
      throw new Error(item.kind === 'frame' ? 'Рамка — картинка PNG, WebP или GIF' : 'Фон — видео MP4 или WebM либо картинка PNG, WebP, GIF, JPEG');
    }
    fs.renameSync(fileOf(id) + '.part', fileOf(id));
    store.shopReady(id, mime);
    say('администратор добавил товар в магазин');
    return store.shopItem(id);
  }

  function update(id, body) {
    if (!SHOP_ID_RE.test(String(id)) || !store.shopItem(id)) throw new Error('Нет такого товара');
    store.updateShopItem(id, fields(body));
    return store.shopItem(id);
  }

  /** Удалить товар с файлом. Возвращает, у кого он был надет. */
  function remove(id) {
    if (!SHOP_ID_RE.test(String(id)) || !store.shopItem(id)) throw new Error('Нет такого товара');
    const users = store.deleteShopItem(id);
    fs.rmSync(fileOf(id), { force: true });
    fs.rmSync(fileOf(id) + '.part', { force: true });
    return users;
  }

  /** Выставить примеры рамок, если этого ещё не делали на этом сервере. */
  function seedSamples() {
    if (store.getMeta('shop_samples')) return 0;
    let n = 0;
    for (const x of SAMPLES) {
      let data;
      try {
        data = fs.readFileSync(path.join(SAMPLES_DIR, x.file));
      } catch {
        continue;
      }
      const mime = sniffMime(data.subarray(0, 16));
      if (!mime || !SHOP_KINDS[x.kind].mimes.includes(mime)) continue;
      const id = randomBytes(8).toString('hex');
      fs.writeFileSync(fileOf(id), data, { mode: 0o600 });
      store.addShopItem({ id, kind: x.kind, name: x.name, price: x.price, premium: x.premium, size: data.length });
      store.shopReceived(id, data.length);
      store.shopReady(id, mime);
      n++;
    }
    store.setMeta('shop_samples', String(Date.now()));
    if (n) say(`магазин: добавлены примеры рамок (${n})`);
    return n;
  }

  /** Брошенные загрузки (старше суток) — удалить. */
  function purge() {
    for (const id of store.staleShopUploads(Date.now() - 86400_000)) remove(id);
  }

  const cors = {
    'Access-Control-Allow-Origin': '*', // приложения (app://, Android) забирают файлы со своих адресов
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Range',
    'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Content-Type',
    'Access-Control-Max-Age': '86400',
  };
  function handleHttp(req, res) {
    const m = /^\/api\/shop\/([^/]+)$/.exec(new URL(req.url, 'http://x').pathname);
    if (!m) return false;
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors).end();
      return true;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, cors).end();
      return true;
    }
    const item = SHOP_ID_RE.test(m[1]) ? store.shopItem(m[1]) : null;
    let size = 0;
    try {
      if (item?.ready) size = fs.statSync(fileOf(item.id)).size;
    } catch {}
    if (!size) {
      res.writeHead(404, { ...cors, 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }).end('Не найдено');
      return true;
    }
    const headers = {
      ...cors,
      'Content-Type': item.mime,
      'Cache-Control': 'public, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Accept-Ranges': 'bytes',
    };
    const r = /^bytes=(\d+)-(\d*)$/.exec(String(req.headers.range || ''));
    if (r) {
      const start = Number(r[1]);
      const end = r[2] ? Math.min(Number(r[2]), size - 1) : size - 1;
      if (start > end || start >= size) {
        res.writeHead(416, { ...headers, 'Content-Range': `bytes */${size}` }).end();
        return true;
      }
      res.writeHead(206, { ...headers, 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${size}` });
      if (req.method === 'HEAD') res.end();
      else fs.createReadStream(fileOf(item.id), { start, end }).pipe(res);
      return true;
    }
    res.writeHead(200, { ...headers, 'Content-Length': size });
    if (req.method === 'HEAD') res.end();
    else fs.createReadStream(fileOf(item.id)).pipe(res);
    return true;
  }

  return { newItem, chunk, finish, update, remove, purge, seedSamples, handleHttp, dir };
}

/** Товар для приложения: только то, что нужно показать. */
export const publicItem = (i) => ({ id: i.id, kind: i.kind, name: i.name, price: i.price, premium: i.premium });
