// Логика клиента (протокол v3: X3DH + Double Ratchet, несколько устройств) без
// привязки к UI и платформе. Используется в вебе, в десктопе (Electron) и подойдёт
// для React Native: нужно передать хранилище (get/set/del/clear, значения — JSON)
// и реализацию WebSocket.
//
// Модель устройств как в Signal: у аккаунта одна личность (ключ личности общий),
// у каждого устройства свои prekey и свои сессии. Сообщение шифруется отдельно
// для каждого устройства собеседника и копией — для остальных своих устройств.
import {
  generateIdentity,
  generateSignedPreKey,
  generateOneTimePreKeys,
  publicIdentity,
  publicSpk,
  publicOpk,
  sameIdentity,
  validIdentityPub,
  startSession,
  encrypt,
  decrypt,
  hasSession,
  sessionIdentity,
  deleteSession,
  safetyNumber,
  fingerprint,
  edSign,
  edVerify,
  dh,
  genX25519,
  randomId,
  te,
  createLinkKeys,
  makeLinkCode,
  parseLinkCode,
  sealProvision,
  openProvision,
  LINK_PREFIX,
  OPK_BATCH,
  OPK_LOW_WATER,
  SPK_ROTATE_MS,
  SPK_KEEP_MS,
} from './protocol/index.js';

const SEEN_LIMIT = 5000;
const DELETED_LIMIT = 2000;
const MAX_DELETE = 100;
const REPLY_SNIPPET = 120;

/** Цитата для ответа: кто написал и начало текста. */
function makeReply(orig, me, peer) {
  const body = String(orig.content?.body ?? '').replace(/\s+/g, ' ').trim();
  return { id: orig.id, from: orig.dir === 'out' ? me : peer, body: body.slice(0, REPLY_SNIPPET) };
}

/** Текстовое сообщение из расшифрованного содержимого (только известные поля). */
function cleanText(c, tsFallback = Date.now()) {
  const ts = Number.isFinite(c?.ts) ? c.ts : tsFallback;
  const out = { t: 'text', body: String(c?.body ?? ''), ts };
  const r = c?.reply;
  if (r && typeof r.id === 'string' && typeof r.from === 'string') {
    out.reply = { id: r.id.slice(0, 64), from: r.from.slice(0, 32), body: String(r.body ?? '').slice(0, REPLY_SNIPPET) };
  }
  return out;
}
const REQUEST_TIMEOUT = 10_000;
const PING_TIMEOUT = 8_000;
const MAX_SEND_ATTEMPTS = 4;
const AUTH_CONTEXT = 'tainik/v3/auth';

export const ERROR_TEXT = {
  push_disabled: 'Уведомления на этом сервере выключены',
  bad_subscription: 'Этот браузер не поддерживает уведомления Тайника',
  bad_username: 'Имя: 3–32 символа, латиница в нижнем регистре, цифры и _',
  bad_keys: 'Сервер отклонил ключи',
  username_taken: 'Это имя уже занято',
  unknown_account: 'Такого аккаунта нет на сервере',
  auth_failed: 'Не удалось подтвердить владение ключом',
  logged_in_elsewhere: 'Это устройство открыто в другом окне',
  device_removed: 'Это устройство отвязано от аккаунта',
  too_many_devices: 'Достигнут предел: 5 устройств на аккаунт',
  unknown_recipient: 'Такого пользователя нет',
  too_large: 'Сообщение слишком большое',
  rate_limited: 'Слишком много запросов, подождите',
  timeout: 'Сервер не ответил',
  offline: 'Нет соединения с сервером',
  key_changed: 'Ключ собеседника изменился — сначала проверьте его',
  bad_spk_signature: 'Ключи собеседника не прошли проверку подписи',
  bad_link_code: 'Неверный код привязки',
  provision_not_found: 'Код привязки устарел или уже использован — обновите его на новом устройстве',
  provision_decrypt_failed: 'Не удалось расшифровать данные привязки',
  bad_device: 'Нельзя отвязать это устройство',
  bad_url: 'Неверный адрес сервера',
};

const errorOf = (code) => Object.assign(new Error(ERROR_TEXT[code] || code), { code });

class Emitter {
  constructor() {
    this._h = new Map();
  }
  on(ev, fn) {
    if (!this._h.has(ev)) this._h.set(ev, new Set());
    this._h.get(ev).add(fn);
    return () => this._h.get(ev).delete(fn);
  }
  emit(ev, data) {
    for (const fn of this._h.get(ev) || []) {
      try {
        fn(data);
      } catch (e) {
        console.error(e);
      }
    }
  }
}

export class MessengerClient extends Emitter {
  /**
   * @param {object} o
   * @param {string} o.url        адрес WebSocket, напр. wss://example.com/ws
   * @param {object} o.storage    { get(k), set(k,v), del(k), clear() } — async, значения JSON
   * @param {Function} [o.WebSocketImpl]
   */
  constructor({ url, storage, WebSocketImpl = globalThis.WebSocket }) {
    super();
    this.url = url;
    this.storage = storage;
    this.WS = WebSocketImpl;
    this.account = null;
    this.status = 'offline';
    this.ws = null;
    this._reqId = 0;
    this._pending = new Map();
    this._lock = Promise.resolve();
    this._retry = 0;
    this._stopped = true;
    this._retryTimer = null;
    this._authExtra = null; // register / newDevice при первом входе
    this._inflight = new Set();
    this._pongWaiters = new Set();
    this.pingTimeout = PING_TIMEOUT;
    this.ps = this._protocolStore();
    this.presence = new Map();
    this.presenceHidden = false;
    this.push = { vapidKey: null, endpoint: null }; // Web Push: ключ сервера и текущая подписка этого устройства
  }

