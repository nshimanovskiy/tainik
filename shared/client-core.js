// Логика клиента (протокол v3: X3DH + Double Ratchet, несколько устройств) без
// привязки к UI и платформе. Используется в вебе, в десктопе (Electron) и подойдёт
// для React Native: нужно передать хранилище (get/set/del/clear, значения — JSON)
// и реализацию WebSocket.
//
// Модель устройств как в Signal: у аккаунта одна личность (ключ личности общий),
// у каждого устройства свои prekey и свои сессии. Сообщение шифруется отдельно
// для каждого устройства собеседника и копией — для остальных своих устройств.
import { t } from './i18n.js';
import { sealBackup, openBackup } from './backup.js';
import {
  generateIdentity,
  generateSignedPreKey,
  generateOneTimePreKeys,
  publicIdentity,
  publicSpk,
  publicOpk,
  sameIdentity,
  validIdentityPub,
  startSession,
  encrypt,
  decrypt,
  hasSession,
  sessionIdentity,
  deleteSession,
  safetyNumber,
  fingerprint,
  edSign,
  edVerify,
  dh,
  genX25519,
  randomId,
  te,
  td,
  toB64,
  fromB64,
  randomBytes,
  isKey32,
  aeadEncrypt,
  aeadDecrypt,
  createLinkKeys,
  makeLinkCode,
  parseLinkCode,
  sealProvision,
  openProvision,
  LINK_PREFIX,
  OPK_BATCH,
  OPK_LOW_WATER,
  SPK_ROTATE_MS,
  SPK_KEEP_MS,
} from './protocol/index.js';
import { SEG, CAPTION_MAX, KINDS, newFileKey, encryptSegment, decryptFile, encryptedSize, segments, cleanFile, safeName, kindOf } from './media.js';

const SEEN_LIMIT = 5000;
const DELETED_LIMIT = 2000;
const MAX_DELETE = 100;
const REPLY_SNIPPET = 120;
export const NAME_MAX = 64;
export const BIO_MAX = 140;
// Фото профиля (преимущество подписки): маленькая картинка data:-URL прямо в зашифрованном
// профиле. Предел выбран так, чтобы профиль со всеми копиями для устройств собеседника
// уместился в одно сообщение серверу.
export const AVATAR_MAX = 20_000;
export const AVATAR_SIZE = 160; // сторона квадрата в пикселях
const AVATAR_RE = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/;
export const validAvatar = (a) => typeof a === 'string' && a.length <= AVATAR_MAX && AVATAR_RE.test(a);
// Фото профиля в хорошем качестве — для просмотра на весь экран. Идёт в профиле рядом с маленьким
// avatar (старые версии его просто не знают); у собеседников хранится отдельно: 'photo:<юзернейм>'.
export const PHOTO_MAX = 100_000;
export const PHOTO_SIZE = 640;
export const validPhoto = (a) => typeof a === 'string' && a.length <= PHOTO_MAX && AVATAR_RE.test(a);
const PROVISION_AVATARS = 30_000; // сколько места под фото собеседников при привязке устройства
// Своё видео на фон профиля (Премиум): зашифрованный файл на сервере, ключ — в профиле.
// Короткое: не длиннее PROFILE_VIDEO_SEC секунд и PROFILE_VIDEO_MAX байт.
export const PROFILE_VIDEO_MAX = 12 * 1024 * 1024;
// Формат профиля, который понимает это приложение: 2 — со своим видео на фоне (0.47). Профиль,
// принятый старой версией, могли получить без фона (незнакомое поле отбрасывается) — его
// переспрашивают один раз: у собеседников (profile-req) и у своих устройств (sync-profile-req).
export const PROFILE_SCHEMA = 2;
export const PROFILE_VIDEO_SEC = 15;
/** Фон профиля — видео или GIF (0.47.2): анимированная картинка, тоже без звука и по кругу. */
export const isProfileBgMime = (mime) => kindOf(mime) === 'video' || mime === 'image/gif';
/** Своё видео (или GIF) для фона из профиля: { id, key, size, mime, kind, w?, h?, dur? } или null. */
function cleanProfileVideo(v) {
  const f = cleanFile(v);
  if (!f || !isProfileBgMime(f.mime) || f.kind !== kindOf(f.mime) || f.size > PROFILE_VIDEO_MAX) return null;
  const out = { id: f.id, key: f.key, size: f.size, mime: f.mime, kind: f.kind };
  if (f.w && f.h) Object.assign(out, { w: f.w, h: f.h });
  if (f.dur !== undefined) out.dur = f.dur;
  return out;
}
// ---------- Магазин: рамки и фоны профиля ----------
// Товары загружает администратор сервера, покупают за монеты. Что у кого надето, знает сервер
// (как галочку и Премиум): он не даст показать чужим некупленную рамку. Файлы товаров открытые.
const SHOP_ID_RE = /^[0-9a-f]{16}$/;
export const SHOP_FILE_MAX = 16 * 1024 * 1024;
/** Надетое { frame?, bg? } — id товаров. */
export function cleanLook(l) {
  const out = {};
  for (const k of ['frame', 'bg']) if (typeof l?.[k] === 'string' && SHOP_ID_RE.test(l[k])) out[k] = l[k];
  return out;
}
const sameLook = (a, b) => (a?.frame || null) === (b?.frame || null) && (a?.bg || null) === (b?.bg || null);
function cleanShopItem(i) {
  if (!i || typeof i.id !== 'string' || !SHOP_ID_RE.test(i.id) || (i.kind !== 'frame' && i.kind !== 'bg')) return null;
  const price = Number.isSafeInteger(i.price) && i.price >= 0 ? i.price : 0;
  return { id: i.id, kind: i.kind, name: cleanProfileText(i.name, 40).replace(/\n/g, ' ') || i.id, price, premium: !!i.premium };
}

/** Имя или «о себе»: без управляющих и «переворачивающих» текст символов, обрезано. */
export function cleanProfileText(s, max) {
  return String(s ?? '')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f\u202a-\u202e\u2066-\u2069\u200b-\u200f\ufeff]/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, max);
}
// ---------- Закреплённые чаты и папки ----------
export const PINNED_CHATS_MAX = 10;
export const FOLDERS_MAX = 10;
export const FOLDER_NAME_MAX = 24;
const FOLDER_CHATS_MAX = 500;
/** Папки: [{ id, name, chats }] — только известные поля, разумные размеры. */
function cleanFolders(list) {
  const out = [];
  const ids = new Set();
  for (const f of Array.isArray(list) ? list : []) {
    if (out.length >= FOLDERS_MAX) break;
    const id = typeof f?.id === 'string' && /^[A-Za-z0-9_-]{1,24}$/.test(f.id) && !ids.has(f.id) ? f.id : null;
    const name = cleanProfileText(f?.name, FOLDER_NAME_MAX).replace(/\n/g, ' ');
    if (!id || !name) continue;
    ids.add(id);
    const chats = [...new Set((Array.isArray(f.chats) ? f.chats : []).filter((c) => typeof c === 'string' && c.length <= 40))].slice(0, FOLDER_CHATS_MAX);
    out.push({ id, name, chats });
  }
  return out;
}

/** Каналов в профиле — не больше этого (свои каналы, как в Telegram «личный канал»). */
export const PROFILE_CHANNELS_MAX = 2;
/** Каналы профиля: [{ ref, title }] — ref: '@имя' (публичный) или 'id.ключ' (приватный, по приглашению). */
function cleanProfileChannels(list) {
  const out = [];
  for (const c of Array.isArray(list) ? list : []) {
    if (out.length >= PROFILE_CHANNELS_MAX) break;
    const ref = String(c?.ref ?? '');
    if (ref.length > 120 || !parseChannelRef(ref) || out.some((x) => x.ref === ref)) continue;
    out.push({ ref, title: cleanProfileText(c.title, CHANNEL_TITLE_MAX).replace(/\n/g, ' ') });
  }
  return out;
}
/** Профиль { name, bio, avatar?, channels?, v } из сообщения (только известные поля) или null. */
function cleanProfile(p) {
  if (!p || !Number.isFinite(p.v) || p.v <= 0) return null;
  const out = { name: cleanProfileText(p.name, NAME_MAX).replace(/\n/g, ' '), bio: cleanProfileText(p.bio, BIO_MAX), v: p.v };
  if (validAvatar(p.avatar)) {
    out.avatar = p.avatar;
    if (validPhoto(p.photo)) out.photo = p.photo;
  }
  const channels = cleanProfileChannels(p.channels);
  if (channels.length) out.channels = channels;
  const video = cleanProfileVideo(p.video);
  if (video) out.video = video;
  return out;
}

// ---------- Группы ----------
// Группа — рассылка по уже существующим парным сессиям (как «старые» группы Signal):
// каждое сообщение шифруется отдельно для каждого участника. Сервер о группах не знает:
// состав, название и админов участники передают друг другу внутри E2E-сообщений.
// Чат группы хранится как контакт с ключом '#<id>' (в юзернеймах «#» не бывает).
export const GROUP_MAX = 50; // участников, вместе с создателем
export const GROUP_NAME_MAX = 64;
const GID_RE = /^[0-9a-f]{24}$/;
const USER_RE = /^[a-z0-9_]{3,32}$/;
export const isGroupChat = (chat) => typeof chat === 'string' && chat.startsWith('#');

// ---------- Служебный чат «Тайник» ----------
// Уведомления сервера: монеты, Премиум, галочка, вход с нового устройства, сообщения
// администратора. Писать в этот чат нельзя. Ключ '~tainik' не пересекается с юзернеймами.
export const SYSTEM_CHAT = '~tainik';
export const isSystemChat = (chat) => chat === SYSTEM_CHAT;
// Чат поддержки: переписка с администратором сервера. Не сквозная — сообщения видны в панели.
export const SUPPORT_CHAT = '~support';
export const isSupportChat = (chat) => chat === SUPPORT_CHAT;
export const SUPPORT_TEXT_MAX = 4000;
const NEWS_OWNER = '~tainik'; // владелец официального канала обновлений (см. server/news.js)
export const NOTICE_TEXT_MAX = 2000;
const NOTICE_KINDS = new Set(['welcome', 'device', 'verified', 'coins-buy', 'coins-admin', 'premium', 'premium-gift', 'gift-sent', 'premium-admin', 'premium-off', 'premium-ended', 'premium-soon', 'admin', 'shop-admin']);
const int = (n) => (Number.isSafeInteger(n) ? n : 0);
const time = (n) => (Number.isFinite(n) && n > 0 ? n : null);
/** Уведомление от сервера → содержимое сообщения { t: 'notice', kind, … } или null. */
export function cleanNotice(n) {
  if (!n || !Number.isSafeInteger(n.id) || n.id <= 0 || !NOTICE_KINDS.has(n.kind)) return null;
  const d = n.data && typeof n.data === 'object' ? n.data : {};
  const c = { t: 'notice', kind: n.kind };
  const user = (u) => (typeof u === 'string' && USER_RE.test(u) ? u : null);
  switch (n.kind) {
    case 'device':
      c.name = String(d.name ?? '').slice(0, 64);
      c.ip = String(d.ip ?? '').slice(0, 64);
      break;
    case 'verified':
      c.on = d.on === true;
      break;
    case 'coins-buy':
      c.amount = int(d.amount);
      c.balance = int(d.balance);
      break;
    case 'coins-admin':
      c.delta = int(d.delta);
      c.balance = int(d.balance);
      if (!c.delta) return null;
      break;
    case 'premium':
    case 'premium-admin':
      c.days = int(d.days);
      c.until = time(d.until);
      if (d.cost != null) c.cost = int(d.cost);
      break;
    case 'premium-gift':
      c.from = user(d.from);
      c.days = int(d.days);
      c.until = time(d.until);
      if (!c.from) return null;
      break;
    case 'gift-sent':
      c.to = user(d.to);
      c.days = int(d.days);
      if (d.cost != null) c.cost = int(d.cost);
      if (!c.to) return null;
      break;
    case 'premium-soon':
      c.until = time(d.until);
      break;
    case 'shop-admin': // администратор выдал или забрал рамку (фон)
      c.name = cleanProfileText(d.name, 40).replace(/\n/g, ' ');
      c.item = d.kind === 'bg' ? 'bg' : 'frame';
      c.on = d.on === true;
      break;
    case 'admin':
      c.body = String(d.text ?? '').slice(0, NOTICE_TEXT_MAX);
      if (!c.body.trim()) return null;
      break;
  }
  return c;
}

// ---------- Каналы ----------
// Пишут владелец и администраторы, читают подписчики. Посты лежат на сервере, зашифрованные
// ключом канала (AES-256-GCM). У приватного канала ключ — только в ссылке-приглашении (после «#»,
// на сервер не уходит), у публичного ключ сервер раздаёт всем, кто нашёл канал по @имени.
// Чат канала — контакт с ключом '!<id>'.
export const isChannelChat = (chat) => typeof chat === 'string' && chat.startsWith('!');
export const CHANNEL_TITLE_MAX = 64;
export const CHANNEL_ABOUT_MAX = 500;
export const CHANNEL_HANDLE_RE = /^[a-z][a-z0-9_]{4,31}$/;
const CHANNEL_ID_RE = /^[0-9a-f]{32}$/;
const channelKey = (id) => '!' + id;
const b64url = (b64) => b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64url = (s) => {
  const b = String(s).replace(/-/g, '+').replace(/_/g, '/');
  return b + '='.repeat((4 - (b.length % 4)) % 4);
};
async function channelSeal(keyB64, id, obj) {
  const iv = randomBytes(12);
  const ct = await aeadEncrypt(fromB64(keyB64), iv, te.encode(JSON.stringify(obj)), te.encode('tainik/channel/' + id));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv);
  out.set(ct, 12);
  return toB64(out);
}
async function channelOpen(keyB64, id, data) {
  try {
    const raw = fromB64(String(data));
    if (raw.length < 29) return null;
    const pt = await aeadDecrypt(fromB64(keyB64), raw.subarray(0, 12), raw.subarray(12), te.encode('tainik/channel/' + id));
    return JSON.parse(td.decode(pt));
  } catch {
    return null;
  }
}
const cleanChannelMeta = (m) => ({
  title: cleanProfileText(m?.title, CHANNEL_TITLE_MAX).replace(/\n/g, ' '),
  about: cleanProfileText(m?.about, CHANNEL_ABOUT_MAX),
});
/**
 * Ссылка или @имя канала → { handle } или { id, key }. Понимает https://…/app#ch=…, #ch=…,
 * @имя и «id.ключ». null — не похоже на канал.
 */
export function parseChannelRef(ref) {
  let s = String(ref ?? '').trim();
  const i = s.indexOf('#ch=');
  if (i >= 0) s = s.slice(i + 4);
  try {
    s = decodeURIComponent(s);
  } catch {}
  if (s.startsWith('@')) {
    const handle = s.slice(1).toLowerCase();
    return CHANNEL_HANDLE_RE.test(handle) ? { handle } : null;
  }
  const m = /^([0-9a-f]{32})\.([A-Za-z0-9_-]{43})$/.exec(s);
  if (m && isKey32(unb64url(m[2]))) return { id: m[1], key: unb64url(m[2]) };
  const handle = s.toLowerCase();
  return CHANNEL_HANDLE_RE.test(handle) ? { handle } : null;
}
const groupKey = (gid) => '#' + gid;
const newGroupId = () => [...globalThis.crypto.getRandomValues(new Uint8Array(12))].map((b) => b.toString(16).padStart(2, '0')).join('');
const cleanGroupName = (n) => cleanProfileText(n, GROUP_NAME_MAX).replace(/\n/g, ' ');

/** Состояние группы { id, name, members, admins, v } из сообщения (только известные поля) или null. */
function cleanGroup(g) {
  const id = String(g?.g ?? g?.id ?? '');
  if (!GID_RE.test(id) || !Number.isFinite(g.v) || g.v <= 0 || !Array.isArray(g.members)) return null;
  const members = [...new Set(g.members.map(String))].filter((m) => USER_RE.test(m)).slice(0, GROUP_MAX);
  if (!members.length) return null;
  const admins = [...new Set((Array.isArray(g.admins) ? g.admins : []).map(String))].filter((a) => members.includes(a));
  return { id, name: cleanGroupName(g.name) || t('Группа'), members, admins: admins.length ? admins : [members[0]], v: g.v };
}

/** Что изменилось в группе — для служебных строк в чате. */
function groupEvents(old, next, by) {
  if (!old) return [{ ev: 'created', by, name: next.name }];
  const out = [];
  if (old.name !== next.name) out.push({ ev: 'renamed', by, name: next.name });
  const added = next.members.filter((m) => !old.members.includes(m));
  const removed = old.members.filter((m) => !next.members.includes(m));
  if (added.length) out.push({ ev: 'added', by, who: added });
  if (removed.length) out.push({ ev: 'removed', by, who: removed });
  return out;
}

/** Цитата для ответа: кто написал и начало текста. */
function makeReply(orig, me, peer) {
  const body = String(orig.content?.body ?? '').replace(/\s+/g, ' ').trim();
  const out = { id: orig.id, from: orig.dir === 'out' ? me : orig.from || peer, body: body.slice(0, REPLY_SNIPPET) };
  if (orig.content?.file) {
    out.kind = orig.content.file.kind;
    if (orig.content.file.as) out.as = orig.content.file.as;
  }
  return out;
}

/**
 * Сообщение из расшифрованного содержимого (только известные поля): текст или
 * вложение { t: 'file', body: подпись, file: {...} }. null — повреждённое вложение.
 */
function cleanText(c, tsFallback = Date.now()) {
  const ts = Number.isFinite(c?.ts) ? c.ts : tsFallback;
  const out = { t: 'text', body: String(c?.body ?? ''), ts };
  if (c?.t === 'file' || c?.file) {
    const file = cleanFile(c.file);
    if (!file) return null;
    out.t = 'file';
    out.file = file;
    out.body = out.body.slice(0, CAPTION_MAX);
  }
  const r = c?.reply;
  if (r && typeof r.id === 'string' && typeof r.from === 'string') {
    out.reply = { id: r.id.slice(0, 64), from: r.from.slice(0, 32), body: String(r.body ?? '').slice(0, REPLY_SNIPPET) };
    if (KINDS.includes(r.kind)) out.reply.kind = r.kind;
    if ((r.as === 'voice' && r.kind === 'audio') || (r.as === 'note' && r.kind === 'video')) out.reply.as = r.as;
  }
  // Пересланное: от кого (имя для показа)
  if (typeof c?.fwd === 'string') {
    const fwd = cleanProfileText(c.fwd, NAME_MAX).replace(/\n/g, ' ');
    if (fwd) out.fwd = fwd;
  }
  return out;
}

/** Часть источника файла: Blob/File (браузер) или Uint8Array. */
async function readPart(src, start, end) {
  if (src instanceof Uint8Array) return src.subarray(start, end);
  return new Uint8Array(await src.slice(start, end).arrayBuffer());
}
const REQUEST_TIMEOUT = 10_000;
const PING_TIMEOUT = 8_000;
const MAX_SEND_ATTEMPTS = 4;
const AUTH_CONTEXT = 'tainik/v3/auth';

