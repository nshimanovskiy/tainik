// Резервная копия переписки: файл, который переносит прошлые чаты на другое устройство.
//
// Файл привязан к аккаунту. Ключ шифрования выводится (HKDF) из закрытых ключей личности
// аккаунта — они одинаковы на всех его устройствах и не покидают их. Поэтому открыть копию
// может только тот же аккаунт: на другом аккаунте (даже с тем же юзернеймом, созданным заново)
// расшифровка не сойдётся. В заголовке открыто лежат юзернейм и идентификатор аккаунта
// (хеш открытых ключей) — чтобы сразу сказать, чей это файл; подменить их нельзя: заголовок
// входит в AAD шифрования.
import { toB64, fromB64, randomBytes, te, td, hkdf, aeadEncrypt, aeadDecrypt, concat } from './protocol/index.js';

export const BACKUP_FORMAT = 'tainik-backup';
export const BACKUP_V = 1;
export const BACKUP_EXT = '.tainik';
export const BACKUP_MAX = 512 * 1024 * 1024; // больше не читаем

/** Идентификатор аккаунта: первые 16 байт SHA-256 от открытых ключей личности, в hex. */
export async function accountId(pub) {
  const h = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', te.encode(`tainik/account/v1|${pub.dh}|${pub.sign}`)));
  return [...h.slice(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const keyOf = (identity, salt) => hkdf(concat(fromB64(identity.dh.priv), fromB64(identity.sign.priv)), salt, 'tainik/backup/v1', 32);
const aadOf = (h) => te.encode(`${BACKUP_FORMAT}|${h.v}|${h.user}|${h.account}|${h.created}|${h.gz ? 1 : 0}`);

async function pipe(bytes, stream) {
  const out = new Response(new Blob([bytes]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}
const canGzip = () => typeof CompressionStream === 'function' && typeof DecompressionStream === 'function';

/** Зашифровать payload для аккаунта { username, identity, pub } → байты файла. */
export async function sealBackup(account, payload, now = Date.now()) {
  let data = te.encode(JSON.stringify(payload));
  const gz = canGzip();
  if (gz) data = await pipe(data, new CompressionStream('gzip'));
  const h = { tainik: BACKUP_FORMAT, v: BACKUP_V, user: account.username, account: await accountId(account.pub), created: now, gz };
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const ct = await aeadEncrypt(await keyOf(account.identity, salt), iv, data, aadOf(h));
  return te.encode(JSON.stringify({ ...h, salt: toB64(salt), iv: toB64(iv), data: toB64(ct) }));
}

/** Заголовок файла без расшифровки: { user, account, created } или ошибка bad_backup. */
export function backupHeader(bytes) {
  let f;
  try {
    if (!bytes || bytes.length > BACKUP_MAX) throw 0;
    f = JSON.parse(td.decode(bytes));
  } catch {
    throw Object.assign(new Error('bad_backup'), { code: 'bad_backup' });
  }
  if (f?.tainik !== BACKUP_FORMAT || typeof f.user !== 'string' || typeof f.account !== 'string' || typeof f.data !== 'string') {
    throw Object.assign(new Error('bad_backup'), { code: 'bad_backup' });
  }
  if (f.v !== BACKUP_V) throw Object.assign(new Error('backup_version'), { code: 'backup_version' });
  return f;
}

/**
 * Открыть файл копии этим аккаунтом. Ошибки (code): bad_backup — не файл копии или повреждён,
 * backup_version — копия из более новой версии, wrong_account — копия другого аккаунта (user — чей).
 */
export async function openBackup(account, bytes) {
  const f = backupHeader(bytes);
  if (f.account !== (await accountId(account.pub)) || f.user !== account.username) {
    throw Object.assign(new Error('wrong_account'), { code: 'wrong_account', user: f.user });
  }
  let data;
  try {
    data = await aeadDecrypt(await keyOf(account.identity, fromB64(f.salt)), fromB64(f.iv), fromB64(f.data), aadOf(f));
  } catch {
    // Тот же юзернейм и отпечаток, но ключ не подошёл — файл испорчен или подделан
    throw Object.assign(new Error('bad_backup'), { code: 'bad_backup' });
  }
  if (f.gz) {
    if (!canGzip()) throw Object.assign(new Error('backup_version'), { code: 'backup_version' });
    data = await pipe(data, new DecompressionStream('gzip'));
  }
  try {
    return { created: f.created, payload: JSON.parse(td.decode(data)) };
  } catch {
    throw Object.assign(new Error('bad_backup'), { code: 'bad_backup' });
  }
}
