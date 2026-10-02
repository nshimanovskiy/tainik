// Криптографические примитивы поверх стандартного WebCrypto.
// Работает в браузерах (Chromium 133+, Firefox 130+, Safari 17+), Node.js 22+,
// Electron 35+. Все ключи хранятся в base64, чтобы состояние протокола можно было
// сериализовать в любое хранилище (IndexedDB, файл, SQLite, Keychain).

const subtle = globalThis.crypto.subtle;
export const te = new TextEncoder();
export const td = new TextDecoder();

// ---------- байты ----------
export function toB64(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(s);
}
export function fromB64(str) {
  if (typeof str !== 'string') throw new TypeError('ожидалась base64-строка');
  const s = atob(str);
  const u8 = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
  return u8;
}
export function concat(...parts) {
  const len = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
export const randomBytes = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n));
export const randomId = (n = 16) => toB64(randomBytes(n));
export function isKey32(b64) {
  try {
    return fromB64(b64).length === 32;
  } catch {
    return false;
  }
}

// ---------- X25519 ----------
export async function genX25519() {
  const kp = await subtle.generateKey({ name: 'X25519' }, true, ['deriveBits']);
  return {
    pub: toB64(await subtle.exportKey('raw', kp.publicKey)),
    priv: toB64(await subtle.exportKey('pkcs8', kp.privateKey)),
  };
}

/** Диффи–Хеллман X25519. Отклоняет точки малого порядка (нулевой результат). */
export async function dh(privB64, pubB64) {
  if (!isKey32(pubB64)) throw new Error('bad_public_key');
  const priv = await subtle.importKey('pkcs8', fromB64(privB64), { name: 'X25519' }, false, ['deriveBits']);
  const pub = await subtle.importKey('raw', fromB64(pubB64), { name: 'X25519' }, false, []);
  const out = new Uint8Array(await subtle.deriveBits({ name: 'X25519', public: pub }, priv, 256));
  if (out.every((b) => b === 0)) throw new Error('bad_public_key');
  return out;
}

// ---------- Ed25519 ----------
export async function genEd25519() {
  const kp = await subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  return {
    pub: toB64(await subtle.exportKey('raw', kp.publicKey)),
    priv: toB64(await subtle.exportKey('pkcs8', kp.privateKey)),
  };
}
export async function edSign(privB64, data) {
  const k = await subtle.importKey('pkcs8', fromB64(privB64), { name: 'Ed25519' }, false, ['sign']);
  return toB64(await subtle.sign({ name: 'Ed25519' }, k, data));
}
export async function edVerify(pubB64, data, sigB64) {
  try {
    const k = await subtle.importKey('raw', fromB64(pubB64), { name: 'Ed25519' }, false, ['verify']);
    return await subtle.verify({ name: 'Ed25519' }, k, fromB64(sigB64), data);
  } catch {
    return false;
  }
}

// ---------- KDF / MAC ----------
export async function hkdf(ikm, salt, info, length) {
  const k = await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(
    await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info: te.encode(info) }, k, length * 8)
  );
}
export async function hmac(key, data) {
  const k = await subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await subtle.sign('HMAC', k, data));
}
export async function sha512(data) {
  return new Uint8Array(await subtle.digest('SHA-512', data));
}

// ---------- AEAD ----------
export async function aeadEncrypt(key32, iv12, plaintext, aad) {
  const k = await subtle.importKey('raw', key32, 'AES-GCM', false, ['encrypt']);
  return new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: iv12, additionalData: aad }, k, plaintext));
}
export async function aeadDecrypt(key32, iv12, ciphertext, aad) {
  const k = await subtle.importKey('raw', key32, 'AES-GCM', false, ['decrypt']);
  return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: iv12, additionalData: aad }, k, ciphertext));
}

// ---------- дополнение (скрывает точную длину) ----------
export function pad(bytes, block = 64) {
  const total = Math.ceil((bytes.length + 4) / block) * block;
  const out = new Uint8Array(total);
  new DataView(out.buffer).setUint32(0, bytes.length);
  out.set(bytes, 4);
  return out;
}
export function unpad(bytes) {
  const len = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
  if (len > bytes.length - 4) throw new Error('bad_padding');
  return bytes.subarray(4, 4 + len);
}