export const ERROR_TEXT = {
  bad_backup: t('Это не файл переписки Тайника или он повреждён'),
  pinned_chats_max: t('Закрепить можно не больше 10 чатов'),
  folders_max: t('Папок может быть не больше 10'),
  profile_channels_max: t('В профиль можно прикрепить не больше двух каналов'),
  backup_version: t('Файл создан более новой версией Тайника — обновите приложение'),
  wrong_account: t('Это переписка другого аккаунта — импортировать её можно только в тот аккаунт, из которого она выгружена'),
  push_disabled: t('Уведомления на этом сервере выключены'),
  bad_subscription: t('Этот браузер не поддерживает уведомления Тайника'),
  bad_username: t('Юзернейм: 3–32 символа, латиница в нижнем регистре, цифры и _'),
  bad_keys: t('Сервер отклонил ключи'),
  username_taken: t('Это имя уже занято'),
  unknown_account: t('Такого аккаунта нет на сервере'),
  auth_failed: t('Не удалось подтвердить владение ключом'),
  logged_in_elsewhere: t('Это устройство открыто в другом окне'),
  device_removed: t('Это устройство отвязано от аккаунта'),
  account_deleted: t('Аккаунт удалён администратором сервера'),
  account_deleted_self: t('Аккаунт удалён с другого вашего устройства'),
  bad_confirm: t('Юзернейм введён неверно'),
  ip_banned: t('Доступ к серверу с вашего адреса заблокирован администратором'),
  too_many_devices: t('Достигнут предел: 5 устройств на аккаунт'),
  unknown_recipient: t('Такого пользователя нет'),
  too_large: t('Сообщение слишком большое'),
  rate_limited: t('Слишком много запросов, подождите'),
  too_many_connections: t('С вашего адреса уже слишком много подключений к серверу — попробуем ещё раз через несколько секунд'),
  timeout: t('Сервер не ответил'),
  offline: t('Нет соединения с сервером'),
  key_changed: t('Ключ собеседника изменился — сначала проверьте его'),
  bad_spk_signature: t('Ключи собеседника не прошли проверку подписи'),
  bad_link_code: t('Неверный код привязки'),
  provision_not_found: t('Код привязки устарел или уже использован — обновите его на новом устройстве'),
  provision_decrypt_failed: t('Не удалось расшифровать данные привязки'),
  billing_disabled: t('Подписка на этом сервере не подключена'),
  billing_failed: t('Не удалось выставить счёт, попробуйте позже'),
  billing_unavailable: t('Платёжный сервис не отвечает, попробуйте позже'),
  bad_plan: t('Такого тарифа нет'),
  bad_currency: t('Этой валютой оплатить нельзя'),
  no_rate: t('Не удалось узнать курс валюты, попробуйте позже или выберите другую'),
  premium_required: t('Фото профиля доступно с подпиской Премиум'),
  premium_presence: t('Скрывать статус «в сети» можно с подпиской Премиум'),
  premium_shop: t('Этот товар бесплатен с подпиской Премиум'),
  premium_video: t('Своё видео на фоне профиля — с подпиской Премиум'),
  shop_unknown: t('Этого товара больше нет в магазине'),
  shop_owned: t('Этот товар уже ваш'),
  shop_free: t('Этот товар бесплатный — его можно просто надеть'),
  shop_not_owned: t('Сначала купите этот товар'),
  video_too_long: t('Видео длиннее 15 секунд'),
  video_too_large: t('Видео больше 12 МБ'),
  gift_unknown_user: t('Нет пользователя с таким юзернеймом'),
  channel_not_found: t('Канал не найден'),
  bad_channel_link: t('Ссылка на канал неверная или устарела'),
  bad_channel_handle: t('Имя канала: от 5 до 32 латинских букв, цифр и «_», начинается с буквы'),
  channel_handle_taken: t('Это имя уже занято'),
  channel_title: t('Введите название канала'),
  channel_not_admin: t('Писать в канал могут только его владелец и администраторы'),
  channel_owner: t('Владелец не может отписаться — канал можно только удалить'),
  channel_not_subscriber: t('Администратором можно сделать только подписчика канала'),
  too_many_channels: t('Слишком много каналов'),
  bad_channel: t('Не удалось сохранить канал'),
  not_enough_coins: t('Не хватает монет — пополните баланс'),
  price_changed: t('Цена изменилась — посмотрите ещё раз'),
  gift_unavailable: t('Этому пользователю нельзя сделать подарок'),
  group_too_big: t('В группе может быть не больше 50 участников'),
  group_name: t('Введите название группы'),
  group_not_admin: t('Менять группу могут только её администраторы'),
  group_left: t('Вы больше не участник этой группы'),
  bad_device: t('Нельзя отвязать это устройство'),
  bad_url: t('Неверный адрес сервера'),
  you_blocked: t('Вы заблокировали этого пользователя. Разблокируйте, чтобы написать'),
  too_many_blocks: t('Заблокировано слишком много пользователей'),
  file_too_large: t('Файл слишком большой'),
  upload_quota: t('Достигнут дневной предел загрузки файлов'),
  storage_full: t('На сервере закончилось место для файлов'),
  bad_size: t('Пустой файл'),
  upload_failed: t('Не удалось загрузить файл'),
  media_expired: t('Файл больше недоступен: он удалён с сервера'),
  bad_media: t('Файл повреждён или подменён'),
  download_failed: t('Не удалось скачать файл'),
  cancelled: t('Отменено'),
};

const errorOf = (code) => Object.assign(new Error(ERROR_TEXT[code] || code), { code });

class Emitter {
  constructor() {
    this._h = new Map();
  }
  on(ev, fn) {
    if (!this._h.has(ev)) this._h.set(ev, new Set());
    this._h.get(ev).add(fn);
    return () => this._h.get(ev).delete(fn);
  }
  emit(ev, data) {
    for (const fn of this._h.get(ev) || []) {
      try {
        fn(data);
      } catch (e) {
        console.error(e);
      }
    }
  }
}

export class MessengerClient extends Emitter {
  /**
   * @param {object} o
   * @param {string} o.url        адрес WebSocket, напр. wss://example.com/ws
   * @param {object} o.storage    { get(k), set(k,v), del(k), clear() } — async, значения JSON
   * @param {Function} [o.WebSocketImpl]
   * @param {Function} [o.fetchImpl]      для загрузки и скачивания вложений
   */
  constructor({ url, storage, WebSocketImpl = globalThis.WebSocket, fetchImpl = (...a) => globalThis.fetch(...a), appVersion = null }) {
    super();
    this.url = url;
    this.appVersion = appVersion; // версия приложения — видна в списке устройств аккаунта
    this.active = true; // приложение на экране: только тогда собеседники видят «в сети»
    this.storage = storage;
    this.WS = WebSocketImpl;
    this.fetch = fetchImpl;
    this.account = null;
    this.status = 'offline';
    this.ws = null;
    this._reqId = 0;
    this._pending = new Map();
    this._lock = Promise.resolve();
    this._retry = 0;
    this._stopped = true;
    this._retryTimer = null;
    this._authExtra = null; // register / newDevice при первом входе
    this._inflight = new Set();
    this._pongWaiters = new Set();
    this.pingTimeout = PING_TIMEOUT;
    this.ps = this._protocolStore();
    this.presence = new Map();
    this.presenceHidden = false;
    this.verified = false; // у своего аккаунта официальная галочка
    this.look = {}; // надетые рамка и фон из магазина (действующие): { frame?, bg? }
    this.shopOn = false; // сервер с магазином (0.47 и новее)
    // Подписка «Премиум» своего аккаунта и тарифы сервера (null — сервер подписку не продаёт)
    this.premium = { active: false, until: null };
    this.coins = 0; // баланс монет — внутренней валюты (хранится на сервере)
    this.billing = null;
    this.blocked = new Set(); // чёрный список (хранится на сервере, общий для своих устройств)
    // Свой профиль (имя, «о себе»). Сервер его не знает: он уходит собеседникам зашифрованным
    this.profile = { name: '', bio: '', v: 0 };
    this._names = new Map(); // имя собеседника по юзернейму — для интерфейса
    this._verifiedChats = new Set(); // группы и каналы с галочкой (ключи чатов)
    this._avatars = new Map(); // фото профиля собеседника по юзернейму
    this._videos = new Map(); // своё видео на фоне профиля собеседника (описание файла)
    this._profileReplies = new Map(); // кому и когда повторно отправляли профиль по запросу
    this.push = { vapidKey: null, endpoint: null }; // Web Push: ключ сервера и текущая подписка этого устройства
  }

  // Хранилище протокола — тот же набор операций, что у Store-интерфейсов libsignal.
  _protocolStore() {
    const s = this.storage;
    const prekeys = async () => (await s.get('prekeys')) || { spks: {}, opks: {} };
    return {
      getLocalIdentity: async () => ({
        username: this.account.username,
        deviceId: this.account.deviceId,
        identity: this.account.identity,
      }),
      getSignedPreKey: async (id) => (await prekeys()).spks[id] || null,
      getOneTimePreKey: async (id) => (await prekeys()).opks[id] || null,
      removeOneTimePreKey: async (id) => {
        const p = await prekeys();
        delete p.opks[id];
        await s.set('prekeys', p);
      },
      loadSession: async (addr) => (await s.get('session:' + addr)) || null,
      storeSession: (addr, record) => s.set('session:' + addr, record),
    };
  }

  // ---------- Аккаунт ----------

  async load() {
    const acc = (await this.storage.get('account')) || null;
    this.account = acc && acc.v === 3 && Number.isInteger(acc.deviceId) ? acc : null; // данные старых версий не подходят
    if (this.account) {
      this.profile = cleanProfile(await this.storage.get('profile')) || { name: '', bio: '', v: 0 };
      this._indexNames(await this.contacts());
    }
    return this.account;
  }

  async _newDeviceKeys(identity) {
    const spk = await generateSignedPreKey(identity, 1);
    const opks = await generateOneTimePreKeys(1, OPK_BATCH);
    await this.storage.set('prekeys', { spks: { [spk.id]: spk }, opks: Object.fromEntries(opks.map((k) => [k.id, k])) });
    return { spk: publicSpk(spk), opks: opks.map(publicOpk) };
  }

  async _firstLogin(extra, timeout) {
    this._authExtra = extra;
    try {
      await this.connect({ timeout });
    } catch (e) {
      this.disconnect();
      await this.storage.clear();
      this.account = null;
      throw e;
    } finally {
      this._authExtra = null;
    }
    await this.storage.set('account', this.account);
    return this.account;
  }

  /** Новый аккаунт: ключ личности + prekey первого устройства. */
  async register(username, { deviceName = t('Устройство'), timeout = 15000 } = {}) {
    username = String(username).trim().toLowerCase();
    const identity = await generateIdentity();
    await this.storage.clear();
    // Новый аккаунт: уведомления «Тайника» с первого входа — обычные (с приветствием).
    // У привязанного устройства отметки нет: всё, что было до него, ляжет прочитанным и без всплывающих.
    await this.storage.set('notice-last', 0);
    await this.storage.set('profile-schema', PROFILE_SCHEMA); // новый аккаунт — переспрашивать профиль не у кого
    this.account = this._makeAccount(username, identity, deviceName);
    const keys = await this._newDeviceKeys(identity);
    return this._firstLogin({ register: { ...keys, deviceName } }, timeout);
  }

  _makeAccount(username, identity, deviceName) {
    return {
      v: 3,
      username,
      deviceId: null, // выдаёт сервер
      deviceName,
      identity,
      pub: publicIdentity(identity),
      nextOpkId: OPK_BATCH + 1,
      nextSpkId: 2,
      createdAt: Date.now(),
    };
  }

  async reset() {
    this.disconnect();
    await this.storage.clear();
    this.account = null;
  }

  async myFingerprint() {
    return fingerprint(this.account.pub);
  }

  // ---------- Привязка нового устройства ----------

  /**
   * НОВОЕ устройство: открывает канал привязки.
   * onCode(code) вызывается, когда код готов (показать QR / текст).
   * Promise завершается, когда привязка прошла и устройство зарегистрировано.
   */
  linkAsNewDevice({ deviceName = t('Устройство'), onCode, timeout = 15000 } = {}) {
    let cancel;
    const done = new Promise((resolve, reject) => {
      let ws;
      let linkKeys;
      let pid;
      let finished = false;
      const fail = (code) => {
        if (finished) return;
        finished = true;
        try {
          ws && ws.close();
        } catch {}
        reject(errorOf(code));
      };
      cancel = () => fail('cancelled');
      (async () => {
        linkKeys = await createLinkKeys();
        try {
          ws = new this.WS(this.url);
        } catch {
          return fail('bad_url');
        }
        ws.onopen = () => ws.send(JSON.stringify({ type: 'provision-open' }));
        ws.onerror = () => {};
        ws.onclose = () => fail('offline');
        ws.onmessage = async (ev) => {
          let msg;
          try {
            msg = JSON.parse(String(ev.data));
          } catch {
            return;
          }
          if (msg.type === 'provision-id') {
            pid = msg.pid;
            const code = makeLinkCode(pid, linkKeys.pub);
            onCode && onCode({ code, qrText: LINK_PREFIX + code, expiresAt: Date.now() + (msg.ttl || 600000) });
          } else if (msg.type === 'provision-message') {
            ws.onclose = null;
            ws.close();
            try {
              const payload = await openProvision(linkKeys, pid, msg.payload);
              await this._completeLink(payload, deviceName, timeout);
              finished = true;
              resolve(this.account);
            } catch (e) {
              finished = true;
              reject(e.code ? e : errorOf(e.message));
            }
          } else if (msg.type === 'error') {
            fail(msg.code);
          }
        };
      })().catch(() => fail('offline'));
    });
    return { done, cancel: () => cancel && cancel() };
  }

  async _completeLink(p, deviceName, timeout) {
    if (!p || p.v !== 1 || typeof p.username !== 'string') throw errorOf('provision_decrypt_failed');
    const identity = p.identity;
    if (!identity?.dh?.priv || !identity?.sign?.priv || !validIdentityPub(publicIdentity(identity))) {
      throw errorOf('provision_decrypt_failed');
    }
    // Проверяем, что приватные части соответствуют публичным
    const probe = te.encode('tainik/v3/probe');
    const sigOk = await edVerify(identity.sign.pub, probe, await edSign(identity.sign.priv, probe));
    const tmp = await genX25519();
    const [x, y] = [await dh(identity.dh.priv, tmp.pub), await dh(tmp.priv, identity.dh.pub)];
    if (!sigOk || x.some((b, i) => b !== y[i])) throw errorOf('provision_decrypt_failed');

    await this.storage.clear();
    this.account = this._makeAccount(p.username, identity, deviceName);
    const contacts = {};
    for (const c of Array.isArray(p.contacts) ? p.contacts : []) {
      if (typeof c?.username !== 'string' || !validIdentityPub(c.keys)) continue;
      contacts[c.username] = { username: c.username, keys: c.keys, verified: !!c.verified, unread: 0, lastTs: Date.now(), pending: [] };
      const prof = cleanProfile(c.profile);
      if (prof) contacts[c.username].profile = prof;
      if (c.shareProfile) contacts[c.username].shareProfile = true;
    }
    // Группы: состав и название (переписка, как и в личных чатах, не переносится)
    for (const raw of Array.isArray(p.groups) ? p.groups : []) {
      const g = cleanGroup(raw);
      if (!g) continue;
      if (raw.left) g.left = true;
      contacts[groupKey(g.id)] = { username: groupKey(g.id), group: g, unread: 0, lastTs: Date.now(), pending: [] };
    }
    for (const ch of Array.isArray(p.channels) ? p.channels : []) {
      if (!CHANNEL_ID_RE.test(String(ch?.id)) || !isKey32(ch.key)) continue;
      contacts[channelKey(ch.id)] = { username: channelKey(ch.id), unread: 0, lastTs: Date.now(), pending: [], hidden: true, channel: { id: ch.id, key: ch.key, lastSeq: 0 } };
    }
    for (const chat of Array.isArray(p.archived) ? p.archived.slice(0, 5000) : []) {
      if (typeof chat === 'string' && contacts[chat]) Object.assign(contacts[chat], { archived: true, archivedTs: 1 });
    }
    for (const [chat, ts] of Array.isArray(p.top) ? p.top.slice(0, PINNED_CHATS_MAX) : []) {
      if (typeof chat === 'string' && contacts[chat] && Number.isFinite(ts)) Object.assign(contacts[chat], { top: ts, topTs: 1 });
    }
    if (Array.isArray(p.folders)) await this.storage.set('folders', { v: 1, list: cleanFolders(p.folders) });
    await this.storage.set('contacts', contacts);
    this._indexNames(contacts);
    this.profile = cleanProfile(p.profile) || { name: '', bio: '', v: 0 };
    if (this.profile.v) await this.storage.set('profile', this.profile);
    // Профиль только что пришёл при привязке в этом формате — переспрашивать свои устройства не нужно
    await this.storage.set('profile-schema', PROFILE_SCHEMA);
    const keys = await this._newDeviceKeys(identity);
    return this._firstLogin({ newDevice: { ...keys, deviceName } }, timeout);
  }

  /** ПРИВЯЗАННОЕ устройство: передаёт ключ личности и контакты новому устройству по коду. */
  async linkDevice(codeInput) {
    let link;
    try {
      link = parseLinkCode(codeInput);
    } catch {
      throw errorOf('bad_link_code');
    }
    // Фото собеседников — сколько влезет в канал привязки, начиная с недавних чатов
    let room = PROVISION_AVATARS;
    const contacts = Object.values(await this.contacts())
      .sort((a, b) => (b.lastTs || 0) - (a.lastTs || 0))
      .map((c) => {
        let profile = c.profile || undefined;
        if (profile?.avatar) {
          if (profile.avatar.length <= room) room -= profile.avatar.length;
          else profile = { ...profile, avatar: undefined };
        }
        return { username: c.username, keys: c.keys, verified: !!c.verified, profile, shareProfile: !!c.shareProfile };
      })
      .filter((c) => !isGroupChat(c.username) && !isChannelChat(c.username) && !isSystemChat(c.username) && !isSupportChat(c.username));
    const groups = Object.values(await this.contacts())
      .filter((c) => c.group)
      .map((c) => ({ ...c.group }));
    // Каналы: только id и ключ — остальное новое устройство получит от сервера при входе
    const channels = Object.values(await this.contacts())
      .filter((c) => c.channel?.key && !c.channel.gone)
      .map((c) => ({ id: c.channel.id, key: c.channel.key }));
    // Архив: какие чаты убраны в архив — и на новом устройстве они будут там же
    const archived = Object.values(await this.contacts())
      .filter((c) => c.archived)
      .map((c) => c.username);
    const top = Object.values(await this.contacts())
      .filter((c) => c.top)
      .map((c) => [c.username, c.top]);
    const folders = await this.folders();
    const payload = { v: 1, username: this.account.username, identity: this.account.identity, contacts, groups, channels, archived, top, folders, profile: this.profile };
    let sealed;
    try {
      sealed = await sealProvision(link, payload);
    } catch {
      throw errorOf('bad_link_code');
    }
    await this._request({ type: 'provision-send', pid: link.pid, payload: sealed });
  }

  async listDevices() {
    return (await this._request({ type: 'list-devices' })).devices;
  }

  async unlinkDevice(deviceId) {
    await this._request({ type: 'unlink-device', deviceId });
    await this._serial(async () => {
      const me = this.account.username;
      const list = ((await this.storage.get('devices:' + me)) || []).filter((d) => d !== deviceId);
      await this.storage.set('devices:' + me, list);
      await deleteSession(this.ps, { name: me, device: deviceId });
    });
  }

  // ---------- Соединение ----------

