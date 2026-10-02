// Хранилище сервера на встроенном SQLite (node:sqlite, без зависимостей).
// Здесь только публичные ключи и зашифрованные конверты — открытого текста нет.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS users (
  name            TEXT PRIMARY KEY,
  identity_dh     TEXT NOT NULL,
  identity_sign   TEXT NOT NULL,
  next_device_id  INTEGER NOT NULL,
  created_at      INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS devices (
  user        TEXT NOT NULL REFERENCES users(name) ON DELETE CASCADE,
  id          INTEGER NOT NULL,
  name        TEXT NOT NULL,
  spk         TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  last_seen   INTEGER NOT NULL,
  PRIMARY KEY (user, id)
);
CREATE TABLE IF NOT EXISTS opks (
  user    TEXT NOT NULL,
  device  INTEGER NOT NULL,
  id      INTEGER NOT NULL,
  pub     TEXT NOT NULL,
  PRIMARY KEY (user, device, id),
  FOREIGN KEY (user, device) REFERENCES devices(user, id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS queue (
  seq            INTEGER PRIMARY KEY AUTOINCREMENT,
  qid            TEXT NOT NULL UNIQUE,
  user           TEXT NOT NULL,
  device         INTEGER NOT NULL,
  sender         TEXT NOT NULL,
  sender_device  INTEGER NOT NULL,
  env_id         TEXT NOT NULL,
  envelope       TEXT NOT NULL,
  ts             INTEGER NOT NULL,
  FOREIGN KEY (user, device) REFERENCES devices(user, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS queue_dst ON queue(user, device, seq);
CREATE UNIQUE INDEX IF NOT EXISTS queue_dedupe ON queue(user, device, sender, sender_device, env_id);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
-- Подписки Web Push: адрес push-сервиса браузера и его ключи (по одной на устройство)
CREATE TABLE IF NOT EXISTS push_subs (
  user        TEXT NOT NULL,
  device      INTEGER NOT NULL,
  endpoint    TEXT NOT NULL,
  p256dh      TEXT NOT NULL,
  auth        TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (user, device),
  FOREIGN KEY (user, device) REFERENCES devices(user, id) ON DELETE CASCADE
);
-- Заблокированные администратором IP-адреса
CREATE TABLE IF NOT EXISTS ip_bans (
  ip          TEXT PRIMARY KEY,
  note        TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL
);
INSERT OR IGNORE INTO meta(key, value) VALUES ('schema', '3');
`;

export class Store {
  constructor(dir, { maxOpks = 200, maxQueue = 1000, maxDevices = 5 } = {}) {
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, 'tainik.db');
    this.db = new DatabaseSync(this.file);
    this.db.exec(SCHEMA);
    // Миграции
    const cols = this.db.prepare("SELECT name FROM pragma_table_info('users')").all().map((r) => r.name);
    if (!cols.includes('presence_hidden')) this.db.exec('ALTER TABLE users ADD COLUMN presence_hidden INTEGER NOT NULL DEFAULT 0');
    const dcols = this.db.prepare("SELECT name FROM pragma_table_info('devices')").all().map((r) => r.name);
    if (!dcols.includes('last_ip')) this.db.exec('ALTER TABLE devices ADD COLUMN last_ip TEXT'); // последний IP устройства
    this.limits = { maxOpks, maxQueue, maxDevices };
    const q = (sql) => this.db.prepare(sql);
    this.s = {
      user: q('SELECT name, identity_dh, identity_sign, next_device_id FROM users WHERE name = ?'),
      insUser: q('INSERT INTO users(name, identity_dh, identity_sign, next_device_id, created_at) VALUES (?, ?, ?, 2, ?)'),
      bumpDevice: q('UPDATE users SET next_device_id = next_device_id + 1 WHERE name = ?'),
      deviceIds: q('SELECT id FROM devices WHERE user = ? ORDER BY id'),
      device: q('SELECT id, name, spk, created_at, last_seen FROM devices WHERE user = ? AND id = ?'),
      devices: q('SELECT id, name, created_at, last_seen, last_ip FROM devices WHERE user = ? ORDER BY id'),
      insDevice: q('INSERT INTO devices(user, id, name, spk, created_at, last_seen) VALUES (?, ?, ?, ?, ?, ?)'),
      delDevice: q('DELETE FROM devices WHERE user = ? AND id = ?'),
      touch: q('UPDATE devices SET last_seen = ? WHERE user = ? AND id = ?'),
      touchIp: q('UPDATE devices SET last_seen = ?, last_ip = ? WHERE user = ? AND id = ?'),
      delUser: q('DELETE FROM users WHERE name = ?'),
      bans: q('SELECT ip, note, created_at FROM ip_bans ORDER BY created_at DESC'),
      addBan: q('INSERT INTO ip_bans(ip, note, created_at) VALUES (?, ?, ?) ON CONFLICT(ip) DO UPDATE SET note = excluded.note'),
      delBan: q('DELETE FROM ip_bans WHERE ip = ?'),
      setSpk: q('UPDATE devices SET spk = ? WHERE user = ? AND id = ?'),
      insOpk: q('INSERT OR IGNORE INTO opks(user, device, id, pub) VALUES (?, ?, ?, ?)'),
      opkCount: q('SELECT COUNT(*) AS n FROM opks WHERE user = ? AND device = ?'),
      firstOpk: q('SELECT id, pub FROM opks WHERE user = ? AND device = ? ORDER BY id LIMIT 1'),
      delOpk: q('DELETE FROM opks WHERE user = ? AND device = ? AND id = ?'),
      trimOpks: q(
        'DELETE FROM opks WHERE user = ? AND device = ? AND id NOT IN (SELECT id FROM opks WHERE user = ? AND device = ? ORDER BY id DESC LIMIT ?)'
      ),
      enqueue: q(
        'INSERT OR IGNORE INTO queue(qid, user, device, sender, sender_device, env_id, envelope, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ),
      queueCount: q('SELECT COUNT(*) AS n FROM queue WHERE user = ? AND device = ?'),
      dropOldest: q('DELETE FROM queue WHERE seq = (SELECT seq FROM queue WHERE user = ? AND device = ? ORDER BY seq LIMIT 1)'),
      queue: q('SELECT qid, sender, envelope, ts FROM queue WHERE user = ? AND device = ? ORDER BY seq'),
      queueItem: q('SELECT qid, sender, env_id FROM queue WHERE qid = ? AND user = ? AND device = ?'),
      delQueue: q('DELETE FROM queue WHERE qid = ?'),
      purgeOld: q('DELETE FROM queue WHERE ts < ?'),
      presence: q('SELECT u.presence_hidden AS hidden, MAX(d.last_seen) AS last_seen FROM users u LEFT JOIN devices d ON d.user = u.name WHERE u.name = ? GROUP BY u.name'),
      setPresenceHidden: q('UPDATE users SET presence_hidden = ? WHERE name = ?'),
      getMeta: q('SELECT value FROM meta WHERE key = ?'),
      setMeta: q('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
      setPush: q(
        'INSERT INTO push_subs(user, device, endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(user, device) DO UPDATE SET endpoint = excluded.endpoint, p256dh = excluded.p256dh, auth = excluded.auth, created_at = excluded.created_at'
      ),
      getPush: q('SELECT endpoint, p256dh, auth FROM push_subs WHERE user = ? AND device = ?'),
      delPush: q('DELETE FROM push_subs WHERE user = ? AND device = ?'),
      delPushOthers: q('DELETE FROM push_subs WHERE endpoint = ? AND NOT (user = ? AND device = ?)'),
      delPushIf: q('DELETE FROM push_subs WHERE user = ? AND device = ? AND endpoint = ?'),
      adminUsers: q(
        `SELECT u.name, u.created_at, u.presence_hidden AS hidden,
           (SELECT COUNT(*) FROM queue q WHERE q.user = u.name) AS queued,
           (SELECT COUNT(*) FROM push_subs p WHERE p.user = u.name) AS push
         FROM users u ORDER BY u.name`
      ),
      adminDevices: q('SELECT user, id, name, created_at, last_seen, last_ip FROM devices ORDER BY user, id'),
      stats: q('SELECT (SELECT COUNT(*) FROM users) AS users, (SELECT COUNT(*) FROM devices) AS devices, (SELECT COUNT(*) FROM queue) AS queued'),
    };
  }

  tx(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const r = fn();
      this.db.exec('COMMIT');
      return r;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  // ----- пользователи и устройства -----
  getUser(name) {
    const r = this.s.user.get(name);
    return r ? { name: r.name, identity: { dh: r.identity_dh, sign: r.identity_sign }, nextDeviceId: r.next_device_id } : null;
  }
  deviceIds(name) {
    return this.s.deviceIds.all(name).map((r) => r.id);
  }
  getDevice(name, id) {
    const r = this.s.device.get(name, id);
    return r ? { id: r.id, name: r.name, spk: JSON.parse(r.spk), createdAt: r.created_at, lastSeen: r.last_seen } : null;
  }
  listDevices(name) {
    return this.s.devices.all(name).map((r) => ({ id: r.id, name: r.name, createdAt: r.created_at, lastSeen: r.last_seen, lastIp: r.last_ip || null }));
  }
  _insertDevice(name, id, keys, now) {
    this.s.insDevice.run(name, id, keys.name, JSON.stringify(keys.spk), now, now);
    for (const k of keys.opks) this.s.insOpk.run(name, id, k.id, k.pub);
  }
  /** Новый аккаунт с первым устройством. Возвращает 1 или null, если имя занято. */
  createAccount(name, identity, keys) {
    return this.tx(() => {
      if (this.s.user.get(name)) return null;
      const now = Date.now();
      this.s.insUser.run(name, identity.dh, identity.sign, now);
      this._insertDevice(name, 1, keys, now);
      return 1;
    });
  }
  /** Ещё одно устройство аккаунта. Возвращает номер или null при превышении лимита. */
  addDevice(name, keys) {
    return this.tx(() => {
      const u = this.s.user.get(name);
      if (!u || this.s.deviceIds.all(name).length >= this.limits.maxDevices) return null;
      const id = u.next_device_id;
      this.s.bumpDevice.run(name);
      this._insertDevice(name, id, keys, Date.now());
      return id;
    });
  }
  removeDevice(name, id) {
    return this.s.delDevice.run(name, id).changes > 0; // очередь и ключи удаляются каскадом
  }
  /** Отметить время последнего подключения (и IP, если передан). */
  touchDevice(name, id, ts = Date.now(), ip = null) {
    if (ip) this.s.touchIp.run(ts, ip, name, id);
    else this.s.touch.run(ts, name, id);
  }
  /** Удалить аккаунт целиком: устройства, ключи, очередь и подписки удаляются каскадом. */
  deleteUser(name) {
    return this.s.delUser.run(name).changes > 0;
  }

  // ----- блокировки IP -----
  listBans() {
    return this.s.bans.all().map((r) => ({ ip: r.ip, note: r.note, createdAt: r.created_at }));
  }
  addBan(ip, note = '') {
    this.s.addBan.run(ip, note, Date.now());
  }
  removeBan(ip) {
    return this.s.delBan.run(ip).changes > 0;
  }

  // ----- prekey -----
  setSpk(name, id, spk) {
    this.s.setSpk.run(JSON.stringify(spk), name, id);
  }
  addOpks(name, id, opks) {
    this.tx(() => {
      for (const k of opks) this.s.insOpk.run(name, id, k.id, k.pub);
      this.s.trimOpks.run(name, id, name, id, this.limits.maxOpks);
    });
  }
  opkCount(name, id) {
    return this.s.opkCount.get(name, id).n;
  }
  /** Выдаёт одноразовый ключ и сразу удаляет его (выдаётся ровно один раз). */
  takeOpk(name, id) {
    return this.tx(() => {
      const k = this.s.firstOpk.get(name, id);
      if (!k) return null;
      this.s.delOpk.run(name, id, k.id);
      return { id: k.id, pub: k.pub };
    });
  }

  // ----- очередь зашифрованных конвертов -----
  /** Возвращает false, если такой конверт уже в очереди (повторная отправка). */
  enqueue(name, device, item) {
    return this.tx(() => {
      const r = this.s.enqueue.run(
        item.qid,
        name,
        device,
        item.from,
        item.envelope.fromDevice,
        item.envelope.id,
        JSON.stringify(item.envelope),
        item.ts
      );
      if (!r.changes) return false;
      if (this.s.queueCount.get(name, device).n > this.limits.maxQueue) this.s.dropOldest.run(name, device);
      return true;
    });
  }
  queueFor(name, device) {
    return this.s.queue.all(name, device).map((r) => ({ qid: r.qid, from: r.sender, envelope: JSON.parse(r.envelope), ts: r.ts }));
  }
  queueSize(name, device) {
    return this.s.queueCount.get(name, device).n;
  }
  /** Удаляет подтверждённые конверты, возвращает [{ from, envId }] для уведомлений о доставке. */
  ack(name, device, qids) {
    return this.tx(() => {
      const out = [];
      for (const qid of qids) {
        const r = this.s.queueItem.get(String(qid), name, device);
        if (!r) continue;
        this.s.delQueue.run(r.qid);
        out.push({ from: r.sender, envId: r.env_id });
      }
      return out;
    });
  }
  /** Срок хранения недоставленного: старше maxAgeMs — удаляется. */
  purgeOlderThan(maxAgeMs) {
    return this.s.purgeOld.run(Date.now() - maxAgeMs).changes;
  }

  /** { hidden, lastSeen } или null, если пользователя нет */
  getPresence(name) {
    const r = this.s.presence.get(name);
    return r ? { hidden: !!r.hidden, lastSeen: r.last_seen || null } : null;
  }
  setPresenceHidden(name, hidden) {
    this.s.setPresenceHidden.run(hidden ? 1 : 0, name);
  }

  // ----- служебные значения (ключи VAPID) -----
  getMeta(key) {
    return this.s.getMeta.get(key)?.value ?? null;
  }
  setMeta(key, value) {
    this.s.setMeta.run(key, value);
  }

  // ----- подписки Web Push -----
  setPushSub(name, device, sub) {
    // Один браузер — одна подписка: если в нём раньше был другой аккаунт, его подписку убираем
    this.s.delPushOthers.run(sub.endpoint, name, device);
    this.s.setPush.run(name, device, sub.endpoint, sub.keys.p256dh, sub.keys.auth, Date.now());
  }
  getPushSub(name, device) {
    const r = this.s.getPush.get(name, device);
    return r ? { endpoint: r.endpoint, keys: { p256dh: r.p256dh, auth: r.auth } } : null;
  }
  /** Удаляет подписку; с endpoint — только если она не успела смениться. */
  delPushSub(name, device, endpoint = null) {
    if (endpoint) this.s.delPushIf.run(name, device, endpoint);
    else this.s.delPush.run(name, device);
  }

  /** Для панели администратора: пользователи и их устройства (только метаданные). */
  adminOverview() {
    const devices = new Map();
    for (const d of this.s.adminDevices.all()) {
      if (!devices.has(d.user)) devices.set(d.user, []);
      devices.get(d.user).push({ id: d.id, name: d.name, createdAt: d.created_at, lastSeen: d.last_seen, lastIp: d.last_ip || null });
    }
    return this.s.adminUsers.all().map((u) => ({
      name: u.name,
      createdAt: u.created_at,
      presenceHidden: !!u.hidden,
      queued: u.queued,
      push: u.push > 0,
      devices: devices.get(u.name) || [],
    }));
  }

  stats() {
    return this.s.stats.get();
  }
  check() {
    return this.db.prepare('SELECT 1 AS ok').get().ok === 1;
  }
  close() {
    try {
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch {}
    this.db.close();
  }
}
