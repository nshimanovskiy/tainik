// Double Ratchet по спецификации Signal (https://signal.org/docs/specifications/doubleratchet/).
// Состояние — обычный JSON-объект: его можно сохранять в любом хранилище.
//
// KDF_RK: HKDF-SHA-256(salt = RK, ikm = DH) → 64 байта: новый RK + цепной ключ
// KDF_CK: MK = HMAC(CK, 0x01), CK' = HMAC(CK, 0x02)
// ENCRYPT: HKDF(MK) → ключ AES-256-GCM + IV; AAD = AD сессии ‖ заголовок ‖ доп. данные
import { genX25519, dh, hkdf, hmac, aeadEncrypt, aeadDecrypt, concat, fromB64, toB64, te, isKey32 } from './primitives.js';

export const MAX_SKIP = 1000; // максимум пропущенных сообщений в одной цепочке
export const MAX_STORED_SKIPPED = 2000; // сколько пропущенных ключей храним всего

const INFO_RK = 'tainik/v2/ratchet';
const INFO_MSG = 'tainik/v2/message-keys';
const ZERO32 = new Uint8Array(32);

export class RatchetError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

async function kdfRK(rkB64, dhOut) {
  const out = await hkdf(dhOut, fromB64(rkB64), INFO_RK, 64);
  return [toB64(out.subarray(0, 32)), toB64(out.subarray(32))];
}
async function kdfCK(ckB64) {
  const ck = fromB64(ckB64);
  const [mk, next] = await Promise.all([hmac(ck, Uint8Array.of(1)), hmac(ck, Uint8Array.of(2))]);
  return [toB64(next), toB64(mk)];
}
async function messageKeys(mkB64) {
  const out = await hkdf(fromB64(mkB64), ZERO32, INFO_MSG, 44);
  return { key: out.subarray(0, 32), iv: out.subarray(32, 44) };
}

export const encodeHeader = (h) => te.encode(JSON.stringify(['hdr', h.dh, h.pn, h.n]));

function validHeader(h) {
  return (
    h &&
    isKey32(h.dh) &&
    Number.isInteger(h.pn) &&
    Number.isInteger(h.n) &&
    h.pn >= 0 &&
    h.n >= 0 &&
    h.pn < 2 ** 31 &&
    h.n < 2 ** 31
  );
}

/** Инициатор (Алиса): после X3DH знает SK и подписанный prekey Боба. */
export async function initAlice(skB64, bobSpkPub, adB64) {
  const DHs = await genX25519();
  const [RK, CKs] = await kdfRK(skB64, await dh(DHs.priv, bobSpkPub));
  return { DHs, DHr: bobSpkPub, RK, CKs, CKr: null, Ns: 0, Nr: 0, PN: 0, skipped: {}, ad: adB64 };
}

/** Ответчик (Боб): его пара signed prekey становится первой парой храповика. */
export function initBob(skB64, bobSpkPair, adB64) {
  return {
    DHs: { pub: bobSpkPair.pub, priv: bobSpkPair.priv },
    DHr: null,
    RK: skB64,
    CKs: null,
    CKr: null,
    Ns: 0,
    Nr: 0,
    PN: 0,
    skipped: {},
    ad: adB64,
  };
}

/**
 * Шифрует и возвращает НОВОЕ состояние (исходное не меняется).
 * @returns {Promise<{state, header, ct}>}
 */
export async function ratchetEncrypt(state, plaintext, extraAad = new Uint8Array()) {
  if (!state.CKs) throw new RatchetError('cannot_send_yet');
  const st = structuredClone(state);
  const [CKs, mk] = await kdfCK(st.CKs);
  st.CKs = CKs;
  const header = { dh: st.DHs.pub, pn: st.PN, n: st.Ns };
  st.Ns += 1;
  const { key, iv } = await messageKeys(mk);
  const ct = await aeadEncrypt(key, iv, plaintext, concat(fromB64(st.ad), encodeHeader(header), extraAad));
  return { state: st, header, ct: toB64(ct) };
}

async function skipMessageKeys(st, until) {
  if (st.Nr + MAX_SKIP < until) throw new RatchetError('too_many_skipped');
  if (!st.CKr) return;
  while (st.Nr < until) {
    const [CKr, mk] = await kdfCK(st.CKr);
    st.CKr = CKr;
    st.skipped[`${st.DHr}|${st.Nr}`] = mk;
    st.Nr += 1;
  }
  const keys = Object.keys(st.skipped);
  for (let i = 0; i < keys.length - MAX_STORED_SKIPPED; i++) delete st.skipped[keys[i]];
}

async function dhRatchet(st, header) {
  st.PN = st.Ns;
  st.Ns = 0;
  st.Nr = 0;
  st.DHr = header.dh;
  [st.RK, st.CKr] = await kdfRK(st.RK, await dh(st.DHs.priv, st.DHr));
  st.DHs = await genX25519();
  [st.RK, st.CKs] = await kdfRK(st.RK, await dh(st.DHs.priv, st.DHr));
}

async function tryDecrypt(mk, header, ct, st, extraAad) {
  const { key, iv } = await messageKeys(mk);
  try {
    return await aeadDecrypt(key, iv, fromB64(ct), concat(fromB64(st.ad), encodeHeader(header), extraAad));
  } catch {
    throw new RatchetError('decrypt_failed');
  }
}

/**
 * Расшифровывает и возвращает НОВОЕ состояние. При любой ошибке исходное
 * состояние остаётся нетронутым (защита от порчи сессии мусорными сообщениями).
 * @returns {Promise<{state, plaintext}>}
 */
export async function ratchetDecrypt(state, header, ct, extraAad = new Uint8Array()) {
  if (!validHeader(header) || typeof ct !== 'string') throw new RatchetError('bad_header');
  const st = structuredClone(state);

  const skippedKey = `${header.dh}|${header.n}`;
  if (st.skipped[skippedKey]) {
    const plaintext = await tryDecrypt(st.skipped[skippedKey], header, ct, st, extraAad);
    delete st.skipped[skippedKey];
    return { state: st, plaintext };
  }

  if (header.dh === st.DHr && header.n < st.Nr) throw new RatchetError('duplicate');

  if (header.dh !== st.DHr) {
    await skipMessageKeys(st, header.pn);
    await dhRatchet(st, header);
  }
  await skipMessageKeys(st, header.n);
  const [CKr, mk] = await kdfCK(st.CKr);
  st.CKr = CKr;
  st.Nr += 1;
  const plaintext = await tryDecrypt(mk, header, ct, st, extraAad);
  return { state: st, plaintext };
}
