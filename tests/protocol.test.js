import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateIdentity,
  generateSignedPreKey,
  generateOneTimePreKeys,
  publicIdentity,
  publicSpk,
  publicOpk,
  startSession,
  encrypt,
  decrypt,
  ratchetDecrypt,
  safetyNumber,
  X3DHError,
  MAX_SKIP,
  te,
} from '../shared/protocol/index.js';

// Хранилище протокола в памяти — тот же интерфейс, что реализует клиент.
async function party(username, { opks = 5, device = 1, identity: sharedIdentity } = {}) {
  const identity = sharedIdentity || (await generateIdentity());
  const spk = await generateSignedPreKey(identity, 1);
  const opkList = await generateOneTimePreKeys(1, opks);
  const db = { spks: new Map([[1, spk]]), opks: new Map(opkList.map((k) => [k.id, k])), sessions: new Map() };
  const store = {
    getLocalIdentity: async () => ({ username, deviceId: device, identity }),
    getSignedPreKey: async (id) => db.spks.get(id) || null,
    getOneTimePreKey: async (id) => db.opks.get(id) || null,
    removeOneTimePreKey: async (id) => void db.opks.delete(id),
    loadSession: async (p) => (db.sessions.has(p) ? structuredClone(db.sessions.get(p)) : null),
    storeSession: async (p, r) => void db.sessions.set(p, structuredClone(r)),
  };
  const serverOpks = opkList.map(publicOpk);
  return {
    username,
    device,
    addr: { name: username, device },
    identity,
    store,
    db,
    // так сервер выдаёт bundle: одноразовый ключ — только один раз
    bundle: (withOpk = true) => ({
      identity: publicIdentity(identity),
      spk: publicSpk(spk),
      opk: withOpk ? serverOpks.shift() || null : null,
    }),
  };
}

const text = (body) => ({ t: 'text', body });
const ADDR = { alice: { name: 'alice', device: 1 }, bob: { name: 'bob', device: 1 } };

async function pair() {
  const a = await party('alice');
  const b = await party('bob');
  await startSession(a.store, ADDR.bob, b.bundle());
  return { a, b };
}

test('X3DH + обмен в обе стороны, prekey до первого ответа', async () => {
  const { a, b } = await pair();
  const e1 = await encrypt(a.store, ADDR.bob, text('привет 1'));
  const e2 = await encrypt(a.store, ADDR.bob, text('привет 2'));
  assert.equal(e1.type, 'prekey');
  assert.equal(e2.type, 'prekey');
  assert.ok(!JSON.stringify(e1).includes('привет'));

  const r1 = await decrypt(b.store, e1);
  assert.equal(r1.content.body, 'привет 1');
  assert.equal(r1.newSession, true);
  assert.deepEqual(r1.peerIdentity, publicIdentity(a.identity));
  assert.equal((await decrypt(b.store, e2)).content.body, 'привет 2');
  assert.equal(b.db.opks.size, 4, 'одноразовый ключ уничтожен');

  const back = await encrypt(b.store, ADDR.alice, text('ответ'));
  assert.equal(back.type, 'msg');
  assert.equal((await decrypt(a.store, back)).content.body, 'ответ');
  const e3 = await encrypt(a.store, ADDR.bob, text('уже обычное'));
  assert.equal(e3.type, 'msg', 'после ответа заголовок X3DH больше не нужен');

  // много раундов с DH-храповиком
  for (let i = 0; i < 20; i++) {
    const [from, to, name] = i % 3 ? [a, b, ADDR.bob] : [b, a, ADDR.alice];
    const env = await encrypt(from.store, name, text('m' + i));
    assert.equal((await decrypt(to.store, env)).content.body, 'm' + i);
  }
  assert.equal((await decrypt(b.store, e3)).content.body, 'уже обычное', 'запоздавшее сообщение тоже расшифровано');
});

test('порядок доставки: перемешанные и потерянные сообщения', async () => {
  const { a, b } = await pair();
  await decrypt(b.store, await encrypt(a.store, ADDR.bob, text('start')));
  await decrypt(a.store, await encrypt(b.store, ADDR.alice, text('ok')));

  const batch1 = [];
  for (let i = 0; i < 5; i++) batch1.push(await encrypt(a.store, ADDR.bob, text('a' + i)));
  await decrypt(a.store, await encrypt(b.store, ADDR.alice, text('перебил')));
  const batch2 = [];
  for (let i = 0; i < 3; i++) batch2.push(await encrypt(a.store, ADDR.bob, text('b' + i)));

  // Сначала новая цепочка, потом старая, вразнобой; a2 потеряно навсегда
  const order = [batch2[2], batch1[4], batch2[0], batch1[0], batch1[3], batch2[1], batch1[1]];
  const got = [];
  for (const env of order) got.push((await decrypt(b.store, env)).content.body);
  assert.deepEqual(got, ['b2', 'a4', 'b0', 'a0', 'a3', 'b1', 'a1']);
});