  // Хранилище протокола — тот же набор операций, что у Store-интерфейсов libsignal.
  _protocolStore() {
    const s = this.storage;
    const prekeys = async () => (await s.get('prekeys')) || { spks: {}, opks: {} };
    return {
      getLocalIdentity: async () => ({
        username: this.account.username,
        deviceId: this.account.deviceId,
        identity: this.account.identity,
      }),
      getSignedPreKey: async (id) => (await prekeys()).spks[id] || null,
      getOneTimePreKey: async (id) => (await prekeys()).opks[id] || null,
      removeOneTimePreKey: async (id) => {
        const p = await prekeys();
        delete p.opks[id];
        await s.set('prekeys', p);
      },
      loadSession: async (addr) => (await s.get('session:' + addr)) || null,
      storeSession: (addr, record) => s.set('session:' + addr, record),
    };
  }

  // ---------- Аккаунт ----------

  async load() {
    const acc = (await this.storage.get('account')) || null;
    this.account = acc && acc.v === 3 && Number.isInteger(acc.deviceId) ? acc : null; // данные старых версий не подходят
    return this.account;
  }

  async _newDeviceKeys(identity) {
    const spk = await generateSignedPreKey(identity, 1);
    const opks = await generateOneTimePreKeys(1, OPK_BATCH);
    await this.storage.set('prekeys', { spks: { [spk.id]: spk }, opks: Object.fromEntries(opks.map((k) => [k.id, k])) });
    return { spk: publicSpk(spk), opks: opks.map(publicOpk) };
  }

  async _firstLogin(extra, timeout) {
    this._authExtra = extra;
    try {
      await this.connect({ timeout });
    } catch (e) {
      this.disconnect();
      await this.storage.clear();
      this.account = null;
      throw e;
    } finally {
      this._authExtra = null;
    }
    await this.storage.set('account', this.account);
    return this.account;
  }

  /** Новый аккаунт: ключ личности + prekey первого устройства. */
  async register(username, { deviceName = 'Устройство', timeout = 15000 } = {}) {
    username = String(username).trim().toLowerCase();
    const identity = await generateIdentity();
    await this.storage.clear();
    this.account = this._makeAccount(username, identity, deviceName);
    const keys = await this._newDeviceKeys(identity);
    return this._firstLogin({ register: { ...keys, deviceName } }, timeout);
  }

  _makeAccount(username, identity, deviceName) {
    return {
      v: 3,
      username,
      deviceId: null, // выдаёт сервер
      deviceName,
      identity,
      pub: publicIdentity(identity),
      nextOpkId: OPK_BATCH + 1,
      nextSpkId: 2,
      createdAt: Date.now(),
    };
  }

  async reset() {
    this.disconnect();
    await this.storage.clear();
    this.account = null;
  }

  async myFingerprint() {
    return fingerprint(this.account.pub);
  }

  // ---------- Привязка нового устройства ----------

  /**
   * НОВОЕ устройство: открывает канал привязки.
   * onCode(code) вызывается, когда код готов (показать QR / текст).
   * Promise завершается, когда привязка прошла и устройство зарегистрировано.
   */
  linkAsNewDevice({ deviceName = 'Устройство', onCode, timeout = 15000 } = {}) {
    let cancel;
    const done = new Promise((resolve, reject) => {
      let ws;
      let linkKeys;
      let pid;
      let finished = false;
      const fail = (code) => {
        if (finished) return;
        finished = true;
        try {
          ws && ws.close();
        } catch {}
        reject(errorOf(code));
      };
      cancel = () => fail('cancelled');
      (async () => {
        linkKeys = await createLinkKeys();
        try {
          ws = new this.WS(this.url);
        } catch {
          return fail('bad_url');
        }
        ws.onopen = () => ws.send(JSON.stringify({ type: 'provision-open' }));
        ws.onerror = () => {};
        ws.onclose = () => fail('offline');
        ws.onmessage = async (ev) => {
          let msg;
          try {
            msg = JSON.parse(String(ev.data));
          } catch {
            return;
          }
          if (msg.type === 'provision-id') {
            pid = msg.pid;
            const code = makeLinkCode(pid, linkKeys.pub);
            onCode && onCode({ code, qrText: LINK_PREFIX + code, expiresAt: Date.now() + (msg.ttl || 600000) });
          } else if (msg.type === 'provision-message') {
            ws.onclose = null;
            ws.close();
            try {
              const payload = await openProvision(linkKeys, pid, msg.payload);
              await this._completeLink(payload, deviceName, timeout);
              finished = true;
              resolve(this.account);
            } catch (e) {
              finished = true;
              reject(e.code ? e : errorOf(e.message));
            }
          } else if (msg.type === 'error') {
            fail(msg.code);
          }
        };
      })().catch(() => fail('offline'));
    });
    return { done, cancel: () => cancel && cancel() };
  }

  async _completeLink(p, deviceName, timeout) {
    if (!p || p.v !== 1 || typeof p.username !== 'string') throw errorOf('provision_decrypt_failed');
    const identity = p.identity;
    if (!identity?.dh?.priv || !identity?.sign?.priv || !validIdentityPub(publicIdentity(identity))) {
      throw errorOf('provision_decrypt_failed');
    }
    // Проверяем, что приватные части соответствуют публичным
    const probe = te.encode('tainik/v3/probe');
    const sigOk = await edVerify(identity.sign.pub, probe, await edSign(identity.sign.priv, probe));
    const t = await genX25519();
    const [x, y] = [await dh(identity.dh.priv, t.pub), await dh(t.priv, identity.dh.pub)];
    if (!sigOk || x.some((b, i) => b !== y[i])) throw errorOf('provision_decrypt_failed');

    await this.storage.clear();
    this.account = this._makeAccount(p.username, identity, deviceName);
    const contacts = {};
    for (const c of Array.isArray(p.contacts) ? p.contacts : []) {
      if (typeof c?.username !== 'string' || !validIdentityPub(c.keys)) continue;
      contacts[c.username] = { username: c.username, keys: c.keys, verified: !!c.verified, unread: 0, lastTs: Date.now(), pending: [] };
    }
    await this.storage.set('contacts', contacts);
    const keys = await this._newDeviceKeys(identity);
    return this._firstLogin({ newDevice: { ...keys, deviceName } }, timeout);
  }

