// Сервер-ретранслятор Тайника (протокол v3: X3DH + Double Ratchet, несколько устройств).
// Сервер НЕ видит текст сообщений. В базе (SQLite) лежат только:
//   • публичные ключи: личность аккаунта, подписанный и одноразовые prekey устройств;
//   • очередь зашифрованных конвертов для офлайн-устройств (до подтверждения доставки).
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, createHmac, createHash } from 'node:crypto';
import { acceptUpgrade } from './ws.js';
import { Store } from './store.js';
import { createAdmin } from './admin.js';
import { createWebclipHandler } from './webclip.js';
import { createReleases } from './releases.js';
import { createBlobs } from './blobs.js';
import { createBilling, parsePlans, parseCurrencies } from './billing.js';
import { Vapid, generateVapid, validSubscription, sendPush, PUSH_HOSTS } from './webpush.js';
import { validIdentityPub, verifySignedPreKey, sameIdentity, OPK_LOW_WATER } from '../shared/protocol/keys.js';
import { edVerify, isKey32, te } from '../shared/protocol/primitives.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

const USERNAME_RE = /^[a-z0-9_]{3,32}$/;
const MAX_ENVELOPE = 64 * 1024; // байт на один конверт
const MAX_BLOCKS = 1000; // заблокированных у одного аккаунта
const MAX_OPKS = 200; // одноразовых ключей на устройство
const MAX_DEVICES = 5; // устройств на аккаунт
const MAX_WATCH = 500; // за статусом скольких пользователей может следить одно соединение
const PROVISION_TTL = 10 * 60 * 1000; // канал привязки живёт 10 минут
const AUTH_CONTEXT = 'tainik/v3/auth';
// authPerMin — на IP: за одним адресом (дом, офис) бывает много устройств и аккаунтов,
// и после перезапуска сервера они входят разом
const RATE = { msgsPerSec: 30, bundlesPerMin: 30, provisionsPerMin: 5, authPerMin: 120, ephemeralPerMin: 120, billingPerMin: 6 };
const PUSH_GAP = 4000; // не чаще одного пуша от одного отправителя на устройство за это время

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

const b64 = (buf) => Buffer.from(buf).toString('base64');
// Версия приложения, которую сообщает устройство: «0.21.0», «0.21.0-beta.1» и т. п.
const cleanVersion = (v) => (typeof v === 'string' && /^[0-9A-Za-z][0-9A-Za-z.+-]{0,31}$/.test(v) ? v : null);
const cleanName = (s) => String(s || 'Устройство').replace(/[\u0000-\u001f]/g, '').slice(0, 64) || 'Устройство';

function validOpks(list) {
  return (
    Array.isArray(list) &&
    list.length <= MAX_OPKS &&
    list.every((k) => k && Number.isInteger(k.id) && k.id > 0 && isKey32(k.pub))
  );
}

// Простое ограничение частоты: скользящее окно
function take(bucket, limit, windowMs) {
  const now = Date.now();
  while (bucket.length && now - bucket[0] > windowMs) bucket.shift();
  if (bucket.length >= limit) return false;
  bucket.push(now);
  return true;
}

// ---------- Статика ----------
function serveStatic(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405).end();
    return;
  }
  const url = new URL(req.url, 'http://x');
  let rel;
  try {
    rel = decodeURIComponent(url.pathname);
  } catch {
    res.writeHead(400).end();
    return;
  }
  let base = path.join(ROOT, 'client');
  if (rel.startsWith('/shared/')) {
    base = path.join(ROOT, 'shared');
    rel = rel.slice('/shared'.length);
  }
  // Главная — описание и загрузки; мессенджер — /app
  if (rel === '/' || rel === '') rel = '/landing.html';
  else if (rel === '/app') rel = '/index.html';
  else if (rel === '/app/') {
    res.writeHead(301, { Location: '/app' }).end(); // относительные адреса файлов работают только без слэша
    return;
  }
  const file = path.normalize(path.join(base, rel));
  if (!file.startsWith(base + path.sep)) {
    res.writeHead(403).end();
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Не найдено');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Permissions-Policy': 'camera=(self), microphone=(self), display-capture=(self), speaker-selection=(self), geolocation=()',
      'Content-Security-Policy':
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' ws: wss:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  });
}

// ---------- Сервер ----------
/**
 * @param {object} o
 * @param {boolean} [o.trustProxy]   брать IP клиента из X-Real-IP / X-Forwarded-For (только за своим прокси — nginx)
 * @param {number}  [o.maxConnPerIp]
 * @param {number}  [o.queueTtlDays] сколько дней хранить недоставленные конверты
 */
