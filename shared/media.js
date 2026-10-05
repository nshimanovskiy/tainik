// Вложения: шифрование файлов и проверка их описаний в сообщениях.
//
// Файл шифруется на устройстве отправителя случайным ключом AES-256-GCM частями по
// SEG байт (каждая часть — отдельный шифротекст с тегом). Номер части — nonce, признак
// последней части входит в AAD: сервер не может переставить, подменить или обрезать
// части незаметно. Ключ уникален для каждого файла, поэтому nonce-счётчик безопасен.
// Ключ, имя, тип и размер файла уходят собеседнику только внутри сообщения Double Ratchet.
import { toB64, fromB64, randomBytes, isKey32, te } from './protocol/index.js';

export const SEG = 768 * 1024 - 16; // часть открытого текста: шифротекст части = 768 КБ (часть загрузки)
const TAG = 16;
export const KINDS = ['image', 'video', 'audio', 'file'];
export const THUMB_MAX = 16_000; // символов data:-URL превью
export const WAVE_MAX = 128; // base64 громкостей голосового (до 96 столбиков 0–255)
export const CAPTION_MAX = 4000;

/** Размер зашифрованного файла. */
export const encryptedSize = (n) => n + Math.max(1, Math.ceil(n / SEG)) * TAG;

const nonce = (i) => {
  const iv = new Uint8Array(12);
  new DataView(iv.buffer).setUint32(8, i);
  return iv;
};
const aad = (i, last) => te.encode(`tainik/file/v1:${i}:${last ? 1 : 0}`);

async function importKey(raw) {
  return globalThis.crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

/** Новый ключ файла: { keyB64, key } */
export async function newFileKey() {
  const raw = randomBytes(32);
  return { keyB64: toB64(raw), key: await importKey(raw) };
}

export const segments = (size) => Math.max(1, Math.ceil(size / SEG));

/** Зашифровать часть i из n. */
export async function encryptSegment(key, i, n, plain) {
  const ct = await globalThis.crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce(i), additionalData: aad(i, i === n - 1) }, key, plain);
  return new Uint8Array(ct);
}

/** Расшифровать файл целиком. size — размер открытого текста из сообщения. */
export async function decryptFile(keyB64, data, size) {
  const key = await importKey(fromB64(keyB64));
  if (data.length !== encryptedSize(size)) throw Object.assign(new Error('bad_media'), { code: 'bad_media' });
  const n = segments(size);
  const out = new Uint8Array(size);
  for (let i = 0, pos = 0, at = 0; i < n; i++) {
    const len = Math.min(SEG, size - at) + TAG;
    let plain;
    try {
      plain = await globalThis.crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce(i), additionalData: aad(i, i === n - 1) }, key, data.subarray(pos, pos + len));
    } catch {
      throw Object.assign(new Error('bad_media'), { code: 'bad_media' });
    }
    out.set(new Uint8Array(plain), at);
    pos += len;
    at += plain.byteLength;
  }
  return out;
}

const int = (v, max) => (Number.isInteger(v) && v >= 0 && v <= max ? v : undefined);

/** Безопасное имя файла: без путей и управляющих символов. */
export function safeName(name) {
  const s = String(name ?? '')
    .replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/g, '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 180);
  return s || 'file';
}

/** Вид вложения по MIME-типу. */
export function kindOf(mime) {
  if (/^image\/(jpeg|png|gif|webp|avif|bmp)$/.test(mime)) return 'image';
  if (/^video\/(mp4|webm|quicktime|ogg)$/.test(mime)) return 'video';
  if (/^audio\//.test(mime)) return 'audio';
  return 'file';
}

/** Описание вложения из сообщения (только известные поля) или null. */
export function cleanFile(f) {
  if (!f || typeof f !== 'object') return null;
  if (typeof f.id !== 'string' || !/^[0-9a-f]{32}$/.test(f.id)) return null;
  if (!isKey32(f.key)) return null;
  const size = int(f.size, 4 * 1024 ** 3);
  if (!size) return null;
  const mime = typeof f.mime === 'string' && /^[\w.+-]{1,60}\/[\w.+-]{1,80}$/.test(f.mime) ? f.mime.toLowerCase() : 'application/octet-stream';
  const out = { id: f.id, key: f.key, size, name: safeName(f.name), mime, kind: KINDS.includes(f.kind) ? f.kind : 'file' };
  // Показываем как фото или видео только то, что браузер действительно может показать
  if (out.kind !== 'file' && kindOf(mime) !== out.kind) out.kind = 'file';
  const w = int(f.w, 100_000);
  const h = int(f.h, 100_000);
  if (w && h) Object.assign(out, { w, h });
  const dur = int(f.dur, 100 * 3600);
  if (dur !== undefined) out.dur = dur;
  if (typeof f.thumb === 'string' && f.thumb.length <= THUMB_MAX && /^data:image\/(jpeg|webp|png);base64,[A-Za-z0-9+/]+=*$/.test(f.thumb)) out.thumb = f.thumb;
  // Голосовое (аудио) и видеосообщение (квадратное видео) — записаны прямо в чате
  if ((f.as === 'voice' && out.kind === 'audio') || (f.as === 'note' && out.kind === 'video')) {
    out.as = f.as;
    if (typeof f.wave === 'string' && f.wave.length <= WAVE_MAX && /^[A-Za-z0-9+/]+=*$/.test(f.wave)) out.wave = f.wave;
  }
  return out;
}

/** Размер для людей: 1,2 МБ */
export function fmtSize(b, units = ['Б', 'КБ', 'МБ', 'ГБ'], locale) {
  let i = 0;
  let v = b;
  while (v >= 1024 && i < units.length - 1) (v /= 1024), i++;
  const n = i === 0 ? String(v) : v.toLocaleString(locale, { maximumFractionDigits: v < 10 ? 1 : 0 });
  return `${n} ${units[i]}`;
}
