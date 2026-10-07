// Web Push: шифрование по RFC 8291 (эталонный пример из приложения A), VAPID и доставка с сервера.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createECDH, createHmac, createDecipheriv, createPublicKey, verify, randomBytes } from 'node:crypto';
import { encryptPayload, generateVapid, Vapid, allowedEndpoint, validSubscription, b64u, fromB64u } from '../server/webpush.js';
import { startServer } from '../server/server.js';
import { MessengerClient, MemoryStorage } from '../shared/client-core.js';

const hmac = (k, d) => createHmac('sha256', k).update(d).digest();

/** Расшифровка на стороне браузера (RFC 8291) — независимо от кода сервера. */
function uaDecrypt(body, uaEcdh, authSecret) {
  const salt = body.subarray(0, 16);
  const rs = body.readUInt32BE(16);
  const idlen = body[20];
  const asPublic = body.subarray(21, 21 + idlen);
  const ct = body.subarray(21 + idlen);
  assert.equal(rs, 4096);
  const shared = uaEcdh.computeSecret(asPublic);
  const prkKey = hmac(authSecret, shared);
  const ikm = hmac(prkKey, Buffer.concat([Buffer.from('WebPush: info\0'), uaEcdh.getPublicKey(), asPublic, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);
  const d = createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(ct.subarray(ct.length - 16));
  const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  assert.equal(plain[plain.length - 1], 2, 'разделитель последней записи');
  return plain.subarray(0, plain.length - 1).toString();
}

function newUa() {
  const ua = createECDH('prime256v1');
  ua.generateKeys();
  const auth = randomBytes(16);
  return { ua, auth, keys: { p256dh: b64u(ua.getPublicKey()), auth: b64u(auth) } };
}

test('RFC 8291, приложение A: шифр совпадает с эталоном', () => {
  const as = createECDH('prime256v1');
  as.setPrivateKey(fromB64u('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw'));
  assert.equal(b64u(as.getPublicKey()), 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8');
  const sub = { endpoint: 'https://x', keys: { p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', auth: 'BTBZMqHH6r4Tts7J_aSIgg' } };
  const body = encryptPayload(sub, fromB64u('V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24'), { salt: fromB64u('DGv6ra1nlYgDCS1FRnbzlw'), ecdh: as });
  assert.equal(
    b64u(body),
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN'
  );
  // и обратно — нашей «браузерной» расшифровкой
  const ua = createECDH('prime256v1');
  ua.setPrivateKey(fromB64u('q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94'));
  assert.equal(uaDecrypt(body, ua, fromB64u('BTBZMqHH6r4Tts7J_aSIgg')), 'When I grow up, I want to be a watermelon');
});

test('VAPID: подпись ES256 проверяется открытым ключом, aud = адрес push-сервиса', () => {
  const v = new Vapid(generateVapid(), 'mailto:admin@example.com');
  const h = v.header('https://fcm.googleapis.com/fcm/send/abc');
  const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(h);
  assert.ok(m, h);
  const [, eh, ec, sig, k] = m;
  assert.equal(k, v.publicKey);
  assert.equal(fromB64u(k).length, 65);
  const claims = JSON.parse(fromB64u(ec).toString());
  assert.equal(claims.aud, 'https://fcm.googleapis.com');
  assert.equal(claims.sub, 'mailto:admin@example.com');
  assert.ok(claims.exp * 1000 > Date.now() && claims.exp * 1000 <= Date.now() + 24 * 3600_000);
  const pk = fromB64u(k);
  const pub = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64u(pk.subarray(1, 33)), y: b64u(pk.subarray(33)) }, format: 'jwk' });
  assert.ok(verify('sha256', Buffer.from(`${eh}.${ec}`), { key: pub, dsaEncoding: 'ieee-p1363' }, fromB64u(sig)));
});

test('подписки: только https-адреса известных push-сервисов', () => {
  assert.ok(allowedEndpoint('https://fcm.googleapis.com/fcm/send/x'));
  assert.ok(allowedEndpoint('https://updates.push.services.mozilla.com/wpush/v2/x'));
  assert.ok(allowedEndpoint('https://web.push.apple.com/abc'));
  assert.ok(!allowedEndpoint('http://fcm.googleapis.com/x'));
  assert.ok(!allowedEndpoint('https://fcm.googleapis.com.evil.com/x'));
  assert.ok(!allowedEndpoint('https://evilpush.apple.com.example/x'));
  assert.ok(!allowedEndpoint('https://127.0.0.1/x'));
  assert.ok(!allowedEndpoint('https://fcm.googleapis.com:8443/x'));
  assert.ok(!allowedEndpoint('https://user@fcm.googleapis.com/x'));
  const { keys } = newUa();
  assert.ok(validSubscription({ endpoint: 'https://fcm.googleapis.com/fcm/send/x', keys }));
  assert.ok(!validSubscription({ endpoint: 'https://fcm.googleapis.com/fcm/send/x', keys: { ...keys, auth: 'AAAA' } }));
});

function waitFor(emitter, event, pred = () => true, ms = 8000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => (off(), reject(new Error('timeout: ' + event))), ms);
    const off = emitter.on(event, (d) => {
      if (pred(d)) {
        clearTimeout(t);
        off();
        resolve(d);
      }
    });
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('сервер: пуш офлайн-устройству — только о сообщениях и пропущенных звонках', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tainik-push-'));
  const sent = [];
  let reply = 201;
  const fakeFetch = async (url, init) => {
    sent.push({ url, init });
    return new Response(null, { status: reply });
  };
  const srv = await startServer({
    port: 0,
    host: '127.0.0.1',
    dataDir,
    log: false,
    push: { subject: 'mailto:t@example.com', hosts: ['push.test'], fetch: fakeFetch },
  });
  const url = `ws://127.0.0.1:${srv.port}/ws`;
  const alice = new MessengerClient({ url, storage: new MemoryStorage() });
  const bob = new MessengerClient({ url, storage: new MemoryStorage() });
  t.after(async () => {
    alice.disconnect();
    bob.disconnect();
    await srv.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  await alice.register('alice');
  await bob.register('bob');
  assert.equal(fromB64u(bob.push.vapidKey).length, 65, 'ключ VAPID приходит в ready');
  assert.equal(bob.push.endpoint, null);

  // чужой адрес не принимается
  const { ua, auth, keys } = newUa();
  await assert.rejects(bob.setPushSubscription({ endpoint: 'https://evil.example/x', keys }), (e) => e.code === 'bad_subscription');
  await bob.setPushSubscription({ endpoint: 'https://push.test/bob-1', keys });
  assert.equal(srv.store.getPushSub('bob', 1).endpoint, 'https://push.test/bob-1');

  // Боб в сети — пушей нет
  await alice.addContact('bob');
  await alice.sendText('bob', 'привет');
  await waitFor(bob, 'message', (d) => d.message.dir === 'in');
  await sleep(100);
  assert.equal(sent.length, 0);

  // Боб закрыл вкладку — сообщение будит его пушем
  bob.disconnect();
  await sleep(100);
  const sentP = waitFor(alice, 'status-change', (d) => d.status === 'sent');
  await alice.sendText('bob', 'ты тут?');
  await sentP;
  const m = (await alice.messages('bob')).at(-1);
  await sleep(100);
  assert.equal(sent.length, 1);
  const { url: to, init } = sent[0];
  assert.equal(to, 'https://push.test/bob-1');
  assert.equal(init.headers['Content-Encoding'], 'aes128gcm');
  assert.match(init.headers.Authorization, /^vapid t=.+, k=/);
  assert.match(init.headers.Topic, /^[A-Za-z0-9_-]{1,32}$/);
  const payload = JSON.parse(uaDecrypt(Buffer.from(init.body), ua, auth));
  assert.deepEqual(payload, { t: 'msg', from: 'alice' }, 'в пуше нет текста сообщения');
  assert.ok(!Buffer.from(init.body).includes('ты тут'));

  // Второе сообщение сразу же — не пушим повторно (окно 4 с); служебные (удаление) — тоже не пушим
  await alice.sendText('bob', 'алло');
  await alice.deleteMessages('bob', [m.id], { forAll: true });
  await sleep(300);
  assert.equal(sent.length, 1);

  // Звонок, который никто не принял — «пропущенный»
  const delivered = await alice.sendEphemeral('bob', { t: 'call', kind: 'offer', callId: 'c1', ts: Date.now() }, { notify: 'call' });
  assert.deepEqual(delivered, []);
  await sleep(100);
  assert.equal(sent.length, 2);
  assert.deepEqual(JSON.parse(uaDecrypt(Buffer.from(sent[1].init.body), ua, auth)), { t: 'call', from: 'alice' });
  assert.equal(sent[1].init.headers.TTL, '60');

  // Браузер отписался (410) — подписка удаляется
  reply = 410;
  await sleep(4100);
  await alice.sendText('bob', 'ещё');
  await sleep(200);
  assert.equal(sent.length, 3);
  assert.equal(srv.store.getPushSub('bob', 1), null);

  // Отписка с самого устройства
  await bob.connect();
  await bob.setPushSubscription({ endpoint: 'https://push.test/bob-2', keys });
  await bob.setPushSubscription(null);
  assert.equal(srv.store.getPushSub('bob', 1), null);
});

test('пуш о сообщении в группе — с названием группы (из реестра) и автором', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tainik-push-g-'));
  const sent = [];
  const srv = await startServer({
    port: 0,
    host: '127.0.0.1',
    dataDir,
    log: false,
    push: { subject: 'mailto:t@example.com', hosts: ['push.test'], fetch: async (url, init) => (sent.push({ url, init }), new Response(null, { status: 201 })) },
  });
  const url = `ws://127.0.0.1:${srv.port}/ws`;
  const alice = new MessengerClient({ url, storage: new MemoryStorage() });
  const bob = new MessengerClient({ url, storage: new MemoryStorage() });
  t.after(async () => {
    alice.disconnect();
    bob.disconnect();
    await srv.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  await alice.register('alice');
  await bob.register('bob');
  const { ua, auth, keys } = newUa();
  await bob.setPushSubscription({ endpoint: 'https://push.test/bob', keys });
  const chat = await alice.createGroup('Дача', ['bob']);
  const gid = chat.slice(1);
  await waitFor(bob, 'message', (d) => d.contact === chat);
  // Оба участника отметились в реестре групп (название сообщил администратор группы)
  for (let i = 0; i < 200 && !(srv.store.groupMembers(gid).includes('bob') && srv.store.getGroup(gid)?.name); i++) await sleep(25);
  assert.deepEqual(srv.store.groupMembers(gid).sort(), ['alice', 'bob']);

  bob.disconnect();
  await sleep(100);
  const sentP = waitFor(alice, 'status-change', (d) => d.status === 'sent');
  await alice.sendText(chat, 'кто едет?');
  await sentP;
  await sleep(100);
  assert.equal(sent.length, 1);
  const payload = JSON.parse(uaDecrypt(Buffer.from(sent[0].init.body), ua, auth));
  assert.deepEqual(payload, { t: 'msg', from: 'alice', g: gid, gn: 'Дача' });

  // Сразу же личное сообщение от того же человека — отдельный пуш (группа и личный чат не склеиваются)
  await alice.addContact('bob');
  await alice.sendText('bob', 'и лично тебе');
  for (let i = 0; i < 100 && sent.length < 2; i++) await sleep(25);
  assert.equal(sent.length, 2);
  assert.deepEqual(JSON.parse(uaDecrypt(Buffer.from(sent[1].init.body), ua, auth)), { t: 'msg', from: 'alice' });
});