  /** Подключается и проходит авторизацию. Promise завершается на первом 'ready'. */
  connect({ timeout = 0 } = {}) {
    if (!this.account) return Promise.reject(new Error(t('Нет аккаунта')));
    this._stopped = false;
    return new Promise((resolve, reject) => {
      const timer = timeout ? setTimeout(() => this._fatal('timeout'), timeout) : null;
      this._firstReady = {
        resolve: (v) => (clearTimeout(timer), resolve(v)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      };
      this._open();
    });
  }

  disconnect() {
    this._stopped = true;
    clearTimeout(this._retryTimer);
    const ws = this.ws;
    this.ws = null;
    this._inflight.clear();
    if (ws) ws.close();
    if (this.status !== 'replaced') this._setStatus('offline');
  }

  _setStatus(s) {
    if (this.status === s) return;
    this.status = s;
    this.emit('status', s);
  }

  _open() {
    clearTimeout(this._retryTimer);
    this._setStatus('connecting');
    let ws;
    try {
      ws = new this.WS(this.url);
    } catch {
      return this._fatal('bad_url');
    }
    this.ws = ws;
    ws.onopen = () => {
      this._send({
        type: 'auth',
        username: this.account.username,
        deviceId: this.account.deviceId ?? undefined,
        identity: this.account.pub,
        ...(this.appVersion ? { appVersion: String(this.appVersion) } : {}),
        active: this.active,
        ...(this._authExtra || {}),
      });
    };
    ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
      } catch {
        return;
      }
      this._onServer(msg).catch((e) => console.error(e));
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this._dropSocket();
      if (this._stopped) return;
      this._setStatus('offline');
      const delay = Math.min(15000, 1000 * 2 ** this._retry++);
      this._retryTimer = setTimeout(() => this._open(), delay);
    };
    ws.onerror = () => {};
  }

  _dropSocket() {
    const ws = this.ws;
    this.ws = null;
    this._inflight.clear();
    for (const p of this._pending.values()) p.reject(errorOf('offline'));
    this._pending.clear();
    if (ws) {
      ws.onclose = null;
      try {
        ws.close();
      } catch {}
    }
  }

  /**
   * Переподключиться сразу, не дожидаясь таймера (сеть вернулась, телефон проснулся).
   * restart — закрыть и текущее соединение: после смены сети оно может быть «мёртвым».
   */
  reconnectNow({ restart = false } = {}) {
    if (this._stopped || !this.account) return false;
    if (this.ws && !restart) return false;
    clearTimeout(this._retryTimer);
    this._retry = 0;
    if (this.ws) this._dropSocket();
    this._open();
    return true;
  }

  /**
   * Проверяет, что соединение живое: запрос ping должен получить ответ.
   * Нет соединения или ответа — переподключается. Возвращает true, если связь была.
   */
  async checkConnection() {
    if (this._stopped || !this.account) return false;
    if (!this.ws) return (this.reconnectNow(), false);
    if (this.ws.readyState !== 1) return false; // ещё подключаемся
    const ws = this.ws;
    // Сервер отвечает на ping сообщением pong без reqId (так и в старых версиях)
    const alive = await new Promise((resolve) => {
      const timer = setTimeout(() => done(false), this.pingTimeout);
      const done = (v) => {
        clearTimeout(timer);
        this._pongWaiters.delete(done);
        resolve(v);
      };
      this._pongWaiters.add(done);
      if (!this._send({ type: 'ping' })) done(false);
    });
    if (!alive && this.ws === ws) this.reconnectNow({ restart: true });
    return alive;
  }

  _send(obj) {
    if (!this.ws || this.ws.readyState !== 1) return false;
    this.ws.send(JSON.stringify(obj));
    return true;
  }

  _request(obj) {
    const reqId = ++this._reqId;
    return new Promise((resolve, reject) => {
      if (!this._send({ ...obj, reqId })) return reject(errorOf('offline'));
      const timer = setTimeout(() => {
        this._pending.delete(reqId);
        reject(errorOf('timeout'));
      }, REQUEST_TIMEOUT);
      this._pending.set(reqId, {
        resolve: (v) => (clearTimeout(timer), resolve(v)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      });
    });
  }

  _fatal(code, extra = {}) {
    this._stopped = true;
    if (this._firstReady) {
      this._firstReady.reject(errorOf(code));
      this._firstReady = null;
    }
    const text = code === 'account_deleted' && extra.self ? ERROR_TEXT.account_deleted_self : ERROR_TEXT[code] || code;
    this.emit('error', { code, text, ...extra });
    if (this.ws) this.ws.close();
  }

  async _onServer(msg) {
    if (msg.reqId && this._pending.has(msg.reqId)) {
      const p = this._pending.get(msg.reqId);
      this._pending.delete(msg.reqId);
      return msg.type === 'error' ? p.reject(Object.assign(errorOf(msg.code), { data: msg })) : p.resolve(msg);
    }
    switch (msg.type) {
      case 'challenge': {
        const data = te.encode(`${AUTH_CONTEXT}|${this.account.username}|${msg.nonce}`);
        this._send({ type: 'auth-proof', sig: await edSign(this.account.identity.sign.priv, data) });
        return;
      }
      case 'pong':
        for (const done of [...this._pongWaiters]) done(true);
        return;
      case 'ready':
        this._retry = 0;
        if (this.account.deviceId !== msg.deviceId) {
          this.account.deviceId = msg.deviceId;
          if (!this._authExtra) await this.storage.set('account', this.account);
        }
        this.presenceHidden = !!msg.presenceHidden;
        if (this.verified !== !!msg.verified) {
          this.verified = !!msg.verified;
          this.emit('verified', this.verified);
        }
        this.push = { vapidKey: msg.vapidKey || null, endpoint: msg.pushEndpoint || null };
        this.billing = msg.billing && Array.isArray(msg.billing.plans) ? msg.billing : null;
        this._send({ type: 'set-active', active: this.active }); // мог смениться, пока шёл вход
        this._setPremium(msg.premium);
        this._setCoins(msg.coins);
        this.shopOn = !!msg.shop;
        this._setLook(msg.look);
        if (Array.isArray(msg.channels)) this._onChannels(msg.channels).catch((e) => console.error('channels', e));
        if (Array.isArray(msg.gifts) && msg.gifts.length) this._serial(() => this._onGifts(msg.gifts)).catch(() => {});
        if (Array.isArray(msg.notices)) this._serial(() => this._onNotices(msg.notices)).catch((e) => console.error('notices', e));
        if (Array.isArray(msg.support)) this._serial(() => this._onSupport(msg.support, true)).catch((e) => console.error('support', e));
        if (Array.isArray(msg.blocks)) this._setBlocks(msg.blocks);
        this._groupsSynced = null;
        this._setStatus('online');
        this._syncGroups().catch(() => {});
        this._subscribePresence().catch(() => {});
        if (this._firstReady) {
          this._firstReady.resolve();
          this._firstReady = null;
        }
        this._pumpOutbox();
        this._serial(() => this._askOwnProfile()).catch(() => {});
        this._maintainPrekeys(msg.opkCount).catch((e) => console.error('prekeys', e));
        return;
      case 'presence':
        this._onPresence(msg.list);
        return;
      case 'blocks':
        this._setBlocks(msg.list);
        return;
      case 'verified':
        this.verified = !!msg.verified;
        this.emit('verified', this.verified);
        return;
      case 'premium':
        this._setPremium(msg);
        return;
      case 'gift':
        this._serial(() => this._onGifts([msg.gift])).catch(() => {});
        return;
      case 'coins':
        this._setCoins(msg.balance);
        return;
      case 'look':
        this._setLook(msg.look);
        return;
      case 'shop-owned': // куплено на другом своём устройстве или выдано администратором
        this.emit('shop', { owned: String(msg.id || '') });
        return;
      case 'shop-revoked': // администратор забрал товар
        this.emit('shop', { revoked: String(msg.id || '') });
        return;
      case 'notice':
        this._serial(() => this._onNotices([msg.notice])).catch((e) => console.error('notices', e));
        return;
      case 'support':
        this._serial(() => this._onSupport([msg.msg])).catch((e) => console.error('support', e));
        return;
      case 'group-removed':
        if (GID_RE.test(String(msg.id))) this._serial(() => this._onGroupsRemoved([String(msg.id)])).catch(() => {});
        return;
      case 'group-verified':
        if (/^[0-9a-f]{24}$/.test(String(msg.id))) this._setGroupsVerified(null, { chat: groupKey(msg.id), on: msg.verified === true }).catch(() => {});
        return;
      case 'channel-post':
        this._serial(() => this._onChannelPost(String(msg.id), msg.post)).catch(() => {});
        return;
      case 'channel-del':
        this._serial(() => this._removeChannelPosts(channelKey(String(msg.id)), Array.isArray(msg.seqs) ? msg.seqs : [])).catch(() => {});
        return;
      case 'channel-meta':
        this._serial(async () => {
          const all = await this.contacts();
          const chat = await this._applyChannelInfo(all, msg.channel);
          if (!chat) return;
          if (!msg.channel.role) all[chat].channel.gone = true; // нас отписали (или сняли с канала)
          await this._saveContacts(all);
          this.emit('channel', { chat });
        })
          .then(() => this._syncChannel(channelKey(String(msg.channel?.id))))
          .catch(() => {});
        return;
      case 'channel-deleted':
      case 'channel-left':
        this._serial(async () => {
          const all = await this.contacts();
          const c = all[channelKey(String(msg.id))];
          if (!c?.channel) return;
          if (msg.type === 'channel-left') delete all[c.username];
          else c.channel.gone = true;
          await this._saveContacts(all);
        })
          .then(() => this.emit('channel-removed', { chat: channelKey(String(msg.id)) }))
          .catch(() => {});
        return;
      case 'prekey-count':
        this._maintainPrekeys(msg.count).catch((e) => console.error('prekeys', e));
        return;
      case 'message':
        return this._serial(() => this._onEnvelope(msg));
      case 'sent-ephemeral':
        return;
      case 'sent':
        return this._serial(() => this._onSent(msg.cid));
      case 'delivered':
        if (msg.to === this.account.username) return;
        return this._serial(async () => {
          // Сообщение группы: доставлено хотя бы одному участнику
          const chat = (await this._groupSentChat(msg.id)) || msg.to;
          await this._setMsgStatus(chat, msg.id, 'delivered');
        });
      case 'devices-changed':
        this.emit('devices-changed');
        return;
      case 'error': {
        if (msg.code === 'mismatched_devices') return this._serial(() => this._onMismatch(msg));
        if (msg.code === 'device_removed' || msg.code === 'account_deleted' || msg.code === 'ip_banned') return this._fatal(msg.code, { self: msg.self === true });
        if (msg.code === 'logged_in_elsewhere') {
          this._setStatus('replaced');
          return this._fatal(msg.code);
        }
        const busy = msg.code === 'too_many_connections' || msg.code === 'rate_limited';
        // Перегрузка при регистрации/привязке — отказ с причиной; у вошедшего — повтор позже (соединение закроет сервер)
        if (this._firstReady && (['username_taken', 'auth_failed', 'bad_username', 'bad_keys', 'unknown_account', 'too_many_devices'].includes(msg.code) || (busy && this._authExtra))) {
          return this._fatal(msg.code);
        }
        if (msg.cid) return this._serial(() => this._failOutbox(msg.cid));
        this.emit('error', { code: msg.code, text: ERROR_TEXT[msg.code] || msg.code });
        return;
      }
    }
  }

  // Все изменения состояния — строго по очереди: храповик не терпит гонок.
  _serial(fn) {
    const run = this._lock.then(fn);
    this._lock = run.catch(() => {}); // ошибка уже доставлена вызывающему
    return run;
  }

  // ---------- Prekey: пополнение и ротация ----------

  async _maintainPrekeys(serverOpkCount) {
    return this._serial(async () => {
      const p = (await this.storage.get('prekeys')) || { spks: {}, opks: {} };
      const upload = {};
      if (serverOpkCount < OPK_LOW_WATER) {
        const fresh = await generateOneTimePreKeys(this.account.nextOpkId, OPK_BATCH);
        for (const k of fresh) p.opks[k.id] = k;
        this.account.nextOpkId += OPK_BATCH;
        upload.opks = fresh.map(publicOpk);
      }
      const spks = Object.values(p.spks).sort((a, b) => b.id - a.id);
      if (!spks.length || Date.now() - spks[0].createdAt > SPK_ROTATE_MS) {
        const spk = await generateSignedPreKey(this.account.identity, this.account.nextSpkId++);
        p.spks[spk.id] = spk;
        upload.spk = publicSpk(spk);
      }
      const newestId = Math.max(...Object.keys(p.spks).map(Number));
      for (const s of Object.values(p.spks)) {
        if (s.id !== newestId && Date.now() - s.createdAt > SPK_ROTATE_MS + SPK_KEEP_MS) delete p.spks[s.id];
      }
      if (!upload.opks && !upload.spk) return;
      // Сначала сохраняем приватные части локально, потом публикуем
      await this.storage.set('prekeys', p);
      await this.storage.set('account', this.account);
      await this._request({ type: 'upload-prekeys', ...upload });
    });
  }

  // ---------- Присутствие ----------

  // ---------- Чёрный список ----------
  // Сервер не доставляет вам сообщения и звонки заблокированного (у него они остаются
  // «отправленными»), а ему показывает «был(а) давно» вместо вашего статуса.

  _setBlocks(list) {
    const next = new Set((Array.isArray(list) ? list : []).filter((n) => typeof n === 'string'));
    const same = next.size === this.blocked.size && [...next].every((n) => this.blocked.has(n));
    this.blocked = next;
    if (!same) this.emit('blocks', [...next]);
  }

  isBlocked(username) {
    return this.blocked.has(String(username).toLowerCase());
  }

  /** Заблокировать (on = true) или разблокировать собеседника. */
  async setBlocked(username, on) {
    const r = await this._request({ type: 'block', username: String(username).toLowerCase(), on: !!on });
    this._setBlocks(r.list);
  }

  /**
   * Удалить чат: переписка стирается на всех ваших устройствах, чат пропадает из списка
   * (ключ собеседника остаётся — при новом сообщении проверка ключа продолжит работать).
   * forAll — стереть переписку и у собеседника.
   */
  async deleteChat(username, { forAll = false } = {}) {
    await this._serial(async () => {
      const me = this.account.username;
      await this._clearChat(username, true);
      let outbox = (await this.storage.get('outbox')) || [];
      // Неотправленное в этот чат больше не нужно
      outbox = outbox.filter((x) => !((x.kind === 'msg' && (x.to === username || x.chat === username)) || (x.kind === 'sync' && x.content?.to === username)));
      if (isGroupChat(username) || isSystemChat(username) || isSupportChat(username)) forAll = false; // в группе и в «Тайнике» — только у себя
      const ts = Date.now();
      const c = (await this.contacts())[username];
      if (forAll && c && !c.keyChanged) outbox.push({ id: randomId(), to: username, kind: 'ctl', content: { t: 'clear-chat', ts }, attempts: 0 });
      outbox.push({ id: randomId(), to: me, kind: 'ctl', content: { t: 'sync-delete-chat', chat: username, forAll, ts }, attempts: 0 });
      await this.storage.set('outbox', outbox);
    });
    this._pumpOutbox();
  }

  async _clearChat(chat, hide) {
    const ids = (await this.messages(chat)).map((m) => m.id);
    await this.storage.set('chat:' + chat, []);
    const del = (await this.storage.get('deleted:' + chat)) || [];
    for (const id of ids) if (!del.includes(id)) del.push(id);
    await this.storage.set('deleted:' + chat, del.slice(-DELETED_LIMIT));
    const all = await this.contacts();
    if (all[chat]) {
      all[chat].unread = 0;
      if (hide) all[chat].hidden = true;
      await this._saveContacts(all);
    }
    this.emit('deleted', { contact: chat, ids, chat: true });
  }

  /** Последний известный статус собеседника: { online, lastSeen, hidden, verified } или undefined */
  presenceOf(username) {
    return this.presence.get(username);
  }

  /** Официальная галочка у собеседника (её ставит администратор сервера). */
  isVerified(username) {
    if (isSystemChat(username) || isSupportChat(username)) return true; // служебные чаты «Тайник» и «Поддержка»
    if (isGroupChat(username) || isChannelChat(username)) return this._verifiedChats.has(username); // галочку ставит администратор
    return !!this.presence.get(username)?.verified;
  }

  // ---------- Подписка «Тайник Премиум» ----------
  // Оплата — криптовалютой через xRocket Pay: сервер выставляет счёт и сам узнаёт об оплате.
  // Сервер не видит фото профиля (оно в зашифрованном профиле), но знает, у кого подписка:
  // фото показывается, только пока у его владельца она действует.

  _setPremium(p) {
    const next = { active: !!p?.active, until: Number.isFinite(p?.until) ? p.until : null };
    if (next.active === this.premium.active && next.until === this.premium.until) return;
    this.premium = next;
    this.emit('premium', next);
  }

  /** Действует ли своя подписка. */
  isPremium() {
    return this.premium.active && (!this.premium.until || this.premium.until > Date.now());
  }

  /** Подписка у собеседника (или у себя). */
  hasPremium(username) {
    if (this.account && username === this.account.username) return this.isPremium();
    return !!this.presence.get(username)?.premium;
  }

  /** Фото профиля для показа: только если у владельца действует подписка. */
  avatarOf(username) {
    if (!this.hasPremium(username)) return null;
    if (this.account && username === this.account.username) return this.profile.avatar || null;
    return this._avatars.get(username) || null;
  }

  /** Фото профиля для просмотра на весь экран: большое, если есть, иначе маленькое; null — нет фото. */
  async photoOf(username) {
    const small = this.avatarOf(username);
    if (!small) return null;
    if (this.account && username === this.account.username) return this.profile.photo || small;
    const big = await this.storage.get('photo:' + username);
    return validPhoto(big) ? big : small;
  }

  /**
   * Счёт на оплату тарифа: { id, url, days, price, currency, expiresAt }; url — оплата в @xRocket.
   * currency — одна из billing.currencies (по умолчанию основная); не в основной валюте сумма — по курсу.
   */
  async buyPremium(planId, currency, giftTo = null) {
    const req = { type: 'premium-buy', plan: String(planId) };
    if (currency) req.currency = String(currency);
    if (giftTo) req.giftTo = String(giftTo).trim().replace(/^@/, '').toLowerCase();
    const r = await this._request(req);
    return { id: r.id, url: r.url, days: r.days, price: r.price, currency: r.currency, expiresAt: r.expiresAt, giftTo: r.giftTo || null };
  }

  /**
   * Оплаченные подарки Премиума (от сервера: при входе — за 30 дней, и сразу после оплаты).
   * Каждый показывается один раз: отметка в чате дарителя и получателя и событие 'gift'.
   */
  async _onGifts(list) {
    const me = this.account?.username;
    if (!me) return;
    const seen = new Set((await this.storage.get('gifts-seen')) || []);
    const fresh = [];
    for (const g of list) {
      if (!g || typeof g.id !== 'string' || !/^tk[0-9a-f]{24}$/.test(g.id) || seen.has(g.id)) continue;
      if (typeof g.from !== 'string' || typeof g.to !== 'string' || g.from === g.to || (g.from !== me && g.to !== me)) continue;
      const days = Number.isInteger(g.days) && g.days > 0 ? g.days : 0;
      const at = Number.isFinite(g.at) ? g.at : Date.now();
      if (!days) continue;
      const peer = g.from === me ? g.to : g.from;
      const all = await this.contacts();
      const c = await this._ensureContact(all, peer).catch(() => null);
      if (!c) continue;
      if (g.to === me) {
        delete c.hidden; // подарок от незнакомого — чат с дарителем появляется в списке
        c.unread = (c.unread || 0) + 1;
      }
      c.lastTs = Math.max(c.lastTs || 0, at);
      await this._saveContacts(all);
      const gift = { id: g.id, from: g.from, to: g.to, days, at };
      await this._appendMsg(peer, { id: 'gift-' + g.id, dir: 'sys', ts: at, content: { t: 'gift', ...gift } });
      seen.add(g.id);
      fresh.push(gift);
    }
    if (!fresh.length) return;
    await this.storage.set('gifts-seen', [...seen].slice(-200));
    for (const gift of fresh) this.emit('gift', gift);
  }

  /**
   * Служебные уведомления → сообщения в чате «Тайник». Каждое — один раз (по id). При первом
   * получении на привязанном устройстве всё, что пришло до него (за 30 дней, включая «вход с
   * нового устройства» о нём самом), ложится прочитанным и без всплывающих уведомлений.
   * Время сообщения — время сервера: одинаковое на всех устройствах (по нему сверяется «прочитано»).
   */
  async _onNotices(list) {
    if (!this.account || !Array.isArray(list)) return;
    const last = await this.storage.get('notice-last');
    const first = !Number.isSafeInteger(last);
    const now = Date.now();
    const fresh = [];
    let maxId = first ? 0 : last;
    for (const n of list) {
      if (!Number.isSafeInteger(n?.id) || n.id <= maxId) continue;
      maxId = n.id;
      const content = cleanNotice(n);
      if (!content) continue;
      const ts = Number.isFinite(n.at) && n.at > 0 ? n.at : now;
      fresh.push({ m: { id: 'n' + n.id, dir: 'in', ts, content }, quiet: first });
    }
    if (maxId !== last) await this.storage.set('notice-last', maxId);
    if (!fresh.length) return;
    const all = await this.contacts();
    const c = (all[SYSTEM_CHAT] ||= { username: SYSTEM_CHAT, system: true, unread: 0, lastTs: 0, pending: [] });
    delete c.hidden; // чат удалили — с новым уведомлением он вернётся
    const msgs = await this.messages(SYSTEM_CHAT);
    const have = new Set(msgs.map((m) => m.id));
    const added = fresh.filter((x) => !have.has(x.m.id));
    for (const x of added) {
      msgs.push(x.m);
      if (!x.quiet) c.unread = (c.unread || 0) + 1;
      c.lastTs = Math.max(c.lastTs || 0, x.m.ts);
    }
    msgs.sort((a, b) => a.ts - b.ts);
    await this.storage.set('chat:' + SYSTEM_CHAT, msgs.slice(-500));
    await this._saveContacts(all);
    for (const x of added) this.emit('message', { contact: SYSTEM_CHAT, message: x.m, quiet: x.quiet });
  }

  // ---------- Поддержка ----------
  /** Чат поддержки в списке (создаётся, когда его открывают впервые). */
  async openSupport() {
    await this._serial(async () => {
      const all = await this.contacts();
      if (all[SUPPORT_CHAT] && !all[SUPPORT_CHAT].hidden) return;
      all[SUPPORT_CHAT] ||= { username: SUPPORT_CHAT, support: true, unread: 0, lastTs: Date.now(), pending: [] };
      delete all[SUPPORT_CHAT].hidden;
      await this._saveContacts(all);
    });
    return SUPPORT_CHAT;
  }

  async _sendSupport(text) {
    text = String(text ?? '').trim();
    if (!text) return;
    if (text.length > SUPPORT_TEXT_MAX) throw errorOf('too_large');
    const r = await this._request({ type: 'support-send', text });
    await this._serial(() => this._onSupport([r.msg]));
  }

  /**
   * Сообщения поддержки (с сервера: при входе — история, потом — новые). Ответы администратора —
   * входящие, свои — исходящие. Каждое — один раз. При первом получении на устройстве
   * история ложится прочитанной и без всплывающих уведомлений.
   */
  async _onSupport(list, initial = false) {
    if (!this.account || !Array.isArray(list) || !list.length) return;
    const last = await this.storage.get('support-last');
    const first = initial && !Number.isSafeInteger(last);
    const all = await this.contacts();
    const msgs = await this.messages(SUPPORT_CHAT);
    const have = new Set(msgs.map((m) => m.id));
    const deleted = new Set((await this.storage.get('deleted:' + SUPPORT_CHAT)) || []);
    const added = [];
    let maxId = Number.isSafeInteger(last) ? last : 0;
    for (const s of list) {
      if (!Number.isSafeInteger(s?.id) || typeof s.text !== 'string') continue;
      maxId = Math.max(maxId, s.id);
      const id = 's' + s.id;
      if (have.has(id) || deleted.has(id)) continue;
      const m = { id, dir: s.admin ? 'in' : 'out', ts: Number.isFinite(s.at) ? s.at : Date.now(), content: { t: 'text', body: s.text.slice(0, SUPPORT_TEXT_MAX) } };
      if (!s.admin) m.status = 'sent';
      msgs.push(m);
      have.add(id);
      added.push({ m, quiet: first || !s.admin || (Number.isSafeInteger(last) && s.id <= last) });
    }
    await this.storage.set('support-last', maxId);
    if (!added.length) return;
    const c = (all[SUPPORT_CHAT] ||= { username: SUPPORT_CHAT, support: true, unread: 0, lastTs: 0, pending: [] });
    delete c.hidden;
    for (const x of added) {
      if (!x.quiet) c.unread = (c.unread || 0) + 1;
      c.lastTs = Math.max(c.lastTs || 0, x.m.ts);
    }
    msgs.sort((a, b) => a.ts - b.ts);
    await this.storage.set('chat:' + SUPPORT_CHAT, msgs.slice(-1000));
    await this._saveContacts(all);
    for (const x of added) this.emit('message', { contact: SUPPORT_CHAT, message: x.m, quiet: x.quiet });
  }

  // ---------- Магазин: рамки и фоны профиля ----------
  _setLook(l) {
    const next = cleanLook(l);
    if (sameLook(next, this.look)) return;
    this.look = next;
    this.emit('look', next);
  }

  /** Надетые рамка и фон пользователя (или свои): { frame?, bg? } — id товаров. */
  lookOf(username) {
    if (this.account && username === this.account.username) return this.look;
    return this.presence.get(username)?.look || {};
  }

  /** Витрина: { items, owned, chosen, look }. chosen — что выбрано (даже если сейчас не действует). */
  async shopList() {
    const r = await this._request({ type: 'shop-list' });
    this._setLook(r.look);
    return {
      items: (Array.isArray(r.items) ? r.items : []).map(cleanShopItem).filter(Boolean),
      owned: (Array.isArray(r.owned) ? r.owned : []).filter((id) => typeof id === 'string' && SHOP_ID_RE.test(id)),
      chosen: cleanLook(r.chosen),
      look: this.look,
    };
  }

  /** Купить товар за монеты. cost — цена, которую видел пользователь (иначе price_changed). */
  async buyShopItem(id, cost) {
    const r = await this._request({ type: 'shop-buy', id: String(id), cost });
    this._setCoins(r.coins);
    return { coins: r.coins };
  }

  /** Надеть товар (kind: 'frame' | 'bg') или снять (id null). */
  async equipShopItem(kind, id) {
    const r = await this._request({ type: 'shop-equip', kind, id: id || null });
    this._setLook(r.look);
    return { chosen: cleanLook(r.chosen), look: this.look };
  }

  /** Адрес файла товара на сервере. */
  shopFileUrl(id) {
    if (!SHOP_ID_RE.test(String(id))) throw errorOf('shop_unknown');
    return `${this._httpBase()}/api/shop/${id}`;
  }

  /** Скачать файл товара: Blob картинки или видео (тип — от сервера, только image/* и video/*). */
  async fetchShopFile(id) {
    let res;
    try {
      res = await this.fetch(this.shopFileUrl(id));
    } catch {
      throw errorOf('download_failed');
    }
    if (!res.ok) throw errorOf(res.status === 404 ? 'shop_unknown' : 'download_failed');
    const type = String(res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!/^(image\/(png|webp|gif|jpeg)|video\/(mp4|webm))$/.test(type)) throw errorOf('bad_media');
    const buf = await res.arrayBuffer();
    if (buf.byteLength > SHOP_FILE_MAX) throw errorOf('bad_media');
    return new Blob([buf], { type });
  }

  /** Своё видео на фон профиля, если у владельца Премиум: описание файла или null. */
  profileVideoOf(username) {
    if (!this.hasPremium(username)) return null;
    if (this.account && username === this.account.username) return this.profile.video || null;
    return this._videos?.get(username) || null;
  }

  /**
   * Поставить своё видео на фон профиля (Премиум): source — File/Blob, meta — { mime, w, h, dur }.
   * null — убрать. Видео шифруется, ключ уходит собеседникам в профиле; сервер его хранит, пока
   * оно в профиле. Надетый фон из магазина при этом снимается (на фоне — что-то одно).
   */
  async setProfileVideo(source, meta = {}, { onProgress = () => {}, signal } = {}) {
    if (source == null) {
      await this._request({ type: 'profile-video', id: null });
      if (this.profile.video) await this.setProfile({ video: null });
      return null;
    }
    if (!this.isPremium()) throw errorOf('premium_video');
    const size = source.size ?? source.length;
    const mime = String(meta.mime || source.type || '').toLowerCase();
    if (!isProfileBgMime(mime)) throw errorOf('bad_media');
    if (!size || size > PROFILE_VIDEO_MAX) throw errorOf('video_too_large');
    if (Number.isFinite(meta.dur) && meta.dur > PROFILE_VIDEO_SEC + 0.5) throw errorOf('video_too_long');
    const { keyB64, id } = await this._upload(source, size, onProgress, signal);
    await this._request({ type: 'profile-video', id });
    const video = cleanProfileVideo({ id, key: keyB64, size, mime, kind: kindOf(mime), name: 'bg', w: meta.w, h: meta.h, dur: meta.dur != null ? Math.round(meta.dur) : undefined });
    if (!video) throw errorOf('bad_media');
    await this.setProfile({ video });
    if (this.look.bg) await this.equipShopItem('bg', null).catch(() => {});
    return video;
  }

  _setCoins(n) {
    n = Number.isSafeInteger(n) && n >= 0 ? n : 0;
    if (n === this.coins) return;
    this.coins = n;
    this.emit('coins', n);
  }

  /** Счёт на пакет монет (id из billing.packs): как buyPremium, в ответе coins — сколько монет. */
  async buyCoins(packId, currency) {
    const req = { type: 'premium-buy', plan: String(packId) };
    if (currency) req.currency = String(currency);
    const r = await this._request(req);
    return { id: r.id, url: r.url, coins: r.coins, price: r.price, currency: r.currency, expiresAt: r.expiresAt, giftTo: null };
  }

  /**
   * Премиум за монеты — себе или в подарок (giftTo). cost — цена, которую видел пользователь:
   * если на сервере она другая, ничего не списывается (price_changed).
   */
  async premiumForCoins(planId, cost, giftTo = null) {
    const req = { type: 'premium-coins', plan: String(planId), cost };
    if (giftTo) req.giftTo = String(giftTo).trim().replace(/^@/, '').toLowerCase();
    const r = await this._request(req);
    this._setCoins(r.coins);
    return { coins: r.coins, until: r.until, gift: r.gift || null };
  }

  /** Спросить сервер, не пришла ли оплата. Возвращает состояние подписки. */
  async checkPremium() {
    this._setPremium(await this._request({ type: 'premium-check' }));
    return this.premium;
  }

  _onPresence(list) {
    for (const p of Array.isArray(list) ? list : []) {
      if (!p || typeof p.username !== 'string') continue;
      this.presence.set(p.username, { online: !!p.online, lastSeen: p.lastSeen || null, hidden: !!p.hidden, verified: !!p.verified, premium: !!p.premium, look: cleanLook(p.look) });
      this.emit('presence', { username: p.username, ...this.presence.get(p.username) });
    }
    // У собеседника подписка, а его фото у нас нет — попросить профиль ещё раз
    const premium = (Array.isArray(list) ? list : []).filter((p) => p?.premium && typeof p.username === 'string').map((p) => p.username);
    if (premium.length && this.account) this._serial(() => this._askProfiles(premium)).catch(() => {});
  }

  /**
   * Запрос профиля (profile-req). Нужен, когда фото «потерялось»: его отбросила старая версия
   * приложения (до 0.20), а собеседник повторно тот же профиль сам не пришлёт. Спрашиваем один
   * раз на каждую версию его профиля; отвечает он, только если сам вам пишет (shareProfile).
   */
  async _askProfiles(names) {
    const all = await this.contacts();
    const outbox = (await this.storage.get('outbox')) || [];
    let asked = false;
    for (const name of names) {
      const c = all[name];
      if (!c || c.keyChanged || this.isBlocked(name) || name === this.account.username) continue;
      // Профиль полный (с фото) и принят этой версией — спрашивать нечего
      const fresh = (c.profileSchema || 1) >= PROFILE_SCHEMA;
      if (c.profile?.avatar && fresh) continue;
      const v = c.profile?.v || 0;
      if (c.profileAskedV === v && (c.profileAskedS || 1) >= PROFILE_SCHEMA) continue;
      c.profileAskedV = v;
      c.profileAskedS = PROFILE_SCHEMA;
      outbox.push({ id: randomId(), to: name, kind: 'ctl', content: { t: 'profile-req', v }, attempts: 0 });
      asked = true;
    }
    if (!asked) return;
    await this.storage.set('outbox', outbox);
    await this.storage.set('contacts', all);
    this._pumpOutbox();
  }

  async _subscribePresence(names) {
    if (this.status !== 'online') return;
    const all = names || Object.keys(await this.contacts());
    if (!all.length) return;
    const r = await this._request({ type: 'presence-subscribe', names: all, replace: !names });
    this._onPresence(r.list);
  }

  /**
   * Приложение на экране (true) или в фоне (false). В фоне соединение остаётся — сообщения
   * и звонки приходят, — но собеседники видят «был(а) …», а не «в сети».
   */
  setActive(active) {
    active = !!active;
    if (this.active === active) return;
    this.active = active;
    this._send({ type: 'set-active', active });
  }

  /** Показывать ли другим, что я в сети и когда был(а). */
  async setPresenceVisible(visible) {
    await this._request({ type: 'set-presence-visibility', visible: !!visible });
    this.presenceHidden = !visible;
  }

  /**
   * Подписка Web Push этого устройства (из PushSubscription.toJSON()) или null — отписаться.
   * Сервер будит устройство пушем, только когда оно не в сети.
   */
  async setPushSubscription(sub) {
    const subscription = sub ? { endpoint: sub.endpoint, keys: { p256dh: sub.keys?.p256dh, auth: sub.keys?.auth } } : null;
    await this._request({ type: 'push-subscribe', subscription });
    this.push = { ...this.push, endpoint: subscription ? subscription.endpoint : null };
  }

  // ---------- Контакты ----------

  async contacts() {
    return (await this.storage.get('contacts')) || {};
  }
  async _saveContacts(c) {
    await this.storage.set('contacts', c);
    this._indexNames(c);
    this.emit('contacts', c);
    this._maybeSyncGroups(c);
  }

  // ---------- Группы на сервере: номер и галочка ----------
  // Сервер не знает групп (переписка в них сквозная). Устройство сообщает ему id своих групп и
  // число участников — так у группы появляется номер в панели администратора и может быть галочка.
  _groupsSig(all) {
    return Object.values(all)
      .filter((c) => c.group && !c.group.left)
      .map((c) => `${c.group.id}:${c.group.members.length}:${c.group.admins.includes(this.account?.username) ? 1 : 0}:${c.group.name}`)
      .sort()
      .join(',');
  }
  _maybeSyncGroups(all) {
    if (this.status !== 'online' || this._groupsSig(all) === this._groupsSynced) return;
    clearTimeout(this._groupsTimer);
    this._groupsTimer = setTimeout(() => this._syncGroups().catch(() => {}), 500);
  }
  async _syncGroups() {
    if (this.status !== 'online') return;
    const all = await this.contacts();
    const sig = this._groupsSig(all);
    const groups = Object.values(all)
      .filter((c) => c.group && !c.group.left)
      .map((c) => {
        const admin = c.group.admins.includes(this.account.username);
        // Название сообщают серверу администраторы группы — чтобы оно было видно в панели администратора
        return { id: c.group.id, members: c.group.members.length, admin, ...(admin ? { name: c.group.name } : {}) };
      });
    const r = await this._request({ type: 'group-sync', groups });
    this._groupsSynced = sig;
    const removed = (Array.isArray(r.removed) ? r.removed : []).map(String).filter((id) => GID_RE.test(id));
    if (removed.length) await this._serial(() => this._onGroupsRemoved(removed));
    await this._setGroupsVerified(new Set((Array.isArray(r.verified) ? r.verified : []).map((id) => groupKey(String(id)))));
  }
  /** verified — множество ключей групп ('#id') с галочкой; null — поменять одну: { chat, on }. */
  async _setGroupsVerified(verified, one = null) {
    await this._serial(async () => {
      const all = await this.contacts();
      let changed = false;
      for (const c of Object.values(all)) {
        if (!c.group) continue;
        const on = one ? (c.username === one.chat ? one.on : !!c.verifiedMark) : verified.has(c.username);
        if (!!c.verifiedMark !== on) {
          if (on) c.verifiedMark = true;
          else delete c.verifiedMark;
          changed = true;
        }
      }
      if (changed) await this._saveContacts(all);
    });
  }

  // ---------- Профиль: юзернейм (уникальный, @name) и имя (любое, как в Telegram) ----------
  // Имя и «о себе» не хранятся на сервере: они уходят зашифрованными тем, кому вы пишете
  // (и вашим устройствам), как профили в Signal.

  _indexNames(all) {
    this._names.clear();
    this._avatars.clear();
    this._videos.clear();
    (this._verifiedChats ||= new Set()).clear();
    (this._archived ||= new Set()).clear();
    (this._top ||= new Set()).clear();
    (this._official ||= new Set()).clear();
    for (const c of Object.values(all || {})) {
      if ((c.group && c.verifiedMark) || c.channel?.verified) this._verifiedChats.add(c.username);
      if (c.archived) this._archived.add(c.username);
      if (c.top) this._top.add(c.username);
      if (c.channel?.owner === NEWS_OWNER) this._official.add(c.username);
      if (c.group) this._names.set(c.username, c.group.name);
      if (c.system) this._names.set(c.username, t('Тайник'));
      if (c.support) this._names.set(c.username, t('Поддержка'));
      if (c.channel) this._names.set(c.username, c.channel.title || (c.channel.handle ? '@' + c.channel.handle : t('Канал')));
      if (c.profile?.name) this._names.set(c.username, c.profile.name);
      if (c.profile?.avatar) this._avatars.set(c.username, c.profile.avatar);
      if (c.profile?.video) this._videos.set(c.username, c.profile.video);
    }
  }

  /** Имя для показа: имя из профиля или юзернейм; для группы — её название. */
  nameOf(username) {
    if (this.account && username === this.account.username) return this.profile.name || username;
    return this._names.get(username) || username;
  }

  /** Профиль собеседника { name, bio, v } или null. */
  async profileOf(username) {
    return (await this.contacts())[username]?.profile || null;
  }

  /**
   * Изменить свой профиль: уходит своим устройствам и собеседникам, которым вы писали.
   * avatar — data:-URL картинки (только с подпиской), null — убрать фото.
   */
  async setProfile({ name = this.profile.name, bio = this.profile.bio, avatar = this.profile.avatar ?? null, photo, channels = this.profile.channels || [], video = this.profile.video ?? null } = {}) {
    if (avatar != null && avatar !== this.profile.avatar) {
      if (!this.isPremium()) throw errorOf('premium_required');
      if (!validAvatar(avatar)) throw errorOf('too_large');
    }
    // Большое фото — вместе с маленьким: сменили маленькое без большого — большого больше нет
    if (photo === undefined) photo = avatar === this.profile.avatar ? this.profile.photo : null;
    if (photo != null && !validPhoto(photo)) throw errorOf('too_large');
    const next = cleanProfile({ name, bio, avatar, photo, channels, video, v: Math.max(Date.now(), this.profile.v + 1) });
    await this._serial(async () => {
      this.profile = next;
      await this.storage.set('profile', next);
      const outbox = (await this.storage.get('outbox')) || [];
      // Старые, ещё не отправленные версии профиля не нужны
      const keep = outbox.filter((x) => !(x.kind === 'ctl' && (x.content?.t === 'profile' || x.content?.t === 'sync-profile')));
      keep.push({ id: randomId(), to: this.account.username, kind: 'ctl', content: { t: 'sync-profile', self: 1 }, attempts: 0 });
      const all = await this.contacts();
      for (const c of Object.values(all)) {
        if (!c.shareProfile || c.keyChanged || this.isBlocked(c.username)) continue;
        keep.push({ id: randomId(), to: c.username, kind: 'ctl', content: { t: 'profile', self: 1 }, attempts: 0 });
        c.profileSentV = next.v;
      }
      await this.storage.set('outbox', keep);
      await this._saveContacts(all);
    });
    this.emit('profile', this.profile);
    this._pumpOutbox();
  }

  /**
   * Один раз после обновления до формата профиля PROFILE_SCHEMA: попросить свои устройства
   * прислать профиль ещё раз — прежняя версия этого устройства могла отбросить фон.
   */
  async _askOwnProfile() {
    if ((await this.storage.get('profile-schema')) >= PROFILE_SCHEMA) return;
    await this.storage.set('profile-schema', PROFILE_SCHEMA);
    const outbox = (await this.storage.get('outbox')) || [];
    outbox.push({ id: randomId(), to: this.account.username, kind: 'ctl', content: { t: 'sync-profile-req' }, attempts: 0 });
    await this.storage.set('outbox', outbox);
    this._pumpOutbox();
  }

  /** Собеседник, которому вы пишете или которого добавили, получает ваш профиль. */
  _shareProfileTo(c, outbox) {
    c.shareProfile = true;
    if (!this.profile.v || c.profileSentV === this.profile.v) return;
    outbox.push({ id: randomId(), to: c.username, kind: 'ctl', content: { t: 'profile', self: 1 }, attempts: 0 });
    c.profileSentV = this.profile.v;
  }

  async fetchIdentity(username) {
    return (await this._request({ type: 'get-identity', username: String(username).toLowerCase() })).identity;
  }

  /** Добавляет собеседника (ключ личности закрепляется при первом знакомстве — TOFU). */
  async addContact(username) {
    username = String(username).trim().toLowerCase();
    if (username === this.account.username) throw new Error(t('Это вы'));
    const identity = await this.fetchIdentity(username);
    if (!identity) throw errorOf('unknown_recipient');
    if (!this.presence.has(username)) this._subscribePresence([username]).catch(() => {});
    return this._serial(async () => {
      const all = await this.contacts();
      const c = all[username];
      if (!c) {
        all[username] = { username, keys: identity, verified: false, unread: 0, lastTs: Date.now(), pending: [] };
      } else if (!sameIdentity(c.keys, identity) && !sameIdentity(c.keyChanged, identity)) {
        c.keyChanged = identity;
        this.emit('key-changed', c);
      }
      delete all[username].hidden; // удалённый чат снова в списке
      const outbox = (await this.storage.get('outbox')) || [];
      this._shareProfileTo(all[username], outbox);
      await this.storage.set('outbox', outbox);
      await this._saveContacts(all);
      if (outbox.length) this._pumpOutbox();
      return all[username];
    });
  }

  async _ensureContact(all, username) {
    if (all[username]) return all[username];
    const identity = await this.fetchIdentity(username);
    if (!identity) return null;
    all[username] = { username, keys: identity, verified: false, unread: 0, lastTs: Date.now(), pending: [] };
    this._subscribePresence([username]).catch(() => {});
    return all[username];
  }

  /**
   * Чат прочитан на этом устройстве. Остальным вашим устройствам уходит зашифрованная
   * отметка «прочитано до сообщения со временем upTo» — там счётчик тоже обнулится.
   */
  async markRead(username) {
    let sent = false;
    await this._serial(async () => {
      const all = await this.contacts();
      if (!all[username] || !all[username].unread) return;
      all[username].unread = 0;
      await this._saveContacts(all);
      const upTo = (await this.messages(username)).reduce((m, x) => (x.dir === 'in' && x.ts > m ? x.ts : m), 0);
      if (!upTo || !this.account) return;
      const outbox = (await this.storage.get('outbox')) || [];
      // Старые отметки этого же чата больше не нужны — хватит последней
      const keep = outbox.filter((x) => !(x.kind === 'ctl' && x.content?.t === 'sync-read' && x.content.chat === username));
      keep.push({ id: randomId(), to: this.account.username, kind: 'ctl', content: { t: 'sync-read', chat: username, upTo, ts: Date.now() }, attempts: 0 });
      await this.storage.set('outbox', keep);
      sent = true;
    });
    if (sent) this._pumpOutbox();
  }

  /** Отметка прочтения с другого своего устройства. */
  async _applyReadSync(chat, upTo) {
    const all = await this.contacts();
    const c = all[chat];
    if (!c || !c.unread) return;
    const left = (await this.messages(chat)).filter((m) => m.dir === 'in' && m.ts > upTo).length;
    if (left >= c.unread) return;
    c.unread = left;
    await this._saveContacts(all);
    this.emit('read-sync', { contact: chat, unread: left });
  }

  async markVerified(username, verified = true) {
    return this._serial(async () => {
      const all = await this.contacts();
      if (!all[username]) return;
      all[username].verified = verified;
      await this._saveContacts(all);
    });
  }

  async _dropSessions(username) {
    for (const d of (await this.storage.get('devices:' + username)) || []) {
      await deleteSession(this.ps, { name: username, device: d });
    }
    await this.storage.set('devices:' + username, []);
  }

  /** Принять новый ключ собеседника: старые сессии удаляются, отметка «проверен» снимается. */
  async acceptNewKey(username) {
    return this._serial(async () => {
      const all = await this.contacts();
      const c = all[username];
      if (!c || !c.keyChanged) return;
      c.keys = c.keyChanged;
      delete c.keyChanged;
      c.verified = false;
      const pending = c.pending || [];
      c.pending = [];
      await this._saveContacts(all);
      await this._dropSessions(username);
      await this._appendMsg(username, { id: 'sys-' + Date.now(), dir: 'sys', ts: Date.now(), content: { t: 'key-accepted' } });
      for (const envelope of pending) await this._onEnvelope({ envelope, from: username, qid: null });
    });
  }

  async safetyNumber(username) {
    const c = (await this.contacts())[username];
    if (!c) return null;
    return safetyNumber(
      { username: this.account.username, identity: this.account.pub },
      { username, identity: c.keyChanged || c.keys }
    );
  }

  // ---------- Сообщения ----------

  async messages(username) {
    return (await this.storage.get('chat:' + username)) || [];
  }

  async _appendMsg(username, m) {
    const list = await this.messages(username);
    list.push(m);
    await this.storage.set('chat:' + username, list);
    this.emit('message', { contact: username, message: m });
  }

  async _setMsgStatus(username, id, status) {
    const list = await this.messages(username);
    const m = list.find((x) => x.id === id && x.dir === 'out');
    if (!m) return;
    const rank = { sending: 0, failed: 0, sent: 1, delivered: 2 };
    if (status !== 'failed' && rank[status] < rank[m.status]) return;
    m.status = status;
    await this.storage.set('chat:' + username, list);
    this.emit('status-change', { contact: username, id, status });
  }

  /**
   * Отправить текст. replyTo — id сообщения, на которое отвечаем (цитата
   * шифруется вместе с текстом, чтобы её видели и устройства без оригинала).
   */
  /**
   * Переслать сообщения (из любого чата) в chat. Текст и вложения уходят как новые сообщения
   * с пометкой «Переслано от …»; файлы заново не загружаются — пересылается ключ к тому же вложению.
   */
  async forwardMessages(chat, msgs, source = '') {
    for (const m of msgs) {
      const c = m?.content;
      if (!c || m.dir === 'sys' || (c.t !== 'text' && c.t !== 'file')) continue;
      const fwd = c.fwd || (m.dir === 'out' ? this.nameOf(this.account.username) : m.from ? this.nameOf(m.from) : this.nameOf(source));
      const base = c.t === 'file' ? { t: 'file', body: c.body || '', file: c.file, fwd } : { t: 'text', body: c.body, fwd };
      await this._sendContent(chat, base, null);
    }
  }

  // ---------- Закреплённое сообщение ----------
  // Одно на чат. В личном чате и в группе закрепление видят все (уходит E2E-сообщением),
  // в канале — только вы. Свои устройства получают sync-pin.

  /** Закрепить (id) или открепить (null) сообщение в чате. */
  async pinMessage(chat, id) {
    id = id == null ? null : String(id).slice(0, 64);
    const ts = Date.now();
    await this._serial(async () => {
      const all = await this.contacts();
      const c = all[chat];
      if (!c) return;
      await this._applyPin(all, chat, id, ts);
      const me = this.account.username;
      const outbox = (await this.storage.get('outbox')) || [];
      if (c.group && !c.group.left) {
        for (const m of c.group.members) if (m !== me) outbox.push({ id: randomId(), to: m, kind: 'ctl', content: { t: 'gpin', g: c.group.id, pin: id, ts }, attempts: 0 });
      } else if (!c.group && !c.channel && !c.keyChanged && !this.isBlocked(chat)) {
        outbox.push({ id: randomId(), to: chat, kind: 'ctl', content: { t: 'pin', pin: id, ts }, attempts: 0 });
      }
      outbox.push({ id: randomId(), to: me, kind: 'ctl', content: { t: 'sync-pin', chat, pin: id, ts }, attempts: 0 });
      await this.storage.set('outbox', outbox);
    });
    this._pumpOutbox();
  }

  // ---------- Закреплённые чаты ----------
  // Закреплённый чат стоит в начале списка (последний закреплённый — первым). Только для вас,
  // синхронизируется между вашими устройствами.

  /** Закрепить чат вверху списка (on) или открепить. Не больше PINNED_CHATS_MAX. */
  async setChatPinned(chat, on) {
    const ts = Date.now();
    await this._serial(async () => {
      const all = await this.contacts();
      if (on && !all[chat]?.top && Object.values(all).filter((c) => c.top).length >= PINNED_CHATS_MAX) throw errorOf('pinned_chats_max');
      if (!(await this._applyChatPin(all, chat, !!on, ts))) return;
      await this._queueToSelf({ t: 'sync-top', chat, on: !!on, ts });
    });
    this._pumpOutbox();
  }

  isChatPinned(chat) {
    return this._top?.has(chat) || false;
  }

  async _applyChatPin(all, chat, on, ts) {
    const c = all[chat];
    if (!c || !Number.isFinite(ts) || (c.topTs && c.topTs >= ts)) return false;
    c.topTs = ts;
    if (on) c.top = ts;
    else delete c.top;
    await this._saveContacts(all);
    return true;
  }

  // ---------- Папки чатов ----------
  // Свои вкладки над списком чатов («Работа», «Семья»…): название и какие чаты в ней. Только для
  // вас, одинаковые на всех ваших устройствах (последнее изменение побеждает).

  /** [{ id, name, chats: [ключи чатов] }] */
  async folders() {
    return (await this.storage.get('folders'))?.list || [];
  }

  /** Сохранить папки целиком (создать, переименовать, изменить состав, удалить, поменять порядок). */
  async setFolders(list) {
    const clean = cleanFolders(list);
    if (Array.isArray(list) && list.length > FOLDERS_MAX) throw errorOf('folders_max');
    const v = Date.now();
    await this._serial(async () => {
      await this.storage.set('folders', { v, list: clean });
      await this._queueToSelf({ t: 'sync-folders', v, list: clean });
    });
    this.emit('folders', clean);
    this._pumpOutbox();
    return clean;
  }

  async _applyFolders(v, list) {
    const cur = await this.storage.get('folders');
    if (!Number.isFinite(v) || (cur?.v && cur.v >= v)) return;
    const clean = cleanFolders(list);
    await this.storage.set('folders', { v, list: clean });
    this.emit('folders', clean);
  }

  // ---------- Архив ----------
  // Чат, группа или канал в архиве не показываются в общем списке (только в «Архиве»). Это
  // отметка только для вас: собеседники о ней не знают. Синхронизируется между вашими устройствами.

  /** Убрать чат в архив (on) или вернуть из архива. */
  async setArchived(chat, on) {
    const ts = Date.now();
    await this._serial(async () => {
      if (!(await this._applyArchive(await this.contacts(), chat, !!on, ts))) return;
      await this._queueToSelf({ t: 'sync-archive', chat, on: !!on, ts });
    });
    this._pumpOutbox();
  }

  /** Официальный канал сервера («Обновления Тайника»): его ведёт сам сервер. */
  isOfficial(chat) {
    return isSystemChat(chat) || isSupportChat(chat) || this._official?.has(chat) || false;
  }

  isArchived(chat) {
    return this._archived?.has(chat) || false;
  }

  async _applyArchive(all, chat, on, ts) {
    const c = all[chat];
    if (!c || !Number.isFinite(ts) || (c.archivedTs && c.archivedTs >= ts)) return false;
    c.archivedTs = ts; // последнее изменение побеждает (если на двух устройствах меняли почти одновременно)
    if (on) c.archived = true;
    else delete c.archived;
    await this._saveContacts(all);
    this.emit('archived', { chat, on });
    return true;
  }

  async _applyPin(all, chat, id, ts) {
    const c = all[chat];
    if (!c || !Number.isFinite(ts) || (c.pinned && c.pinned.ts >= ts)) return false;
    c.pinned = { id: typeof id === 'string' && id ? id.slice(0, 64) : null, ts };
    await this._saveContacts(all);
    this.emit('pinned', { chat, id: c.pinned.id });
    return true;
  }

  async sendText(username, text, { replyTo = null } = {}) {
    text = String(text);
    if (!text.trim()) return;
    await this._sendContent(username, { t: 'text', body: text }, replyTo);
  }

  /** Сообщение собеседнику и копия «отправлено» своим устройствам (общая часть sendText и sendFile). */
  async _sendContent(username, base, replyTo) {
    if (isSystemChat(username)) throw new Error(t('В этот чат нельзя писать'));
    if (isSupportChat(username)) {
      if (base.t !== 'text') throw new Error(t('В поддержку можно отправить только текст'));
      return this._sendSupport(base.body);
    }
    if (isGroupChat(username)) return this._sendGroupContent(username, base, replyTo);
    if (isChannelChat(username)) return this._postToChannel(username, base);
    await this._serial(async () => {
      const all = await this.contacts();
      const c = all[username];
      if (!c) throw new Error(t('Нет такого контакта'));
      if (c.keyChanged) throw errorOf('key_changed');
      if (this.isBlocked(username)) throw errorOf('you_blocked');
      delete c.hidden;
      const id = randomId();
      const ts = Date.now();
      const content = { ...base, ts };
      if (replyTo) {
        const orig = (await this.messages(username)).find((m) => m.id === replyTo && m.dir !== 'sys');
        if (orig) content.reply = makeReply(orig, this.account.username, username);
      }
      const outbox = (await this.storage.get('outbox')) || [];
      this._shareProfileTo(c, outbox); // профиль — перед первым сообщением
      outbox.push({ id, to: username, kind: 'msg', content, attempts: 0 });
      const sync = { t: 'sync-sent', to: username, body: content.body, ts, reply: content.reply, fwd: content.fwd };
      if (content.file) sync.file = content.file;
      outbox.push({ id, to: this.account.username, kind: 'sync', content: sync, attempts: 0 });
      await this.storage.set('outbox', outbox);
      await this._appendMsg(username, { id, dir: 'out', ts, content, status: 'sending' });
      c.lastTs = ts;
      await this._saveContacts(all);
    });
    this._pumpOutbox();
  }

  // ---------- Каналы ----------
  // См. isChannelChat. Состав подписчиков и права хранит сервер; ключи — только у клиентов
  // (своим устройствам ключ приватного канала уходит E2E-сообщением sync-channel).

  /** Состояние канала { id, public, handle, key, title, about, role, subs, ... } или null. */
  async channelOf(chat) {
    return (isChannelChat(chat) && (await this.contacts())[chat]?.channel) || null;
  }

  /** Описание канала от сервера + ключ → обновить (или завести) чат канала. Возвращает чат или null. */
  async _applyChannelInfo(all, info, key = null) {
    if (!info || !CHANNEL_ID_RE.test(String(info.id))) return null;
    const chat = channelKey(info.id);
    let c = all[chat];
    key = key || c?.channel?.key || (info.public && isKey32(info.key) ? info.key : null);
    if (!key) return null; // приватный канал, ключа ещё нет — придёт от своего устройства
    const meta = await channelOpen(key, info.id, info.meta);
    if (!meta) return null; // ключ не подходит
    const { title, about } = cleanChannelMeta(meta);
    if (!c) c = all[chat] = { username: chat, unread: 0, lastTs: Date.now(), pending: [], channel: { lastSeq: 0 } };
    Object.assign(c.channel, {
      id: info.id,
      public: !!info.public,
      handle: info.public ? info.handle || null : null,
      key,
      title,
      about,
      role: info.role || null,
      subs: Number.isSafeInteger(info.subs) ? info.subs : c.channel.subs || 0,
      seq: Number.isSafeInteger(info.seq) ? info.seq : c.channel.seq || 0,
      owner: typeof info.owner === 'string' ? info.owner : c.channel.owner || null,
      admins: Array.isArray(info.admins) ? info.admins.filter((a) => typeof a === 'string') : c.channel.admins || [],
      verified: info.verified === true,
    });
    delete c.channel.gone;
    delete c.hidden;
    return chat;
  }

  /** Канал по ссылке или @имени — без подписки: { chat, title, about, subs, public, handle, role, posts }. */
  async channelPreview(refInput) {
    const ref = typeof refInput === 'string' ? parseChannelRef(refInput) : refInput;
    if (!ref) throw errorOf('bad_channel_link');
    const r = await this._request({ type: 'channel-get', ...(ref.handle ? { handle: ref.handle } : { id: ref.id }) });
    const info = r.channel;
    const key = ref.key || (info.public && isKey32(info.key) ? info.key : null);
    const meta = key && (await channelOpen(key, info.id, info.meta));
    if (!meta) throw errorOf('bad_channel_link');
    const posts = [];
    for (const p of r.posts || []) {
      const content = cleanText(await channelOpen(key, info.id, p.data), p.ts);
      if (content) posts.push({ id: 'p' + p.seq, dir: 'in', ts: p.ts, content });
    }
    return { chat: channelKey(info.id), id: info.id, key, ...cleanChannelMeta(meta), subs: info.subs, public: !!info.public, handle: info.handle || null, role: info.role, verified: info.verified === true, posts };
  }

  /** Подписаться (ref — ссылка, @имя или результат channelPreview). Возвращает чат канала. */
  async joinChannel(refInput) {
    const pre = refInput?.chat ? refInput : await this.channelPreview(refInput);
    const r = await this._request({ type: 'channel-join', id: pre.id });
    let chat = null;
    await this._serial(async () => {
      const all = await this.contacts();
      chat = await this._applyChannelInfo(all, r.channel, pre.key);
      if (!chat) throw errorOf('bad_channel_link');
      all[chat].lastTs = Date.now();
      await this._saveContacts(all);
      if (!pre.public) await this._queueToSelf({ t: 'sync-channel', id: pre.id, key: pre.key });
    });
    this._pumpOutbox();
    await this._syncChannel(chat).catch(() => {});
    return chat;
  }

  /**
   * Создать канал. Публичный находят по @имени (handle), в приватный входят по ссылке.
   * Возвращает чат канала.
   */
  async createChannel({ title, about = '', isPublic = false, handle = '' } = {}) {
    const meta = cleanChannelMeta({ title, about });
    if (!meta.title) throw errorOf('channel_title');
    handle = String(handle || '').trim().replace(/^@/, '').toLowerCase();
    if (isPublic && !CHANNEL_HANDLE_RE.test(handle)) throw errorOf('bad_channel_handle');
    const key = toB64(randomBytes(32));
    const id = [...randomBytes(16)].map((b) => b.toString(16).padStart(2, '0')).join('');
    const req = { type: 'channel-create', id, public: !!isPublic, meta: await channelSeal(key, id, meta) };
    if (isPublic) Object.assign(req, { handle, key });
    const upd = await this._request(req);
    let chat = null;
    await this._serial(async () => {
      const all = await this.contacts();
      chat = await this._applyChannelInfo(all, upd.channel, key);
      all[chat].channel.lastSeq = upd.channel.seq || 0;
      await this._saveContacts(all);
      if (!isPublic) await this._queueToSelf({ t: 'sync-channel', id, key });
    });
    this._pumpOutbox();
    return chat;
  }

  /** Изменить название или описание (владелец и администраторы). */
  async updateChannel(chat, { title, about } = {}) {
    const ch = await this.channelOf(chat);
    if (!ch) throw errorOf('channel_not_found');
    const meta = cleanChannelMeta({ title: title ?? ch.title, about: about ?? ch.about });
    if (!meta.title) throw errorOf('channel_title');
    const r = await this._request({ type: 'channel-update', id: ch.id, meta: await channelSeal(ch.key, ch.id, meta) });
    await this._serial(async () => {
      const all = await this.contacts();
      await this._applyChannelInfo(all, r.channel);
      await this._saveContacts(all);
    });
    // Канал прикреплён к профилю — новое название и там
    const ref = this.channelRef(ch);
    const pinned = this.profile.channels || [];
    if (pinned.some((c) => c.ref === ref && c.title !== meta.title)) {
      await this.setProfile({ channels: pinned.map((c) => (c.ref === ref ? { ...c, title: meta.title } : c)) });
    }
  }

  /** Назначить или снять администратора (только владелец; пользователь должен быть подписан). */
  async setChannelAdmin(chat, user, on = true) {
    const ch = await this.channelOf(chat);
    if (!ch) throw errorOf('channel_not_found');
    const r = await this._request({ type: 'channel-admin', id: ch.id, user: String(user).trim().replace(/^@/, '').toLowerCase(), on: !!on });
    await this._serial(async () => {
      const all = await this.contacts();
      await this._applyChannelInfo(all, r.channel);
      await this._saveContacts(all);
    });
  }

  /** Отписаться (владелец не может — только удалить канал). Переписка канала удаляется. */
  async leaveChannel(chat) {
    const ch = await this.channelOf(chat);
    if (ch && !ch.gone) await this._request({ type: 'channel-leave', id: ch.id });
    await this._dropChannel(chat);
  }

  /** Удалить канал у всех (только владелец). */
  async deleteChannel(chat) {
    const ch = await this.channelOf(chat);
    if (!ch) return;
    await this._request({ type: 'channel-delete', id: ch.id });
    await this._dropChannel(chat);
  }

  async _dropChannel(chat) {
    await this._serial(async () => {
      const all = await this.contacts();
      delete all[chat];
      await this.storage.set('chat:' + chat, []);
      await this._saveContacts(all);
    });
    this.emit('channel-removed', { chat });
  }

  /** Ссылка на канал: публичный — по @имени, приватный — с ключом (кто получил ссылку, тот читает). */
  /**
   * Удалить свой аккаунт навсегда: confirm — свой юзернейм. Сервер удаляет ключи, очередь
   * сообщений, подписку и каналы; другие ваши устройства отключаются и стирают данные.
   * После этого локальные данные этого устройства нужно стереть (reset).
   */
  async deleteAccount(confirm) {
    await this._request({ type: 'delete-account', confirm: String(confirm ?? '').trim().replace(/^@/, '').toLowerCase() });
    this._stopped = true;
    if (this.ws) this.ws.close();
  }

  /** Ссылка на канал без адреса сервера: '@имя' или 'id.ключ' (для профиля). */
  channelRef(ch) {
    return ch.public && ch.handle ? '@' + ch.handle : `${ch.id}.${b64url(ch.key)}`;
  }

  /** Свои каналы (вы владелец), которые можно прикрепить к профилю. */
  async ownChannels() {
    return Object.values(await this.contacts())
      .filter((c) => c.channel?.role === 'owner' && !c.channel.gone && c.channel.key)
      .map((c) => ({ chat: c.username, ref: this.channelRef(c.channel), title: c.channel.title || '', public: !!c.channel.public }));
  }

  /** Прикрепить к профилю каналы (не больше PROFILE_CHANNELS_MAX): refs — из ownChannels(). */
  async setProfileChannels(refs) {
    const own = await this.ownChannels();
    const channels = [];
    for (const ref of refs) {
      const ch = own.find((x) => x.ref === ref);
      if (!ch) continue; // канал удалён или больше не ваш — из профиля он уходит
      if (channels.length >= PROFILE_CHANNELS_MAX) throw errorOf('profile_channels_max');
      channels.push({ ref: ch.ref, title: ch.title });
    }
    await this.setProfile({ channels });
  }

  channelLink(ch, origin) {
    const base = `${String(origin || '').replace(/\/+$/, '')}/app#ch=`;
    return ch.public && ch.handle ? base + '@' + ch.handle : base + `${ch.id}.${b64url(ch.key)}`;
  }

  /** Пост в канал (текст или вложение). Для владельца и администраторов. */
  async _postToChannel(chat, base) {
    const ch = await this.channelOf(chat);
    if (!ch || ch.gone) throw errorOf('channel_not_found');
    if (ch.role !== 'owner' && ch.role !== 'admin') throw errorOf('channel_not_admin');
    const content = { ...base, ts: Date.now() };
    delete content.reply;
    const data = await channelSeal(ch.key, ch.id, content);
    const r = await this._request({ type: 'channel-post', id: ch.id, data, blobs: content.file ? [content.file.id] : [] });
    await this._serial(() => this._onChannelPost(ch.id, { seq: r.seq, ts: r.ts, data }, true));
  }

  /** Пост пришёл (или отправлен отсюда): в чат канала, если его там ещё нет. */
  async _onChannelPost(id, post, mine = false) {
    const chat = channelKey(id);
    const all = await this.contacts();
    const c = all[chat];
    if (!c?.channel?.key || !Number.isSafeInteger(post?.seq)) return;
    const mid = 'p' + post.seq;
    const list = await this.messages(chat);
    if (list.some((m) => m.id === mid)) return;
    if (((await this.storage.get('deleted:' + chat)) || []).includes(mid)) return;
    const content = cleanText(await channelOpen(c.channel.key, id, post.data), post.ts);
    if (!content) return;
    delete content.reply;
    const m = { id: mid, dir: 'in', ts: post.ts, content };
    // По порядку номеров (история может прийти позже живых постов)
    const at = list.findIndex((x) => x.id?.startsWith('p') && Number(x.id.slice(1)) > post.seq);
    if (at >= 0) list.splice(at, 0, m);
    else list.push(m);
    await this.storage.set('chat:' + chat, list);
    c.channel.lastSeq = Math.max(c.channel.lastSeq || 0, post.seq);
    c.channel.seq = Math.max(c.channel.seq || 0, post.seq);
    c.lastTs = Math.max(c.lastTs || 0, post.ts);
    const admin = c.channel.role === 'owner' || c.channel.role === 'admin';
    if (!mine && !admin) c.unread = (c.unread || 0) + 1;
    await this._saveContacts(all);
    // quiet — без уведомления: история, свои посты, посты в канале, где вы администратор
    this.emit('message', { contact: chat, message: m, channel: true, quiet: mine || admin });
  }

  /** Догнать канал: новые посты после lastSeq и удаления, случившиеся без нас. */
  async _syncChannel(chat) {
    if (this.status !== 'online') return;
    const ch = await this.channelOf(chat);
    if (!ch?.key || ch.gone) return;
    let after = ch.lastSeq || 0;
    let delSince = ch.syncedAt ?? null;
    let now = null;
    for (let round = 0; round < 20; round++) {
      const r = await this._request({ type: 'channel-history', id: ch.id, after, delSince, tail: after === 0, limit: after === 0 ? 50 : 100 });
      now = r.now;
      await this._serial(async () => {
        for (const p of r.posts || []) await this._onChannelPost(ch.id, p, true);
        if (r.deleted?.length) await this._removeChannelPosts(chat, r.deleted);
      });
      const last = r.posts?.at(-1)?.seq;
      if (!last || after === 0 || (r.posts?.length || 0) < 100) break;
      after = last;
      delSince = null;
    }
    await this._serial(async () => {
      const all = await this.contacts();
      if (!all[chat]?.channel) return;
      all[chat].channel.syncedAt = now;
      if (!all[chat].channel.lastSeq) all[chat].channel.lastSeq = all[chat].channel.seq || 0;
      await this._saveContacts(all);
    });
  }

  async _removeChannelPosts(chat, seqs) {
    const ids = seqs.filter(Number.isSafeInteger).map((n) => 'p' + n);
    const list = await this.messages(chat);
    const keep = list.filter((m) => !ids.includes(m.id));
    if (keep.length === list.length) return;
    await this.storage.set('chat:' + chat, keep);
    this.emit('deleted', { contact: chat, ids });
  }

  /** Список каналов от сервера при входе: обновить, завести новые публичные, догнать посты. */
  async _onChannels(list) {
    const ids = new Set();
    const chats = [];
    await this._serial(async () => {
      const all = await this.contacts();
      for (const info of Array.isArray(list) ? list : []) {
        const chat = await this._applyChannelInfo(all, info);
        if (chat) (ids.add(chat), chats.push(chat));
      }
      // Каналы, которых в списке нет: отписались на другом устройстве или канал удалён
      for (const c of Object.values(all)) if (c.channel && !ids.has(c.username)) c.channel.gone = true;
      await this._saveContacts(all);
    });
    for (const chat of chats) await this._syncChannel(chat).catch(() => {});
  }

  async _queueToSelf(content) {
    const outbox = (await this.storage.get('outbox')) || [];
    outbox.push({ id: randomId(), to: this.account.username, kind: 'ctl', content, attempts: 0 });
    await this.storage.set('outbox', outbox);
  }

  // ---------- Группы ----------
  // См. GROUP_MAX и комментарий у cleanGroup. Все изменения группы — от администраторов;
  // каждый участник проверяет это сам по своему последнему известному состоянию.

  /** Состояние группы { id, name, members, admins, v, left? } или null. */
  async groupOf(chat) {
    return (isGroupChat(chat) && (await this.contacts())[chat]?.group) || null;
  }

  /** Собеседник для рассылки: если его нет в контактах, заводим скрытым (в списке чатов не виден). */
  async _ensureMember(all, name) {
    const existed = !!all[name];
    const c = await this._ensureContact(all, name);
    if (c && !existed) c.hidden = true;
    return c;
  }

  _normMembers(list) {
    const me = this.account.username;
    return [...new Set((Array.isArray(list) ? list : []).map((m) => String(m).trim().replace(/^@/, '').toLowerCase()))].filter((m) => m && m !== me);
  }

  async _ensureMembers(all, names) {
    for (const m of names) {
      if (!USER_RE.test(m) || !(await this._ensureMember(all, m))) throw Object.assign(errorOf('unknown_recipient'), { user: m });
    }
  }

  /**
   * Создать группу. members — юзернеймы участников (без себя). Возвращает id чата группы ('#…').
   * Создатель — администратор.
   */
  async createGroup(name, members = []) {
    const me = this.account.username;
    const list = this._normMembers(members);
    const nm = cleanGroupName(name);
    if (!nm) throw errorOf('group_name');
    if (list.length + 1 > GROUP_MAX) throw errorOf('group_too_big');
    const gid = newGroupId();
    await this._serial(async () => {
      const all = await this.contacts();
      await this._ensureMembers(all, list);
      const next = { id: gid, name: nm, members: [me, ...list], admins: [me], v: Date.now() };
      const outbox = (await this.storage.get('outbox')) || [];
      this._queueGroupState(all, [], next, outbox);
      await this.storage.set('outbox', outbox);
      await this._applyGroupState(all, next, me);
    });
    this._pumpOutbox();
    return groupKey(gid);
  }

  /**
   * Изменить группу (только администратор): { name, add: [...], remove: [...], admins: [...] }.
   * Исключённые получают новое состояние и узнают, что их исключили.
   */
  async updateGroup(chat, { name, add = [], remove = [], admins } = {}) {
    const me = this.account.username;
    await this._serial(async () => {
      const all = await this.contacts();
      const g = all[chat]?.group;
      if (!g) throw new Error(t('Нет такой группы'));
      if (g.left) throw errorOf('group_left');
      if (!g.admins.includes(me)) throw errorOf('group_not_admin');
      const addList = this._normMembers(add).filter((m) => !g.members.includes(m));
      const drop = new Set(this._normMembers(remove));
      const members = [...g.members.filter((m) => !drop.has(m)), ...addList];
      if (members.length > GROUP_MAX) throw errorOf('group_too_big');
      await this._ensureMembers(all, addList);
      const nm = name === undefined ? g.name : cleanGroupName(name);
      if (!nm) throw errorOf('group_name');
      let adm = (Array.isArray(admins) ? this._normMembers(admins).concat(admins.includes(me) ? [me] : []) : g.admins).filter((a) => members.includes(a));
      if (!adm.length) adm = [me];
      const next = { id: g.id, name: nm, members, admins: [...new Set(adm)], v: Math.max(Date.now(), g.v + 1) };
      // Бывшие участники тоже получают новое состояние — так они узнают, что их исключили
      await this._ensureMembers(all, g.members.filter((m) => m !== me && !members.includes(m)));
      const outbox = (await this.storage.get('outbox')) || [];
      this._queueGroupState(all, g.members, next, outbox);
      await this.storage.set('outbox', outbox);
      await this._applyGroupState(all, next, me);
    });
    this._pumpOutbox();
  }

  /** Выйти из группы: участники уберут вас из состава; история у вас остаётся (только чтение). */
  async leaveGroup(chat) {
    const me = this.account.username;
    await this._serial(async () => {
      const all = await this.contacts();
      const g = all[chat]?.group;
      if (!g || g.left) return;
      const outbox = (await this.storage.get('outbox')) || [];
      const ts = Date.now();
      for (const m of g.members) {
        if (m === me || all[m]?.keyChanged) continue;
        if (!all[m]) await this._ensureMember(all, m);
        outbox.push({ id: randomId(), to: m, kind: 'ctl', content: { t: 'group-leave', g: g.id, ts }, attempts: 0 });
      }
      outbox.push({ id: randomId(), to: me, kind: 'ctl', content: { t: 'group-leave', g: g.id, ts }, attempts: 0 });
      await this.storage.set('outbox', outbox);
      await this._applyLeave(all, chat, me, me);
    });
    this._pumpOutbox();
  }

  /** Новое состояние группы — всем её участникам (и бывшим) и своим устройствам. */
  _queueGroupState(all, oldMembers, next, outbox) {
    const me = this.account.username;
    const content = { t: 'group', g: next.id, name: next.name, members: next.members, admins: next.admins, v: next.v, ts: Date.now() };
    for (const m of new Set([...oldMembers, ...next.members])) {
      if (m === me || !all[m] || all[m].keyChanged) continue;
      if (next.members.includes(m)) this._shareProfileTo(all[m], outbox); // участники видят ваше имя и фото
      outbox.push({ id: randomId(), to: m, kind: 'ctl', content, attempts: 0 });
    }
    outbox.push({ id: randomId(), to: me, kind: 'ctl', content, attempts: 0 });
  }

  /** Применить состояние группы у себя: запись, служебные строки, отложенные сообщения. */
  async _applyGroupState(all, next, by) {
    const me = this.account.username;
    const key = groupKey(next.id);
    const rec = (all[key] ||= { username: key, unread: 0, lastTs: Date.now(), pending: [] });
    const old = rec.group || null;
    const events = groupEvents(old, next, by);
    rec.group = { id: next.id, name: next.name, members: next.members, admins: next.admins, v: next.v };
    if (!next.members.includes(me)) rec.group.left = true;
    rec.lastTs = Date.now();
    delete rec.hidden;
    await this._saveContacts(all);
    for (const e of events) await this._appendMsg(key, { id: 'g-' + randomId(9), dir: 'sys', ts: Date.now(), content: { t: 'group', ...e } });
    this.emit('group', { chat: key, group: rec.group });
    await this._replayGroup(all, key);
  }

  /** Группы удалены администратором сервера: выходим из них (писать в них больше нельзя). */
  async _onGroupsRemoved(ids) {
    const all = await this.contacts();
    for (const id of ids) {
      const key = groupKey(id);
      const g = all[key]?.group;
      if (!g || g.removed) continue;
      g.left = true;
      g.removed = true;
      await this._saveContacts(all);
      await this._appendMsg(key, { id: 'g-' + randomId(9), dir: 'sys', ts: Date.now(), content: { t: 'group', ev: 'deleted' } });
      this.emit('group', { chat: key, group: g });
    }
  }

  /** Участник вышел (или вы сами): убрать из состава; если админов не осталось — первый участник. */
  async _applyLeave(all, key, who, by) {
    const me = this.account.username;
    const rec = all[key];
    const g = rec?.group;
    if (!g || !g.members.includes(who)) return;
    g.members = g.members.filter((m) => m !== who);
    g.admins = g.admins.filter((a) => a !== who);
    if (!g.admins.length && g.members.length) g.admins = [g.members[0]];
    if (who === me) g.left = true;
    await this._saveContacts(all);
    await this._appendMsg(key, { id: 'g-' + randomId(9), dir: 'sys', ts: Date.now(), content: { t: 'group', ev: 'left', by, who: [who] } });
    this.emit('group', { chat: key, group: g });
  }

  /** Сообщение в группу: по копии каждому участнику и копия своим устройствам. */
  async _sendGroupContent(chat, base, replyTo) {
    const me = this.account.username;
    await this._serial(async () => {
      const all = await this.contacts();
      const rec = all[chat];
      const g = rec?.group;
      if (!g) throw new Error(t('Нет такой группы'));
      if (g.left || !g.members.includes(me)) throw errorOf('group_left');
      const id = randomId();
      const ts = Date.now();
      const content = { ...base, ts };
      if (replyTo) {
        const orig = (await this.messages(chat)).find((m) => m.id === replyTo && m.dir !== 'sys');
        if (orig) content.reply = makeReply(orig, me, orig.from || me);
      }
      const outbox = (await this.storage.get('outbox')) || [];
      for (const m of g.members) {
        if (m === me) continue;
        const c = all[m] || (await this._ensureMember(all, m));
        if (!c || c.keyChanged) continue; // ключ участника сменился — ему не отправится, пока не сверите
        this._shareProfileTo(c, outbox);
        outbox.push({ id, to: m, chat, kind: 'msg', content: { t: 'gmsg', g: g.id, m: content }, attempts: 0 });
      }
      const sync = { t: 'sync-sent', to: chat, body: content.body, ts, reply: content.reply, fwd: content.fwd };
      if (content.file) sync.file = content.file;
      outbox.push({ id, to: me, kind: 'sync', content: sync, attempts: 0 });
      await this.storage.set('outbox', outbox);
      await this._rememberGroupSent(id, chat);
      // Один в группе — отправлять некому: сразу «отправлено»
      const alone = !g.members.some((m) => m !== me);
      await this._appendMsg(chat, { id, dir: 'out', ts, content, status: alone ? 'sent' : 'sending' });
      rec.lastTs = ts;
      delete rec.hidden;
      await this._saveContacts(all);
    });
    this._pumpOutbox();
  }

  // Отметки «доставлено» приходят по id сообщения и участнику — помним, в какой группе оно
  async _rememberGroupSent(id, chat) {
    const list = (await this.storage.get('gsent')) || [];
    list.push([id, chat]);
    await this.storage.set('gsent', list.slice(-500));
  }
  async _groupSentChat(id) {
    return ((await this.storage.get('gsent')) || []).find((x) => x[0] === id)?.[1] || null;
  }

  /**
   * Групповое содержимое от участника (или со своего устройства, self): состояние группы,
   * выход, удаление, сообщение. Возвращает «подтвердить доставку».
   */
  async _onGroupContent(all, from, res, self = false) {
    const me = this.account.username;
    const gc = res.content;
    const gid = String(gc.g || '');
    if (!GID_RE.test(gid)) {
      await this._saveContacts(all);
      return false;
    }
    const key = groupKey(gid);
    const g = all[key]?.group;
    if (gc.t === 'group') {
      const next = cleanGroup(gc);
      // Принимаем только более новое состояние и только от администратора (по нашему состоянию)
      const ok = next && (g ? next.v > g.v && (self || g.admins.includes(from)) : self || next.admins.includes(from));
      if (ok && (self || next.members.includes(me) || g)) await this._applyGroupState(all, next, from);
      else await this._saveContacts(all);
      return false;
    }
    if (gc.t === 'group-leave') {
      if (g) await this._applyLeave(all, key, from, from);
      else await this._saveContacts(all);
      return false;
    }
    if (gc.t === 'gpin') {
      if (g && !g.left && g.members.includes(from)) await this._applyPin(all, key, gc.pin ?? null, gc.ts);
      else await this._saveContacts(all);
      return false;
    }
    if (gc.t === 'gdelete' && Array.isArray(gc.ids)) {
      await this._saveContacts(all);
      if (!g) return false;
      const ids = gc.ids.map(String).slice(0, MAX_DELETE);
      const theirs = (await this.messages(key)).filter((m) => ids.includes(m.id) && m.from === from).map((m) => m.id);
      if (theirs.length) await this._removeMessages(key, theirs);
      return false;
    }
    if (gc.t === 'gmsg') {
      const ts = Number.isFinite(gc.m?.ts) ? gc.m.ts : Date.now();
      // Группа ещё неизвестна или участник ещё не в составе (состояние придёт следом) — отложим
      if (!g || g.left || !g.members.includes(from)) {
        await this._saveContacts(all);
        await this._stashGroupMsg(gid, { id: res.id, from, m: gc.m, ts });
        return true;
      }
      return this._appendGroupMsg(all, key, from, res.id, gc.m, ts);
    }
    await this._saveContacts(all);
    return false;
  }

  async _appendGroupMsg(all, key, from, id, raw, ts) {
    const content = cleanText(raw, ts);
    const rec = all[key];
    if (!content || !rec) {
      await this._saveContacts(all);
      return false;
    }
    if (await this._isDeleted(key, id)) {
      await this._saveContacts(all);
      return true;
    }
    const list = await this.messages(key);
    if (list.some((m) => m.id === id && m.from === from)) {
      await this._saveContacts(all);
      return true;
    }
    rec.unread = (rec.unread || 0) + 1;
    rec.lastTs = Date.now();
    delete rec.hidden;
    await this._saveContacts(all);
    await this._appendMsg(key, { id, dir: 'in', ts, from, content });
    return true;
  }

  async _stashGroupMsg(gid, item) {
    const k = 'gpend:' + gid;
    const list = (await this.storage.get(k)) || [];
    if (!list.some((x) => x.id === item.id && x.from === item.from)) list.push(item);
    await this.storage.set(k, list.slice(-100));
  }

  async _replayGroup(all, key) {
    const k = 'gpend:' + key.slice(1);
    const list = (await this.storage.get(k)) || [];
    const g = all[key]?.group;
    if (!list.length || !g || g.left) return;
    const keep = [];
    for (const it of list) {
      if (g.members.includes(it.from)) await this._appendGroupMsg(all, key, it.from, it.id, it.m, it.ts);
      else keep.push(it);
    }
    await this.storage.set(k, keep);
  }

  /** Своё сообщение в группу, отправленное с другого своего устройства. */
  async _onGroupSyncSent(chat, id, c) {
    const all = await this.contacts();
    const rec = all[chat];
    if (!rec?.group || (await this._isDeleted(chat, id))) return;
    const content = cleanText(c);
    if (!content) return;
    const list = await this.messages(chat);
    if (list.some((m) => m.id === id && m.dir === 'out')) return;
    rec.lastTs = Date.now();
    delete rec.hidden;
    await this._saveContacts(all);
    await this._rememberGroupSent(id, chat);
    await this._appendMsg(chat, { id, dir: 'out', ts: Number.isFinite(c.ts) ? c.ts : Date.now(), content, status: 'sent' });
  }

  // ---------- Вложения ----------

  /** https://сервер — для загрузки и скачивания файлов (адрес WebSocket без /ws). */
  _httpBase() {
    const u = new URL(this.url);
    u.protocol = u.protocol === 'wss:' ? 'https:' : 'http:';
    u.pathname = u.pathname.replace(/\/ws\/?$/, '');
    u.search = '';
    u.hash = '';
    return u.toString().replace(/\/$/, '');
  }

  /**
   * Отправить файл: зашифровать, загрузить на сервер частями, затем отправить
   * собеседнику сообщение с ключом. source — File/Blob или Uint8Array.
   * meta: { name, mime, kind?, w?, h?, dur?, thumb? }
   * o: { caption, replyTo, onProgress(0..1), signal, onReady(file) — файл загружен, сообщение сейчас уйдёт }
   */
  async sendFile(username, source, meta = {}, { caption = '', replyTo = null, onProgress = () => {}, signal, onReady = () => {} } = {}) {
    const all = await this.contacts();
    if (!all[username]) throw new Error(t('Нет такого контакта'));
    if (isSystemChat(username)) throw new Error(t('В этот чат нельзя писать'));
    if (isSupportChat(username)) throw new Error(t('В поддержку можно отправить только текст'));
    if (isGroupChat(username)) {
      if (all[username].group?.left) throw errorOf('group_left');
    } else if (isChannelChat(username)) {
      const role = all[username].channel?.role;
      if (role !== 'owner' && role !== 'admin') throw errorOf('channel_not_admin');
    } else {
      if (all[username].keyChanged) throw errorOf('key_changed');
      if (this.isBlocked(username)) throw errorOf('you_blocked');
    }
    const size = source.size ?? source.length;
    const mime = String(meta.mime || source.type || 'application/octet-stream').toLowerCase();
    const { keyB64, id } = await this._upload(source, size, onProgress, signal);
    const file = cleanFile({ ...meta, id, key: keyB64, size, mime, name: safeName(meta.name ?? source.name), kind: meta.kind || kindOf(mime) });
    onReady(file);
    await this._sendContent(username, { t: 'file', body: String(caption).slice(0, CAPTION_MAX), file }, replyTo);
    return file;
  }

  async _upload(source, size, onProgress, signal) {
    if (!size) throw errorOf('bad_size');
    const total = encryptedSize(size);
    const r = await this._request({ type: 'blob-new', size: total });
    if (SEG + 16 > r.chunk) throw errorOf('upload_failed');
    const url = `${this._httpBase()}/api/blob/${r.id}`;
    const { keyB64, key } = await newFileKey();
    const n = segments(size);
    let sent = 0;
    for (let i = 0; i < n; i++) {
      if (signal?.aborted) throw errorOf('cancelled');
      const plain = await readPart(source, i * SEG, Math.min(size, (i + 1) * SEG));
      const body = await encryptSegment(key, i, n, plain);
      for (let attempt = 0; ; attempt++) {
        let res;
        try {
          res = await this.fetch(`${url}?offset=${sent}`, { method: 'PUT', headers: { 'X-Blob-Token': r.token, 'Content-Type': 'application/octet-stream' }, body, signal });
        } catch (e) {
          if (signal?.aborted) throw errorOf('cancelled');
          if (attempt >= 4) throw errorOf('upload_failed');
          await new Promise((ok) => setTimeout(ok, 1000 * (attempt + 1)));
          continue;
        }
        const data = await res.json().catch(() => ({}));
        if (res.ok) break;
        // Часть уже дошла, но ответ потерялся — продолжаем с того, что получил сервер
        if (res.status === 409 && data.received === sent + body.length) break;
        if (res.status === 409 && data.error === 'busy' && attempt < 4) {
          await new Promise((ok) => setTimeout(ok, 1000));
          continue;
        }
        throw errorOf('upload_failed');
      }
      sent += body.length;
      onProgress(sent / total);
    }
    return { keyB64, id: r.id };
  }

  /** Скачать и расшифровать вложение. Возвращает Uint8Array. */
  async fetchFile(file, { onProgress = () => {}, signal } = {}) {
    let res;
    try {
      res = await this.fetch(`${this._httpBase()}/api/blob/${file.id}`, { signal });
    } catch {
      throw errorOf(signal?.aborted ? 'cancelled' : 'download_failed');
    }
    if (res.status === 404) throw errorOf('media_expired');
    if (!res.ok) throw errorOf('download_failed');
    const total = encryptedSize(file.size);
    let data;
    if (res.body?.getReader) {
      data = new Uint8Array(total);
      const reader = res.body.getReader();
      let at = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (at + value.length > total) throw errorOf('bad_media');
          data.set(value, at);
          at += value.length;
          onProgress(at / total);
        }
      } catch (e) {
        if (e.code === 'bad_media') throw e;
        throw errorOf(signal?.aborted ? 'cancelled' : 'download_failed');
      }
      if (at !== total) throw errorOf('bad_media');
    } else {
      data = new Uint8Array(await res.arrayBuffer());
    }
    return decryptFile(file.key, data, file.size);
  }

  /**
   * Удалить сообщения. forAll — «удалить у всех»: собеседник и все его
   * устройства тоже удалят их. В любом случае удаление синхронизируется на
   * остальные ваши устройства (как в Telegram).
   */
  async deleteMessages(username, ids, { forAll = false } = {}) {
    ids = [...new Set(ids.map(String))].slice(0, MAX_DELETE);
    if (!ids.length) return;
    await this._serial(async () => {
      const me = this.account.username;
      // В группе «у всех» можно удалить только свои сообщения — запоминаем их до удаления
      const mine = isGroupChat(username) ? (await this.messages(username)).filter((m) => m.dir === 'out' && ids.includes(m.id)).map((m) => m.id) : [];
      await this._removeMessages(username, ids);
      // Ещё не отправленные сообщения — просто отменяем
      let outbox = (await this.storage.get('outbox')) || [];
      outbox = outbox.filter((x) => !(ids.includes(x.id) && (x.kind === 'msg' || x.kind === 'sync')));
      const ts = Date.now();
      if (forAll && isChannelChat(username)) {
        // Пост канала «у всех» удаляет сервер (только владелец и администраторы)
        const ch = (await this.contacts())[username]?.channel;
        if (ch && (ch.role === 'owner' || ch.role === 'admin')) {
          for (const id of ids) if (/^p\d+$/.test(id)) this._request({ type: 'channel-del-post', id: ch.id, seq: Number(id.slice(1)) }).catch(() => {});
        }
      } else if (forAll && isGroupChat(username)) {
        const g = (await this.contacts())[username]?.group;
        if (g && !g.left && mine.length) {
          for (const m of g.members) if (m !== me) outbox.push({ id: randomId(), to: m, kind: 'ctl', content: { t: 'gdelete', g: g.id, ids: mine, ts }, attempts: 0 });
        }
      } else if (forAll) {
        const c = (await this.contacts())[username];
        if (c && !c.keyChanged) outbox.push({ id: randomId(), to: username, kind: 'ctl', content: { t: 'delete', ids, ts }, attempts: 0 });
      }
      outbox.push({ id: randomId(), to: me, kind: 'ctl', content: { t: 'sync-delete', chat: username, ids, forAll, ts }, attempts: 0 });
      await this.storage.set('outbox', outbox);
    });
    this._pumpOutbox();
  }

  async _removeMessages(chat, ids) {
    const list = await this.messages(chat);
    const keep = list.filter((m) => !ids.includes(m.id));
    const removed = list.length - keep.length;
    await this.storage.set('chat:' + chat, keep);
    // Запоминаем, чтобы запоздавшая копия удалённого сообщения не появилась снова
    const del = (await this.storage.get('deleted:' + chat)) || [];
    for (const id of ids) if (!del.includes(id)) del.push(id);
    await this.storage.set('deleted:' + chat, del.slice(-DELETED_LIMIT));
    if (removed) {
      const all = await this.contacts();
      const c = all[chat];
      if (c && c.unread) {
        c.unread = Math.min(c.unread, keep.filter((m) => m.dir === 'in').length);
        await this._saveContacts(all);
      }
    }
    this.emit('deleted', { contact: chat, ids });
  }

  // ---------- Перенос переписки (резервная копия) ----------
  // Чаты, их участники и сообщения — в файл, зашифрованный ключами личности аккаунта
  // (см. shared/backup.js). Сессии шифрования и ключи в файл не попадают: новое устройство
  // общается со всеми по своим сессиям, а в копии — только история.

  /** Файл копии: { bytes, name, chats, messages }. */
  async exportBackup(now = Date.now()) {
    if (!this.account) throw new Error(t('Нет аккаунта'));
    const contacts = {};
    const chats = {};
    const deleted = {};
    let messages = 0;
    for (const [chat, c] of Object.entries(await this.contacts())) {
      const { pending, unread, ...rest } = c;
      contacts[chat] = rest;
      const list = await this.messages(chat);
      if (list.length) chats[chat] = list;
      messages += list.length;
      const del = await this.storage.get('deleted:' + chat);
      if (del?.length) deleted[chat] = del;
    }
    const bytes = await sealBackup(this.account, { contacts, chats, deleted }, now);
    const day = new Date(now).toISOString().slice(0, 10);
    return { bytes, name: `tainik-${this.account.username}-${day}.tainik`, chats: Object.keys(chats).length, messages };
  }

  /**
   * Импорт копии этого же аккаунта: недостающие чаты добавляются, сообщения сливаются с уже
   * имеющимися (без повторов и без удалённых здесь). Возвращает { chats, messages } — сколько добавлено.
   */
  async importBackup(bytes) {
    if (!this.account) throw new Error(t('Нет аккаунта'));
    let opened;
    try {
      opened = await openBackup(this.account, bytes);
    } catch (e) {
      throw Object.assign(new Error(ERROR_TEXT[e.code] || e.message), { code: e.code, user: e.user });
    }
    const p = opened.payload || {};
    const src = p.contacts && typeof p.contacts === 'object' ? p.contacts : {};
    const srcChats = p.chats && typeof p.chats === 'object' ? p.chats : {};
    const srcDel = p.deleted && typeof p.deleted === 'object' ? p.deleted : {};
    const me = this.account.username;
    const okChat = (chat) =>
      typeof chat === 'string' && chat !== me && (USER_RE.test(chat) || isSystemChat(chat) || isSupportChat(chat) || (isGroupChat(chat) && GID_RE.test(chat.slice(1))) || (isChannelChat(chat) && CHANNEL_ID_RE.test(chat.slice(1))));
    const res = await this._serial(async () => {
      const all = await this.contacts();
      let newChats = 0;
      let added = 0;
      const touched = [];
      for (const [chat, bc] of Object.entries(src)) {
        if (!okChat(chat) || !bc || typeof bc !== 'object' || bc.username !== chat) continue;
        const list = Array.isArray(srcChats[chat]) ? srcChats[chat] : [];
        if (!all[chat]) {
          // Личный чат — только с действительным ключом собеседника
          if (USER_RE.test(chat) && !validIdentityPub(bc.keys)) continue;
          if (isGroupChat(chat) && !bc.group) continue;
          if (isChannelChat(chat) && !bc.channel) continue;
          const c = { ...bc, unread: 0, pending: [] };
          delete c.keyChanged;
          if (c.channel) c.channel.gone = true; // подписку подтвердит сервер при следующем входе
          all[chat] = c;
          newChats++;
        }
        const c = all[chat];
        // Имя и фото собеседника из копии — если здесь их ещё нет
        if (!c.profile && bc.profile && typeof bc.profile === 'object') c.profile = bc.profile;
        if (!c.pinned && bc.pinned && typeof bc.pinned === 'object') c.pinned = bc.pinned;
        const here = await this.messages(chat);
        const delHere = (await this.storage.get('deleted:' + chat)) || [];
        const del = new Set([...delHere, ...(Array.isArray(srcDel[chat]) ? srcDel[chat] : [])]);
        const have = new Set(here.map((m) => m.id));
        let n = 0;
        for (const m of list) {
          if (!m || typeof m.id !== 'string' || have.has(m.id) || del.has(m.id) || !Number.isFinite(m.ts)) continue;
          if (!['in', 'out', 'sys'].includes(m.dir) || !m.content || typeof m.content !== 'object') continue;
          // Неотправленное там здесь уже не уйдёт (очередь отправки не переносится)
          const msg = m.dir === 'out' && m.status === 'sending' ? { ...m, status: 'failed' } : m;
          here.push(msg);
          have.add(m.id);
          n++;
        }
        if (n) {
          here.sort((a, b) => a.ts - b.ts);
          await this.storage.set('chat:' + chat, here);
          c.lastTs = Math.max(c.lastTs || 0, here[here.length - 1].ts);
          added += n;
          touched.push(chat);
        }
        if (del.size > delHere.length) await this.storage.set('deleted:' + chat, [...del].slice(-DELETED_LIMIT));
      }
      await this._saveContacts(all);
      return { chats: newChats, messages: added, touched };
    });
    this._subscribePresence().catch(() => {});
    this.emit('imported', res);
    return { chats: res.chats, messages: res.messages };
  }

  async _isDeleted(chat, id) {
    return ((await this.storage.get('deleted:' + chat)) || []).includes(id);
  }

  _cid(item) {
    return `${item.id}:${item.to}`;
  }

  async _pumpOutbox() {
    if (this.status !== 'online') return;
    const outbox = (await this.storage.get('outbox')) || [];
    for (const item of outbox) {
      const cid = this._cid(item);
      if (this._inflight.has(cid)) continue;
      this._inflight.add(cid);
      this._serial(() => this._deliver(cid)).catch(async (e) => {
        this._inflight.delete(cid);
        if (e.code === 'offline' || e.code === 'timeout') return; // повторим после переподключения
        await this._serial(() => this._failOutbox(cid, e));
      });
    }
  }

  async _deliver(cid) {
    const outbox = (await this.storage.get('outbox')) || [];
    const item = outbox.find((x) => this._cid(x) === cid);
    if (!item || this.status !== 'online') {
      this._inflight.delete(cid);
      return;
    }
    const name = item.to;
    const expected = await this._expectedIdentity(name);
    const devices = (await this.storage.get('devices:' + name)) || [];
    await this._ensureSessions(name, devices, expected);

    // Профиль в очереди хранится ссылкой (с фото он большой) — подставляем текущий при отправке
    const content = item.content?.self && (item.content.t === 'profile' || item.content.t === 'sync-profile') ? { t: item.content.t, ...this.profile } : item.content;
    const messages = [];
    for (const d of devices) {
      if (!(await hasSession(this.ps, { name, device: d }))) continue; // устройство исчезло — сервер подскажет
      messages.push({ deviceId: d, envelope: await encrypt(this.ps, { name, device: d }, content, item.id) });
    }
    // notify: обычное сообщение — серверу можно разбудить офлайн-устройство пушем (служебные — нет)
    const notify = item.kind === 'msg';
    const req = { type: 'send', to: name, id: item.id, cid, messages, notify };
    // Сообщение в группе: серверу — id группы, чтобы в пуше было её название (оно ему известно из реестра групп)
    if (notify && item.content?.t === 'gmsg' && GID_RE.test(String(item.content.g))) req.group = item.content.g;
    if (!this._send(req)) this._inflight.delete(cid);
  }

  /** Закреплённая личность получателя (для себя — своя). Бросает key_changed, если ключ изменился. */
  async _expectedIdentity(name) {
    if (name === this.account.username) return this.account.pub;
    const c = (await this.contacts())[name];
    if (!c || c.keyChanged) throw errorOf('key_changed');
    return c.keys;
  }

  /** Устанавливает недостающие сессии X3DH с указанными устройствами собеседника. */
  async _ensureSessions(name, devices, expected) {
    const me = this.account.username;
    const needBundles = [];
    for (const d of devices) {
      const addr = { name, device: d };
      const sid = await sessionIdentity(this.ps, addr);
      if (sid && !sameIdentity(sid, expected)) await deleteSession(this.ps, addr);
      if (!(await hasSession(this.ps, addr))) needBundles.push(d);
    }
    if (needBundles.length) {
      // X3DH: берём bundle нужных устройств (сервер выдаёт одноразовый ключ один раз)
      const { bundles } = await this._request({ type: 'get-bundles', username: name, deviceIds: needBundles });
      for (const b of bundles) {
        if (!sameIdentity(b.identity, expected)) {
          if (name !== me) await this._markKeyChanged(name, b.identity);
          throw errorOf('key_changed');
        }
        try {
          await startSession(this.ps, { name, device: b.deviceId }, b);
        } catch (e) {
          throw errorOf(e.code || 'bad_spk_signature');
        }
      }
    }
  }

  async _markKeyChanged(username, identity) {
    const all = await this.contacts();
    const c = all[username];
    if (!c || sameIdentity(c.keyChanged, identity)) return;
    c.keyChanged = identity;
    await this._saveContacts(all);
    this.emit('key-changed', c);
  }

  // Сервер сообщил, что список устройств получателя другой: обновляем и пробуем снова.
  async _onMismatch({ cid, to, missing = [], extra = [] }) {
    this._inflight.delete(cid);
    await this._applyMismatch(to, missing, extra);
    const outbox = (await this.storage.get('outbox')) || [];
    const item = outbox.find((x) => this._cid(x) === cid);
    if (!item) return;
    item.attempts = (item.attempts || 0) + 1;
    await this.storage.set('outbox', outbox);
    if (item.attempts > MAX_SEND_ATTEMPTS) return this._failOutbox(cid);
    this._inflight.add(cid);
    try {
      await this._deliver(cid);
    } catch (e) {
      this._inflight.delete(cid);
      if (e.code !== 'offline' && e.code !== 'timeout') await this._failOutbox(cid, e);
    }
  }

  async _applyMismatch(to, missing = [], extra = []) {
    let devices = (await this.storage.get('devices:' + to)) || [];
    for (const d of extra) await deleteSession(this.ps, { name: to, device: d });
    devices = devices.filter((d) => !extra.includes(d));
    for (const d of missing) if (!devices.includes(d)) devices.push(d);
    await this.storage.set('devices:' + to, devices);
  }

  // ---------- Эфемерные сообщения (сигнализация звонков) ----------

  /**
   * Отправляет зашифрованное служебное сообщение без очереди: его получат только
   * устройства, которые сейчас в сети. Без deviceIds — всем устройствам собеседника.
   * @returns {Promise<number[]>} номера устройств, которым сообщение доставлено
   */
  async sendEphemeral(name, content, { deviceIds = null, notify = undefined } = {}) {
    name = String(name).toLowerCase();
    let targets = deviceIds ? [...new Set(deviceIds.map(Number))] : null;
    for (let attempt = 0; attempt < 4; attempt++) {
      const { id, messages } = await this._serial(async () => {
        const expected = await this._expectedIdentity(name);
        const me = this.account.username;
        let devices = targets || (await this.storage.get('devices:' + name)) || [];
        if (name === me) devices = devices.filter((d) => d !== this.account.deviceId);
        await this._ensureSessions(name, devices, expected);
        const id = randomId();
        const messages = [];
        for (const d of devices) {
          if (!(await hasSession(this.ps, { name, device: d }))) continue;
          messages.push({ deviceId: d, envelope: await encrypt(this.ps, { name, device: d }, content, id) });
        }
        return { id, messages };
      });
      if (targets && !messages.length) return [];
      try {
        const r = await this._request({ type: 'send-ephemeral', to: name, id, targets: targets ? 'subset' : 'all', messages, notify });
        return r.delivered || [];
      } catch (e) {
        if (e.code !== 'mismatched_devices') throw e;
        const { missing = [], extra = [] } = e.data || {};
        await this._serial(() => this._applyMismatch(name, missing, extra));
        if (targets) targets = targets.filter((d) => !extra.includes(d));
      }
    }
    throw errorOf('mismatched_devices');
  }

  /** Серверы STUN/TURN для звонков (учётные данные TURN временные). */
  async getIceServers() {
    return (await this._request({ type: 'get-ice' })).iceServers || [];
  }

  /** Запись о звонке в истории чата (только на этом устройстве). */
  async logCall(username, info) {
    return this._serial(async () => {
      const all = await this.contacts();
      if (all[username]) {
        all[username].lastTs = Date.now();
        if (info.missed) all[username].unread = (all[username].unread || 0) + 1;
        await this._saveContacts(all);
      }
      await this._appendMsg(username, { id: 'call-' + randomId(8), dir: 'sys', ts: Date.now(), content: { t: 'call', ...info } });
    });
  }

  async _onSent(cid) {
    this._inflight.delete(cid);
    const outbox = (await this.storage.get('outbox')) || [];
    const i = outbox.findIndex((x) => this._cid(x) === cid);
    if (i < 0) return;
    const [item] = outbox.splice(i, 1);
    await this.storage.set('outbox', outbox);
    if (item.kind === 'msg') await this._setMsgStatus(item.chat || item.to, item.id, 'sent');
  }

  async _failOutbox(cid, err) {
    this._inflight.delete(cid);
    const outbox = (await this.storage.get('outbox')) || [];
    const i = outbox.findIndex((x) => this._cid(x) === cid);
    if (i < 0) return;
    const [item] = outbox.splice(i, 1);
    await this.storage.set('outbox', outbox);
    if (item.kind === 'msg') {
      // В группе «не отправлено», только если не ушло никому и больше никому не уходит
      const chat = item.chat || item.to;
      const same = item.chat && outbox.some((x) => x.id === item.id && x.kind === 'msg');
      const m = item.chat && (await this.messages(chat)).find((x) => x.id === item.id);
      if (!same && (!item.chat || m?.status === 'sending')) await this._setMsgStatus(chat, item.id, 'failed');
      if (err) this.emit('error', { code: err.code, text: err.message });
    }
  }

  async _reject(from, all, reason) {
    await this._saveContacts(all);
    await this._appendMsg(from, { id: 'sys-' + Date.now(), dir: 'sys', ts: Date.now(), content: { t: 'rejected', reason } });
  }

  async _remember(from, id) {
    const seen = (await this.storage.get('seen')) || [];
    seen.push(`${from}|${id}`);
    if (seen.length > SEEN_LIMIT) seen.splice(0, seen.length - SEEN_LIMIT);
    await this.storage.set('seen', seen);
  }

  async _learnDevice(name, device) {
    const list = (await this.storage.get('devices:' + name)) || [];
    if (!list.includes(device)) {
      list.push(device);
      await this.storage.set('devices:' + name, list);
    }
  }

  async _onEnvelope({ qid, from, envelope, ephemeral = false }) {
    const ack = (receipt = true) => qid && this._send({ type: 'ack', qids: [qid], receipt });
    if (!envelope || typeof envelope.id !== 'string' || envelope.from !== from) return ack(false);
    const seen = (await this.storage.get('seen')) || [];
    if (seen.includes(`${from}|${envelope.id}`)) return ack(); // уже получено
    const me = this.account.username;

    // Копия с другого своего устройства (синхронизация отправленных)
    if (from === me) {
      if (envelope.type === 'prekey' && !sameIdentity(envelope.x3dh?.ik, this.account.pub)) return ack(false);
      let res;
      try {
        res = await decrypt(this.ps, envelope);
      } catch {
        return ack(false);
      }
      if (!sameIdentity(res.peerIdentity, this.account.pub)) return ack(false);
      await this._learnDevice(me, res.fromDevice);
      await this._remember(from, res.id);
      const c = res.content;
      if (c?.t === 'sync-read' && typeof c.chat === 'string' && Number.isFinite(c.upTo)) {
        await this._applyReadSync(c.chat, c.upTo);
        return ack(false);
      }
      // Своё устройство после обновления просит профиль ещё раз (старая версия могла отбросить фон)
      if (c?.t === 'sync-profile-req') {
        if (this.profile.v) {
          const outbox = (await this.storage.get('outbox')) || [];
          if (!outbox.some((x) => x.kind === 'ctl' && x.content?.t === 'sync-profile')) {
            outbox.push({ id: randomId(), to: me, kind: 'ctl', content: { t: 'sync-profile', self: 1 }, attempts: 0 });
            await this.storage.set('outbox', outbox);
            this._pumpOutbox();
          }
        }
        return ack(false);
      }
      if (c?.t === 'sync-profile') {
        const prof = cleanProfile(c);
        if (prof && (prof.v > this.profile.v || (prof.v === this.profile.v && prof.video && !this.profile.video))) {
          this.profile = prof;
          await this.storage.set('profile', prof);
          this.emit('profile', prof);
        }
        return ack(false);
      }
      // Своё устройство подписалось на приватный канал или создало его — ключ к нему
      if (c?.t === 'sync-channel' && typeof c.id === 'string' && CHANNEL_ID_RE.test(c.id) && isKey32(c.key)) {
        const chat = channelKey(c.id);
        if (!(await this.contacts())[chat]?.channel?.key && this.status === 'online') {
          // Описание канала — с сервера (сразу, без очереди: _serial уже занят этим сообщением)
          this._request({ type: 'channel-get', id: c.id })
            .then((r) =>
              this._serial(async () => {
                const all = await this.contacts();
                if (!r.channel.role) return; // уже отписались
                if (await this._applyChannelInfo(all, r.channel, c.key)) await this._saveContacts(all);
              })
            )
            .then(() => this._syncChannel(chat))
            .catch(() => {});
        }
        return ack(false);
      }
      if (c?.t === 'sync-delete-chat' && typeof c.chat === 'string') {
        await this._clearChat(c.chat, true);
        return ack(false);
      }
      if (c?.t === 'sync-top' && typeof c.chat === 'string') {
        await this._applyChatPin(await this.contacts(), c.chat, c.on === true, c.ts);
        return ack(false);
      }
      if (c?.t === 'sync-folders') {
        await this._applyFolders(c.v, c.list);
        return ack(false);
      }
      if (c?.t === 'sync-archive' && typeof c.chat === 'string') {
        await this._applyArchive(await this.contacts(), c.chat, c.on === true, c.ts);
        return ack(false);
      }
      if (c?.t === 'sync-pin' && typeof c.chat === 'string') {
        await this._applyPin(await this.contacts(), c.chat, c.pin ?? null, c.ts);
        return ack(false);
      }
      if (c?.t === 'sync-delete' && typeof c.chat === 'string' && Array.isArray(c.ids)) {
        await this._removeMessages(c.chat, c.ids.map(String).slice(0, MAX_DELETE));
        return ack(false);
      }
      if (c?.t === 'group' || c?.t === 'group-leave') {
        await this._onGroupContent(await this.contacts(), me, res, true);
        return ack(false);
      }
      if (c?.t === 'sync-sent' && isGroupChat(c.to)) {
        await this._onGroupSyncSent(c.to, res.id, c);
        return ack(false);
      }
      if (c?.t === 'sync-sent' && typeof c.to === 'string' && c.to !== me) {
        if (await this._isDeleted(c.to, res.id)) return ack(false);
        const all = await this.contacts();
        let contact = null;
        try {
          contact = await this._ensureContact(all, c.to);
        } catch {
          return; // нет связи — сервер пришлёт снова
        }
        const content = cleanText(c);
        if (contact && content) {
          contact.lastTs = Date.now();
          delete contact.hidden;
          contact.shareProfile = true; // вы пишете ему с другого устройства — профиль ему тоже положен
          await this._saveContacts(all);
          const list = await this.messages(c.to);
          if (!list.some((m) => m.id === res.id)) {
            await this._appendMsg(c.to, {
              id: res.id,
              dir: 'out',
              ts: Number.isFinite(c.ts) ? c.ts : Date.now(),
              content,
              status: 'sent',
            });
          }
        }
      }
      return ack(false);
    }

    const all = await this.contacts();
    const known = !!all[from];
    let c;
    try {
      c = await this._ensureContact(all, from);
    } catch {
      return; // без подтверждения: сервер пришлёт снова
    }
    if (!c) return ack(false);
    if (c.keyChanged && ephemeral) return; // звонок от собеседника с непроверенным новым ключом — не принимаем
    if (c.keyChanged) {
      (c.pending ||= []).push(envelope);
      await this._saveContacts(all);
      return ack();
    }

    // Новая сессия (prekey) от другой личности: либо собеседник сменил ключ, либо подделка.
    if (envelope.type === 'prekey' && !sameIdentity(envelope.x3dh?.ik, c.keys)) {
      let serverIdentity = null;
      try {
        serverIdentity = await this.fetchIdentity(from);
      } catch {
        return;
      }
      if (serverIdentity && sameIdentity(serverIdentity, envelope.x3dh.ik)) {
        c.keyChanged = serverIdentity;
        (c.pending ||= []).push(envelope);
        await this._saveContacts(all);
        this.emit('key-changed', c);
        return ack();
      }
      await this._reject(from, all, 'identity_mismatch');
      return ack(false);
    }

    let res;
    try {
      res = await decrypt(this.ps, envelope);
    } catch (e) {
      if (e.code === 'duplicate' || e.code === 'opk_used') return ack(false); // повтор — молча
      await this._reject(from, all, e.code || 'decrypt_failed');
      return ack(false);
    }
    if (!sameIdentity(res.peerIdentity, c.keys)) {
      await this._reject(from, all, 'identity_mismatch');
      return ack(false);
    }

    await this._learnDevice(from, res.fromDevice);
    await this._remember(from, res.id);
    // Заблокирован: сервер такое уже не доставляет, а пришедшее до блокировки — отбрасываем
    // (расшифровали, чтобы не сбить храповик на случай разблокировки)
    if (this.isBlocked(from)) return ack(false);
    if (['gmsg', 'group', 'group-leave', 'gdelete', 'gpin'].includes(res.content?.t)) {
      if (!known) c.hidden = true; // участник группы, с которым нет личного чата
      return ack(await this._onGroupContent(all, from, res));
    }
    if (res.content?.t === 'profile-req') {
      // Повторная отправка профиля по просьбе собеседника — тем, кому вы пишете. На один и тот же
      // запрос (та же версия профиля у собеседника) — не чаще раза в час.
      const now = Date.now();
      const asked = Number.isFinite(res.content.v) ? res.content.v : 0;
      const last = this._profileReplies.get(from);
      if (c.shareProfile && this.profile.v && (!last || last.v !== asked || now - last.at > 3600_000)) {
        this._profileReplies.set(from, { v: asked, at: now });
        const outbox = (await this.storage.get('outbox')) || [];
        delete c.profileSentV;
        this._shareProfileTo(c, outbox);
        await this.storage.set('outbox', outbox);
        await this._saveContacts(all);
        this._pumpOutbox();
      }
      return ack(false);
    }
    if (res.content?.t === 'profile') {
      const prof = cleanProfile(res.content);
      const old = c.profile;
      // Та же версия, но с фото (повтор по запросу) — тоже принимаем
      const fuller = prof && prof.v === old?.v && ((prof.avatar && !old.avatar) || (prof.video && !old.video));
      if (prof) c.profileSchema = PROFILE_SCHEMA; // профиль собеседника принят этой версией (с фоном)
      if (prof && (prof.v > (old?.v || 0) || fuller)) {
        // Большое фото — отдельно от контактов (список контактов перезаписывается часто)
        const { photo, ...rest } = prof;
        await this.storage.set('photo:' + from, photo || null);
        c.profile = rest;
        if (!known) c.hidden = true; // только профиль, без сообщений — в списке чатов не показываем
        await this._saveContacts(all);
        this.emit('profile-changed', { username: from, profile: prof });
      }
      return ack(false);
    }
    if (res.content?.t === 'clear-chat') {
      await this._clearChat(from, false);
      return ack(false);
    }
    if (res.content?.t === 'call') {
      // Сигнализация звонка: в историю не пишется. Устаревшие (старше 2 минут) отбрасываются.
      const age = Date.now() - Number(res.content.ts || 0);
      if (ephemeral && age < 120_000 && age > -60_000) {
        await this._saveContacts(all); // собеседник мог быть добавлен только что
        this.emit('call-signal', { from, fromDevice: res.fromDevice, data: res.content });
      }
      return ack(false);
    }
    if (res.content?.t === 'pin') {
      await this._applyPin(all, from, res.content.pin ?? null, res.content.ts);
      return ack(false);
    }
    if (res.content?.t === 'delete' && Array.isArray(res.content.ids)) {
      await this._removeMessages(from, res.content.ids.map(String).slice(0, MAX_DELETE));
      return ack(false);
    }
    if (res.content?.t !== 'text' && res.content?.t !== 'file') return ack(false); // неизвестный тип — игнорируем
    const ts = Number.isFinite(res.content?.ts) ? res.content.ts : Date.now();
    const content = cleanText(res.content, ts);
    if (!content) return ack(false);
    if (await this._isDeleted(from, res.id)) return ack();
    const list = await this.messages(from);
    if (list.some((m) => m.id === res.id && m.dir === 'in')) return ack();
    c.unread = (c.unread || 0) + 1;
    c.lastTs = Date.now();
    delete c.hidden; // удалённый чат появляется снова, как в Telegram
    await this._saveContacts(all);
    await this._appendMsg(from, { id: res.id, dir: 'in', ts, content });
    ack();
  }
}

/** Хранилище в памяти (для тестов и как образец адаптера). */
export class MemoryStorage {
  constructor() {
    this.m = new Map();
  }
  async get(k) {
    return this.m.has(k) ? structuredClone(this.m.get(k)) : undefined;
  }
  async set(k, v) {
    this.m.set(k, structuredClone(v));
  }
  async del(k) {
    this.m.delete(k);
  }
  async clear() {
    this.m.clear();
  }
}
