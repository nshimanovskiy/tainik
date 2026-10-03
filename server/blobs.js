// Вложения (фото, видео, файлы). Сервер хранит только ЗАШИФРОВАННЫЕ данные: клиент шифрует
// файл случайным ключом (AES-256-GCM) до загрузки, а ключ передаёт собеседнику внутри
// сообщения Double Ratchet. Сервер не знает ни ключа, ни имени, ни типа файла.
//
//   WS  blob-new {size}             → {id, token, chunk}   (только после входа)
//   PUT /api/blob/<id>?offset=N     тело — следующая часть (≤ chunk байт), заголовок X-Blob-Token
//   GET /api/blob/<id>              зашифрованный файл (поддерживается Range); id случаен (128 бит)
//
// Загрузка частями по 768 КБ: так она проходит через nginx с client_max_body_size 1m.
// Файлы удаляются через ttlDays дней (как недоставленные сообщения), незаконченные — через сутки.
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';

export const CHUNK = 768 * 1024;
const ID_RE = /^[0-9a-f]{32}$/;

export function createBlobs({ dataDir, store, maxBytes = 100 * 1024 * 1024, maxTotalBytes = 20 * 1024 ** 3, ttlDays = 30, perUserDaily = 2 * 1024 ** 3, say = () => {} }) {
  const dir = path.join(dataDir, 'blobs');
  fs.mkdirSync(dir, { recursive: true });
  const fileOf = (id) => path.join(dir, id);
  const daily = new Map(); // user -> { day, bytes }
  const busy = new Set(); // id загрузки, в которую сейчас пишется часть

  const hashToken = (tok) => createHash('sha256').update(String(tok)).digest('hex');

  /** Новая загрузка. Возвращает { id, token, chunk } или бросает ошибку с кодом. */
  function newUpload(user, size) {
    size = Number(size);
    if (!Number.isInteger(size) || size <= 0) throw Object.assign(new Error('bad_size'), { code: 'bad_size' });
    if (size > maxBytes) throw Object.assign(new Error('too_large'), { code: 'file_too_large' });
    const day = Math.floor(Date.now() / 86400_000);
    const d = daily.get(user);
    const used = d && d.day === day ? d.bytes : 0;
    if (used + size > perUserDaily) throw Object.assign(new Error('quota'), { code: 'upload_quota' });
    if (store.blobsTotal() + size > maxTotalBytes) throw Object.assign(new Error('full'), { code: 'storage_full' });
    daily.set(user, { day, bytes: used + size });
    const id = randomBytes(16).toString('hex');
    const token = randomBytes(24).toString('base64url');
    store.addBlob({ id, owner: user, size, tokenHash: hashToken(token) });
    fs.writeFileSync(fileOf(id) + '.part', Buffer.alloc(0), { mode: 0o600 });
    return { id, token, chunk: CHUNK, maxBytes };
  }

  const cors = {
    'Access-Control-Allow-Origin': '*', // приложения (app://, Android) обращаются со своих адресов; данные зашифрованы
    'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
    'Access-Control-Allow-Headers': 'X-Blob-Token, Content-Type, Range',
    'Access-Control-Expose-Headers': 'Content-Length, Content-Range',
    'Access-Control-Max-Age': '86400',
  };
  function json(res, status, obj) {
    res.writeHead(status, { ...cors, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(obj));
  }

  function put(req, res, id) {
    const b = store.getBlob(id);
    const tok = String(req.headers['x-blob-token'] || '');
    const want = b && Buffer.from(b.token_hash, 'hex');
    const got = Buffer.from(hashToken(tok), 'hex');
    if (!b || b.done || !tok || !timingSafeEqual(want, got)) return json(res, 403, { error: 'forbidden' });
    const offset = Number(new URL(req.url, 'http://x').searchParams.get('offset'));
    if (offset !== b.received) return json(res, 409, { error: 'bad_offset', received: b.received });
    if (busy.has(id)) return json(res, 409, { error: 'busy', received: b.received });
    const declared = Number(req.headers['content-length']);
    if (declared > CHUNK || b.received + declared > b.size) {
      res.setHeader('Connection', 'close');
      json(res, 413, { error: 'too_large' });
      return req.resume();
    }
    busy.add(id);
    const chunks = [];
    let n = 0;
    let failed = false;
    req.on('data', (c) => {
      n += c.length;
      if (n > CHUNK || b.received + n > b.size) {
        failed = true; // дальше только дочитываем (тело ограничено nginx) и отвечаем 413
        chunks.length = 0;
      } else if (!failed) chunks.push(c);
    });
    req.on('error', () => busy.delete(id));
    req.on('close', () => busy.delete(id));
    req.on('end', () => {
      if (failed) return busy.delete(id), json(res, 413, { error: 'too_large' });
      const data = Buffer.concat(chunks);
      try {
        fs.appendFileSync(fileOf(id) + '.part', data);
        const received = b.received + data.length;
        const done = received === b.size;
        if (done) fs.renameSync(fileOf(id) + '.part', fileOf(id));
        store.updateBlob(id, received, done);
        busy.delete(id);
        json(res, 200, { received, done });
      } catch (e) {
        busy.delete(id);
        say('вложение: ошибка записи ' + e.message);
        json(res, 500, { error: 'write_failed' });
      }
    });
  }

  function get(req, res, id) {
    const b = store.getBlob(id);
    if (!b || !b.done) return json(res, 404, { error: 'not_found' });
    const file = fileOf(id);
    let size;
    try {
      size = fs.statSync(file).size;
    } catch {
      return json(res, 404, { error: 'not_found' });
    }
    const headers = {
      ...cors,
      'Content-Type': 'application/octet-stream',
      'Cache-Control': 'private, max-age=86400, immutable',
      'X-Content-Type-Options': 'nosniff',
      'Accept-Ranges': 'bytes',
    };
    const m = /^bytes=(\d+)-(\d*)$/.exec(String(req.headers.range || ''));
    if (m) {
      const start = Number(m[1]);
      const end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
      if (start > end || start >= size) {
        res.writeHead(416, { ...headers, 'Content-Range': `bytes */${size}` });
        return res.end();
      }
      res.writeHead(206, { ...headers, 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${size}` });
      if (req.method === 'HEAD') return res.end();
      return fs.createReadStream(file, { start, end }).pipe(res);
    }
    res.writeHead(200, { ...headers, 'Content-Length': size });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  }

  function handleHttp(req, res) {
    const p = new URL(req.url, 'http://x').pathname;
    const m = /^\/api\/blob\/([^/]+)$/.exec(p);
    if (!m) return false;
    if (!ID_RE.test(m[1])) return json(res, 404, { error: 'not_found' }), true;
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors);
      res.end();
    } else if (req.method === 'PUT') put(req, res, m[1]);
    else if (req.method === 'GET' || req.method === 'HEAD') get(req, res, m[1]);
    else json(res, 405, { error: 'method' });
    return true;
  }

  /** Удалить просроченные файлы и брошенные загрузки. */
  function purge() {
    const ids = store.expiredBlobs(Date.now() - ttlDays * 86400_000, Date.now() - 86400_000);
    for (const id of ids) {
      fs.rmSync(fileOf(id), { force: true });
      fs.rmSync(fileOf(id) + '.part', { force: true });
    }
    store.deleteBlobs(ids);
    if (ids.length) say(`удалено просроченных вложений: ${ids.length}`);
  }

  return { newUpload, handleHttp, purge, dir };
}
