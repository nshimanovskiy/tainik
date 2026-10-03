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
-- Вложения: зашифрованные файлы лежат в папке blobs, здесь — только размер и владелец
CREATE TABLE IF NOT EXISTS blobs (
  id          TEXT PRIMARY KEY,
  owner       TEXT NOT NULL,
  size        INTEGER NOT NULL,
  received    INTEGER NOT NULL DEFAULT 0,
  done        INTEGER NOT NULL DEFAULT 0,
  token_hash  TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS blobs_created ON blobs(created_at);
-- Заблокированные администратором IP-адреса
CREATE TABLE IF NOT EXISTS ip_bans (
  ip          TEXT PRIMARY KEY,
  note        TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL
);
-- Чёрный список: user заблокировал blocked. Сервер не доставляет blocked сообщения и звонки
-- от него к user и не показывает ему статус user. Нужен серверу, иначе блокировку не обеспечить.
CREATE TABLE IF NOT EXISTS blocks (
  user        TEXT NOT NULL REFERENCES users(name) ON DELETE CASCADE,
  blocked     TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (user, blocked)
);
CREATE INDEX IF NOT EXISTS blocks_blocked ON blocks(blocked);
-- Платная подписка «Тайник Премиум»: до какого момента действует (мс). Удаляется вместе с аккаунтом.
CREATE TABLE IF NOT EXISTS premium (
  user   TEXT PRIMARY KEY REFERENCES users(name) ON DELETE CASCADE,
  until  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS premium_until ON premium(until);
-- Счета на оплату подписки (xRocket Pay). id — наш clientInvoiceId. Записи остаются и после
-- удаления аккаунта: это бухгалтерия. Сумма — десятичная строка, как в API xRocket.
CREATE TABLE IF NOT EXISTS payments (
  id          TEXT PRIMARY KEY,
  user        TEXT NOT NULL,
  plan        TEXT NOT NULL,
  days        INTEGER NOT NULL,
  amount      TEXT NOT NULL,
  currency    TEXT NOT NULL,
  invoice_id  TEXT,
  url         TEXT,
  status      TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  paid_at     INTEGER
);
CREATE INDEX IF NOT EXISTS payments_user ON payments(user, created_at);
CREATE INDEX IF NOT EXISTS payments_status ON payments(status, expires_at);
INSERT OR IGNORE INTO meta(key, value) VALUES ('schema', '3');
`;

function paymentRow(r) {
  if (!r) return null;
  return {
    id: r.id,
    user: r.user,
    plan: r.plan,
    days: r.days,
    amount: r.amount,
    currency: r.currency,
    invoiceId: r.invoice_id || null,
    url: r.url || null,
    status: r.status,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    paidAt: r.paid_at || null,
  };
}

/** Аккаунты, которые получают официальную галочку при регистрации. */
export const DEFAULT_VERIFIED = ['admin'];

export class Store {
  constructor(dir, { maxOpks = 200, maxQueue = 1000, maxDevices = 5 } = {}) {
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, 'tainik.db');
    this.db = new DatabaseSync(this.file);
    this.db.exec(SCHEMA);
    // Миграции
    const cols = this.db.prepare("SELECT name FROM pragma_table_info('users')").all().map((r) => r.name);
    if (!cols.includes('presence_hidden')) this.db.exec('ALTER TABLE users ADD COLUMN presence_hidden INTEGER NOT NULL DEFAULT 0');
    if (!cols.includes('verified')) {
      // Официальная «галочка», как в Telegram. Ставит и снимает администратор в панели.
      this.db.exec('ALTER TABLE users ADD COLUMN verified INTEGER NOT NULL DEFAULT 0');
      const mark = this.db.prepare('UPDATE users SET verified = 1 WHERE name = ?');
      for (const n of DEFAULT_VERIFIED) mark.run(n);
    }
    const dcols = this.db.prepare("SELECT name FROM pragma_table_info('devices')").all().map((r) => r.name);
    if (!dcols.includes('last_ip')) this.db.exec('ALTER TABLE devices ADD COLUMN last_ip TEXT'); // последний IP устройства
    if (!dcols.includes('app_version')) this.db.exec('ALTER TABLE devices ADD COLUMN app_version TEXT'); // версия приложения при последнем входе
    this.limits = { maxOpks, maxQueue, maxDevices };
    const q = (sql) => this.db.prepare(sql);
    this.s = {
      user: q('SELECT name, identity_dh, identity_sign, next_device_id FROM users WHERE name = ?'),
      insUser: q('INSERT INTO users(name, identity_dh, identity_sign, next_device_id, created_at) VALUES (?, ?, ?, 2, ?)'),
      bumpDevice: q('UPDATE users SET next_device_id = next_device_id + 1 WHERE name = ?'),
      deviceIds: q('SELECT id FROM devices WHERE user = ? ORDER BY id'),
      device: q('SELECT id, name, spk, created_at, last_seen FROM devices WHERE user = ? AND id = ?'),
      devices: q('SELECT id, name, created_at, last_seen, last_ip, app_version FROM devices WHERE user = ? ORDER BY id'),
      setAppVersion: q('UPDATE devices SET app_version = ? WHERE user = ? AND id = ?'),
      insDevice: q('INSERT INTO devices(user, id, name, spk, created_at, last_seen) VALUES (?, ?, ?, ?, ?, ?)'),
      delDevice: q('DELETE FROM devices WHERE user = ? AND id = ?'),
      touch: q('UPDATE devices SET last_seen = ? WHERE user = ? AND id = ?'),
      touchIp: q('UPDATE devices SET last_seen = ?, last_ip = ? WHERE user = ? AND id = ?'),
      delUser: q('DELETE FROM users WHERE name = ?'),
      bans: q('SELECT ip, note, created_at FROM ip_bans ORDER BY created_at DESC'),
      addBlob: q('INSERT INTO blobs(id, owner, size, token_hash, created_at) VALUES (?, ?, ?, ?, ?)'),
      getBlob: q('SELECT id, owner, size, received, done, token_hash, created_at FROM blobs WHERE id = ?'),
      updBlob: q('UPDATE blobs SET received = ?, done = ? WHERE id = ?'),
      blobsTotal: q('SELECT COALESCE(SUM(size), 0) AS n FROM blobs'),
      blobsExpired: q('SELECT id FROM blobs WHERE created_at < ? OR (done = 0 AND created_at < ?)'),
      delBlob: q('DELETE FROM blobs WHERE id = ?'),
      blobStats: q('SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes FROM blobs WHERE done = 1'),
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
      presence: q(
        'SELECT u.presence_hidden AS hidden, u.verified AS verified, MAX(d.last_seen) AS last_seen, (SELECT until FROM premium p WHERE p.user = u.name) AS premium_until FROM users u LEFT JOIN devices d ON d.user = u.name WHERE u.name = ? GROUP BY u.name'
      ),
      premiumUntil: q('SELECT until FROM premium WHERE user = ?'),
      setPremium: q('INSERT INTO premium(user, until) VALUES (?, ?) ON CONFLICT(user) DO UPDATE SET until = excluded.until'),
      delPremium: q('DELETE FROM premium WHERE user = ?'),
      premiumEnded: q('SELECT user FROM premium WHERE until > ? AND until <= ?'),
      premiumActive: q('SELECT COUNT(*) AS n FROM premium WHERE until > ?'),
      addPayment: q(
        'INSERT INTO payments(id, user, plan, days, amount, currency, status, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ),
      getPayment: q('SELECT * FROM payments WHERE id = ?'),
      setPaymentInvoice: q('UPDATE payments SET invoice_id = ?, url = ?, expires_at = ? WHERE id = ?'),
      setPaymentStatus: q('UPDATE payments SET status = ? WHERE id = ? AND status = ?'),
      markPaid: q("UPDATE payments SET status = 'paid', paid_at = ? WHERE id = ? AND status <> 'paid'"),
      openPaymentOf: q("SELECT * FROM payments WHERE user = ? AND plan = ? AND currency = ? AND status = 'active' AND url IS NOT NULL AND expires_at > ? ORDER BY created_at DESC LIMIT 1"),
      pendingOf: q("SELECT * FROM payments WHERE user = ? AND status = 'active' AND expires_at > ? ORDER BY created_at DESC LIMIT ?"),
      pendingAll: q("SELECT * FROM payments WHERE status = 'active' AND expires_at > ? ORDER BY created_at LIMIT ?"),
      recentPayments: q('SELECT * FROM payments ORDER BY created_at DESC LIMIT ?'),
      setVerified: q('UPDATE users SET verified = ? WHERE name = ?'),
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
        `SELECT u.name, u.created_at, u.presence_hidden AS hidden, u.verified AS verified,
           (SELECT until FROM premium p WHERE p.user = u.name) AS premium_until,
           (SELECT COUNT(*) FROM queue q WHERE q.user = u.name) AS queued,
           (SELECT COUNT(*) FROM push_subs p WHERE p.user = u.name) AS push
         FROM users u ORDER BY u.name`
      ),
      adminDevices: q('SELECT user, id, name, created_at, last_seen, last_ip, app_version FROM devices ORDER BY user, id'),
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
    return this.s.devices.all(name).map((r) => ({ id: r.id, name: r.name, createdAt: r.created_at, lastSeen: r.last_seen, lastIp: r.last_ip || null, appVersion: r.app_version || null }));
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
      if (DEFAULT_VERIFIED.includes(name)) this.s.setVerified.run(1, name);
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
  /** Версия приложения устройства (сообщает само устройство при входе). */
  setAppVersion(name, id, version) {
    this.s.setAppVersion.run(version, name, id);
  }
  /** Удалить аккаунт целиком: устройства, ключи, очередь и подписки удаляются каскадом. */
  deleteUser(name) {
    this.db.prepare('DELETE FROM blocks WHERE blocked = ?').run(name);
    return this.s.delUser.run(name).changes > 0;
  }

  // ----- чёрный список -----
  setBlocked(user, blocked, on) {
    if (on) this.db.prepare('INSERT OR IGNORE INTO blocks(user, blocked, created_at) VALUES (?, ?, ?)').run(user, blocked, Date.now());
    else this.db.prepare('DELETE FROM blocks WHERE user = ? AND blocked = ?').run(user, blocked);
  }
  /** Кого заблокировал user */
  blocksOf(user) {
    return this.db.prepare('SELECT blocked FROM blocks WHERE user = ? ORDER BY created_at').all(user).map((r) => r.blocked);
  }
  /** user заблокировал other? */
  hasBlocked(user, other) {
    return !!this.db.prepare('SELECT 1 FROM blocks WHERE user = ? AND blocked = ?').get(user, other);
  }

  // ----- вложения (зашифрованные файлы) -----
  addBlob({ id, owner, size, tokenHash }) {
    this.s.addBlob.run(id, owner, size, tokenHash, Date.now());
  }
  getBlob(id) {
    const r = this.s.getBlob.get(id);
    return r ? { ...r, done: !!r.done } : null;
  }
  updateBlob(id, received, done) {
    this.s.updBlob.run(received, done ? 1 : 0, id);
  }
  blobsTotal() {
    return this.s.blobsTotal.get().n;
  }
  blobStats() {
    return this.s.blobStats.get();
  }
  expiredBlobs(createdBefore, partialBefore) {
    return this.s.blobsExpired.all(createdBefore, partialBefore).map((r) => r.id);
  }
  deleteBlobs(ids) {
    for (const id of ids) this.s.delBlob.run(id);
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

  /** { hidden, verified, premium, lastSeen } или null, если пользователя нет */
  getPresence(name) {
    const r = this.s.presence.get(name);
    return r ? { hidden: !!r.hidden, verified: !!r.verified, premium: (r.premium_until || 0) > Date.now(), lastSeen: r.last_seen || null } : null;
  }
  setVerified(name, on) {
    return this.s.setVerified.run(on ? 1 : 0, name).changes > 0;
  }
  setPresenceHidden(name, hidden) {
    this.s.setPresenceHidden.run(hidden ? 1 : 0, name);
  }

  // ----- подписка «Тайник Премиум» -----
  /** До какого момента (мс) действует подписка; 0 — не было или удалена. Может быть в прошлом. */
  premiumUntil(name) {
    return this.s.premiumUntil.get(name)?.until || 0;
  }
  /** Продлить на days дней: от конца текущей подписки или от сейчас, если она истекла. */
  extendPremium(name, days, now = Date.now()) {
    return this.tx(() => this._extend(name, days, now));
  }
  _extend(name, days, now) {
    const until = Math.max(now, this.premiumUntil(name)) + days * 86400_000;
    this.s.setPremium.run(name, until);
    return until;
  }
  /** Отключить подписку сразу. */
  revokePremium(name) {
    return this.s.delPremium.run(name).changes > 0;
  }
  /** Чья подписка закончилась в промежутке (from, to] — им и собеседникам нужно сообщить. */
  premiumEndedBetween(from, to) {
    return this.s.premiumEnded.all(from, to).map((r) => r.user);
  }
  premiumActiveCount(now = Date.now()) {
    return this.s.premiumActive.get(now).n;
  }

  // ----- счета на оплату -----
  addPayment({ id, user, plan, days, amount, currency, expiresAt, now = Date.now() }) {
    this.s.addPayment.run(id, user, plan, days, String(amount), currency, 'active', now, expiresAt);
  }
  getPayment(id) {
    return paymentRow(this.s.getPayment.get(String(id)));
  }
  setPaymentInvoice(id, invoiceId, url, expiresAt) {
    this.s.setPaymentInvoice.run(invoiceId, url, expiresAt, id);
  }
  /** Сменить статус неоплаченного счёта (active → expired/cancelled/failed). */
  closePayment(id, status) {
    return this.s.setPaymentStatus.run(status, id, 'active').changes > 0;
  }
  /**
   * Счёт оплачен: отметить и продлить подписку — одной транзакцией и ровно один раз,
   * сколько бы раз ни пришло уведомление. Возвращает { user, until } или null (уже учтён).
   */
  markPaymentPaid(id, now = Date.now()) {
    return this.tx(() => {
      const p = this.getPayment(id);
      if (!p || !this.s.markPaid.run(now, p.id).changes) return null;
      if (!this.s.user.get(p.user)) return { user: p.user, until: 0 }; // аккаунт удалён — платёж учтён, продлевать некого
      return { user: p.user, until: this._extend(p.user, p.days, now) };
    });
  }
  /** Неистёкший счёт этого пользователя на этот тариф (чтобы не плодить новые). */
  openPayment(user, plan, currency, validAfter) {
    return paymentRow(this.s.openPaymentOf.get(user, plan, currency, validAfter));
  }
  pendingPayments(user = null, now = Date.now(), limit = 10) {
    const rows = user ? this.s.pendingOf.all(user, now, limit) : this.s.pendingAll.all(now, limit);
    return rows.map(paymentRow);
  }
  recentPayments(limit = 50) {
    return this.s.recentPayments.all(limit).map(paymentRow);
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
      devices.get(d.user).push({ id: d.id, name: d.name, createdAt: d.created_at, lastSeen: d.last_seen, lastIp: d.last_ip || null, appVersion: d.app_version || null });
    }
    return this.s.adminUsers.all().map((u) => ({
      name: u.name,
      createdAt: u.created_at,
      presenceHidden: !!u.hidden,
      verified: !!u.verified,
      premiumUntil: u.premium_until || null,
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
