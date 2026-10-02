// Ключи аккаунта по схеме Signal:
//   identity      — долговременная личность: X25519 (для X3DH) + Ed25519 (подписи)
//   signed prekey — среднесрочный X25519, подписан Ed25519, ротация раз в неделю
//   one-time prekeys — одноразовые X25519, каждый выдаётся сервером один раз
import { genX25519, genEd25519, edSign, edVerify, te, isKey32 } from './primitives.js';

export const SPK_ROTATE_MS = 7 * 24 * 3600 * 1000;
export const SPK_KEEP_MS = 30 * 24 * 3600 * 1000; // старые SPK храним для запоздавших сообщений
export const OPK_BATCH = 100;
export const OPK_LOW_WATER = 20;

export const spkSignedData = (spk) => te.encode(`tainik/v2/spk|${spk.id}|${spk.pub}`);

export async function generateIdentity() {
  const [dh, sign] = await Promise.all([genX25519(), genEd25519()]);
  return { dh, sign };
}

export const publicIdentity = (identity) => ({ dh: identity.dh.pub, sign: identity.sign.pub });

export async function generateSignedPreKey(identity, id) {
  const kp = await genX25519();
  const spk = { id, pub: kp.pub, priv: kp.priv, createdAt: Date.now() };
  spk.sig = await edSign(identity.sign.priv, spkSignedData(spk));
  return spk;
}

export async function generateOneTimePreKeys(startId, count = OPK_BATCH) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const kp = await genX25519();
    out.push({ id: startId + i, pub: kp.pub, priv: kp.priv });
  }
  return out;
}

export const publicSpk = (spk) => ({ id: spk.id, pub: spk.pub, sig: spk.sig });
export const publicOpk = (opk) => ({ id: opk.id, pub: opk.pub });

export function validIdentityPub(ik) {
  return !!ik && typeof ik === 'object' && isKey32(ik.dh) && isKey32(ik.sign);
}

export async function verifySignedPreKey(identityPub, spk) {
  if (!spk || !Number.isInteger(spk.id) || !isKey32(spk.pub) || typeof spk.sig !== 'string') return false;
  return edVerify(identityPub.sign, spkSignedData(spk), spk.sig);
}

export function sameIdentity(a, b) {
  return !!a && !!b && a.dh === b.dh && a.sign === b.sign;
}
