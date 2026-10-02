// Привязка нового устройства (аналог «provisioning» в Signal).
//
//  1. Новое устройство создаёт одноразовую пару X25519 и открывает на сервере
//     канал привязки (сервер выдаёт случайный pid).
//  2. Оно показывает код (QR или 64 символа): pid + свой публичный ключ.
//     Код передаётся МИМО сервера — глазами/камерой, поэтому сервер не может
//     подменить ключ.
//  3. Уже привязанное устройство шифрует для этого ключа «посылку»
//     (ключ личности + контакты) и отправляет через сервер в канал pid.
//  4. Новое устройство расшифровывает посылку и регистрируется как ещё одно
//     устройство того же аккаунта.
import { genX25519, dh, hkdf, aeadEncrypt, aeadDecrypt, toB64, fromB64, te, td } from './primitives.js';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const LINK_PREFIX = 'TAINIK1:';
const PID_BYTES = 8;

export function base32Encode(bytes) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += CROCKFORD[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += CROCKFORD[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(str) {
  const s = String(str)
    .toUpperCase()
    .replace(/[O]/g, '0')
    .replace(/[IL]/g, '1')
    .replace(/[^0-9A-Z]/g, '');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of s) {
    const v = CROCKFORD.indexOf(ch);
    if (v < 0) throw new Error('bad_link_code');
    value = ((value << 5) | v) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

/** Одноразовые ключи нового устройства для канала привязки. */
export const createLinkKeys = genX25519;

/** Код привязки: pid (8 байт) + публичный ключ (32 байта) → 64 символа Crockford base32. */
export function makeLinkCode(pidB64, pubB64) {
  const pid = fromB64(pidB64);
  const pub = fromB64(pubB64);
  if (pid.length !== PID_BYTES || pub.length !== 32) throw new Error('bad_link_code');
  const bytes = new Uint8Array(PID_BYTES + 32);
  bytes.set(pid);
  bytes.set(pub, PID_BYTES);
  return base32Encode(bytes);
}

/** Для показа человеку: группы по 4 символа. */
export const formatLinkCode = (code) => code.match(/.{1,4}/g).join('-');

/** Принимает код (с дефисами/пробелами/префиксом QR) → { pid, pub } в base64. */
export function parseLinkCode(input) {
  let s = String(input || '').trim();
  if (s.toUpperCase().startsWith(LINK_PREFIX)) s = s.slice(LINK_PREFIX.length);
  const bytes = base32Decode(s);
  if (bytes.length !== PID_BYTES + 32) throw new Error('bad_link_code');
  return { pid: toB64(bytes.subarray(0, PID_BYTES)), pub: toB64(bytes.subarray(PID_BYTES)) };
}

async function channelKey(sharedSecret, pidB64, aPub, bPub) {
  const okm = await hkdf(sharedSecret, fromB64(pidB64), 'tainik/v3/provision', 44);
  const aad = te.encode(JSON.stringify(['tainik/v3/provision', pidB64, aPub, bPub]));
  return { key: okm.subarray(0, 32), iv: okm.subarray(32, 44), aad };
}

/** Привязанное устройство: шифрует посылку для нового устройства. */
export async function sealProvision(link, payload) {
  const eph = await genX25519();
  const { key, iv, aad } = await channelKey(await dh(eph.priv, link.pub), link.pid, eph.pub, link.pub);
  const ct = await aeadEncrypt(key, iv, te.encode(JSON.stringify(payload)), aad);
  return { epub: eph.pub, ct: toB64(ct) };
}

/** Новое устройство: расшифровывает посылку своим одноразовым ключом. */
export async function openProvision(linkKeys, pidB64, message) {
  const { key, iv, aad } = await channelKey(await dh(linkKeys.priv, message.epub), pidB64, message.epub, linkKeys.pub);
  try {
    return JSON.parse(td.decode(await aeadDecrypt(key, iv, fromB64(message.ct), aad)));
  } catch {
    throw new Error('provision_decrypt_failed');
  }
}