export function startServer({
  port = 8080,
  host = '0.0.0.0',
  dataDir = path.join(ROOT, 'data'),
  log = true,
  trustProxy = false,
  maxConnPerIp = 100,
  queueTtlDays = 30,
  turn = null, // { secret, host, port = 3478, tlsPort = 5349, ttlHours = 12 }
  stunFallback = 'stun:stun.l.google.com:19302',
  // Web Push: уведомления в браузер, когда вкладка закрыта. false — выключить.
  // { subject: 'mailto:…' | 'https://…', hosts: [...], fetch }
  push = {},
  // Панель администратора: { password, path } (см. server/admin.js). Без пароля выключена.
  admin = null,
  // Домен для профиля iPhone (/tainik.mobileconfig); без него — из заголовка Host
  domain = null,
  // Загрузки с сайта: ретрансляция релизов GitHub { repo: 'owner/name', token?, fetch? }
  releases = null,
  // Вложения: { maxMb = 100, maxTotalGb = 20 } — лимит файла и всего хранилища
  uploads = {},
  // Подписка «Тайник Премиум» через xRocket Pay (см. server/billing.js). Без токена — выключена.
  // { token, webhookSecret, testnet, apiUrl, plans, publicUrl, fetch }
  billing: billingOpts = null,
} = {}) {
  const store = new Store(dataDir, { maxOpks: MAX_OPKS, maxDevices: MAX_DEVICES });
  const online = new Map(); // "user.device" -> conn
  const provisions = new Map(); // pid -> { conn, expires }
  const watchers = new Map(); // username -> Set(conn), кто следит за статусом пользователя
  const connsPerIp = new Map();
  const sockets = new Set(); // все WebSocket-соединения (для корректной остановки)
  const allConns = new Set(); // принятые WebSocket-соединения (для блокировки IP)
  const bans = new Set(store.listBans().map((b) => b.ip)); // заблокированные IP
  const ipBuckets = new Map(); // ip -> { provisions: [], auth: [] }
  let lastLimitLog = 0; // когда последний раз писали в журнал об отказе по лимиту подключений
  // В журнал не пишем имена и IP: метаданные — тоже чувствительные данные.
  const say = (...a) => log && console.log(new Date().toISOString(), ...a);

  // Ключ VAPID создаётся один раз и хранится в базе (попадает в бэкапы):
  // если он сменится, браузерам придётся подписываться заново.
  let vapid = null;
  const pushHosts = push?.hosts || PUSH_HOSTS;
  const pushLast = new Map(); // "user.device|from" -> время последнего пуша
  if (push !== false) {
    let jwk = store.getMeta('vapid');
    if (!jwk) {
      jwk = JSON.stringify(generateVapid());
      store.setMeta('vapid', jwk);
    }
    vapid = new Vapid(JSON.parse(jwk), push.subject || 'mailto:admin@localhost');
  }
  // Пуш на устройство, которое сейчас не в сети. В пуше только тип и имя отправителя —
  // зашифровано ключом браузера, push-сервис содержимого не видит.
  function pushTo(username, deviceId, payload) {
    if (!vapid) return;
    const sub = store.getPushSub(username, deviceId);
    if (!sub) return;
    const k = `${username}.${deviceId}|${payload.t}|${payload.from}`;
    const now = Date.now();
    if (now - (pushLast.get(k) || 0) < PUSH_GAP) return;
    pushLast.set(k, now);
    const topic = createHash('sha256').update(`${payload.t}|${payload.from}`).digest('base64url').slice(0, 22);
    sendPush(sub, payload, { vapid, fetch: push.fetch, topic, ttl: payload.t === 'call' ? 60 : 86400 })
      .then((r) => {
        if (r.gone) store.delPushSub(username, deviceId, sub.endpoint);
        else if (!r.ok) say(`push: ответ ${r.status}`);
      })
      .catch((e) => say('push: ошибка', e?.cause?.code || e?.name || e?.message));
  }

  // Временные учётные данные TURN (схема «TURN REST API», coturn: use-auth-secret).
  // Логин = срок_действия:случайный_ид — имя пользователя на TURN-сервер не попадает.
  function iceServersFor() {
    if (!turn || !turn.secret || !turn.host) return stunFallback ? [{ urls: [stunFallback] }] : [];
    const port = turn.port || 3478;
    const tlsPort = turn.tlsPort || 5349;
    const expires = Math.floor(Date.now() / 1000) + (turn.ttlHours || 12) * 3600;
    const username = `${expires}:${randomBytes(6).toString('hex')}`;
    const credential = createHmac('sha1', turn.secret).update(username).digest('base64');
    const urls = [`turn:${turn.host}:${port}?transport=udp`, `turn:${turn.host}:${port}?transport=tcp`];
    if (tlsPort) urls.push(`turns:${turn.host}:${tlsPort}?transport=tcp`);
    return [{ urls: [`stun:${turn.host}:${port}`] }, { urls, username, credential }];
  }

  const send = (conn, obj) => conn.send(JSON.stringify(obj));
  const error = (conn, code, extra = {}) => send(conn, { type: 'error', code, ...extra });
  const addr = (name, device) => `${name}.${device}`;

  function clientIp(req) {
    if (trustProxy) {
      // nginx из deploy/ ставит X-Real-IP (и X-Forwarded-For)
      const real = String(req.headers['x-real-ip'] || '').trim();
      if (real) return real;
      const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
      if (xff) return xff;
    }
    return req.socket.remoteAddress || 'unknown';
  }
  // IPv4 через IPv6-сокет приходит как ::ffff:1.2.3.4 — храним и сравниваем в обычном виде
  const normIp = (ip) => String(ip || '').trim().replace(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i, '$1').toLowerCase();
  const ipOf = (req) => normIp(clientIp(req));
  const bucketsFor = (ip) => {
    if (!ipBuckets.has(ip)) ipBuckets.set(ip, { provisions: [], auth: [] });
    return ipBuckets.get(ip);
  };

  function onlineDevices(username) {
    return store
      .deviceIds(username)
      .map((d) => online.get(addr(username, d)))
      .filter(Boolean);
  }

  // ---------- Присутствие («в сети» / «был(а) …») ----------
  const isOnline = (name) => store.deviceIds(name).some((d) => online.has(addr(name, d)));
  /** Статус name глазами viewer: кого name заблокировал, видит «был(а) давно», как при скрытом статусе. */
  function presenceOf(name, viewer) {
    const p = store.getPresence(name);
    if (!p) return { username: name, exists: false };
    // Галочку видно всегда, даже если статус «в сети» скрыт
    // Галочку и значок Премиум (а с ним и фото профиля) видно и при скрытом статусе
    if (p.hidden || (viewer && store.hasBlocked(name, viewer))) return { username: name, exists: true, verified: p.verified, premium: p.premium, hidden: true, online: false, lastSeen: null };
    const on = isOnline(name);
    return { username: name, exists: true, verified: p.verified, premium: p.premium, hidden: false, online: on, lastSeen: on ? Date.now() : p.lastSeen };
  }
  function broadcastPresence(name) {
    const set = watchers.get(name);
    if (!set || !set.size) return;
    const p = presenceOf(name);
    for (const c of set) send(c, { type: 'presence', list: [c.meta?.user && !p.hidden && p.exists ? presenceOf(name, c.meta.user) : p] });
  }
  function unwatchAll(conn, state) {
    for (const name of state.watching) {
      const set = watchers.get(name);
      if (!set) continue;
      set.delete(conn);
      if (!set.size) watchers.delete(name);
    }
    state.watching.clear();
  }

  // ---------- Подписка «Тайник Премиум» ----------
  const premiumOf = (name) => {
    const until = store.premiumUntil(name);
    return { active: until > Date.now(), until: until || null };
  };
  /** Подписка изменилась: сказать своим устройствам, а собеседникам — через статус. */
  function premiumChanged(name) {
    const p = premiumOf(name);
    for (const c of onlineDevices(name)) send(c, { type: 'premium', ...p });
    broadcastPresence(name);
  }
  const billingInfo = () => (billing ? { plans: billing.plans, currencies: billing.currencies, testnet: billing.testnet } : null);

  function deliverQueue(username, device) {
    const conn = online.get(addr(username, device));
    if (!conn) return;
    for (const item of store.queueFor(username, device)) {
      send(conn, { type: 'message', qid: item.qid, from: item.from, envelope: item.envelope, ts: item.ts });
    }
  }

  function notifyPrekeyCount(username, device) {
    const conn = online.get(addr(username, device));
    const d = store.getDevice(username, device);
    if (d && conn) send(conn, { type: 'prekey-count', count: store.opkCount(username, device), spkId: d.spk.id });
  }

  async function readDeviceKeys(identity, k) {
    if (!k || !(await verifySignedPreKey(identity, k.spk)) || !validOpks(k.opks)) return null;
    return {
      spk: { id: k.spk.id, pub: k.spk.pub, sig: k.spk.sig },
      opks: k.opks.map((o) => ({ id: o.id, pub: o.pub })),
      name: cleanName(k.deviceName),
    };
  }

  async function handle(conn, state, msg) {
    switch (msg.type) {
      // ----- вход: новый аккаунт, новое устройство или существующее устройство -----
      case 'auth': {
        if (!take(bucketsFor(state.ip).auth, RATE.authPerMin, 60_000)) {
          say('отказ: слишком много входов с одного IP за минуту');
          error(conn, 'rate_limited');
          return conn.close(4006, 'rate limited'); // клиент переподключится позже, а не зависнет
        }
        const username = String(msg.username || '').toLowerCase();
        if (!USERNAME_RE.test(username)) return error(conn, 'bad_username');
        if (!validIdentityPub(msg.identity)) return error(conn, 'bad_keys');
        const identity = { dh: msg.identity.dh, sign: msg.identity.sign };
        const u = store.getUser(username);
        let mode;
        let keys = null;
        if (!u) {
          // Устройство входит в аккаунт, которого больше нет, — его удалил администратор
          if (!msg.register && msg.deviceId != null && !msg.newDevice) return error(conn, 'account_deleted');
          if (!msg.register) return error(conn, 'unknown_account');
          keys = await readDeviceKeys(identity, msg.register);
          if (!keys) return error(conn, 'bad_keys');
          mode = 'register';
        } else {
          if (!sameIdentity(u.identity, identity) || msg.register) return error(conn, 'username_taken');
          if (msg.newDevice) {
            if (store.deviceIds(username).length >= MAX_DEVICES) return error(conn, 'too_many_devices');
            keys = await readDeviceKeys(identity, msg.newDevice);
            if (!keys) return error(conn, 'bad_keys');
            mode = 'link';
          } else {
            if (!store.getDevice(username, Number(msg.deviceId))) return error(conn, 'device_removed');
            mode = 'login';
          }
        }
        state.pending = { username, identity, mode, keys, deviceId: Number(msg.deviceId), appVersion: cleanVersion(msg.appVersion), nonce: b64(randomBytes(32)) };
        return send(conn, { type: 'challenge', nonce: state.pending.nonce });
      }

      case 'auth-proof': {
        const p = state.pending;
        state.pending = null;
        if (!p) return error(conn, 'no_challenge');
        const ok = await edVerify(p.identity.sign, te.encode(`${AUTH_CONTEXT}|${p.username}|${p.nonce}`), String(msg.sig || ''));
        if (!ok) return error(conn, 'auth_failed');
        let deviceId;
        if (p.mode === 'register') {
          deviceId = store.createAccount(p.username, p.identity, p.keys);
          if (!deviceId) return error(conn, 'username_taken');
          say('новый аккаунт');
        } else {
          const u = store.getUser(p.username);
          if (!u || !sameIdentity(u.identity, p.identity)) return error(conn, 'username_taken');
          if (p.mode === 'link') {
            deviceId = store.addDevice(p.username, p.keys);
            if (!deviceId) return error(conn, 'too_many_devices');
            say('привязано устройство');
          } else {
            deviceId = p.deviceId;
            if (!store.getDevice(p.username, deviceId)) return error(conn, 'device_removed');
            store.touchDevice(p.username, deviceId);
          }
        }
        store.touchDevice(p.username, deviceId, Date.now(), state.ip); // последний IP устройства
        if (p.appVersion) store.setAppVersion(p.username, deviceId, p.appVersion);
        const key = addr(p.username, deviceId);
        const prev = online.get(key);
        if (prev && prev !== conn) {
          send(prev, { type: 'error', code: 'logged_in_elsewhere' });
          prev.close(4000, 'replaced');
        }
        const wasOnline = isOnline(p.username);
        state.user = p.username;
        state.device = deviceId;
        if (conn.meta) conn.meta.user = p.username;
        online.set(key, conn);
        if (!wasOnline) broadcastPresence(p.username);
        const d = store.getDevice(p.username, deviceId);
        send(conn, {
          type: 'ready',
          username: p.username,
          deviceId,
          opkCount: store.opkCount(p.username, deviceId),
          spkId: d.spk.id,
          presenceHidden: store.getPresence(p.username)?.hidden || false,
          verified: store.getPresence(p.username)?.verified || false,
          premium: premiumOf(p.username),
          billing: billingInfo(),
          blocks: store.blocksOf(p.username),
          vapidKey: vapid ? vapid.publicKey : null,
          pushEndpoint: store.getPushSub(p.username, deviceId)?.endpoint || null,
        });
        deliverQueue(p.username, deviceId);
        if (p.mode === 'link') {
          for (const c of onlineDevices(p.username)) if (c !== conn) send(c, { type: 'devices-changed' });
        }
        return;
      }

      case 'upload-prekeys': {
        if (!state.user) return error(conn, 'not_authenticated', { reqId: msg.reqId });
        const u = store.getUser(state.user);
        if (!store.getDevice(state.user, state.device)) return error(conn, 'device_removed', { reqId: msg.reqId });
        if (msg.spk) {
          if (!(await verifySignedPreKey(u.identity, msg.spk))) return error(conn, 'bad_keys', { reqId: msg.reqId });
          store.setSpk(state.user, state.device, { id: msg.spk.id, pub: msg.spk.pub, sig: msg.spk.sig });
        }
        if (msg.opks) {
          if (!validOpks(msg.opks)) return error(conn, 'bad_keys', { reqId: msg.reqId });
          store.addOpks(state.user, state.device, msg.opks);
        }
        const spk = store.getDevice(state.user, state.device).spk;
        return send(conn, { type: 'prekeys-ok', reqId: msg.reqId, opkCount: store.opkCount(state.user, state.device), spkId: spk.id });
      }

      case 'get-identity': {
        if (!state.user) return error(conn, 'not_authenticated', { reqId: msg.reqId });
        const username = String(msg.username || '').toLowerCase();
        const u = store.getUser(username);
        return send(conn, { type: 'identity', reqId: msg.reqId, username, identity: u ? u.identity : null });
      }

      // ----- ключи устройств для X3DH (каждый одноразовый ключ выдаётся один раз) -----
      case 'get-bundles': {
        if (!state.user) return error(conn, 'not_authenticated', { reqId: msg.reqId });
        if (!take(state.bundles, RATE.bundlesPerMin, 60_000)) return error(conn, 'rate_limited', { reqId: msg.reqId });
        const username = String(msg.username || '').toLowerCase();
        const u = store.getUser(username);
        if (!u) return send(conn, { type: 'bundles', reqId: msg.reqId, username, bundles: [] });
        let ids = store.deviceIds(username);
        if (Array.isArray(msg.deviceIds)) ids = ids.filter((id) => msg.deviceIds.includes(id));
        if (username === state.user) ids = ids.filter((id) => id !== state.device);
        const bundles = ids.map((id) => {
          const d = store.getDevice(username, id);
          const opk = store.takeOpk(username, id);
          if (store.opkCount(username, id) < OPK_LOW_WATER) notifyPrekeyCount(username, id);
          return { deviceId: id, identity: u.identity, spk: d.spk, opk };
        });
        return send(conn, { type: 'bundles', reqId: msg.reqId, username, bundles });
      }

      // ----- эфемерная отправка (сигнализация звонков): без очереди, только устройствам в сети -----
      // targets: 'all' — все устройства получателя (строгая сверка списка), 'subset' — выбранные
      case 'send-ephemeral': {
        if (!state.user) return error(conn, 'not_authenticated', { reqId: msg.reqId });
        if (!take(state.ephemeral, RATE.ephemeralPerMin, 60_000)) return error(conn, 'rate_limited', { reqId: msg.reqId });
        const to = String(msg.to || '').toLowerCase();
        if (!store.getUser(to)) return error(conn, 'unknown_recipient', { reqId: msg.reqId });
        if (typeof msg.id !== 'string' || msg.id.length > 64 || !Array.isArray(msg.messages) || (!msg.messages.length && msg.targets !== 'all')) {
          return error(conn, 'bad_envelope', { reqId: msg.reqId });
        }
        const expected = store.deviceIds(to).filter((d) => !(to === state.user && d === state.device));
        const given = msg.messages.map((m) => m && m.deviceId);
        const extra = given.filter((d) => !expected.includes(d));
        const missing = msg.targets === 'all' ? expected.filter((d) => !given.includes(d)) : [];
        if (missing.length || extra.length || new Set(given).size !== given.length) {
          return error(conn, 'mismatched_devices', { reqId: msg.reqId, to, missing, extra: [...new Set(extra)] });
        }
        for (const { deviceId, envelope: env } of msg.messages) {
          const ok =
            env &&
            typeof env === 'object' &&
            env.v === 3 &&
            env.id === msg.id &&
            env.from === state.user &&
            env.fromDevice === state.device &&
            env.to === to &&
            env.toDevice === deviceId &&
            JSON.stringify(env).length <= MAX_ENVELOPE;
          if (!ok) return error(conn, 'bad_envelope', { reqId: msg.reqId });
        }
        // Получатель заблокировал отправителя: звонок молча «не доходит»
        if (to !== state.user && store.hasBlocked(to, state.user)) return send(conn, { type: 'sent-ephemeral', reqId: msg.reqId, id: msg.id, delivered: [] });
        const delivered = [];
        for (const { deviceId, envelope } of msg.messages) {
          const rc = online.get(addr(to, deviceId));
          if (!rc) continue;
          send(rc, { type: 'message', qid: null, from: state.user, envelope, ts: Date.now(), ephemeral: true });
          delivered.push(deviceId);
        }
        // Звонок, который не дошёл ни до одного устройства, — «пропущенный» в пуше
        if (msg.notify === 'call' && !delivered.length && to !== state.user) {
          for (const d of expected) pushTo(to, d, { t: 'call', from: state.user });
        }
        return send(conn, { type: 'sent-ephemeral', reqId: msg.reqId, id: msg.id, delivered });
      }

      // ----- серверы ICE для звонков: STUN и временные учётные данные TURN -----
      case 'get-ice': {
        if (!state.user) return error(conn, 'not_authenticated', { reqId: msg.reqId });
        return send(conn, { type: 'ice', reqId: msg.reqId, iceServers: iceServersFor(state.user) });
      }

      // ----- отправка: по копии на каждое устройство получателя -----
      case 'send': {
        if (!state.user) return error(conn, 'not_authenticated', { cid: msg.cid });
        const to = String(msg.to || '').toLowerCase();
        if (!store.getUser(to)) return error(conn, 'unknown_recipient', { cid: msg.cid });
        if (typeof msg.id !== 'string' || msg.id.length > 64 || !Array.isArray(msg.messages)) {
          return error(conn, 'bad_envelope', { cid: msg.cid });
        }
        const expected = store.deviceIds(to).filter((d) => !(to === state.user && d === state.device));
        const given = msg.messages.map((m) => m && m.deviceId);
        const missing = expected.filter((d) => !given.includes(d));
        const extra = given.filter((d) => !expected.includes(d));
        if (missing.length || extra.length || new Set(given).size !== given.length) {
          return error(conn, 'mismatched_devices', { cid: msg.cid, to, missing, extra: [...new Set(extra)] });
        }
        for (const { deviceId, envelope: env } of msg.messages) {
          const ok =
            env &&
            typeof env === 'object' &&
            env.v === 3 &&
            env.id === msg.id &&
            env.from === state.user &&
            env.fromDevice === state.device &&
            env.to === to &&
            env.toDevice === deviceId &&
            JSON.stringify(env).length <= MAX_ENVELOPE;
          if (!ok) return error(conn, 'bad_envelope', { cid: msg.cid });
        }
        // Получатель заблокировал отправителя: как в Telegram — «отправлено», но не доставляется
        if (to !== state.user && store.hasBlocked(to, state.user)) return send(conn, { type: 'sent', cid: msg.cid, id: msg.id, to });
        const now = Date.now();
        for (const { deviceId, envelope } of msg.messages) {
          const item = { qid: b64(randomBytes(12)), from: state.user, envelope, ts: now };
          if (!store.enqueue(to, deviceId, item)) continue; // уже в очереди (повторная отправка)
          const rc = online.get(addr(to, deviceId));
          if (rc) send(rc, { type: 'message', qid: item.qid, from: item.from, envelope, ts: now });
          else if (msg.notify === true && to !== state.user) pushTo(to, deviceId, { t: 'msg', from: state.user });
        }
        return send(conn, { type: 'sent', cid: msg.cid, id: msg.id, to });
      }

      case 'ack': {
        if (!state.user) return;
        const qids = Array.isArray(msg.qids) ? msg.qids.slice(0, 500) : [];
        for (const { from, envId } of store.ack(state.user, state.device, qids)) {
          if (msg.receipt !== false && from !== state.user) {
            for (const sc of onlineDevices(from)) send(sc, { type: 'delivered', id: envId, to: state.user });
          }
        }
        return;
      }

      // ----- управление своими устройствами -----
      case 'list-devices': {
        if (!state.user) return error(conn, 'not_authenticated', { reqId: msg.reqId });
        const devices = store.listDevices(state.user).map(({ lastIp, ...d }) => {
          const c = online.get(addr(state.user, d.id));
          return {
            ...d,
            online: !!c,
            lastSeen: c ? Date.now() : d.lastSeen,
            ip: c?.meta?.ip || lastIp, // текущий IP или последний, с которого подключалось
            current: d.id === state.device,
          };
        });
        return send(conn, { type: 'devices', reqId: msg.reqId, devices });
      }

      case 'unlink-device': {
        if (!state.user) return error(conn, 'not_authenticated', { reqId: msg.reqId });
        const id = Number(msg.deviceId);
        if (id === state.device || !store.removeDevice(state.user, id)) return error(conn, 'bad_device', { reqId: msg.reqId });
        const victim = online.get(addr(state.user, id));
        if (victim) {
          send(victim, { type: 'error', code: 'device_removed' });
          victim.close(4001, 'removed');
        }
        say('устройство отвязано');
        broadcastPresence(state.user);
        for (const c of onlineDevices(state.user)) send(c, { type: 'devices-changed' });
        return send(conn, { type: 'device-unlinked', reqId: msg.reqId, deviceId: id });
      }

      // ----- канал привязки нового устройства -----
      case 'provision-open': {
        if (!take(bucketsFor(state.ip).provisions, RATE.provisionsPerMin, 60_000)) return error(conn, 'rate_limited');
        const pid = b64(randomBytes(8));
        provisions.set(pid, { conn, expires: Date.now() + PROVISION_TTL });
        state.pids.push(pid);
        return send(conn, { type: 'provision-id', pid, ttl: PROVISION_TTL });
      }

      case 'provision-send': {
        if (!state.user) return error(conn, 'not_authenticated', { reqId: msg.reqId });
        const p = provisions.get(String(msg.pid || ''));
        if (!p || p.expires < Date.now()) return error(conn, 'provision_not_found', { reqId: msg.reqId });
        const payload = msg.payload;
        if (!payload || typeof payload.epub !== 'string' || typeof payload.ct !== 'string' || payload.ct.length > 100_000) {
          return error(conn, 'bad_payload', { reqId: msg.reqId });
        }
        provisions.delete(String(msg.pid));
        send(p.conn, { type: 'provision-message', payload: { epub: payload.epub, ct: payload.ct } });
        return send(conn, { type: 'provision-sent', reqId: msg.reqId });
      }

      // ----- присутствие -----
      case 'presence-subscribe': {
        if (!state.user) return error(conn, 'not_authenticated', { reqId: msg.reqId });
        const names = [...new Set((Array.isArray(msg.names) ? msg.names : []).map((n) => String(n).toLowerCase()))]
          .filter((n) => USERNAME_RE.test(n) && n !== state.user)
          .slice(0, MAX_WATCH);
        if (msg.replace) unwatchAll(conn, state);
        for (const n of names) {
          if (state.watching.size >= MAX_WATCH) break;
          state.watching.add(n);
          if (!watchers.has(n)) watchers.set(n, new Set());
          watchers.get(n).add(conn);
        }
        return send(conn, { type: 'presence', reqId: msg.reqId, list: names.map((n) => presenceOf(n, state.user)) });
      }

      // ----- чёрный список (общий для всех своих устройств) -----
      case 'block': {
        if (!state.user) return error(conn, 'not_authenticated', { reqId: msg.reqId });
        const name = String(msg.username || '').toLowerCase();
        if (!USERNAME_RE.test(name) || name === state.user) return error(conn, 'bad_username', { reqId: msg.reqId });
        if (msg.on && store.blocksOf(state.user).length >= MAX_BLOCKS) return error(conn, 'too_many_blocks', { reqId: msg.reqId });
        store.setBlocked(state.user, name, !!msg.on);
        const list = store.blocksOf(state.user);
        for (const c of onlineDevices(state.user)) if (c !== conn) send(c, { type: 'blocks', list });
        // Заблокированный сразу перестаёт видеть статус (или снова видит)
        const watching = watchers.get(state.user);
        if (watching) for (const c of watching) if (c.meta?.user === name) send(c, { type: 'presence', list: [presenceOf(state.user, name)] });
        return send(conn, { type: 'blocks', reqId: msg.reqId, list });
      }

      case 'set-presence-visibility': {
        if (!state.user) return error(conn, 'not_authenticated', { reqId: msg.reqId });
        store.setPresenceHidden(state.user, !msg.visible);
        broadcastPresence(state.user);
        return send(conn, { type: 'presence-visibility', reqId: msg.reqId, visible: !!msg.visible });
      }

      // ----- Web Push: подписка браузера этого устройства (null — отписаться) -----
      case 'push-subscribe': {
        if (!state.user) return error(conn, 'not_authenticated', { reqId: msg.reqId });
        if (msg.subscription == null) {
          store.delPushSub(state.user, state.device);
          return send(conn, { type: 'push-subscribed', reqId: msg.reqId, enabled: false });
        }
        if (!vapid) return error(conn, 'push_disabled', { reqId: msg.reqId });
        const sub = msg.subscription;
        if (!validSubscription(sub, pushHosts)) return error(conn, 'bad_subscription', { reqId: msg.reqId });
        store.setPushSub(state.user, state.device, { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } });
        return send(conn, { type: 'push-subscribed', reqId: msg.reqId, enabled: true });
      }

      // ----- вложения: разрешение на загрузку зашифрованного файла -----
      case 'blob-new': {
        if (!state.user) return error(conn, 'not_authenticated', { reqId: msg.reqId });
        try {
          const b = blobs.newUpload(state.user, msg.size);
          return send(conn, { type: 'blob-created', reqId: msg.reqId, ...b });
        } catch (e) {
          return error(conn, e.code || 'bad_size', { reqId: msg.reqId });
        }
      }

      // ----- подписка: счёт на оплату и проверка оплаты -----
      case 'premium-buy': {
        if (!state.user) return error(conn, 'not_authenticated', { reqId: msg.reqId });
        if (!billing) return error(conn, 'billing_disabled', { reqId: msg.reqId });
        if (!take(state.billing, RATE.billingPerMin, 60_000)) return error(conn, 'rate_limited', { reqId: msg.reqId });
        try {
          const inv = await billing.createInvoice(state.user, String(msg.plan || ''), msg.currency == null ? undefined : String(msg.currency));
          return send(conn, { type: 'premium-invoice', reqId: msg.reqId, ...inv });
        } catch (e) {
          const known = ['bad_plan', 'bad_currency', 'no_rate', 'billing_unavailable'];
          // Пояснение xRocket (например, про минимальную сумму) — пользователю, чтобы было понятно, что не так
          const extra = e.code === 'billing_failed' ? { reason: String(e.detail || ''), detail: e.text || '' } : {};
          return error(conn, known.includes(e.code) ? e.code : 'billing_failed', { reqId: msg.reqId, ...extra });
        }
      }

      case 'premium-check': {
        if (!state.user) return error(conn, 'not_authenticated', { reqId: msg.reqId });
        if (billing && take(state.billing, RATE.billingPerMin, 60_000)) await billing.check(state.user).catch(() => {});
        return send(conn, { type: 'premium', reqId: msg.reqId, ...premiumOf(state.user) });
      }

      case 'ping':
        return send(conn, { type: 'pong' });

      // Диагностика сети (/diag.html): эхо и «скачать N КБ» по WebSocket, без входа.
      // Ограничено частотой и размером — нагрузку не создаст.
      case 'diag-echo': {
        if (!take(state.diag, 20, 60_000)) return error(conn, 'rate_limited', { reqId: msg.reqId });
        const data = typeof msg.data === 'string' ? msg.data.slice(0, 200_000) : '';
        const down = Math.min(Math.max(0, Number(msg.down) || 0), 200) * 1024;
        return send(conn, { type: 'diag-echo', reqId: msg.reqId, got: data.length, data: down ? randomBytes(Math.ceil(down * 0.75)).toString('base64').slice(0, down) : '' });
      }

      default:
        return error(conn, 'unknown_type');
    }
  }

  const startedAt = Date.now();
  // Данные для панели администратора: IP — только у открытых сейчас соединений
  function adminOverview() {
    const now = Date.now();
    let onlineUsers = 0;
    let devicesTotal = 0;
    let queued = 0;
    const users = store.adminOverview().map((u) => {
      const devices = u.devices.map((d) => {
        const conn = online.get(addr(u.name, d.id));
        return {
          id: d.id,
          name: d.name,
          createdAt: d.createdAt,
          online: !!conn,
          lastSeen: conn ? now : d.lastSeen,
          ip: conn?.meta?.ip ?? null,
          lastIp: d.lastIp,
          appVersion: d.appVersion,
          since: conn?.meta?.since ?? null,
        };
      });
      const isOn = devices.some((d) => d.online);
      if (isOn) onlineUsers++;
      devicesTotal += devices.length;
      queued += u.queued;
      return { ...u, devices, online: isOn, lastSeen: Math.max(0, ...devices.map((d) => d.lastSeen || 0)) || null };
    });
    return {
      version: VERSION,
      now,
      startedAt,
      totals: { users: users.length, online: onlineUsers, devices: devicesTotal, connections: online.size, queued, media: store.blobStats() },
      users,
      bans: store.listBans(),
      billing: billing ? { plans: billing.plans, currencies: billing.currencies, testnet: billing.testnet, webhook: billing.webhook, active: store.premiumActiveCount(), payments: store.recentPayments(30) } : null,
    };
  }
  // Действия администратора
  const adminActions = {
    deleteUser(name) {
      name = String(name || '').toLowerCase();
      if (!USERNAME_RE.test(name) || !store.getUser(name)) throw new Error('Нет такого пользователя');
      for (const c of onlineDevices(name)) {
        send(c, { type: 'error', code: 'account_deleted' });
        c.close(4003, 'deleted');
      }
      store.deleteUser(name);
      for (const k of [...online.keys()]) if (k.startsWith(name + '.')) online.delete(k);
      broadcastPresence(name);
      say('администратор удалил аккаунт');
    },
    // Официальная галочка: видна всем собеседникам сразу (через подписку на статус)
    setVerified(name, on) {
      name = String(name || '').toLowerCase();
      if (!USERNAME_RE.test(name) || !store.getUser(name)) throw new Error('Нет такого пользователя');
      store.setVerified(name, !!on);
      broadcastPresence(name);
      for (const c of onlineDevices(name)) send(c, { type: 'verified', verified: !!on });
      say(on ? 'администратор поставил галочку' : 'администратор снял галочку');
    },
    // Подписка вручную: days > 0 — продлить на столько дней, 0 — отключить сразу
    setPremium(name, days) {
      name = String(name || '').toLowerCase();
      if (!USERNAME_RE.test(name) || !store.getUser(name)) throw new Error('Нет такого пользователя');
      days = Number(days);
      if (!Number.isInteger(days) || days < 0 || days > 3650) throw new Error('Дней: целое число от 0 до 3650');
      if (days) store.extendPremium(name, days);
      else store.revokePremium(name);
      premiumChanged(name);
      say(days ? 'администратор продлил подписку' : 'администратор отключил подписку');
    },
    ban(ip, note = '') {
      ip = normIp(ip);
      if (!net.isIP(ip)) throw new Error('Неверный IP-адрес');
      store.addBan(ip, String(note || '').slice(0, 200));
      bans.add(ip);
      // Отключить всех, кто сейчас подключён с этого адреса
      for (const c of allConns) {
        if (c.meta?.ip !== ip) continue;
        send(c, { type: 'error', code: 'ip_banned' });
        c.close(4004, 'banned');
      }
      say('администратор заблокировал IP');
    },
    unban(ip) {
      ip = normIp(ip);
      store.removeBan(ip);
      bans.delete(ip);
    },
  };
  const adminHandler = admin?.password
    ? createAdmin({ password: admin.password, basePath: admin.path, overview: adminOverview, actions: adminActions, clientIp: ipOf, say })
    : null;
  if (adminHandler) say('панель администратора включена');
  const webclip = createWebclipHandler({ root: ROOT, domain, dataDir });
  const releasesHandler = releases?.repo ? createReleases({ ...releases, say, clientIp: ipOf }) : null;
  const blobs = createBlobs({
    dataDir,
    store,
    maxBytes: (uploads.maxMb ?? 100) * 1024 * 1024,
    maxTotalBytes: (uploads.maxTotalGb ?? 20) * 1024 ** 3,
    ttlDays: queueTtlDays,
    say,
  });

  const billing = billingOpts?.token
    ? createBilling({ ...billingOpts, store, say, onPaid: (name) => premiumChanged(name) })
    : null;
  if (billing) say(`подписка включена (xRocket Pay${billing.testnet ? ', тестовая сеть' : ''}${billing.webhook ? '' : ', без вебхука — только опрос'})`);

  // Диагностика сети: скачать N КБ и отправить до 1 МБ (для /diag.html)
  const diagHits = new Map(); // ip → [время запросов]
  function handleDiag(req, res) {
    const url = new URL(req.url, 'http://x');
    if (!url.pathname.startsWith('/api/diag/')) return false;
    const reply = (status, obj) => res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(obj));
    const ip = ipOf(req);
    if (!diagHits.has(ip)) diagHits.set(ip, []);
    if (!take(diagHits.get(ip), 30, 60_000)) return reply(429, { error: 'rate_limited' }), true;
    if (url.pathname === '/api/diag/down' && req.method === 'GET') {
      const kb = Math.min(Math.max(1, Number(url.searchParams.get('kb')) || 64), 1024);
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': kb * 1024, 'Cache-Control': 'no-store' });
      res.end(randomBytes(kb * 1024));
      return true;
    }
    if (url.pathname === '/api/diag/up' && req.method === 'POST') {
      let n = 0;
      req.on('data', (c) => {
        n += c.length;
        if (n > 1024 * 1024) req.destroy();
      });
      req.on('end', () => reply(200, { got: n }));
      req.on('error', () => {});
      return true;
    }
    reply(404, { error: 'not_found' });
    return true;
  }

  const server = http.createServer((req, res) => {
    if (adminHandler && adminHandler(req, res)) return; // панель доступна и с заблокированного IP
    if (billing && billing.handleHttp(req, res)) return; // вебхук xRocket Pay — до проверки банов
    if (bans.has(ipOf(req))) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Доступ запрещён');
      return;
    }
    if (webclip(req, res)) return; // профиль iPhone; /ios → страница установки
    if (releasesHandler && releasesHandler(req, res)) return; // /api/releases, /download/…
    if (blobs.handleHttp(req, res)) return; // /api/blob/… — зашифрованные вложения
    if (handleDiag(req, res)) return; // /api/diag/… — проверка сети
    if (req.url === '/healthz') {
      let ok = false;
      try {
        ok = store.check();
      } catch {}
      res.writeHead(ok ? 200 : 503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ ok, version: VERSION }));
      return;
    }
    serveStatic(req, res);
  });
  server.headersTimeout = 15_000;
  server.requestTimeout = 30_000;

  server.on('upgrade', (req, socket) => {
    if (new URL(req.url, 'http://x').pathname !== '/ws') {
      socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
      return;
    }
    const ip = ipOf(req);
    if (bans.has(ip)) {
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    const n = connsPerIp.get(ip) || 0;
    if (n >= maxConnPerIp) {
      // Отказ не молча (браузер не показывает код ответа на WebSocket): открываем соединение,
      // сообщаем причину и закрываем — приложение покажет её и попробует позже
      const now = Date.now();
      if (now - lastLimitLog > 60_000) {
        lastLimitLog = now;
        say(`отказ: больше ${maxConnPerIp} подключений с одного IP (MAX_CONN_PER_IP)`);
      }
      acceptUpgrade(req, socket, (conn) => {
        send(conn, { type: 'error', code: 'too_many_connections', limit: maxConnPerIp });
        conn.close(4005, 'too many connections');
      });
      return;
    }
    connsPerIp.set(ip, n + 1);
    sockets.add(socket);
    socket.once('close', () => {
      sockets.delete(socket);
      const left = (connsPerIp.get(ip) || 1) - 1;
      if (left > 0) connsPerIp.set(ip, left);
      else connsPerIp.delete(ip);
    });
    acceptUpgrade(
      req,
      socket,
      (conn) => {
        conn.meta = { ip, since: Date.now() }; // для панели администратора, на диск не пишется
        allConns.add(conn);
        const state = { ip, user: null, device: null, pending: null, msgs: [], bundles: [], ephemeral: [], billing: [], diag: [], pids: [], watching: new Set() };
        let chain = Promise.resolve(); // сообщения обрабатываются строго по порядку
        conn.on('message', (text) => {
          if (!take(state.msgs, RATE.msgsPerSec, 1000)) return error(conn, 'rate_limited');
          let msg;
          try {
            msg = JSON.parse(text);
          } catch {
            return error(conn, 'bad_json');
          }
          if (!msg || typeof msg !== 'object') return error(conn, 'bad_json');
          chain = chain.then(() => handle(conn, state, msg)).catch((e) => say('ошибка', e?.message || e));
        });
        conn.on('close', () => {
          allConns.delete(conn);
          for (const pid of state.pids) provisions.delete(pid);
          unwatchAll(conn, state);
          if (!state.user) return;
          const key = addr(state.user, state.device);
          if (online.get(key) === conn) online.delete(key);
          if (!store.closed) {
            store.touchDevice(state.user, state.device);
            if (!isOnline(state.user)) broadcastPresence(state.user);
          }
        });
      },
      { maxPayload: 256 * 1024 }
    );
  });

  // Пинг «мёртвых» соединений, уборка просроченных каналов привязки и счётчиков
  const heartbeat = setInterval(() => {
    for (const conn of online.values()) {
      if (!conn.alive) {
        conn.socket.destroy();
        continue;
      }
      conn.alive = false;
      conn.ping();
    }
    const now = Date.now();
    for (const [pid, p] of provisions) if (p.expires < now) provisions.delete(pid);
    for (const [k, t] of pushLast) if (now - t > PUSH_GAP) pushLast.delete(k);
    for (const [ip, b] of diagHits) if (!b.length || now - b[b.length - 1] > 60_000) diagHits.delete(ip);
    for (const [ip, b] of ipBuckets) {
      take(b.provisions, Infinity, 60_000);
      take(b.auth, Infinity, 60_000);
      b.provisions.pop();
      b.auth.pop();
      if (!b.provisions.length && !b.auth.length && !connsPerIp.has(ip)) ipBuckets.delete(ip);
    }
  }, 30_000);
  // Недоставленные конверты старше срока хранения удаляются
  const purge = () => {
    const n = store.purgeOlderThan(queueTtlDays * 86400_000);
    if (n) say(`удалено просроченных конвертов: ${n}`);
    blobs.purge();
  };
  const janitor = setInterval(purge, 3600_000);
  purge();
  // Подписка: у кого закончилась — сообщить; неоплаченные счета — сверить (если вебхук потерялся)
  let premiumTick = Date.now();
  const premiumTimer = setInterval(() => {
    const now = Date.now();
    for (const name of store.premiumEndedBetween(premiumTick, now)) premiumChanged(name);
    premiumTick = now;
    billing?.reconcile().catch(() => {});
  }, 5 * 60_000);

  return new Promise((resolve) => {
    server.listen(port, host, () => {
      const actual = server.address().port;
      say(`Тайник ${VERSION} (протокол v3) слушает ${host}:${actual}`);
      resolve({
        port: actual,
        store,
        purge,
        async close() {
          clearInterval(heartbeat);
          clearInterval(janitor);
          clearInterval(premiumTimer);
          for (const s of sockets) s.destroy();
          server.closeAllConnections?.();
          await new Promise((r) => server.close(r));
          await new Promise((r) => setImmediate(r));
          store.closed = true;
          store.close();
        },
      });
    });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const env = process.env;
  const srv = await startServer({
    port: Number(env.PORT) || 8080,
    host: env.HOST || '0.0.0.0',
    dataDir: env.DATA_DIR || undefined,
    trustProxy: env.TRUST_PROXY === '1',
    maxConnPerIp: Number(env.MAX_CONN_PER_IP) || 100,
    queueTtlDays: Number(env.QUEUE_TTL_DAYS) || 30,
    turn: env.TURN_SECRET
      ? {
          secret: env.TURN_SECRET,
          host: env.TURN_HOST || env.DOMAIN,
          port: Number(env.TURN_PORT) || 3478,
          tlsPort: env.TURNS_PORT === '0' ? 0 : Number(env.TURNS_PORT) || 5349,
        }
      : null,
    stunFallback: env.STUN_FALLBACK ?? 'stun:stun.l.google.com:19302',
    push:
      env.WEB_PUSH === '0'
        ? false
        : {
            subject:
              env.VAPID_SUBJECT ||
              (env.ACME_EMAIL ? `mailto:${env.ACME_EMAIL}` : env.DOMAIN ? `https://${env.DOMAIN}` : undefined),
          },
    domain: env.DOMAIN || null,
    uploads: { maxMb: Number(env.MAX_UPLOAD_MB) || 100, maxTotalGb: Number(env.MAX_STORAGE_GB) || 20 },
    releases: env.RELEASES_REPO ? { repo: env.RELEASES_REPO.trim(), token: env.GITHUB_TOKEN || null } : null,
    admin: env.ADMIN_PASSWORD ? { password: env.ADMIN_PASSWORD, path: env.ADMIN_PATH || '/adminadminadmin' } : null,
    billing: env.XROCKET_PAY_TOKEN
      ? {
          token: env.XROCKET_PAY_TOKEN.trim(),
          webhookSecret: (env.XROCKET_WEBHOOK_SECRET || '').trim() || null,
          testnet: env.XROCKET_TESTNET === '1',
          plans: parsePlans(env.PREMIUM_PLANS || '30:3', env.PREMIUM_CURRENCY || 'USDT'),
          currencies: parseCurrencies(env.PREMIUM_PAY_CURRENCIES ?? 'GRAM,TRX', (env.PREMIUM_CURRENCY || 'USDT').trim().toUpperCase()),
          publicUrl: env.DOMAIN ? `https://${env.DOMAIN}` : null,
        }
      : null,
  });
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await srv.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
