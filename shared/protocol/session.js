// Сессии поверх X3DH + Double Ratchet. По смыслу соответствует SessionBuilder +
// SessionCipher из libsignal, а хранилище — их интерфейсам *Store. Чтобы
// перейти на libsignal, достаточно реализовать эти же функции через неё.
//
// Сессия устанавливается между парой УСТРОЙСТВ: адрес = { name, device }.
//
// ProtocolStore (все методы async):
//   getLocalIdentity()        → { username, deviceId, identity }
//   getSignedPreKey(id)       → { id, pub, priv, sig } | null
//   getOneTimePreKey(id)      → { id, pub, priv } | null
//   removeOneTimePreKey(id)
//   loadSession(addr)         → { active, archived[] } | null     (addr — строка "name.device")
//   storeSession(addr, record)
import { initiate, respond } from './x3dh.js';
import { ratchetEncrypt, ratchetDecrypt } from './ratchet.js';
import { pad, unpad, te, td, randomId } from './primitives.js';

export const ENVELOPE_VERSION = 3;
const MAX_ARCHIVED = 5;

export class SessionError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

/** Строковый адрес устройства: "alice.2". */
export const addrKey = (a) => `${a.name}.${a.device}`;

const envAad = (env) =>
  te.encode(JSON.stringify(['tainik/v3/env', env.v, env.from, env.fromDevice, env.to, env.toDevice, env.id]));

function archive(record, state) {
  if (!state) return;
  record.archived.unshift(state);
  record.archived.length = Math.min(record.archived.length, MAX_ARCHIVED);
}

async function localAddress(store) {
  const me = await store.getLocalIdentity();
  if (!Number.isInteger(me.deviceId)) throw new SessionError('no_device_id');
  return me;
}

export async function hasSession(store, addr) {
  const r = await store.loadSession(addrKey(addr));
  return !!(r && r.active);
}

/** Личность собеседника, к которой привязана активная сессия с этим устройством. */
export async function sessionIdentity(store, addr) {
  const r = await store.loadSession(addrKey(addr));
  return r && r.active ? r.active.peerIdentity : null;
}

export async function deleteSession(store, addr) {
  await store.storeSession(addrKey(addr), { active: null, archived: [] });
}

/** Начать сессию с устройством по его bundle (X3DH, роль инициатора). */
export async function startSession(store, addr, bundle) {
  const me = await localAddress(store);
  const { state, x3dh } = await initiate(
    { username: addrKey({ name: me.username, device: me.deviceId }), identity: me.identity },
    { username: addrKey(addr), bundle }
  );
  state.pendingPrekey = x3dh; // шлём заголовок X3DH, пока собеседник не ответит
  state.peerIdentity = bundle.identity;
  state.createdAt = Date.now();
  const key = addrKey(addr);
  const record = (await store.loadSession(key)) || { active: null, archived: [] };
  archive(record, record.active);
  record.active = state;
  await store.storeSession(key, record);
}

/**
 * Зашифровать JSON-содержимое для одного устройства. Нужна активная сессия.
 * id — общий идентификатор логического сообщения (одинаков для всех копий).
 */
export async function encrypt(store, addr, content, id = randomId()) {
  const me = await localAddress(store);
  const key = addrKey(addr);
  const record = await store.loadSession(key);
  if (!record || !record.active) throw new SessionError('no_session');
  const env = { v: ENVELOPE_VERSION, from: me.username, fromDevice: me.deviceId, to: addr.name, toDevice: addr.device, id };
  const pt = pad(te.encode(JSON.stringify(content)));
  const { state, header, ct } = await ratchetEncrypt(record.active, pt, envAad(env));
  env.type = state.pendingPrekey ? 'prekey' : 'msg';
  if (state.pendingPrekey) env.x3dh = state.pendingPrekey;
  env.header = header;
  env.ct = ct;
  record.active = state;
  await store.storeSession(key, record);
  return env;
}

/**
 * Расшифровать конверт. Возвращает { id, from, fromDevice, content, peerIdentity, newSession }.
 * Коды ошибок: bad_envelope, wrong_recipient, unknown_spk, opk_used,
 * no_session, duplicate, decrypt_failed, bad_x3dh.
 */