test('повтор и подделка отклоняются, состояние сессии не портится', async () => {
  const { a, b } = await pair();
  const first = await encrypt(a.store, ADDR.bob, text('один раз'));
  await decrypt(b.store, first);
  await assert.rejects(decrypt(b.store, first), { code: 'duplicate' });
  await decrypt(a.store, await encrypt(b.store, ADDR.alice, text('ок')));

  const env = await encrypt(a.store, ADDR.bob, text('секрет'));
  const flip = (s) => s.slice(0, 10) + (s[10] === 'A' ? 'B' : 'A') + s.slice(11);
  await assert.rejects(decrypt(b.store, { ...env, ct: flip(env.ct) }), { code: 'decrypt_failed' });
  await assert.rejects(decrypt(b.store, { ...env, id: 'подмена' }), { code: 'decrypt_failed' });
  await assert.rejects(decrypt(b.store, { ...env, header: { ...env.header, n: env.header.n + 1 } }), { code: 'decrypt_failed' });
  await assert.rejects(decrypt(b.store, { ...env, to: 'mallory' }), { code: 'wrong_recipient' });
  assert.equal((await decrypt(b.store, env)).content.body, 'секрет', 'настоящее сообщение всё ещё проходит');
  await assert.rejects(decrypt(b.store, env), { code: 'duplicate' });
});

test('повтор первого prekey-сообщения после уничтожения OPK отклоняется', async () => {
  const a = await party('alice');
  const b = await party('bob');
  await startSession(a.store, ADDR.bob, b.bundle());
  const env = await encrypt(a.store, ADDR.bob, text('x'));
  await decrypt(b.store, env);
  // злоумышленник стёр у Боба сессию и повторяет старое сообщение
  b.db.sessions.clear();
  await assert.rejects(decrypt(b.store, env), { code: 'opk_used' });
});

test('подделанная подпись signed prekey и чужая личность', async () => {
  const a = await party('alice');
  const b = await party('bob');
  const m = await party('mallory');
  const forged = { ...b.bundle(), spk: m.bundle().spk }; // SPK Мэллори под личностью Боба
  await assert.rejects(startSession(a.store, ADDR.bob, forged), (e) => e instanceof X3DHError && e.code === 'bad_spk_signature');

  // Мэллори подменяет bundle целиком: сессия создаётся, но с ЕЁ личностью —
  // клиент видит peerIdentity ≠ закреплённой и показывает предупреждение.
  await startSession(a.store, ADDR.bob, m.bundle());
  const env = await encrypt(a.store, ADDR.bob, text('для боба'));
  await assert.rejects(decrypt(b.store, env)); // настоящий Боб прочитать не может (не его ключи)
});

test('bundle без одноразового ключа тоже работает', async () => {
  const a = await party('alice');
  const b = await party('bob', { opks: 0 });
  await startSession(a.store, ADDR.bob, b.bundle(false));
  const env = await encrypt(a.store, ADDR.bob, text('без OPK'));
  assert.equal(env.x3dh.opkId, null);
  assert.equal((await decrypt(b.store, env)).content.body, 'без OPK');
});

test('одновременный старт сессий с двух сторон сходится', async () => {
  const a = await party('alice');
  const b = await party('bob');
  await startSession(a.store, ADDR.bob, b.bundle());
  await startSession(b.store, ADDR.alice, a.bundle());
  const fromA = await encrypt(a.store, ADDR.bob, text('A1'));
  const fromB = await encrypt(b.store, ADDR.alice, text('B1'));
  assert.equal((await decrypt(b.store, fromA)).content.body, 'A1');
  assert.equal((await decrypt(a.store, fromB)).content.body, 'B1');
  for (let i = 0; i < 6; i++) {
    const [from, to, name] = i % 2 ? [a, b, ADDR.bob] : [b, a, ADDR.alice];
    assert.equal((await decrypt(to.store, await encrypt(from.store, name, text('c' + i)))).content.body, 'c' + i);
  }
});

test('восстановление после взлома: старое состояние не читает новые сообщения', async () => {
  const { a, b } = await pair();
  await decrypt(b.store, await encrypt(a.store, ADDR.bob, text('1')));
  await decrypt(a.store, await encrypt(b.store, ADDR.alice, text('2')));
  const stolen = (await b.store.loadSession('alice.1')).active; // злоумышленник копирует состояние Боба
  for (let i = 0; i < 2; i++) {
    await decrypt(b.store, await encrypt(a.store, ADDR.bob, text('x')));
    await decrypt(a.store, await encrypt(b.store, ADDR.alice, text('y')));
  }
  const fresh = await encrypt(a.store, ADDR.bob, text('после восстановления'));
  const aad = te.encode(JSON.stringify(['tainik/v3/env', fresh.v, fresh.from, fresh.fromDevice, fresh.to, fresh.toDevice, fresh.id]));
  await assert.rejects(ratchetDecrypt(stolen, fresh.header, fresh.ct, aad));
  assert.equal((await decrypt(b.store, fresh)).content.body, 'после восстановления');
});

