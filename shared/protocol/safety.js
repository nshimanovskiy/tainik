// Код безопасности: 60 цифр, одинаковые у обоих собеседников.
// Совпадение при личной сверке означает, что сервер не подменил ключи.
import { sha512, te } from './primitives.js';

export async function safetyNumber(a, b) {
  const [x, y] = [a, b].sort((p, q) => (p.username < q.username ? -1 : 1));
  let h = await sha512(
    te.encode(JSON.stringify(['tainik/v2/safety', x.username, x.identity.dh, x.identity.sign, y.username, y.identity.dh, y.identity.sign]))
  );
  for (let i = 0; i < 5200; i++) h = await sha512(h); // как в Signal: дорогой перебор
  const groups = [];
  for (let i = 0; i < 12; i++) {
    let n = 0;
    for (let j = 0; j < 5; j++) n = n * 256 + h[i * 5 + j];
    groups.push(String(n % 100000).padStart(5, '0'));
  }
  return groups;
}

/** Короткий отпечаток своей личности (для меню). */
export async function fingerprint(identityPub) {
  const h = await sha512(te.encode(`tainik/v2/fp|${identityPub.dh}|${identityPub.sign}`));
  return [...h.subarray(0, 20)].map((b) => b.toString(16).padStart(2, '0')).join('').match(/.{4}/g).join(' ');
}