  /** ПРИВЯЗАННОЕ устройство: передаёт ключ личности и контакты новому устройству по коду. */
  async linkDevice(codeInput) {
    let link;
    try {
      link = parseLinkCode(codeInput);
    } catch {
      throw errorOf('bad_link_code');
    }
    const contacts = Object.values(await this.contacts()).map((c) => ({ username: c.username, keys: c.keys, verified: !!c.verified }));
    const payload = { v: 1, username: this.account.username, identity: this.account.identity, contacts };
    let sealed;
    try {
      sealed = await sealProvision(link, payload);
    } catch {
      throw errorOf('bad_link_code');
    }
    await this._request({ type: 'provision-send', pid: link.pid, payload: sealed });
  }

  async listDevices() {
    return (await this._request({ type: 'list-devices' })).devices;
  }

  async unlinkDevice(deviceId) {
    await this._request({ type: 'unlink-device', deviceId });
    await this._serial(async () => {
      const me = this.account.username;
      const list = ((await this.storage.get('devices:' + me)) || []).filter((d) => d !== deviceId);
      await this.storage.set('devices:' + me, list);
      await deleteSession(this.ps, { name: me, device: deviceId });
    });
  }

  // ---------- Соединение ----------

  /** Подключается и проходит авторизацию. Promise завершается на первом 'ready'. */
  connect({ timeout = 0 } = {}) {
    if (!this.account) return Promise.reject(new Error('Нет аккаунта'));
    this._stopped = false;
    return new Promise((resolve, reject) => {
      const t = timeout ? setTimeout(() => this._fatal('timeout'), timeout) : null;
      this._firstReady = {
        resolve: (v) => (clearTimeout(t), resolve(v)),
        reject: (e) => (clearTimeout(t), reject(e)),
      };
      this._open();
    });
  }

  disconnect() {
    this._stopped = true;
    clearTimeout(this._retryTimer);
    const ws = this.ws;
    this.ws = null;
    this._inflight.clear();
    if (ws) ws.close();
    if (this.status !== 'replaced') this._setStatus('offline');
  }

  _setStatus(s) {
    if (this.status === s) return;
    this.status = s;
    this.emit('status', s);
  }

