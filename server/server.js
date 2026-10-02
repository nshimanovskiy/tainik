// Сервер-ретранслятор Тайника (протокол v3: X3DH + Double Ratchet, несколько устройств).
// Сервер НЕ видит текст сообщений. В базе (SQLite) лежат только:
//   • публичные ключи: личность аккаунта, подписанный и одноразовые prekey устройств;
//   • очередь зашифрованных конвертов для офлайн-устройств (до подтверждения доставки).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, createHmac } from 'node:crypto';
import { acceptUpgrade } from './ws.js';
import { Store } from './store.js';
import { validIdentityPub, verifySignedPreKey, sameIdentity, OPK_LOW_WATER } from '../shared/protocol/keys.js';
import { edVerify, isKey32, te } from '../shared/protocol/primitives.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

const USERNAME_RE = /^[a-z0-9_]{3,32}$/;
const MAX_ENVELOPE = 64 * 1024; // байт на один конверт
const MAX_OPKS = 200; // одноразовых ключей на устройство
const MAX_DEVICES = 5; // устройств на аккаунт
const MAX_WATCH = 500; // за статусом скольких пользователей может следить одно соединение
const PROVISION_TTL = 10 * 60 * 1000; // канал привязки живёт 10 минут
const AUTH_CONTEXT = 'tainik/v3/auth';
const RATE = { msgsPerSec: 30, bundlesPerMin: 30, provisionsPerMin: 5, authPerMin: 30, ephemeralPerMin: 120 };

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
};

const b64 = (buf) => Buffer.from(buf).toString('base64');
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
  if (rel === '/' || rel === '') rel = '/index.html';
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
      'Permissions-Policy': 'camera=(self), microphone=(self), display-capture=(self), geolocation=()',
      'Content-Security-Policy':
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' ws: wss:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  });
}

// ---------- Сервер ----------
/**
 * @param {object} o
 * @param {boolean} [o.trustProxy]   брать IP клиента из X-Forwarded-For (только за своим прокси, напр. Caddy)
 * @param {number}  [o.maxConnPerIp]
 * @param {number}  [o.queueTtlDays] сколько дней хранить недоставленные конверты
 */
export function startServer({
  port = 8080,
  host = '0.0.0.0',
  dataDir = path.join(ROOT, 'data'),
  log = true,
  trustProxy = false,
  maxConnPerIp = 20,
  queueTtlDays = 30,
  turn = null, // { secret, host, port = 3478, tlsPort = 5349, ttlHours = 12 }
  stunFallback = 'stun:stun.l.google.com:19302',
} = {}) {
  const store = new Store(dataDir, { maxOpks: MAX_OPKS, maxDevices: MAX_DEVICES });
  const online = new Map(); // "user.device" -> conn
  const provisions = new Map(); // pid -> { conn, expires }
  const watchers = new Map(); // username -> Set(conn), кто следит за статусом пользователя
  const connsPerIp = new Map();
  const sockets = new Set(); // все WebSocket-соединения (для корректной остановки)
  const ipBuckets = new Map(); // ip -> { provisions: [], auth: [] }
  // В журнал не пишем имена и IP: метаданные — тоже чувствительные данные.
  const say = (...a) => log && console.log(new Date().toISOString(), ...a);

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
      // nginx из deploy/ ставит X-Real-IP; Caddy — X-Forwarded-For
      const real = String(req.headers['x-real-ip'] || '').trim();
      if (real) return real;
      const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
      if (xff) return xff;
    }
    return req.socket.remoteAddress || 'unknown';
  }
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
  function presenceOf(name) {
    const p = store.getPresence(name);
    if (!p) return { username: name, exists: false };
    if (p.hidden) return { username: name, exists: true, hidden: true, online: false, lastSeen: null };
    const on = isOnline(name);
    return { username: name, exists: true, hidden: false, online: on, lastSeen: on ? Date.now() : p.lastSeen };
  }
  function broadcastPresence(name) {
    const set = watchers.get(name);
    if (!set || !set.size) return;
    const p = presenceOf(name);
    for (const c of set) send(c, { type: 'presence', list: [p] });
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
        if (!take(bucketsFor(state.ip).auth, RATE.authPerMin, 60_000)) return error(conn, 'rate_limited');
        const username = String(msg.username || '').toLowerCase();
        if (!USERNAME_RE.test(username)) return error(conn, 'bad_username');
        if (!validIdentityPub(msg.identity)) return error(conn, 'bad_keys');
        const identity = { dh: msg.identity.dh, sign: msg.identity.sign };
        const u = store.getUser(username);
        let mode;
        let keys = null;
        if (!u) {
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
        state.pending = { username, identity, mode, keys, deviceId: Number(msg.deviceId), nonce: b64(randomBytes(32)) };
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
        const key = addr(p.username, deviceId);
        const prev = online.get(key);
        if (prev && prev !== conn) {
          send(prev, { type: 'error', code: 'logged_in_elsewhere' });
          prev.close(4000, 'replaced');
        }
        const wasOnline = isOnline(p.username);
        state.user = p.username;
        state.device = deviceId;
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
        const delivered = [];
        for (const { deviceId, envelope } of msg.messages) {
          const rc = online.get(addr(to, deviceId));
          if (!rc) continue;
          send(rc, { type: 'message', qid: null, from: state.user, envelope, ts: Date.now(), ephemeral: true });
          delivered.push(deviceId);
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
        const now = Date.now();
        for (const { deviceId, envelope } of msg.messages) {
          const item = { qid: b64(randomBytes(12)), from: state.user, envelope, ts: now };
          if (!store.enqueue(to, deviceId, item)) continue; // уже в очереди (повторная отправка)
          const rc = online.get(addr(to, deviceId));
          if (rc) send(rc, { type: 'message', qid: item.qid, from: item.from, envelope, ts: now });
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
        const devices = store.listDevices(state.user).map((d) => ({
          ...d,
          online: online.has(addr(state.user, d.id)),
          lastSeen: online.has(addr(state.user, d.id)) ? Date.now() : d.lastSeen,
          current: d.id === state.device,
        }));
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
        return send(conn, { type: 'presence', reqId: msg.reqId, list: names.map(presenceOf) });
      }

      case 'set-presence-visibility': {
        if (!state.user) return error(conn, 'not_authenticated', { reqId: msg.reqId });
        store.setPresenceHidden(state.user, !msg.visible);
        broadcastPresence(state.user);
        return send(conn, { type: 'presence-visibility', reqId: msg.reqId, visible: !!msg.visible });
      }

      case 'ping':
        return send(conn, { type: 'pong' });

      default:
        return error(conn, 'unknown_type');
    }
  }

  const server = http.createServer((req, res) => {
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
    const ip = clientIp(req);
    const n = connsPerIp.get(ip) || 0;
    if (n >= maxConnPerIp) {
      socket.end('HTTP/1.1 429 Too Many Requests\r\n\r\n');
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
        const state = { ip, user: null, device: null, pending: null, msgs: [], bundles: [], ephemeral: [], pids: [], watching: new Set() };
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
  };
  const janitor = setInterval(purge, 3600_000);
  purge();

  return new Promise((resolve) => {
    server.listen(port, host, () => {
      const actual = server.address().port;
      say(`Тайник ${VERSION} (протокол v3) слушает ${host}:${actual}`);
      resolve({
        port: actual,
        store,
        async close() {
          clearInterval(heartbeat);
          clearInterval(janitor);
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
    maxConnPerIp: Number(env.MAX_CONN_PER_IP) || 20,
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