test('слишком большой пропуск сообщений отклоняется', async () => {
  const { a, b } = await pair();
  await decrypt(b.store, await encrypt(a.store, ADDR.bob, text('0')));
  const env = await encrypt(a.store, ADDR.bob, text('далеко'));
  await assert.rejects(decrypt(b.store, { ...env, header: { ...env.header, n: MAX_SKIP + 50 } }), { code: 'decrypt_failed' });
  assert.equal((await decrypt(b.store, env)).content.body, 'далеко');
});

test('код безопасности симметричен', async () => {
  const a = await party('alice');
  const b = await party('bob');
  const A = { username: 'alice', identity: publicIdentity(a.identity) };
  const B = { username: 'bob', identity: publicIdentity(b.identity) };
  const s = await safetyNumber(A, B);
  assert.deepEqual(s, await safetyNumber(B, A));
  assert.equal(s.join('').length, 60);
});

// ---------- Несколько устройств и привязка ----------
import { sealProvision, openProvision, createLinkKeys, makeLinkCode, parseLinkCode, formatLinkCode, toB64, randomBytes } from '../shared/protocol/index.js';

test('несколько устройств: у каждого своя сессия, чужая копия не расшифровывается', async () => {
  const a = await party('alice');
  const b1 = await party('bob', { device: 1 });
  const b2 = await party('bob', { device: 2, identity: b1.identity }); // одна личность, свои prekey
  const B1 = { name: 'bob', device: 1 };
  const B2 = { name: 'bob', device: 2 };
  await startSession(a.store, B1, b1.bundle());
  await startSession(a.store, B2, b2.bundle());
  const id = 'общий-id';
  const e1 = await encrypt(a.store, B1, text('всем устройствам'), id);
  const e2 = await encrypt(a.store, B2, text('всем устройствам'), id);
  assert.equal(e1.id, e2.id);
  assert.equal((await decrypt(b1.store, e1)).content.body, 'всем устройствам');
  assert.equal((await decrypt(b2.store, e2)).content.body, 'всем устройствам');
  await assert.rejects(decrypt(b2.store, e1), { code: 'wrong_recipient' });
  await assert.rejects(decrypt(b1.store, { ...e2, toDevice: 1 })); // копия другого устройства не подходит
});

test('синхронизация между своими устройствами (одна личность)', async () => {
  const a1 = await party('alice', { device: 1 });
  const a2 = await party('alice', { device: 2, identity: a1.identity });
  await startSession(a1.store, { name: 'alice', device: 2 }, a2.bundle());
  const env = await encrypt(a1.store, { name: 'alice', device: 2 }, { t: 'sync-sent', to: 'bob', body: 'копия' });
  const r = await decrypt(a2.store, env);
  assert.equal(r.content.body, 'копия');
  assert.equal(r.fromDevice, 1);
  const back = await encrypt(a2.store, { name: 'alice', device: 1 }, text('ответ себе'));
  assert.equal((await decrypt(a1.store, back)).content.body, 'ответ себе');
});

test('привязка устройства: код, шифрованная посылка, защита от подмены', async () => {
  const keys = await createLinkKeys();
  const pid = toB64(randomBytes(8));
  const code = makeLinkCode(pid, keys.pub);
  assert.equal(code.length, 64);
  const parsed = parseLinkCode('tainik1:' + formatLinkCode(code).toLowerCase());
  assert.deepEqual(parsed, { pid, pub: keys.pub });

  const payload = { username: 'alice', identity: { secret: 'приватный ключ' }, contacts: [{ username: 'bob' }] };
  const sealed = await sealProvision(parsed, payload);
  assert.ok(!JSON.stringify(sealed).includes('приватный'));
  assert.deepEqual(await openProvision(keys, pid, sealed), payload);

  const other = await createLinkKeys(); // посторонний не откроет
  await assert.rejects(openProvision(other, pid, sealed), /provision_decrypt_failed/);
  await assert.rejects(openProvision(keys, toB64(randomBytes(8)), sealed), /provision_decrypt_failed/);
  const flipped = { ...sealed, ct: sealed.ct.slice(0, 5) + (sealed.ct[5] === 'A' ? 'B' : 'A') + sealed.ct.slice(6) };
  await assert.rejects(openProvision(keys, pid, flipped), /provision_decrypt_failed/);
  assert.throws(() => parseLinkCode('слишком-коротко'), /bad_link_code/);
});