  _open() {
    clearTimeout(this._retryTimer);
    this._setStatus('connecting');
    let ws;
    try {
      ws = new this.WS(this.url);
    } catch {
      return this._fatal('bad_url');
    }
    this.ws = ws;
    ws.onopen = () => {
      this._send({
        type: 'auth',
        username: this.account.username,
        deviceId: this.account.deviceId ?? undefined,
        identity: this.account.pub,
        ...(this._authExtra || {}),
      });
    };
    ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
      } catch {
        return;
      }
      this._onServer(msg).catch((e) => console.error(e));
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this._dropSocket();
      if (this._stopped) return;
      this._setStatus('offline');
      const delay = Math.min(15000, 1000 * 2 ** this._retry++);
      this._retryTimer = setTimeout(() => this._open(), delay);
    };
    ws.onerror = () => {};
  }

  _dropSocket() {
    const ws = this.ws;
    this.ws = null;
    this._inflight.clear();
    for (const p of this._pending.values()) p.reject(errorOf('offline'));
    this._pending.clear();
    if (ws) {
      ws.onclose = null;
      try {
        ws.close();
      } catch {}
    }
  }

  /**
   * Переподключиться сразу, не дожидаясь таймера (сеть вернулась, телефон проснулся).
   * restart — закрыть и текущее соединение: после смены сети оно может быть «мёртвым».
   */
  reconnectNow({ restart = false } = {}) {
    if (this._stopped || !this.account) return false;
    if (this.ws && !restart) return false;
    clearTimeout(this._retryTimer);
    this._retry = 0;
    if (this.ws) this._dropSocket();
    this._open();
    return true;
  }

  /**
   * Проверяет, что соединение живое: запрос ping должен получить ответ.
   * Нет соединения или ответа — переподключается. Возвращает true, если связь была.
   */
  async checkConnection() {
    if (this._stopped || !this.account) return false;
    if (!this.ws) return (this.reconnectNow(), false);
    if (this.ws.readyState !== 1) return false; // ещё подключаемся
    const ws = this.ws;
    // Сервер отвечает на ping сообщением pong без reqId (так и в старых версиях)
    const alive = await new Promise((resolve) => {
      const t = setTimeout(() => done(false), this.pingTimeout);
      const done = (v) => {
        clearTimeout(t);
        this._pongWaiters.delete(done);
        resolve(v);
      };
      this._pongWaiters.add(done);
      if (!this._send({ type: 'ping' })) done(false);
    });
    if (!alive && this.ws === ws) this.reconnectNow({ restart: true });
    return alive;
  }

  _send(obj) {
    if (!this.ws || this.ws.readyState !== 1) return false;
    this.ws.send(JSON.stringify(obj));
    return true;
  }

  _request(obj) {
    const reqId = ++this._reqId;
    return new Promise((resolve, reject) => {
      if (!this._send({ ...obj, reqId })) return reject(errorOf('offline'));
      const t = setTimeout(() => {
        this._pending.delete(reqId);
        reject(errorOf('timeout'));
      }, REQUEST_TIMEOUT);
      this._pending.set(reqId, {
        resolve: (v) => (clearTimeout(t), resolve(v)),
        reject: (e) => (clearTimeout(t), reject(e)),
      });
    });
  }

  _fatal(code) {
    this._stopped = true;
    if (this._firstReady) {
      this._firstReady.reject(errorOf(code));
      this._firstReady = null;
    }
    this.emit('error', { code, text: ERROR_TEXT[code] || code });
    if (this.ws) this.ws.close();
  }

  async _onServer(msg) {
    if (msg.reqId && this._pending.has(msg.reqId)) {
      const p = this._pending.get(msg.reqId);
      this._pending.delete(msg.reqId);
      return msg.type === 'error' ? p.reject(Object.assign(errorOf(msg.code), { data: msg })) : p.resolve(msg);
    }
    switch (msg.type) {
      case 'challenge': {
        const data = te.encode(`${AUTH_CONTEXT}|${this.account.username}|${msg.nonce}`);
        this._send({ type: 'auth-proof', sig: await edSign(this.account.identity.sign.priv, data) });
        return;
      }
      case 'pong':
        for (const done of [...this._pongWaiters]) done(true);
        return;
      case 'ready':
        this._retry = 0;
        if (this.account.deviceId !== msg.deviceId) {
          this.account.deviceId = msg.deviceId;
          if (!this._authExtra) await this.storage.set('account', this.account);
        }
        this.presenceHidden = !!msg.presenceHidden;
        this.push = { vapidKey: msg.vapidKey || null, endpoint: msg.pushEndpoint || null };
        this._setStatus('online');
        this._subscribePresence().catch(() => {});
        if (this._firstReady) {
          this._firstReady.resolve();
          this._firstReady = null;
        }
        this._pumpOutbox();
        this._maintainPrekeys(msg.opkCount).catch((e) => console.error('prekeys', e));
        return;
      case 'presence':
        this._onPresence(msg.list);
        return;
      case 'prekey-count':
        this._maintainPrekeys(msg.count).catch((e) => console.error('prekeys', e));
        return;
      case 'message':
        return this._serial(() => this._onEnvelope(msg));
      case 'sent-ephemeral':
        return;
      case 'sent':
        return this._serial(() => this._onSent(msg.cid));
      case 'delivered':
        if (msg.to === this.account.username) return;
        return this._serial(() => this._setMsgStatus(msg.to, msg.id, 'delivered'));
      case 'devices-changed':
        this.emit('devices-changed');
        return;
      case 'error': {
        if (msg.code === 'mismatched_devices') return this._serial(() => this._onMismatch(msg));
        if (msg.code === 'device_removed') return this._fatal('device_removed');
        if (msg.code === 'logged_in_elsewhere') {
          this._setStatus('replaced');
          return this._fatal(msg.code);
        }
        if (this._firstReady && ['username_taken', 'auth_failed', 'bad_username', 'bad_keys', 'unknown_account', 'too_many_devices'].includes(msg.code)) {
          return this._fatal(msg.code);
        }
        if (msg.cid) return this._serial(() => this._failOutbox(msg.cid));
        this.emit('error', { code: msg.code, text: ERROR_TEXT[msg.code] || msg.code });
        return;
      }
    }
  }

  // Все изменения состояния — строго по очереди: храповик не терпит гонок.
  _serial(fn) {
    const run = this._lock.then(fn);
    this._lock = run.catch(() => {}); // ошибка уже доставлена вызывающему
    return run;
  }

  // ---------- Prekey: пополнение и ротация ----------

  async _maintainPrekeys(serverOpkCount) {
    return this._serial(async () => {
      const p = (await this.storage.get('prekeys')) || { spks: {}, opks: {} };
      const upload = {};
      if (serverOpkCount < OPK_LOW_WATER) {
        const fresh = await generateOneTimePreKeys(this.account.nextOpkId, OPK_BATCH);
        for (const k of fresh) p.opks[k.id] = k;
        this.account.nextOpkId += OPK_BATCH;
        upload.opks = fresh.map(publicOpk);
      }
      const spks = Object.values(p.spks).sort((a, b) => b.id - a.id);
      if (!spks.length || Date.now() - spks[0].createdAt > SPK_ROTATE_MS) {
        const spk = await generateSignedPreKey(this.account.identity, this.account.nextSpkId++);
        p.spks[spk.id] = spk;
        upload.spk = publicSpk(spk);
      }
      const newestId = Math.max(...Object.keys(p.spks).map(Number));
      for (const s of Object.values(p.spks)) {
        if (s.id !== newestId && Date.now() - s.createdAt > SPK_ROTATE_MS + SPK_KEEP_MS) delete p.spks[s.id];
      }
      if (!upload.opks && !upload.spk) return;
      // Сначала сохраняем приватные части локально, потом публикуем
      await this.storage.set('prekeys', p);
      await this.storage.set('account', this.account);
      await this._request({ type: 'upload-prekeys', ...upload });
    });
  }

  // ---------- Присутствие ----------

  /** Последний известный статус собеседника: { online, lastSeen, hidden } или undefined */
  presenceOf(username) {
    return this.presence.get(username);
  }

  _onPresence(list) {
    for (const p of Array.isArray(list) ? list : []) {
      if (!p || typeof p.username !== 'string') continue;
      this.presence.set(p.username, { online: !!p.online, lastSeen: p.lastSeen || null, hidden: !!p.hidden });
      this.emit('presence', { username: p.username, ...this.presence.get(p.username) });
    }
  }

  async _subscribePresence(names) {
    if (this.status !== 'online') return;
    const all = names || Object.keys(await this.contacts());
    if (!all.length) return;
    const r = await this._request({ type: 'presence-subscribe', names: all, replace: !names });
    this._onPresence(r.list);
  }

  /** Показывать ли другим, что я в сети и когда был(а). */
  async setPresenceVisible(visible) {
    await this._request({ type: 'set-presence-visibility', visible: !!visible });
    this.presenceHidden = !visible;
  }

  /**
   * Подписка Web Push этого устройства (из PushSubscription.toJSON()) или null — отписаться.
   * Сервер будит устройство пушем, только когда оно не в сети.
   */
  async setPushSubscription(sub) {
    const subscription = sub ? { endpoint: sub.endpoint, keys: { p256dh: sub.keys?.p256dh, auth: sub.keys?.auth } } : null;
    await this._request({ type: 'push-subscribe', subscription });
    this.push = { ...this.push, endpoint: subscription ? subscription.endpoint : null };
  }

  // ---------- Контакты ----------

  async contacts() {
    return (await this.storage.get('contacts')) || {};
  }
  async _saveContacts(c) {
    await this.storage.set('contacts', c);
    this.emit('contacts', c);
  }

  async fetchIdentity(username) {
    return (await this._request({ type: 'get-identity', username: String(username).toLowerCase() })).identity;
  }

  /** Добавляет собеседника (ключ личности закрепляется при первом знакомстве — TOFU). */
  async addContact(username) {
    username = String(username).trim().toLowerCase();
    if (username === this.account.username) throw new Error('Это вы');
    const identity = await this.fetchIdentity(username);
    if (!identity) throw errorOf('unknown_recipient');
    if (!this.presence.has(username)) this._subscribePresence([username]).catch(() => {});
    return this._serial(async () => {
      const all = await this.contacts();
      const c = all[username];
      if (!c) {
        all[username] = { username, keys: identity, verified: false, unread: 0, lastTs: Date.now(), pending: [] };
      } else if (!sameIdentity(c.keys, identity) && !sameIdentity(c.keyChanged, identity)) {
        c.keyChanged = identity;
        this.emit('key-changed', c);
      }
      await this._saveContacts(all);
      return all[username];
    });
  }

  async _ensureContact(all, username) {
    if (all[username]) return all[username];
    const identity = await this.fetchIdentity(username);
    if (!identity) return null;
    all[username] = { username, keys: identity, verified: false, unread: 0, lastTs: Date.now(), pending: [] };
    this._subscribePresence([username]).catch(() => {});
    return all[username];
  }

  async markRead(username) {
    return this._serial(async () => {
      const all = await this.contacts();
      if (all[username] && all[username].unread) {
        all[username].unread = 0;
        await this._saveContacts(all);
      }
    });
  }

  async markVerified(username, verified = true) {
    return this._serial(async () => {
      const all = await this.contacts();
      if (!all[username]) return;
      all[username].verified = verified;
      await this._saveContacts(all);
    });
  }

  async _dropSessions(username) {
    for (const d of (await this.storage.get('devices:' + username)) || []) {
      await deleteSession(this.ps, { name: username, device: d });
    }
    await this.storage.set('devices:' + username, []);
  }

  /** Принять новый ключ собеседника: старые сессии удаляются, отметка «проверен» снимается. */
  async acceptNewKey(username) {
    return this._serial(async () => {
      const all = await this.contacts();
      const c = all[username];
      if (!c || !c.keyChanged) return;
      c.keys = c.keyChanged;
      delete c.keyChanged;
      c.verified = false;
      const pending = c.pending || [];
      c.pending = [];
      await this._saveContacts(all);
      await this._dropSessions(username);
      await this._appendMsg(username, { id: 'sys-' + Date.now(), dir: 'sys', ts: Date.now(), content: { t: 'key-accepted' } });
      for (const envelope of pending) await this._onEnvelope({ envelope, from: username, qid: null });
    });
  }

  async safetyNumber(username) {
    const c = (await this.contacts())[username];
    if (!c) return null;
    return safetyNumber(
      { username: this.account.username, identity: this.account.pub },
      { username, identity: c.keyChanged || c.keys }
    );
  }

  // ---------- Сообщения ----------

  async messages(username) {
    return (await this.storage.get('chat:' + username)) || [];
  }

  async _appendMsg(username, m) {
    const list = await this.messages(username);
    list.push(m);
    await this.storage.set('chat:' + username, list);
    this.emit('message', { contact: username, message: m });
  }

  async _setMsgStatus(username, id, status) {
    const list = await this.messages(username);
    const m = list.find((x) => x.id === id && x.dir === 'out');
    if (!m) return;
    const rank = { sending: 0, failed: 0, sent: 1, delivered: 2 };
    if (status !== 'failed' && rank[status] < rank[m.status]) return;
    m.status = status;
    await this.storage.set('chat:' + username, list);
    this.emit('status-change', { contact: username, id, status });
  }

  /** Отправить текст: копия каждому устройству собеседника и каждому своему устройству. */
  /**
   * Отправить текст. replyTo — id сообщения, на которое отвечаем (цитата
   * шифруется вместе с текстом, чтобы её видели и устройства без оригинала).
   */
  async sendText(username, text, { replyTo = null } = {}) {
    text = String(text);
    if (!text.trim()) return;
    await this._serial(async () => {
      const all = await this.contacts();
      const c = all[username];
      if (!c) throw new Error('Нет такого контакта');
      if (c.keyChanged) throw errorOf('key_changed');
      const id = randomId();
      const ts = Date.now();
      const content = { t: 'text', body: text, ts };
      if (replyTo) {
        const orig = (await this.messages(username)).find((m) => m.id === replyTo && m.dir !== 'sys');
        if (orig) content.reply = makeReply(orig, this.account.username, username);
      }
      const outbox = (await this.storage.get('outbox')) || [];
      outbox.push({ id, to: username, kind: 'msg', content, attempts: 0 });
      outbox.push({ id, to: this.account.username, kind: 'sync', content: { t: 'sync-sent', to: username, body: text, ts, reply: content.reply }, attempts: 0 });
      await this.storage.set('outbox', outbox);
      await this._appendMsg(username, { id, dir: 'out', ts, content, status: 'sending' });
      c.lastTs = ts;
      await this._saveContacts(all);
    });
    this._pumpOutbox();
  }

  /**
   * Удалить сообщения. forAll — «удалить у всех»: собеседник и все его
   * устройства тоже удалят их. В любом случае удаление синхронизируется на
   * остальные ваши устройства (как в Telegram).
   */
  async deleteMessages(username, ids, { forAll = false } = {}) {
    ids = [...new Set(ids.map(String))].slice(0, MAX_DELETE);
    if (!ids.length) return;
    await this._serial(async () => {
      const me = this.account.username;
      await this._removeMessages(username, ids);
      // Ещё не отправленные сообщения — просто отменяем
      let outbox = (await this.storage.get('outbox')) || [];
      outbox = outbox.filter((x) => !(ids.includes(x.id) && (x.kind === 'msg' || x.kind === 'sync')));
      const ts = Date.now();
      if (forAll) {
        const c = (await this.contacts())[username];
        if (c && !c.keyChanged) outbox.push({ id: randomId(), to: username, kind: 'ctl', content: { t: 'delete', ids, ts }, attempts: 0 });
      }
      outbox.push({ id: randomId(), to: me, kind: 'ctl', content: { t: 'sync-delete', chat: username, ids, forAll, ts }, attempts: 0 });
      await this.storage.set('outbox', outbox);
    });
    this._pumpOutbox();
  }

  async _removeMessages(chat, ids) {
    const list = await this.messages(chat);
    const keep = list.filter((m) => !ids.includes(m.id));
    const removed = list.length - keep.length;
    await this.storage.set('chat:' + chat, keep);
    // Запоминаем, чтобы запоздавшая копия удалённого сообщения не появилась снова
    const del = (await this.storage.get('deleted:' + chat)) || [];
    for (const id of ids) if (!del.includes(id)) del.push(id);
    await this.storage.set('deleted:' + chat, del.slice(-DELETED_LIMIT));
    if (removed) {
      const all = await this.contacts();
      const c = all[chat];
      if (c && c.unread) {
        c.unread = Math.min(c.unread, keep.filter((m) => m.dir === 'in').length);
        await this._saveContacts(all);
      }
    }
    this.emit('deleted', { contact: chat, ids });
  }

  async _isDeleted(chat, id) {
    return ((await this.storage.get('deleted:' + chat)) || []).includes(id);
  }

  _cid(item) {
    return `${item.id}:${item.to}`;
  }

  async _pumpOutbox() {
    if (this.status !== 'online') return;
    const outbox = (await this.storage.get('outbox')) || [];
    for (const item of outbox) {
      const cid = this._cid(item);
      if (this._inflight.has(cid)) continue;
      this._inflight.add(cid);
      this._serial(() => this._deliver(cid)).catch(async (e) => {
        this._inflight.delete(cid);
        if (e.code === 'offline' || e.code === 'timeout') return; // повторим после переподключения
        await this._serial(() => this._failOutbox(cid, e));
      });
    }
  }

  async _deliver(cid) {
    const outbox = (await this.storage.get('outbox')) || [];
    const item = outbox.find((x) => this._cid(x) === cid);
    if (!item || this.status !== 'online') {
      this._inflight.delete(cid);
      return;
    }
    const name = item.to;
    const expected = await this._expectedIdentity(name);
    const devices = (await this.storage.get('devices:' + name)) || [];
    await this._ensureSessions(name, devices, expected);

    const messages = [];
    for (const d of devices) {
      if (!(await hasSession(this.ps, { name, device: d }))) continue; // устройство исчезло — сервер подскажет
      messages.push({ deviceId: d, envelope: await encrypt(this.ps, { name, device: d }, item.content, item.id) });
    }
    // notify: обычное сообщение — серверу можно разбудить офлайн-устройство пушем (служебные — нет)
    const notify = item.kind === 'msg';
    if (!this._send({ type: 'send', to: name, id: item.id, cid, messages, notify })) this._inflight.delete(cid);
  }

  /** Закреплённая личность получателя (для себя — своя). Бросает key_changed, если ключ изменился. */
  async _expectedIdentity(name) {
    if (name === this.account.username) return this.account.pub;
    const c = (await this.contacts())[name];
    if (!c || c.keyChanged) throw errorOf('key_changed');
    return c.keys;
  }

  /** Устанавливает недостающие сессии X3DH с указанными устройствами собеседника. */
  async _ensureSessions(name, devices, expected) {
    const me = this.account.username;
    const needBundles = [];
    for (const d of devices) {
      const addr = { name, device: d };
      const sid = await sessionIdentity(this.ps, addr);
      if (sid && !sameIdentity(sid, expected)) await deleteSession(this.ps, addr);
      if (!(await hasSession(this.ps, addr))) needBundles.push(d);
    }
    if (needBundles.length) {
      // X3DH: берём bundle нужных устройств (сервер выдаёт одноразовый ключ один раз)
      const { bundles } = await this._request({ type: 'get-bundles', username: name, deviceIds: needBundles });
      for (const b of bundles) {
        if (!sameIdentity(b.identity, expected)) {
          if (name !== me) await this._markKeyChanged(name, b.identity);
          throw errorOf('key_changed');
        }
        try {
          await startSession(this.ps, { name, device: b.deviceId }, b);
        } catch (e) {
          throw errorOf(e.code || 'bad_spk_signature');
        }
      }
    }
  }

  async _markKeyChanged(username, identity) {
    const all = await this.contacts();
    const c = all[username];
    if (!c || sameIdentity(c.keyChanged, identity)) return;
    c.keyChanged = identity;
    await this._saveContacts(all);
    this.emit('key-changed', c);
  }

  // Сервер сообщил, что список устройств получателя другой: обновляем и пробуем снова.
  async _onMismatch({ cid, to, missing = [], extra = [] }) {
    this._inflight.delete(cid);
    await this._applyMismatch(to, missing, extra);
    const outbox = (await this.storage.get('outbox')) || [];
    const item = outbox.find((x) => this._cid(x) === cid);
    if (!item) return;
    item.attempts = (item.attempts || 0) + 1;
    await this.storage.set('outbox', outbox);
    if (item.attempts > MAX_SEND_ATTEMPTS) return this._failOutbox(cid);
    this._inflight.add(cid);
    try {
      await this._deliver(cid);
    } catch (e) {
      this._inflight.delete(cid);
      if (e.code !== 'offline' && e.code !== 'timeout') await this._failOutbox(cid, e);
    }
  }

  async _applyMismatch(to, missing = [], extra = []) {
    let devices = (await this.storage.get('devices:' + to)) || [];
    for (const d of extra) await deleteSession(this.ps, { name: to, device: d });
    devices = devices.filter((d) => !extra.includes(d));
    for (const d of missing) if (!devices.includes(d)) devices.push(d);
    await this.storage.set('devices:' + to, devices);
  }

  // ---------- Эфемерные сообщения (сигнализация звонков) ----------

  /**
   * Отправляет зашифрованное служебное сообщение без очереди: его получат только
   * устройства, которые сейчас в сети. Без deviceIds — всем устройствам собеседника.
   * @returns {Promise<number[]>} номера устройств, которым сообщение доставлено
   */
  async sendEphemeral(name, content, { deviceIds = null, notify = undefined } = {}) {
    name = String(name).toLowerCase();
    let targets = deviceIds ? [...new Set(deviceIds.map(Number))] : null;
    for (let attempt = 0; attempt < 4; attempt++) {
      const { id, messages } = await this._serial(async () => {
        const expected = await this._expectedIdentity(name);
        const me = this.account.username;
        let devices = targets || (await this.storage.get('devices:' + name)) || [];
        if (name === me) devices = devices.filter((d) => d !== this.account.deviceId);
        await this._ensureSessions(name, devices, expected);
        const id = randomId();
        const messages = [];
        for (const d of devices) {
          if (!(await hasSession(this.ps, { name, device: d }))) continue;
          messages.push({ deviceId: d, envelope: await encrypt(this.ps, { name, device: d }, content, id) });
        }
        return { id, messages };
      });
      if (targets && !messages.length) return [];
      try {
        const r = await this._request({ type: 'send-ephemeral', to: name, id, targets: targets ? 'subset' : 'all', messages, notify });
        return r.delivered || [];
      } catch (e) {
        if (e.code !== 'mismatched_devices') throw e;
        const { missing = [], extra = [] } = e.data || {};
        await this._serial(() => this._applyMismatch(name, missing, extra));
        if (targets) targets = targets.filter((d) => !extra.includes(d));
      }
    }
    throw errorOf('mismatched_devices');
  }

  /** Серверы STUN/TURN для звонков (учётные данные TURN временные). */
  async getIceServers() {
    return (await this._request({ type: 'get-ice' })).iceServers || [];
  }

  /** Запись о звонке в истории чата (только на этом устройстве). */
  async logCall(username, info) {
    return this._serial(async () => {
      const all = await this.contacts();
      if (all[username]) {
        all[username].lastTs = Date.now();
        if (info.missed) all[username].unread = (all[username].unread || 0) + 1;
        await this._saveContacts(all);
      }
      await this._appendMsg(username, { id: 'call-' + randomId(8), dir: 'sys', ts: Date.now(), content: { t: 'call', ...info } });
    });
  }

  async _onSent(cid) {
    this._inflight.delete(cid);
    const outbox = (await this.storage.get('outbox')) || [];
    const i = outbox.findIndex((x) => this._cid(x) === cid);
    if (i < 0) return;
    const [item] = outbox.splice(i, 1);
    await this.storage.set('outbox', outbox);
    if (item.kind === 'msg') await this._setMsgStatus(item.to, item.id, 'sent');
  }

  async _failOutbox(cid, err) {
    this._inflight.delete(cid);
    const outbox = (await this.storage.get('outbox')) || [];
    const i = outbox.findIndex((x) => this._cid(x) === cid);
    if (i < 0) return;
    const [item] = outbox.splice(i, 1);
    await this.storage.set('outbox', outbox);
    if (item.kind === 'msg') {
      await this._setMsgStatus(item.to, item.id, 'failed');
      if (err) this.emit('error', { code: err.code, text: err.message });
    }
  }

  async _reject(from, all, reason) {
    await this._saveContacts(all);
    await this._appendMsg(from, { id: 'sys-' + Date.now(), dir: 'sys', ts: Date.now(), content: { t: 'rejected', reason } });
  }

  async _remember(from, id) {
    const seen = (await this.storage.get('seen')) || [];
    seen.push(`${from}|${id}`);
    if (seen.length > SEEN_LIMIT) seen.splice(0, seen.length - SEEN_LIMIT);
    await this.storage.set('seen', seen);
  }

  async _learnDevice(name, device) {
    const list = (await this.storage.get('devices:' + name)) || [];
    if (!list.includes(device)) {
      list.push(device);
      await this.storage.set('devices:' + name, list);
    }
  }

  async _onEnvelope({ qid, from, envelope, ephemeral = false }) {
    const ack = (receipt = true) => qid && this._send({ type: 'ack', qids: [qid], receipt });
    if (!envelope || typeof envelope.id !== 'string' || envelope.from !== from) return ack(false);
    const seen = (await this.storage.get('seen')) || [];
    if (seen.includes(`${from}|${envelope.id}`)) return ack(); // уже получено
    const me = this.account.username;

    // Копия с другого своего устройства (синхронизация отправленных)
    if (from === me) {
      if (envelope.type === 'prekey' && !sameIdentity(envelope.x3dh?.ik, this.account.pub)) return ack(false);
      let res;
      try {
        res = await decrypt(this.ps, envelope);
      } catch {
        return ack(false);
      }
      if (!sameIdentity(res.peerIdentity, this.account.pub)) return ack(false);
      await this._learnDevice(me, res.fromDevice);
      await this._remember(from, res.id);
      const c = res.content;
      if (c?.t === 'sync-delete' && typeof c.chat === 'string' && Array.isArray(c.ids)) {
        await this._removeMessages(c.chat, c.ids.map(String).slice(0, MAX_DELETE));
        return ack(false);
      }
      if (c?.t === 'sync-sent' && typeof c.to === 'string' && c.to !== me) {
        if (await this._isDeleted(c.to, res.id)) return ack(false);
        const all = await this.contacts();
        let contact = null;
        try {
          contact = await this._ensureContact(all, c.to);
        } catch {
          return; // нет связи — сервер пришлёт снова
        }
        if (contact) {
          contact.lastTs = Date.now();
          await this._saveContacts(all);
          const list = await this.messages(c.to);
          if (!list.some((m) => m.id === res.id)) {
            await this._appendMsg(c.to, {
              id: res.id,
              dir: 'out',
              ts: Number.isFinite(c.ts) ? c.ts : Date.now(),
              content: cleanText(c),
              status: 'sent',
            });
          }
        }
      }
      return ack(false);
    }

    const all = await this.contacts();
    let c;
    try {
      c = await this._ensureContact(all, from);
    } catch {
      return; // без подтверждения: сервер пришлёт снова
    }
    if (!c) return ack(false);
    if (c.keyChanged && ephemeral) return; // звонок от собеседника с непроверенным новым ключом — не принимаем
    if (c.keyChanged) {
      (c.pending ||= []).push(envelope);
      await this._saveContacts(all);
      return ack();
    }

    // Новая сессия (prekey) от другой личности: либо собеседник сменил ключ, либо подделка.
    if (envelope.type === 'prekey' && !sameIdentity(envelope.x3dh?.ik, c.keys)) {
      let serverIdentity = null;
      try {
        serverIdentity = await this.fetchIdentity(from);
      } catch {
        return;
      }
      if (serverIdentity && sameIdentity(serverIdentity, envelope.x3dh.ik)) {
        c.keyChanged = serverIdentity;
        (c.pending ||= []).push(envelope);
        await this._saveContacts(all);
        this.emit('key-changed', c);
        return ack();
      }
      await this._reject(from, all, 'identity_mismatch');
      return ack(false);
    }

    let res;
    try {
      res = await decrypt(this.ps, envelope);
    } catch (e) {
      if (e.code === 'duplicate' || e.code === 'opk_used') return ack(false); // повтор — молча
      await this._reject(from, all, e.code || 'decrypt_failed');
      return ack(false);
    }
    if (!sameIdentity(res.peerIdentity, c.keys)) {
      await this._reject(from, all, 'identity_mismatch');
      return ack(false);
    }

    await this._learnDevice(from, res.fromDevice);
    await this._remember(from, res.id);
    if (res.content?.t === 'call') {
      // Сигнализация звонка: в историю не пишется. Устаревшие (старше 2 минут) отбрасываются.
      const age = Date.now() - Number(res.content.ts || 0);
      if (ephemeral && age < 120_000 && age > -60_000) {
        await this._saveContacts(all); // собеседник мог быть добавлен только что
        this.emit('call-signal', { from, fromDevice: res.fromDevice, data: res.content });
      }
      return ack(false);
    }
    if (res.content?.t === 'delete' && Array.isArray(res.content.ids)) {
      await this._removeMessages(from, res.content.ids.map(String).slice(0, MAX_DELETE));
      return ack(false);
    }
    if (res.content?.t !== 'text') return ack(false); // неизвестный тип — игнорируем
    if (await this._isDeleted(from, res.id)) return ack();
    const list = await this.messages(from);
    if (list.some((m) => m.id === res.id && m.dir === 'in')) return ack();
    c.unread = (c.unread || 0) + 1;
    c.lastTs = Date.now();
    await this._saveContacts(all);
    const ts = Number.isFinite(res.content?.ts) ? res.content.ts : Date.now();
    await this._appendMsg(from, { id: res.id, dir: 'in', ts, content: cleanText(res.content, ts) });
    ack();
  }
}

/** Хранилище в памяти (для тестов и как образец адаптера). */
export class MemoryStorage {
  constructor() {
    this.m = new Map();
  }
  async get(k) {
    return this.m.has(k) ? structuredClone(this.m.get(k)) : undefined;
  }
  async set(k, v) {
    this.m.set(k, structuredClone(v));
  }
  async del(k) {
    this.m.delete(k);
  }
  async clear() {
    this.m.clear();
  }
}
