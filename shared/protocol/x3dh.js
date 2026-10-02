// X3DH по спецификации Signal (https://signal.org/docs/specifications/x3dh/).
// Отличие: вместо XEdDSA у личности две пары — X25519 для DH и Ed25519 для
// подписей; обе публичные части входят в AD и в код безопасности.
import { dh, hkdf, genX25519, concat, toB64, te } from './primitives.js';
import { verifySignedPreKey, validIdentityPub } from './keys.js';
import { initAlice, initBob } from './ratchet.js';

const INFO_X3DH = 'tainik/v2/x3dh';
const F = new Uint8Array(32).fill(0xff);
const ZERO32 = new Uint8Array(32);

export class X3DHError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

/** Associated data: связывает сессию с именами и ключами личности обеих сторон. */
export function associatedData(initiatorName, initiatorIk, responderName, responderIk) {
  return toB64(
    te.encode(
      JSON.stringify(['tainik/v2/ad', initiatorName, initiatorIk.dh, initiatorIk.sign, responderName, responderIk.dh, responderIk.sign])
    )
  );
}

async function deriveSK(parts) {
  return toB64(await hkdf(concat(F, ...parts), ZERO32, INFO_X3DH, 32));
}

/**
 * Инициатор строит сессию по набору ключей (bundle) собеседника.
 * @param {object} me      { username, identity: {dh:{pub,priv}, sign:{pub,priv}} }
 * @param {object} peer    { username, bundle: { identity:{dh,sign}, spk:{id,pub,sig}, opk:{id,pub}|null } }
 * @returns {Promise<{state, x3dh}>} x3dh — заголовок для первых сообщений
 */
export async function initiate(me, peer) {
  const { identity: ikB, spk, opk } = peer.bundle;
  if (!validIdentityPub(ikB)) throw new X3DHError('bad_bundle');
  if (!(await verifySignedPreKey(ikB, spk))) throw new X3DHError('bad_spk_signature');

  const ek = await genX25519();
  const parts = [
    await dh(me.identity.dh.priv, spk.pub), // DH1 = DH(IKa, SPKb)
    await dh(ek.priv, ikB.dh), // DH2 = DH(EKa, IKb)
    await dh(ek.priv, spk.pub), // DH3 = DH(EKa, SPKb)
  ];
  if (opk) parts.push(await dh(ek.priv, opk.pub)); // DH4 = DH(EKa, OPKb)
  const sk = await deriveSK(parts);

  const ikA = { dh: me.identity.dh.pub, sign: me.identity.sign.pub };
  const ad = associatedData(me.username, ikA, peer.username, ikB);
  const state = await initAlice(sk, spk.pub, ad);
  const x3dh = { ik: ikA, ek: ek.pub, spkId: spk.id, opkId: opk ? opk.id : null };
  return { state, x3dh };
}

/**
 * Ответчик восстанавливает ту же сессию по заголовку X3DH из первого сообщения.
 * @param {object} me   { username, identity, spk: {id,pub,priv}, opk: {id,pub,priv}|null }
 * @param {object} peer { username, x3dh }
 */
export async function respond(me, peer) {
  const { ik: ikA, ek } = peer.x3dh;
  if (!validIdentityPub(ikA)) throw new X3DHError('bad_x3dh');
  const parts = [
    await dh(me.spk.priv, ikA.dh), // DH1
    await dh(me.identity.dh.priv, ek), // DH2
    await dh(me.spk.priv, ek), // DH3
  ];
  if (me.opk) parts.push(await dh(me.opk.priv, ek)); // DH4
  const sk = await deriveSK(parts);
  const ikB = { dh: me.identity.dh.pub, sign: me.identity.sign.pub };
  const ad = associatedData(peer.username, ikA, me.username, ikB);
  return initBob(sk, me.spk, ad);
}