export async function decrypt(store, env) {
  const me = await localAddress(store);
  if (
    !env ||
    env.v !== ENVELOPE_VERSION ||
    typeof env.from !== 'string' ||
    !Number.isInteger(env.fromDevice) ||
    typeof env.id !== 'string'
  ) {
    throw new SessionError('bad_envelope');
  }
  if (env.to !== me.username || env.toDevice !== me.deviceId) throw new SessionError('wrong_recipient');
  if (env.from === me.username && env.fromDevice === me.deviceId) throw new SessionError('bad_envelope');
  const peer = { name: env.from, device: env.fromDevice };
  const key = addrKey(peer);
  const record = (await store.loadSession(key)) || { active: null, archived: [] };
  const aad = envAad(env);
  const all = [record.active, ...record.archived].filter(Boolean);

  const finish = async (state, plaintext, idx, newSession = false) => {
    delete state.pendingPrekey; // собеседник ответил — сессия подтверждена
    if (newSession) {
      archive(record, record.active);
      record.active = state;
    } else if (idx === 0 && record.active) {
      record.active = state;
    } else {
      // сообщение пришло по архивной сессии — делаем её активной (сходимость при одновременном старте)
      const archIdx = record.active ? idx - 1 : idx;
      record.archived.splice(archIdx, 1);
      archive(record, record.active);
      record.active = state;
    }
    await store.storeSession(key, record);
    let content;
    try {
      content = JSON.parse(td.decode(unpad(plaintext)));
    } catch {
      throw new SessionError('decrypt_failed');
    }
    return { id: env.id, from: env.from, fromDevice: env.fromDevice, content, peerIdentity: state.peerIdentity, newSession };
  };

  const errors = [];
  const tryStates = async (states) => {
    for (const [i, st] of states) {
      try {
        const { state, plaintext } = await ratchetDecrypt(st, env.header, env.ct, aad);
        return await finish(state, plaintext, i);
      } catch (e) {
        errors.push(e.code || 'decrypt_failed');
      }
    }
    return null;
  };

  if (env.type === 'prekey') {
    const x = env.x3dh;
    if (!x || typeof x.ek !== 'string') throw new SessionError('bad_x3dh');
    // Повторное prekey-сообщение той же сессии (собеседник ещё не получил ответ)
    const same = all.map((st, i) => [i, st]).filter(([, st]) => st.ek === x.ek);
    if (same.length) {
      const res = await tryStates(same);
      if (res) return res;
      throw new SessionError(errors.includes('duplicate') ? 'duplicate' : 'decrypt_failed');
    }
    const spk = await store.getSignedPreKey(x.spkId);
    if (!spk) throw new SessionError('unknown_spk');
    let opk = null;
    if (x.opkId != null) {
      opk = await store.getOneTimePreKey(x.opkId);
      if (!opk) throw new SessionError('opk_used'); // повтор или уже обработано
    }
    let state;
    try {
      state = await respond(
        { username: addrKey({ name: me.username, device: me.deviceId }), identity: me.identity, spk, opk },
        { username: key, x3dh: x }
      );
    } catch (e) {
      throw new SessionError(e.code || 'bad_x3dh');
    }
    state.ek = x.ek;
    state.peerIdentity = x.ik;
    state.createdAt = Date.now();
    let out;
    try {
      out = await ratchetDecrypt(state, env.header, env.ct, aad);
    } catch {
      throw new SessionError('decrypt_failed');
    }
    if (opk) await store.removeOneTimePreKey(opk.id); // одноразовый ключ уничтожен
    return finish(out.state, out.plaintext, -1, true);
  }

  if (env.type === 'msg') {
    if (!all.length) throw new SessionError('no_session');
    const res = await tryStates(all.map((st, i) => [i, st]));
    if (res) return res;
    throw new SessionError(errors.includes('duplicate') ? 'duplicate' : 'decrypt_failed');
  }

  throw new SessionError('bad_envelope');
}
