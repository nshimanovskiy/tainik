// Web Push без зависимостей: VAPID (RFC 8292) и шифрование содержимого (RFC 8291, aes128gcm).
// Сервер отправляет только «кому пришло сообщение и от кого» — текста он не знает.
// Содержимое пуша зашифровано ключом браузера, push-сервис (Google, Mozilla, Apple) его не видит.
import {
  createECDH,
  createHmac,
  createCipheriv,
  generateKeyPairSync,
  createPrivateKey,
  createPublicKey,
  sign,
  randomBytes,
} from 'node:crypto';

export const b64u = (buf) => Buffer.from(buf).toString('base64url');
export const fromB64u = (s) => Buffer.from(String(s), 'base64url');
const hmac = (key, data) => createHmac('sha256', key).update(data).digest();

// Push-сервисы браузеров. Отправлять запросы на произвольные адреса нельзя:
// иначе любой пользователь мог бы заставить сервер стучаться во внутреннюю сеть.
export const PUSH_HOSTS = [
  'fcm.googleapis.com', // Chrome, Edge, Яндекс, Opera
  'android.googleapis.com',
  '.push.services.mozilla.com', // Firefox
  '.notify.windows.com', // старый Edge
  '.push.apple.com', // Safari (macOS, iOS 16.4+)
];

export function allowedEndpoint(endpoint, hosts = PUSH_HOSTS) {
  let u;
  try {
    u = new URL(endpoint);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443')) return false;
  const h = u.hostname.toLowerCase();
  return hosts.some((x) => (x.startsWith('.') ? h.endsWith(x) && h.length > x.length : h === x));
}

/** Проверка подписки из браузера: { endpoint, keys: { p256dh, auth } } */
export function validSubscription(sub, hosts) {
  if (!sub || typeof sub !== 'object' || typeof sub.endpoint !== 'string' || sub.endpoint.length > 1024) return false;
  if (!allowedEndpoint(sub.endpoint, hosts)) return false;
  const k = sub.keys || {};
  try {
    const p = fromB64u(k.p256dh);
    const a = fromB64u(k.auth);
    return p.length === 65 && p[0] === 4 && a.length === 16;
  } catch {
    return false;
  }
}

// ---------- VAPID ----------
/** Новая пара ключей VAPID (ECDSA P-256) в виде JWK. */
export function generateVapid() {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return privateKey.export({ format: 'jwk' });
}

export class Vapid {
  constructor(jwk, subject) {
    this.key = createPrivateKey({ key: jwk, format: 'jwk' });
    const pub = createPublicKey(this.key).export({ format: 'jwk' });
    this.publicKey = b64u(Buffer.concat([Buffer.from([4]), fromB64u(pub.x), fromB64u(pub.y)])); // 65 байт, base64url
    this.subject = subject;
    this.cache = new Map(); // aud -> { header, exp }
  }
  /** Заголовок Authorization для адреса push-сервиса (кешируется на ~11 часов). */
  header(endpoint, now = Date.now()) {
    const aud = new URL(endpoint).origin;
    const c = this.cache.get(aud);
    if (c && c.exp - now > 3600_000) return c.header;
    const exp = now + 12 * 3600_000;
    const enc = (o) => b64u(JSON.stringify(o));
    const input = `${enc({ typ: 'JWT', alg: 'ES256' })}.${enc({ aud, exp: Math.floor(exp / 1000), sub: this.subject })}`;
    const sig = sign('sha256', Buffer.from(input), { key: this.key, dsaEncoding: 'ieee-p1363' });
    const header = `vapid t=${input}.${b64u(sig)}, k=${this.publicKey}`;
    this.cache.set(aud, { header, exp });
    return header;
  }
}

// ---------- Шифрование содержимого (RFC 8291) ----------
export function encryptPayload(sub, payload, { salt = randomBytes(16), ecdh = null } = {}) {
  const uaPublic = fromB64u(sub.keys.p256dh);
  const authSecret = fromB64u(sub.keys.auth);
  const as = ecdh || createECDH('prime256v1');
  if (!ecdh) as.generateKeys();
  const asPublic = as.getPublicKey(); // несжатый, 65 байт
  const shared = as.computeSecret(uaPublic);

  const prkKey = hmac(authSecret, shared);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic, Buffer.from([1])]);
  const ikm = hmac(prkKey, keyInfo);
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);

  const plain = Buffer.concat([Buffer.from(payload), Buffer.from([2])]); // 0x02 — последняя запись
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);

  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, body]);
}

/**
 * Отправляет пуш. Возвращает { ok, gone } — gone=true, если подписка больше не действует
 * (браузер отписался, пользователь запретил уведомления) и её нужно удалить.
 */
export async function sendPush(sub, payload, { vapid, fetch = globalThis.fetch, ttl = 86400, topic, urgency = 'high' }) {
  const headers = {
    'Content-Type': 'application/octet-stream',
    'Content-Encoding': 'aes128gcm',
    TTL: String(ttl),
    Urgency: urgency,
    Authorization: vapid.header(sub.endpoint),
  };
  if (topic) headers.Topic = topic; // новый пуш с тем же Topic заменяет недоставленный
  const res = await fetch(sub.endpoint, {
    method: 'POST',
    headers,
    body: encryptPayload(sub, JSON.stringify(payload)),
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  });
  await res.arrayBuffer().catch(() => {});
  return { ok: res.status >= 200 && res.status < 300, gone: res.status === 404 || res.status === 410, status: res.status };
}
