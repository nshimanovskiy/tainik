import { MessengerClient, ERROR_TEXT, AVATAR_SIZE, validAvatar, PHOTO_SIZE, validPhoto, isGroupChat, isChannelChat, isSystemChat, isSupportChat, GROUP_MAX, PROFILE_CHANNELS_MAX, PROFILE_VIDEO_MAX, PROFILE_VIDEO_SEC } from '/shared/client-core.js';
import { formatLinkCode } from '/shared/protocol/provision.js';
import { qrEncode } from '/shared/qr.js';
import { IdbStorage, settings as webSettings } from './idb-storage.js';
import config from './config.js';
import { CallManager, CALL_RESULT_TEXT } from './call.js';
import { t, LANG, LOCALE, setLang, translateDom, LANGS as LANG_LIST } from '/shared/i18n.js';
import { fmtSize, kindOf, THUMB_MAX } from '/shared/media.js';
import { linkify } from '/shared/linkify.js';
import { loadIcons, icon } from './icons.js';
import { VERSION } from '/shared/version.js';

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text; // только textContent — никакого HTML от собеседника
  return e;
};

// ---------- Платформа ----------
// В десктопе (Electron) preload-скрипт даёт window.desktop: системное защищённое
// хранилище и настройки. В браузере — IndexedDB с шифрованием и localStorage.
const desktop = window.desktop || null;
translateDom(); // статический текст страницы — на выбранный язык
// Android-приложение даёт тот же мост, что и десктоп, с platform: 'android'
const android = desktop?.platform === 'android';

// Интерфейс не масштабируется: Safari на iPhone не слушается user-scalable=no в viewport,
// а в браузере на компьютере масштаб меняют Ctrl+колесо (и щипок тачпада) и Ctrl +/−
for (const ev of ['gesturestart', 'gesturechange', 'gestureend']) document.addEventListener(ev, (e) => e.preventDefault(), { passive: false });
document.addEventListener('touchmove', (e) => e.scale !== undefined && e.scale !== 1 && e.preventDefault(), { passive: false });
document.addEventListener('wheel', (e) => e.ctrlKey && e.preventDefault(), { passive: false });
// iPhone: двойное касание приближает страницу даже с touch-action — гасим второе касание подряд
let lastTouchEnd = 0;
document.addEventListener('touchend', (e) => {
  const now = Date.now();
  if (now - lastTouchEnd < 300 && e.touches.length === 0 && !e.target.closest('input, textarea, [contenteditable]')) e.preventDefault();
  lastTouchEnd = now;
}, { passive: false });
document.addEventListener('touchstart', (e) => e.touches.length > 1 && e.preventDefault(), { passive: false });
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && ['+', '=', '-', '_', '0'].includes(e.key)) e.preventDefault();
});

if (!window.isSecureContext || !globalThis.crypto?.subtle || (!desktop && !window.indexedDB)) {
  $('unsupported').hidden = false;
  throw new Error(t('Небезопасный контекст: WebCrypto недоступен'));
}

const settings = desktop
  ? desktop.settings
  : { get: async (k) => webSettings.get(k), set: async (k, v) => webSettings.set(k, v) };
const sameOriginWs = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
const DEFAULT_SERVER = desktop ? config.defaultServer || 'ws://localhost:8080/ws' : sameOriginWs;

// ---------- Аккаунты ----------
// На одном устройстве может быть несколько аккаунтов. Для каждого это устройство —
// отдельное «устройство» аккаунта со своими ключами, переписка хранится раздельно:
// 'main' — исходное хранилище (как до появления нескольких аккаунтов), у остальных — своё
// (IndexedDB tainik-v3-<id>, файл в десктопе, папка на Android).
// Активный аккаунт показан в интерфейсе, остальные работают в фоне (см. startOthers).
const MAX_ACCOUNTS = 5;
const ACCOUNT_ID = /^(main|a[0-9a-f]{8})$/;
function storageFor(id) {
  const ns = id === 'main' ? '' : id;
  if (desktop) return ns ? desktop.storageFor(ns) : desktop.storage;
  return new IdbStorage(ns ? `tainik-v3-${ns}` : 'tainik-v3');
}
async function loadAccounts() {
  try {
    const list = JSON.parse((await settings.get('accounts')) || '[]');
    return Array.isArray(list) ? list.filter((a) => a && ACCOUNT_ID.test(a.id)) : [];
  } catch {
    return [];
  }
}
let accounts = await loadAccounts();
if (!accounts.length) accounts = [{ id: 'main' }];
let activeId = (await settings.get('active-account')) || accounts[0].id;
if (!accounts.some((a) => a.id === activeId)) activeId = accounts[0].id;
// Брошенные пустые места (начали добавлять аккаунт и передумали) убираем
accounts = accounts.filter((a) => a.username || a.id === activeId || a.id === 'main');
const activeAccount = () => accounts.find((a) => a.id === activeId);
const savedAccounts = () => accounts.filter((a) => a.username);
const saveAccounts = () => settings.set('accounts', JSON.stringify(accounts));

// Версия приложения: у десктопа и Android — версия установленного приложения, в вебе — версия страницы
const APP_VERSION = (desktop?.version && (await desktop.version().catch(() => ''))) || VERSION;
const client = new MessengerClient({ url: DEFAULT_SERVER, storage: storageFor(activeId), appVersion: APP_VERSION });
let ownUnread = 0;
const others = new Map(); // id → { acc, client, unread } — остальные аккаунты, работают в фоне
let current = null;

// ---------- На экране или в фоне ----------
// «В сети» собеседники видят, только пока приложение открыто на экране. В фоне (Android,
// окно в трее, свёрнутая вкладка) соединение остаётся — сообщения и звонки приходят.
const pageActive = () => (android ? desktop.isActive?.() ?? true : document.visibilityState === 'visible');
function applyActive() {
  client.setActive(pageActive());
  // Остальные аккаунты на этом устройстве работают в фоне: сообщения приходят, но «в сети»
  // показывается только тот, который сейчас открыт
  for (const o of others.values()) o.client.setActive(false);
}
client.active = pageActive();
document.addEventListener('visibilitychange', () => !android && applyActive());
window.__tainikActive = () => applyActive(); // Android: окно ушло в фон или вернулось

// ---------- Утилиты ----------
function hue(name) {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)) % 360;
  return h;
}
/** Имя для показа: имя из профиля собеседника или юзернейм. */
const nameOf = (username) => (username && client.account ? client.nameOf(username) : username || '');
/**
 * Аватар: фото профиля (если у владельца подписка Премиум), иначе первая буква имени,
 * цвет — по юзернейму (не меняется вместе с именем).
 */
function paintAvatar(node, username, photo = username && client.account ? client.avatarOf(username) : null) {
  paintAvatarBase(node, username, photo);
  // Рамка из магазина — у аватаров в списке чатов, шапке чата и профилях (класс with-frame)
  if (node.classList.contains('with-frame')) paintFrame(node, username);
}
function paintAvatarBase(node, username, photo) {
  node.classList.toggle('photo', !!photo);
  // Фото в профиле открывается на весь экран
  if (node.id === 'pf-avatar' || node.id === 'prof-avatar') {
    node.classList.toggle('zoomable', !!photo);
    if (photo) {
      node.setAttribute('role', 'button');
      node.tabIndex = 0;
      node.setAttribute('aria-label', t('Открыть фото профиля'));
    } else {
      node.removeAttribute('role');
      node.removeAttribute('tabindex');
      node.removeAttribute('aria-label');
    }
  }
  if (photo) {
    node.textContent = '';
    node.style.background = '';
    node.style.backgroundImage = `url("${photo}")`; // только проверенный data:-URL (validAvatar)
    return;
  }
  if (isSystemChat(username) || (client.account && client.isOfficial(username))) {
    node.classList.add('photo');
    node.textContent = '';
    node.style.background = '';
    node.style.backgroundImage = 'url("/icon-192.png")';
    return;
  }
  node.style.backgroundImage = '';
  const shown = nameOf(username) || '?';
  node.textContent = [...shown][0].toUpperCase();
  node.style.background = `hsl(${hue(username || '')} 42% 42%)`;
}
// ---------- Рамки и фоны профиля (магазин) ----------
// Файлы товаров открытые и не меняются: скачиваем один раз за сеанс и держим в памяти как blob:-URL.
// Уже скачанные рисуются сразу (список чатов перерисовывается часто — рамки не должны мигать).
const shopFiles = new Map(); // id → Promise<{ url, type }>
const shopReady = new Map(); // id → { url, type } — уже скачанные
function shopFile(id) {
  if (!shopFiles.has(id)) {
    const p = client.fetchShopFile(id).then((blob) => {
      const f = { url: URL.createObjectURL(blob), type: blob.type };
      shopReady.set(id, f);
      return f;
    });
    p.catch(() => setTimeout(() => shopFiles.get(id) === p && shopFiles.delete(id), 30_000)); // попробовать позже
    shopFiles.set(id, p);
  }
  return shopFiles.get(id);
}
function frameImg(url) {
  const img = el('img', 'av-frame');
  img.alt = '';
  img.setAttribute('aria-hidden', 'true');
  img.draggable = false;
  img.src = url;
  return img;
}
/** Рамка вокруг аватара: id — товар (по умолчанию — что надето у username). */
function paintFrame(node, username, id = username && client.account ? client.lookOf(username).frame || null : null) {
  node.querySelector(':scope > .av-frame')?.remove();
  node.classList.toggle('framed', !!id);
  node.dataset.frame = id || '';
  if (!id) return;
  const ready = shopReady.get(id);
  if (ready) {
    if (ready.type.startsWith('image/')) node.append(frameImg(ready.url));
    return;
  }
  shopFile(id)
    .then((f) => {
      if (node.dataset.frame !== id || !f.type.startsWith('image/') || node.querySelector(':scope > .av-frame')) return;
      node.append(frameImg(f.url));
    })
    .catch(() => {});
}
// Своё видео на фоне профиля — расшифрованное, в памяти (id файла → Promise<url>)
const coverVideos = new Map();
function coverVideoUrl(file) {
  if (!coverVideos.has(file.id)) {
    const p = client.fetchFile(file).then((data) => URL.createObjectURL(new Blob([data], { type: file.mime })));
    p.catch(() => coverVideos.get(file.id) === p && coverVideos.delete(file.id));
    coverVideos.set(file.id, p);
  }
  return coverVideos.get(file.id);
}
/** Фон профиля в box: своё видео (Премиум) или фон из магазина; bgId — показать этот товар. */
function paintCover(box, username, bgId) {
  const own = bgId === undefined && username && client.account ? client.profileVideoOf(username) : null;
  const id = bgId !== undefined ? bgId : own ? null : username && client.account ? client.lookOf(username).bg || null : null;
  const key = own ? 'v:' + own.id : id ? 's:' + id : '';
  const top = box.parentElement;
  if (box.dataset.key === key) return;
  box.dataset.key = key;
  box.replaceChildren();
  box.hidden = !key;
  top?.classList.toggle('has-cover', !!key);
  if (!key) return;
  const show = (url, type) => {
    if (box.dataset.key !== key) return;
    let m;
    if (type.startsWith('video/')) {
      m = el('video');
      m.muted = true;
      m.defaultMuted = true;
      m.loop = true;
      m.autoplay = true;
      m.playsInline = true;
      m.setAttribute('playsinline', '');
      m.setAttribute('muted', '');
      m.disablePictureInPicture = true;
      m.src = url;
      m.play?.().catch(() => {});
    } else {
      m = el('img');
      m.alt = '';
      m.src = url;
    }
    m.setAttribute('aria-hidden', 'true');
    box.replaceChildren(m);
  };
  // Не скачалось (нет сети) — при следующей отрисовке попробовать снова, а не оставлять пустой фон
  const failed = () => box.dataset.key === key && (box.dataset.key = '');
  if (own) coverVideoUrl(own).then((url) => show(url, own.mime)).catch(failed);
  else shopFile(id).then((f) => show(f.url, f.type)).catch(failed);
}

// Звезда подписки Премиум рядом с именем
function premiumStar() {
  const s = el('span', 'premium-star');
  s.append(icon('star'));
  s.title = t('Подписка Премиум');
  s.setAttribute('aria-label', t('Подписка Премиум'));
  return s;
}
// Официальная галочка (её ставит администратор сервера), как в Telegram
function verifiedBadge() {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'official');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', t('Официальный аккаунт'));
  const titleEl = document.createElementNS(NS, 'title');
  titleEl.textContent = t('Официальный аккаунт');
  const bg = document.createElementNS(NS, 'path');
  bg.setAttribute('class', 'official-bg');
  bg.setAttribute('d', 'M12 1.5a10.5 10.5 0 1 0 0 21a10.5 10.5 0 1 0 0-21z'); // круг
  const ck = document.createElementNS(NS, 'path');
  ck.setAttribute('class', 'official-check');
  ck.setAttribute('d', 'M7.6 12.3l3 3 5.8-6.2');
  svg.append(titleEl, bg, ck);
  return svg;
}
/** Имя (из профиля, иначе юзернейм) с галочкой, если аккаунт официальный. */
function setName(node, username, verified) {
  node.replaceChildren(document.createTextNode(nameOf(username)));
  if (verified) node.append(verifiedBadge());
  if (username && client.account && client.hasPremium(username)) node.append(premiumStar());
}

const timeFmt = new Intl.DateTimeFormat(LOCALE, { hour: '2-digit', minute: '2-digit' });
const dayFmt = new Intl.DateTimeFormat(LOCALE, { day: 'numeric', month: 'long' });
function dayLabel(ts) {
  const d = new Date(ts);
  const today = new Date();
  const y = new Date(Date.now() - 86400000);
  if (d.toDateString() === today.toDateString()) return t('Сегодня');
  if (d.toDateString() === y.toDateString()) return t('Вчера');
  return dayFmt.format(d);
}
let toastTimer;
function toast(text, ms = 3500) {
  const box = $('toast');
  box.textContent = text;
  box.hidden = false;
  clearTimeout(toastTimer);
  if (ms) toastTimer = setTimeout(() => (box.hidden = true), ms);
}
/** Иконка + текст в элементе (статусы ключа, блокировки и т. п.). */
function iconText(node, name, text) {
  node.replaceChildren(icon(name), text);
  return node;
}
const withIcon = (cls, name, text) => iconText(el('span', cls), name, text);
const STATUS_ICON = { sending: 'clock', sent: 'check', delivered: 'check2' };
/** Значок статуса доставки: иконка или текст «не отправлено». */
function setStatusIcon(node, status) {
  if (status === 'failed') return node.replaceChildren(t('⚠ не отправлено'));
  node.replaceChildren(...(STATUS_ICON[status] ? [icon(STATUS_ICON[status])] : []));
}
const STATUS_TEXT = { online: t('в сети'), connecting: t('подключение…'), offline: t('нет связи'), replaced: t('открыт в другом месте') };

function callText(ct) {
  const dir = ct.direction === 'out' ? t('Исходящий') : t('Входящий');
  const kind = ct.video ? t('видеозвонок') : t('звонок');
  if (ct.result === 'answered') {
    const d = ct.duration || 0;
    const dur = d >= 3600 ? `${Math.floor(d / 3600)}:${String(Math.floor((d % 3600) / 60)).padStart(2, '0')}:${String(d % 60).padStart(2, '0')}` : `${Math.floor(d / 60)}:${String(d % 60).padStart(2, '0')}`;
    return `📞 ${dir} ${kind} · ${dur}`;
  }
  if (ct.result === 'missed') return t('📞 Пропущенный {0}', kind);
  return `📞 ${dir} ${kind} · ${CALL_RESULT_TEXT[ct.result] || ct.result}`;
}

// Вложения: подписи для списка чатов, уведомлений и цитат
const SIZE_UNITS = [t('Б'), t('КБ'), t('МБ'), t('ГБ')];
const sizeText = (b) => fmtSize(b, SIZE_UNITS, LOCALE);
const KIND_LABEL = { image: t('📷 Фото'), video: t('🎬 Видео'), audio: t('🎵 Аудио'), file: t('📄 Файл') };
const AS_LABEL = { voice: t('🎤 Голосовое сообщение'), note: t('⏹ Видеосообщение') };
// Запись голосовых и видеосообщений: нужен MediaRecorder, для квадрата — ещё и захват холста
const REC_OK = !!(window.MediaRecorder && navigator.mediaDevices?.getUserMedia);
const NOTE_OK = REC_OK && typeof HTMLCanvasElement !== 'undefined' && !!HTMLCanvasElement.prototype.captureStream;
const kindLabel = (x) => AS_LABEL[x.as] || KIND_LABEL[x.kind];
function fileLabel(content) {
  const f = content.file;
  const base = f.as ? `${AS_LABEL[f.as]}${f.dur ? ` (${fmtClock(f.dur)})` : ''}` : f.kind === 'image' || f.kind === 'video' ? KIND_LABEL[f.kind] : `${f.kind === 'audio' ? '🎵' : '📄'} ${f.name}`;
  const cap = String(content.body || '').replace(/\s+/g, ' ').trim();
  return cap ? `${base} · ${cap}` : base;
}
/** Текст сообщения одной строкой: для вложения — вид и подпись. */
const textOf = (content) =>
  content?.t === 'notice' ? noticeText(content) : content?.t === 'file' && content.file ? fileLabel(content) : String(content?.body ?? '');

// ---------- Служебный чат «Тайник» ----------
const longDateFmt = new Intl.DateTimeFormat(LOCALE, { day: 'numeric', month: 'long', year: 'numeric' });
const untilText = (ts) => (ts ? longDateFmt.format(new Date(ts)).replace(/\.$/, '') : '—'); // «2026 г.» → без второй точки
/** Текст служебного уведомления (см. cleanNotice в shared/client-core.js). */
function noticeText(c) {
  switch (c.kind) {
    case 'welcome':
      return t('👋 Добро пожаловать в Тайник! Сюда приходят служебные уведомления: монеты, Премиум, входы с новых устройств и новости сервера.');
    case 'device':
      return c.ip
        ? t('🔐 Вход с нового устройства «{0}» (IP {1}). Если это были не вы — отвяжите его в настройках, раздел «Устройства».', c.name || '?', c.ip)
        : t('🔐 Вход с нового устройства «{0}». Если это были не вы — отвяжите его в настройках, раздел «Устройства».', c.name || '?');
    case 'verified':
      return c.on ? t('✔ Вашему аккаунту выдана официальная галочка.') : t('Официальная галочка с вашего аккаунта снята.');
    case 'coins-buy':
      return t('🪙 Зачислено монет: {0}. Баланс: {1}.', c.amount, c.balance);
    case 'coins-admin':
      return c.delta > 0
        ? t('🪙 Администратор начислил вам монеты: {0}. Баланс: {1}.', c.delta, c.balance)
        : t('🪙 Администратор списал монеты: {0}. Баланс: {1}.', -c.delta, c.balance);
    case 'premium':
      return c.cost != null
        ? t('★ Премиум на {0} оплачен монетами ({1}). Действует до {2}.', planName(c.days), c.cost, untilText(c.until))
        : t('★ Премиум на {0} оплачен. Действует до {1}.', planName(c.days), untilText(c.until));
    case 'premium-gift':
      return t('🎁 {0} дарит вам Премиум на {1}! Действует до {2}.', nameOf(c.from), planName(c.days), untilText(c.until));
    case 'gift-sent':
      return c.cost != null
        ? t('🎁 Вы подарили {0} Премиум на {1}. Списано монет: {2}.', nameOf(c.to), planName(c.days), c.cost)
        : t('🎁 Вы подарили {0} Премиум на {1}.', nameOf(c.to), planName(c.days));
    case 'premium-admin':
      return t('★ Администратор продлил ваш Премиум на {0}. Действует до {1}.', planName(c.days), untilText(c.until));
    case 'premium-off':
      return t('Администратор отключил вашу подписку Премиум.');
    case 'premium-ended':
      return t('★ Подписка Премиум закончилась. Продлить её можно в настройках.');
    case 'premium-soon':
      return t('★ Подписка Премиум закончится {0}. Продлить её можно в настройках.', untilText(c.until));
    case 'shop-admin':
      if (c.item === 'bg') return c.on ? t('🎁 Администратор выдал вам фон профиля «{0}». Поставить его — Настройки → «Магазин».', c.name) : t('Администратор забрал у вас фон профиля «{0}».', c.name);
      return c.on ? t('🎁 Администратор выдал вам рамку «{0}». Надеть её — Настройки → «Магазин».', c.name) : t('Администратор забрал у вас рамку «{0}».', c.name);
    case 'admin':
      return String(c.body ?? '');
  }
  return t('Служебное сообщение');
}

function previewOf(m) {
  if (!m) return t('Нет сообщений');
  if (m.dir === 'sys' && m.content?.t === 'call') return callText(m.content);
  if (m.dir === 'sys' && m.content?.t === 'group') return groupEventText(m.content);
  if (m.dir === 'sys' && m.content?.t === 'gift') return giftText(m.content);
  if (m.dir === 'sys') return t('Служебное сообщение');
  const body = textOf(m.content);
  const who = m.dir === 'out' ? t('Вы: ') : m.from ? `${nameOf(m.from)}: ` : '';
  return who + body.replace(/\s+/g, ' ');
}

// ---------- Группы: подписи ----------
const whoName = (u) => (u === client.account?.username ? t('вы') : nameOf(u));
const byName = (u) => (u === client.account?.username ? t('Вы') : nameOf(u));
/** Служебная строка группы: создана, переименована, добавлены, исключены, вышел. */
function groupEventText(e) {
  const who = (e.who || []).map(whoName).join(', ');
  switch (e.ev) {
    case 'created':
      return t('{0} создал(а) группу «{1}»', byName(e.by), e.name);
    case 'renamed':
      return t('{0} переименовал(а) группу в «{1}»', byName(e.by), e.name);
    case 'added':
      return t('{0} добавил(а): {1}', byName(e.by), who);
    case 'removed':
      return (e.who || []).includes(client.account?.username) ? t('{0} исключил(а) вас из группы', byName(e.by)) : t('{0} исключил(а): {1}', byName(e.by), who);
    case 'left':
      return e.by === client.account?.username ? t('Вы покинули группу') : t('{0} покинул(а) группу', byName(e.by));
    case 'deleted':
      return t('Группа удалена администратором сервера');
    default:
      return t('Служебное сообщение');
  }
}
const isChAdmin = (ch) => !!ch && !ch.gone && (ch.role === 'owner' || ch.role === 'admin');
function channelSubText(ch) {
  if (ch.gone) return t('канал недоступен');
  const kind = ch.public ? t('публичный канал') : t('приватный канал');
  return ch.subs ? `${kind} · ${t('подписчиков: {0}', ch.subs)}` : kind;
}
function membersText(g) {
  if (g.left) return t('вы не участник группы');
  const n = g.members.length;
  return n === 1 ? t('1 участник') : t('участников: {0}', n);
}

// ---------- Экраны ----------
function showAuth() {
  $('auth').hidden = false;
  $('app').hidden = true;
  // Safari на iPhone/iPad: предложить установить на экран «Домой» (там своё хранилище и пуши)
  $('ios-install').hidden = !(isIOS && !standalone && !desktop);
  const others = savedAccounts().filter((a) => a.id !== activeId);
  $('auth-cancel').hidden = !others.length;
  $('auth-extra').hidden = !others.length;
  if (desktop) {
    $('server-field').hidden = false;
    if (!$('server').value) $('server').value = DEFAULT_SERVER;
  }
  $('username').focus();
}
async function showApp() {
  $('auth').hidden = true;
  $('app').hidden = false;
  setName($('me-name'), client.account.username, client.verified);
  paintAvatar($('me-avatar'), client.account.username);
  setStatus(client.status);
  await renderContacts();
  initNotifications().catch((e) => console.warn('notifications', e));
  const after = await settings.get('open-chat-after-switch');
  if (after) {
    await settings.set('open-chat-after-switch', '');
    pendingNoticeChat = after;
  }
  const flash = await settings.get('flash');
  if (flash) {
    await settings.set('flash', '');
    toast(flash, 6000);
  }
  startOthers().catch((e) => console.warn('accounts', e));
  if (pendingNoticeChat) {
    const chat = pendingNoticeChat;
    pendingNoticeChat = null;
    openChatFromNotice(chat);
  }
}

function setStatus(s) {
  $('status-dot').className = 'dot ' + s;
  $('status-text').textContent = STATUS_TEXT[s] || s;
  updateComposer();
}

// ---------- Вход ----------
function normalizeServer(raw) {
  let s = String(raw || '').trim();
  if (!s) return DEFAULT_SERVER;
  if (!/^wss?:\/\//i.test(s)) s = (/^(localhost|127\.)/.test(s) ? 'ws://' : 'wss://') + s;
  const u = new URL(s);
  if (u.protocol !== 'ws:' && u.protocol !== 'wss:') throw new Error(t('Адрес должен начинаться с ws:// или wss://'));
  if (u.pathname === '/' || u.pathname === '') u.pathname = '/ws';
  return u.toString();
}

function readServer(errorNode) {
  try {
    return desktop ? normalizeServer($('server').value) : DEFAULT_SERVER;
  } catch (err) {
    errorNode.textContent = err.message.startsWith(t('Адрес')) ? err.message : t('Неверный адрес сервера');
    return null;
  }
}

// Понятное имя устройства для списка устройств
function deviceName() {
  const ua = navigator.userAgent;
  const os = /Windows/.test(ua) ? 'Windows' : /Mac OS X|Macintosh/.test(ua) ? (/iPhone|iPad/.test(ua) ? 'iOS' : 'macOS') : /Android/.test(ua) ? 'Android' : /Linux/.test(ua) ? 'Linux' : t('ОС');
  if (desktop) return t('Приложение · {0}', os);
  const br = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : t('Браузер');
  return `${br} · ${os}`;
}

$('auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('username').value.trim().toLowerCase();
  $('auth-error').textContent = '';
  const server = readServer($('auth-error'));
  if (!server) return;
  $('auth-btn').disabled = true;
  $('auth-btn').textContent = t('Создаём ключи…');
  try {
    client.url = server;
    await client.register(name, { deviceName: deviceName() });
    await settings.set('server', server);
    await rememberAccount();
    await showApp();
  } catch (err) {
    $('auth-error').textContent = err.code === 'timeout' ? t('Сервер недоступен') : err.message;
  } finally {
    $('auth-btn').disabled = false;
    $('auth-btn').textContent = t('Создать ключи и войти');
  }
});

// ---------- Привязка ЭТОГО устройства к существующему аккаунту ----------
let linking = null;
function setTab(link) {
  $('tab-new').classList.toggle('active', !link);
  $('tab-link').classList.toggle('active', link);
  $('tab-new').setAttribute('aria-selected', String(!link));
  $('tab-link').setAttribute('aria-selected', String(link));
  $('auth-form').hidden = link;
  $('link-pane').hidden = !link;
  if (!link && linking) {
    linking.cancel();
    linking = null;
    resetLinkPane();
  }
}
$('tab-new').addEventListener('click', () => setTab(false));
$('tab-link').addEventListener('click', () => setTab(true));

function resetLinkPane() {
  $('link-box').hidden = true;
  $('link-start').hidden = false;
  $('link-start').disabled = false;
}

function renderQr(container, text) {
  const NS = 'http://www.w3.org/2000/svg';
  const m = qrEncode(text);
  const size = m.length + 8; // «тихая зона» по 4 модуля
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
  svg.setAttribute('shape-rendering', 'crispEdges');
  const bg = document.createElementNS(NS, 'rect');
  bg.setAttribute('width', size);
  bg.setAttribute('height', size);
  bg.setAttribute('fill', '#fff');
  const path = document.createElementNS(NS, 'path');
  let d = '';
  m.forEach((row, y) => row.forEach((dark, x) => dark && (d += `M${x + 4} ${y + 4}h1v1h-1z`)));
  path.setAttribute('d', d);
  path.setAttribute('fill', '#000');
  svg.append(bg, path);
  container.replaceChildren(svg);
}

$('link-start').addEventListener('click', async () => {
  $('link-error').textContent = '';
  const server = readServer($('link-error'));
  if (!server) return;
  client.url = server;
  $('link-start').disabled = true;
  linking = client.linkAsNewDevice({
    deviceName: deviceName(),
    onCode: ({ code, qrText }) => {
      renderQr($('qr'), qrText);
      $('link-code').replaceChildren(...formatLinkCode(code).split('-').map((g) => el('span', '', g)));
      $('link-box').hidden = false;
      $('link-start').hidden = true;
    },
  });
  try {
    await linking.done;
    linking = null;
    await settings.set('server', server);
    await rememberAccount();
    await showApp();
    toast(t('Устройство привязано. Контакты перенесены, старая переписка — нет.'), 6000);
  } catch (err) {
    linking = null;
    resetLinkPane();
    if (err.code !== 'cancelled') {
      $('link-error').textContent =
        err.code === 'offline' ? t('Соединение прервано. Нажмите, чтобы получить новый код.') : err.message;
    }
  }
});
// ---------- Перенос переписки ----------
function backupStatus(text, bad = false) {
  $('backup-status').textContent = text;
  $('backup-status').classList.toggle('error', bad);
}
$('backup-export').addEventListener('click', async () => {
  const btn = $('backup-export');
  btn.disabled = true;
  backupStatus(t('Готовим файл…'));
  try {
    const r = await client.exportBackup();
    const saved = await saveBytes(r.name, 'application/octet-stream', r.bytes);
    backupStatus(saved ? t('Сохранено: {0} — чатов: {1}, сообщений: {2}', r.name, r.chats, r.messages) : '');
  } catch (err) {
    backupStatus(t('Не удалось экспортировать: {0}', err.message), true);
  } finally {
    btn.disabled = false;
  }
});
$('backup-import').addEventListener('click', () => {
  $('backup-file').value = '';
  $('backup-file').click();
});
$('backup-file').addEventListener('change', async () => {
  const f = $('backup-file').files?.[0];
  if (!f) return;
  $('backup-import').disabled = true;
  backupStatus(t('Импортируем…'));
  try {
    const r = await client.importBackup(new Uint8Array(await f.arrayBuffer()));
    backupStatus(r.messages || r.chats ? t('Готово: новых чатов — {0}, сообщений — {1}', r.chats, r.messages) : t('Всё из этого файла уже есть на устройстве'));
  } catch (err) {
    backupStatus(err.code === 'wrong_account' && err.user ? t('Это переписка аккаунта @{0}. Импортировать её можно только в него.', err.user) : err.message, true);
  } finally {
    $('backup-import').disabled = false;
  }
});
client.on('imported', async () => {
  await renderContacts();
  if (current) await renderChat();
});
/** Сохранить байты в файл: в Android — через приложение, иначе — обычной загрузкой. */
async function saveBytes(name, mime, bytes) {
  if (desktop?.saveFile) return !!(await desktop.saveFile(name, mime, bytes));
  const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return true;
}
$('link-copy').addEventListener('click', async () => {
  try {
    await copyText($('link-code').textContent);
    toast(t('Код скопирован'));
  } catch {
    toast(t('Не удалось скопировать — выделите код вручную'));
  }
});

// ---------- Контакты ----------
// Перерисовки идут подряд (contacts, status, presence, сообщения из очереди) и
// внутри ждут хранилище. Строим список целиком и применяем только последнюю
// перерисовку — иначе вызовы перемешиваются и в списке появляются дубли.
let contactsGen = 0;
let showArchive = false; // в списке — архив, а не обычные чаты
let folderId = null; // открытая папка (null — «Все чаты»)
try {
  folderId = localStorage.getItem('tainik:folder') || null;
} catch {}
let folderList = [];
async function renderContacts() {
  const gen = ++contactsGen;
  folderList = await client.folders();
  if (folderId && !folderList.some((f) => f.id === folderId)) folderId = null;
  const folder = folderList.find((f) => f.id === folderId) || null;
  // Удалённые чаты не показываем (ключ собеседника хранится — чат вернётся с новым сообщением).
  // Закреплённые — сверху (последний закреплённый — первым), остальные — по времени.
  const visible = Object.values(await client.contacts())
    .filter((c) => !c.hidden || c.username === current)
    .sort((a, b) => (b.top || 0) - (a.top || 0) || b.lastTs - a.lastTs);
  renderFolderTabs(visible);
  // Архив: отдельный список; в обычном — строка «Архив» сверху. В папке — только её чаты.
  const archived = visible.filter((c) => c.archived);
  if (showArchive && (!archived.length || folder)) showArchive = false;
  const all = folder ? visible.filter((c) => folder.chats.includes(c.username)) : visible.filter((c) => !!c.archived === showArchive);
  const lasts = [];
  for (const c of all) {
    const msgs = await client.messages(c.username);
    lasts.push(msgs[msgs.length - 1]);
    if (gen !== contactsGen) return;
  }
  if (gen !== contactsGen) return;
  const frag = document.createDocumentFragment();
  if (showArchive) {
    const li = el('li', 'archive-head');
    const b = el('button', 'archive-row');
    b.type = 'button';
    b.append(icon('back', 'archive-ico'), el('span', 'archive-title', t('Архив')));
    b.addEventListener('click', () => {
      showArchive = false;
      renderContacts();
    });
    li.append(b);
    frag.append(li);
  } else if (archived.length && !folder) {
    const li = el('li');
    const b = el('button', 'archive-row');
    b.type = 'button';
    const unread = archived.reduce((n, c) => n + (c.username !== current ? c.unread || 0 : 0), 0);
    const body = el('div', 'c-body');
    body.append(el('div', 'c-top', t('Архив')), el('div', 'c-preview', archived.map((c) => nameOf(c.username)).join(', ')));
    const av = el('span', 'avatar archive-av');
    av.append(icon('archive'));
    b.append(av, body);
    if (unread) b.append(el('span', 'badge muted-badge', String(unread)));
    b.addEventListener('click', () => {
      showArchive = true;
      renderContacts();
    });
    li.append(b);
    frag.append(li);
  }
  all.forEach((c, i) => {
    const li = el('li');
    const btn = el('button', c.username === current ? 'active' : '');
    const avWrap = el('span', 'avatar-wrap');
    const av = el('span', 'avatar with-frame');
    paintAvatar(av, c.username);
    avWrap.append(av);
    if (client.presenceOf(c.username)?.online) avWrap.append(el('span', 'online-dot'));
    const body = el('div', 'c-body');
    const top = el('div', 'c-top');
    const cn = el('span', 'c-name');
    setName(cn, c.username, client.isVerified(c.username));
    if (c.group) cn.prepend(icon('group', 'g-ico'));
    if (c.channel) cn.prepend(icon('channel', 'g-ico'));
    top.append(cn);
    if (client.isBlocked(c.username)) top.append(withIcon('shield warn', 'block', t('заблокирован')));
    else if (c.keyChanged) top.append(withIcon('shield warn', 'warning', t('ключ изменён')));
    else if (c.verified) top.append(withIcon('shield', 'check', t('проверен')));
    if (c.top) top.append(icon('pin', 'c-pin'));
    body.append(top, el('div', 'c-preview', previewOf(lasts[i])));
    btn.append(avWrap, body);
    if (c.unread && c.username !== current) btn.append(el('span', 'badge', String(c.unread)));
    btn.dataset.chat = c.username;
    btn.addEventListener('click', () => openChat(c.username));
    li.append(btn);
    frag.append(li);
  });
  $('contacts').replaceChildren(frag);
  $('no-contacts').hidden = visible.length > 0;
  $('folder-empty').hidden = !folder || all.length > 0;
  ownUnread = visible.reduce((n, c) => n + (c.unread || 0), 0);
  setUnread(ownUnread + othersUnread());
}

// ---------- Папки (вкладки под поиском) ----------
function renderFolderTabs(visible) {
  const box = $('folder-tabs');
  box.hidden = !folderList.length;
  if (!folderList.length) return box.replaceChildren();
  const unreadOf = (chats) => visible.reduce((n, c) => n + (chats.includes(c.username) && c.username !== current ? c.unread || 0 : 0), 0);
  const tab = (id, name, unread) => {
    const b = el('button', 'folder-tab' + ((folderId || null) === id ? ' on' : ''));
    b.type = 'button';
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', String((folderId || null) === id));
    b.append(el('span', '', name));
    if (unread) b.append(el('span', 'badge', String(unread)));
    if (id) b.dataset.folder = id;
    b.addEventListener('click', () => selectFolder(id));
    return b;
  };
  const add = el('button', 'folder-tab add', '＋');
  add.type = 'button';
  add.title = t('Новая папка');
  add.setAttribute('aria-label', t('Новая папка'));
  add.addEventListener('click', () => openFolderEdit(null));
  box.replaceChildren(tab(null, t('Все'), 0), ...folderList.map((f) => tab(f.id, f.name, unreadOf(f.chats))), add);
  box.querySelector('.on')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}
function selectFolder(id) {
  folderId = id;
  showArchive = false;
  try {
    if (id) localStorage.setItem('tainik:folder', id);
    else localStorage.removeItem('tainik:folder');
  } catch {}
  renderContacts();
}
// Правый клик или долгое нажатие на вкладку — изменить папку
$('folder-tabs').addEventListener('contextmenu', (e) => {
  const b = e.target.closest('[data-folder]');
  if (!b) return;
  e.preventDefault();
  openFolderEdit(b.dataset.folder);
});
let folderPress = null;
$('folder-tabs').addEventListener('touchstart', (e) => {
  const b = e.target.closest('[data-folder]');
  if (!b) return;
  folderPress = setTimeout(() => {
    folderPress = 'fired';
    openFolderEdit(b.dataset.folder);
  }, 500);
}, { passive: true });
for (const ev of ['touchend', 'touchmove', 'touchcancel']) {
  $('folder-tabs').addEventListener(ev, (e) => {
    if (folderPress === 'fired' && ev === 'touchend') e.preventDefault();
    clearTimeout(folderPress);
    folderPress = null;
  });
}

// Окно папки: название и какие чаты в ней (новая — id null)
let folderEditing = null;
async function openFolderEdit(id, preselect = null) {
  const f = folderList.find((x) => x.id === id) || null;
  folderEditing = id;
  $('fd-title').textContent = f ? t('Папка «{0}»', f.name) : t('Новая папка');
  $('fd-name').value = f ? f.name : '';
  $('fd-delete').hidden = !f;
  $('fd-error').textContent = '';
  const chosen = new Set(f ? f.chats : preselect ? [preselect] : []);
  const chats = Object.values(await client.contacts())
    .filter((c) => !c.hidden)
    .sort((a, b) => b.lastTs - a.lastTs);
  $('fd-list').replaceChildren(
    ...chats.map((c) => {
      const li = el('li');
      const label = el('label', 'pick');
      const cb = el('input');
      cb.type = 'checkbox';
      cb.value = c.username;
      cb.checked = chosen.has(c.username);
      const av = el('span', 'avatar');
      paintAvatar(av, c.username);
      label.append(cb, av, el('span', 'p-name', nameOf(c.username)));
      li.append(label);
      return li;
    })
  );
  $('folder-dialog').showModal();
  if (!f) $('fd-name').focus();
}
$('fd-cancel').addEventListener('click', () => $('folder-dialog').close());
$('fd-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('fd-name').value.trim();
  if (!name) return ($('fd-error').textContent = t('Введите название папки'));
  const chats = [...$('fd-list').querySelectorAll('input:checked')].map((x) => x.value);
  const list = folderList.map((f) => ({ ...f }));
  if (folderEditing) {
    const f = list.find((x) => x.id === folderEditing);
    if (f) Object.assign(f, { name, chats });
  } else {
    list.push({ id: Math.random().toString(36).slice(2, 12), name, chats });
  }
  try {
    const saved = await client.setFolders(list);
    $('folder-dialog').close();
    if (!folderEditing) selectFolder(saved[saved.length - 1]?.id || null);
  } catch (err) {
    $('fd-error').textContent = err.message;
  }
});
$('fd-delete').addEventListener('click', async () => {
  if (!folderEditing) return;
  await client.setFolders(folderList.filter((f) => f.id !== folderEditing));
  $('folder-dialog').close();
  toast(t('Папка удалена — чаты остались в списке'));
});
client.on('folders', () => renderContacts());

// Чат → папки: отметить, в каких папках он есть (или создать новую с ним)
let pickFoldersFor = null;
function openChatFolders(chat) {
  if (!folderList.length) return openFolderEdit(null, chat);
  pickFoldersFor = chat;
  $('cf-title').textContent = t('Папки для «{0}»', nameOf(chat));
  $('cf-list').replaceChildren(
    ...folderList.map((f) => {
      const li = el('li');
      const label = el('label', 'pick');
      const cb = el('input');
      cb.type = 'checkbox';
      cb.value = f.id;
      cb.checked = f.chats.includes(chat);
      label.append(cb, icon('folder'), el('span', 'p-name', f.name));
      li.append(label);
      return li;
    })
  );
  $('chat-folders-dialog').showModal();
}
$('cf-cancel').addEventListener('click', () => $('chat-folders-dialog').close());
$('cf-new').addEventListener('click', () => {
  $('chat-folders-dialog').close();
  openFolderEdit(null, pickFoldersFor);
});
$('cf-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const on = new Set([...$('cf-list').querySelectorAll('input:checked')].map((x) => x.value));
  const chat = pickFoldersFor;
  const list = folderList.map((f) => ({ ...f, chats: on.has(f.id) ? [...new Set([...f.chats, chat])] : f.chats.filter((c) => c !== chat) }));
  try {
    await client.setFolders(list);
    $('chat-folders-dialog').close();
  } catch (err) {
    toast(err.message);
  }
});

$('add-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('add-input').value.trim().replace(/^@/, '').toLowerCase();
  $('add-error').textContent = '';
  if (!name) return;
  try {
    const c = await client.addContact(name);
    $('add-input').value = '';
    await openChat(c.username);
  } catch (err) {
    $('add-error').textContent = ERROR_TEXT[err.message] || err.message;
  }
});

// ---------- Чат ----------
async function openChat(name) {
  if (current !== name) setReply(null);
  current = name;
  $('app').classList.add('in-chat');
  $('chat-empty').hidden = true;
  $('chat-view').hidden = false;
  await client.markRead(name);
  clearChatNotices(name);
  await renderChat();
  await renderContacts();
  // На телефоне не открываем клавиатуру сразу при входе в чат — только по нажатию на поле
  if (!touchUI()) $('text').focus();
}
/** Сенсорный экран без мыши (телефон, планшет): клавиатура экранная. */
const touchUI = () => matchMedia('(hover: none) and (pointer: coarse)').matches;

// Уведомления о сообщениях чата больше не нужны: он прочитан здесь или на другом устройстве
async function clearChatNotices(chat) {
  if (desktop?.dismissNotice) return desktop.dismissNotice({ chat });
  try {
    const reg = await navigator.serviceWorker?.getRegistration('/');
    for (const n of (await reg?.getNotifications({ tag: 'msg:' + chat })) || []) n.close();
  } catch {}
}
// ---------- Оформление: тема ----------
// Тему ставит theme.js (до отрисовки страницы); здесь — только выбор. Своя тема — позже.
const THEME_NAMES = [
  ['system', t('Как в системе')],
  ['light', t('Светлая')],
  ['dark', t('Тёмная')],
];
const theme = window.tainikTheme;
function renderThemes() {
  const cur = theme?.get().id || 'system';
  $('set-theme-value').textContent = THEME_NAMES.find(([id]) => id === cur)?.[1] || t('Своя');
  $('theme-list').replaceChildren(
    ...THEME_NAMES.map(([id, name]) => {
      const b = el('button', 'set-row set-radio');
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(id === cur));
      const ico = el('span', 'set-ico');
      ico.append(el('span', 'theme-swatch ' + id));
      const check = el('span', 'set-check');
      if (id === cur) check.append(icon('check'));
      b.append(ico, el('span', 'set-label', name), check);
      b.addEventListener('click', () => {
        theme?.set(id);
        renderThemes();
      });
      return b;
    })
  );
}
if (theme) renderThemes();
else $('menu-dialog').querySelector('[data-go="theme"]').hidden = true;

// ---------- Язык ----------
const LANGS = LANG_LIST;
{
  for (const [code, name] of LANGS) {
    const b = el('button', 'set-row set-radio');
    b.type = 'button';
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(code === LANG));
    const check = el('span', 'set-check');
    if (code === LANG) check.append(icon('check'));
    b.append(el('span', 'set-label', name), check);
    b.addEventListener('click', async () => {
      if (code === LANG) return;
      setLang(code);
      await settings.set('lang', code); // нативной части: трей, уведомления Android
      location.reload();
    });
    $('lang-list').append(b);
  }
  settings.set('lang', LANG);
}

client.on('read-sync', ({ contact, unread }) => {
  if (!unread) clearChatNotices(contact);
});

$('back-btn').addEventListener('click', () => {
  current = null;
  $('app').classList.remove('in-chat');
  $('chat-view').hidden = true;
  $('chat-empty').hidden = false;
  renderContacts();
});

async function renderHeader() {
  const c = (await client.contacts())[current];
  if (!c) return;
  setName($('peer-name'), c.username, client.isVerified(c.username));
  paintAvatar($('peer-avatar'), c.username);
  const v = $('peer-verify');
  const group = !!c.group || !!c.channel || !!c.system || !!c.support;
  // В группе и канале нет звонков, кода безопасности и статуса «в сети»
  for (const id of ['call-audio-btn', 'call-video-btn', 'safety-btn']) $(id).hidden = group;
  if (group) {
    v.className = 'peer-verify';
    v.textContent = c.system ? t('служебные уведомления') : c.support ? t('ответит администратор сервера') : c.channel ? channelSubText(c.channel) : membersText(c.group);
    $('peer-presence').textContent = '';
    $('key-banner').hidden = true;
    updateComposer(c);
    return;
  }
  if (c.keyChanged) {
    v.className = 'peer-verify bad';
    iconText(v, 'warning', t('ключ изменился — сверьте код'));
  } else if (c.verified) {
    v.className = 'peer-verify ok';
    iconText(v, 'check', t('ключ проверен'));
  } else {
    v.className = 'peer-verify';
    iconText(v, 'lock', t('ключ не проверен'));
  }
  renderPresence();
  $('key-banner').hidden = !c.keyChanged;
  updateComposer(c);
}

// ---------- Статус собеседника ----------
const hmFmt = new Intl.DateTimeFormat(LOCALE, { hour: '2-digit', minute: '2-digit' });
const dmFmt = new Intl.DateTimeFormat(LOCALE, { day: 'numeric', month: 'short' });
function presenceText(p) {
  if (!p) return '';
  if (p.online) return t('в сети');
  if (p.hidden || !p.lastSeen) return t('был(а) недавно');
  const diff = Date.now() - p.lastSeen;
  const min = Math.floor(diff / 60000);
  if (min < 1) return t('был(а) только что');
  if (min < 60) return t('был(а) {0} мин. назад', min);
  const d = new Date(p.lastSeen);
  const today = new Date();
  const y = new Date(Date.now() - 86400000);
  if (d.toDateString() === today.toDateString()) return t('был(а) сегодня в {0}', hmFmt.format(d));
  if (d.toDateString() === y.toDateString()) return t('был(а) вчера в {0}', hmFmt.format(d));
  return t('был(а) {0}', dmFmt.format(d));
}
function renderPresence() {
  if (!current || isGroupChat(current) || isChannelChat(current) || isSystemChat(current) || isSupportChat(current)) return;
  const p = client.presenceOf(current);
  const node = $('peer-presence');
  node.textContent = client.status === 'online' ? presenceText(p) : '';
  node.classList.toggle('online', !!p?.online);
}
setInterval(renderPresence, 30_000);

async function updateComposer(c) {
  if (!current) return;
  if (!c) c = (await client.contacts())[current];
  // Заблокировали собеседника — вместо поля ввода полоска «Разблокировать»
  const iBlocked = client.isBlocked(current);
  const left = !!c?.group?.left; // исключили или вышли из группы — писать нельзя
  $('blocked-bar').hidden = !iBlocked;
  $('composer').hidden = iBlocked;
  if (iBlocked) setReply(null);
  // Канал: пишут только владелец и администраторы, у остальных — полоска «О канале»
  const ch = c?.channel;
  const chReader = !!ch && !isChAdmin(ch);
  const system = !!c?.system; // «Тайник»: только читать
  $('channel-bar').hidden = !chReader && !system;
  $('channel-bar-btn').hidden = system;
  if (chReader) {
    $('composer').hidden = true;
    if (ch.gone) $('channel-bar-text').textContent = t('Канал удалён или вы больше не подписаны');
    else iconText($('channel-bar-text'), 'channel', t('Вы читаете канал'));
    $('channel-bar-btn').textContent = ch.gone ? t('Удалить чат') : t('О канале');
  } else if (system) {
    $('composer').hidden = true;
    setReply(null);
    $('channel-bar-text').textContent = t('Служебные уведомления Тайника. Отвечать на них не нужно.');
  }
  const blocked = !c || !!c.keyChanged || iBlocked || left || chReader || system;
  $('send-btn').disabled = blocked || client.status !== 'online';
  $('attach-btn').disabled = blocked || client.status !== 'online';
  // Поддержка: только текст — без вложений, голосовых и видеосообщений
  const support = !!c?.support;
  $('attach-btn').disabled ||= support;
  const noCall = blocked || client.status !== 'online' || !window.RTCPeerConnection;
  $('call-audio-btn').disabled = noCall;
  $('call-video-btn').disabled = noCall;
  $('text').disabled = blocked;
  $('text').placeholder = ch ? (client.status === 'online' ? t('Пост в канал') : t('Нет связи')) : left ? t('Вы не участник этой группы') : blocked ? t('Отправка остановлена: ключ изменился') : client.status === 'online' ? t('Сообщение') : t('Нет связи — сообщение уйдёт позже');
  if (!blocked) $('send-btn').disabled = !$('text').value.trim();
  // Пустое поле — вместо «Отправить» кнопки записи голосового и видеосообщения
  const empty = !$('text').value.trim();
  $('send-btn').hidden = empty && REC_OK;
  $('voice-btn').hidden = !empty || !REC_OK || support;
  $('note-btn').hidden = !empty || !NOTE_OK || support;
  if (support && empty) $('send-btn').hidden = false;
  $('voice-btn').disabled = $('note-btn').disabled = blocked || client.status !== 'online';
}

const REJECT_TEXT = {
  identity_mismatch: t('Сообщение отклонено: ключ отправителя не совпадает с проверенным'),
  unknown_spk: t('Не удалось расшифровать: сообщение слишком старое (ключ уже удалён)'),
  no_session: t('Не удалось расшифровать: нет сессии. Попросите собеседника написать ещё раз'),
};
// Копирование в буфер. Вызывать сразу в обработчике нажатия, до любых await: иначе браузер
// (особенно Safari и WebView) считает, что нажатия уже не было, и молча отказывает.
const msgText = new Map(); // id → текст показанных сообщений: копирование без ожидания базы
function copyText(text) {
  text = String(text ?? '');
  if (window.desktop?.copyText?.(text)) return Promise.resolve();
  // Старый способ срабатывает синхронно и там, где navigator.clipboard недоступен
  const prev = document.activeElement;
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;font-size:16px';
  document.body.append(ta);
  ta.focus({ preventScroll: true });
  ta.select();
  ta.setSelectionRange(0, text.length);
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {}
  ta.remove();
  if (prev instanceof HTMLElement && prev !== document.body) prev.focus({ preventScroll: true });
  if (ok) return Promise.resolve();
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);
  return Promise.reject(new Error('clipboard'));
}
// Текст со ссылками: только узлы DOM (никакого innerHTML), ссылки — http(s)
function linkNodes(parent, text) {
  for (const p of linkify(text)) {
    if (!p.href) {
      parent.append(document.createTextNode(p.text));
      continue;
    }
    const a = el('a', 'lnk', p.text);
    a.href = p.href;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    if (p.ch) a.dataset.ch = p.href;
    parent.append(a);
  }
  return parent;
}
// Ссылка на канал Тайника открывается внутри приложения, остальные — в браузере
document.addEventListener('click', (e) => {
  const a = e.target.closest?.('a.lnk');
  if (!a) return;
  e.stopPropagation();
  if (a.dataset.ch && client.account) {
    e.preventDefault();
    openChannels(a.dataset.ch.slice(a.dataset.ch.indexOf('#ch=')));
  }
});

function messageNode(m) {
  if (m.dir === 'sys' && m.content?.t === 'call') {
    const li = el('li', 'msg sys call' + (m.content.result === 'missed' ? ' missed' : ''));
    li.append(el('div', 'bubble', `${callText(m.content)} · ${timeFmt.format(new Date(m.ts))}`));
    return li;
  }
  if (m.dir === 'sys' && m.content?.t === 'gift') {
    const li = el('li', 'msg sys gift');
    li.append(el('div', 'bubble', giftText(m.content)));
    return li;
  }
  if (m.dir === 'sys' && m.content?.t === 'group') {
    const li = el('li', 'msg sys group');
    li.append(el('div', 'bubble', groupEventText(m.content)));
    return li;
  }
  if (m.dir === 'sys') {
    const bad = m.content.t === 'rejected';
    const text = bad
      ? REJECT_TEXT[m.content.reason] || t('Сообщение отклонено: не удалось подтвердить его подлинность')
      : t('Вы приняли новый ключ собеседника. Сверьте код безопасности.');
    const li = el('li', 'msg sys' + (bad ? ' bad' : ''));
    li.append(el('div', 'bubble', text));
    return li;
  }
  const li = el('li', `msg ${m.dir}${m.status === 'failed' ? ' failed' : ''}`);
  li.dataset.id = m.id;
  msgText.set(m.id, m.content?.t === 'notice' ? noticeText(m.content) : m.content?.body ?? '');
  const bubble = el('div', 'bubble');
  // В группе — кто написал (нажатие открывает профиль участника)
  if (m.dir === 'in' && m.from) {
    const f = el('button', 'from', nameOf(m.from));
    f.type = 'button';
    f.dataset.act = 'from';
    f.dataset.user = m.from;
    f.style.color = `hsl(${hue(m.from)} 55% 42%)`;
    bubble.append(f);
  }
  const r = m.content?.reply;
  if (r) {
    const q = el('button', 'quote');
    q.type = 'button';
    q.dataset.target = r.id;
    const label = r.kind ? [kindLabel(r), r.body].filter(Boolean).join(' · ') : r.body || t('Сообщение');
    q.append(el('b', '', r.from === client.account.username ? t('Вы') : nameOf(r.from)), el('span', '', label));
    bubble.append(q);
  }
  if (m.content?.fwd) bubble.append(el('div', 'fwd', t('Переслано от {0}', m.content.fwd)));
  if (m.content?.t === 'file' && m.content.file) {
    bubble.classList.add('has-media');
    if (m.content.file.as === 'note') bubble.classList.add('has-note');
    bubble.append(mediaNode(m.content.file));
    if (m.content.body) bubble.append(linkNodes(el('div', 'caption'), m.content.body));
  } else if (m.content?.t === 'notice') {
    bubble.classList.add('notice');
    linkNodes(bubble, noticeText(m.content));
  } else {
    linkNodes(bubble, m.content?.body ?? '');
  }
  li.append(bubble);
  const acts = el('div', 'msg-actions');
  const noReply = isChannelChat(current) || isSystemChat(current) || isSupportChat(current);
  if (noReply) li.classList.add('post'); // пост канала и уведомление «Тайника»: без ответа
  const rb = el('button');
  rb.append(icon('reply'));
  rb.type = 'button';
  rb.dataset.act = 'reply';
  rb.title = t('Ответить');
  rb.setAttribute('aria-label', t('Ответить'));
  const mb = el('button');
  mb.append(icon('more-h'));
  mb.type = 'button';
  mb.dataset.act = 'menu';
  mb.title = t('Ещё');
  mb.setAttribute('aria-label', t('Действия с сообщением'));
  if (noReply) acts.append(mb);
  else acts.append(rb, mb);
  li.append(acts);
  const meta = el('div', 'meta');
  meta.append(el('span', '', timeFmt.format(new Date(m.ts))));
  if (m.dir === 'out') {
    const st = el('span', 'st');
    setStatusIcon(st, m.status);
    meta.append(st);
  }
  li.append(meta);
  return li;
}

// ---------- Закреплённое сообщение и пересылка ----------
async function renderPin() {
  if (!current) return;
  const c = (await client.contacts())[current];
  const id = c?.pinned?.id;
  const m = id && (await client.messages(current)).find((x) => x.id === id);
  $('pin-bar').hidden = !id;
  if (!id) return;
  $('pin-body').textContent = m ? textOf(m.content).replace(/\s+/g, ' ').slice(0, 120) || t('Сообщение') : t('Сообщение удалено');
}
$('pin-open').addEventListener('click', async () => {
  const id = (await client.contacts())[current]?.pinned?.id;
  const target = id && $('messages').querySelector(`.msg[data-id="${CSS.escape(id)}"]`);
  if (!target) return toast(t('Сообщение удалено'));
  target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  target.classList.remove('flash');
  void target.offsetWidth;
  target.classList.add('flash');
});
$('pin-close').addEventListener('click', () => current && client.pinMessage(current, null).catch((err) => toast(err.message)));
client.on('pinned', ({ chat }) => chat === current && renderPin());

let forwardIds = null;
async function openForward(id) {
  forwardIds = { chat: current, ids: [id] };
  $('fw-search').value = '';
  await renderForward();
  $('forward-dialog').showModal();
  if (!('ontouchstart' in window)) $('fw-search').focus();
}
async function renderForward() {
  const q = $('fw-search').value.trim().toLowerCase();
  const list = Object.values(await client.contacts())
    .filter((c) => !c.hidden && !c.keyChanged && !client.isBlocked(c.username))
    .filter((c) => !c.group?.left && (!c.channel || isChAdmin(c.channel)))
    .filter((c) => !q || nameOf(c.username).toLowerCase().includes(q) || c.username.includes(q))
    .sort((a, b) => b.lastTs - a.lastTs);
  $('fw-empty').hidden = list.length > 0;
  $('fw-list').replaceChildren(
    ...list.map((c) => {
      const li = el('li');
      const b = el('button', 'fw-item');
      b.type = 'button';
      const av = el('span', 'avatar');
      paintAvatar(av, c.username);
      const body = el('div', 'm-body');
      const nm = el('span', 'm-name');
      setName(nm, c.username, client.isVerified(c.username));
      if (c.group) nm.prepend(icon('group', 'g-ico'));
      if (c.channel) nm.prepend(icon('channel', 'g-ico'));
      body.append(nm, el('span', 'm-sub', c.group || c.channel ? '' : '@' + c.username));
      b.append(av, body);
      b.addEventListener('click', () => doForward(c.username));
      li.append(b);
      return li;
    })
  );
}
$('fw-search').addEventListener('input', renderForward);
$('fw-close').addEventListener('click', () => $('forward-dialog').close());
async function doForward(target) {
  const f = forwardIds;
  if (!f) return;
  $('forward-dialog').close();
  try {
    const all = await client.messages(f.chat);
    const msgs = f.ids.map((id) => all.find((m) => m.id === id)).filter(Boolean);
    await client.forwardMessages(target, msgs, f.chat);
    if (target !== current) toast(t('Переслано: {0}', nameOf(target)));
  } catch (err) {
    toast(err.message);
  }
}

let chatGen = 0;
async function renderChat() {
  if (!current) return;
  const gen = ++chatGen;
  await renderHeader();
  const list = await client.messages(current);
  const ch = isChannelChat(current) ? await client.channelOf(current) : null;
  if (gen !== chatGen) return;
  renderPin();
  const ol = $('messages');
  const note = isSystemChat(current)
    ? t('ℹ️ Сообщения от сервера Тайника: о монетах, Премиуме и безопасности вашего аккаунта')
    : isSupportChat(current)
    ? t('⚠ Чат поддержки не защищён сквозным шифрованием: ваши сообщения читает администратор сервера. Не отправляйте сюда пароли и секреты.')
    : ch
    ? ch.public
      ? t('📢 Публичный канал: посты может прочитать любой, кто его найдёт')
      : t('🔒 Посты зашифрованы ключом канала: прочитать их может только тот, у кого есть ссылка-приглашение')
    : t('🔒 Сообщения в этом чате защищены сквозным шифрованием');
  msgText.clear();
  ol.replaceChildren(el('li', 'e2e-note', note));
  let lastDay = '';
  for (const m of list) {
    const d = dayLabel(m.ts);
    if (d !== lastDay) {
      ol.append(el('li', 'day', d));
      lastDay = d;
    }
    ol.append(messageNode(m));
  }
  for (const up of uploads) if (up.chat === current) ol.append(uploadNode(up));
  ol.scrollTop = ol.scrollHeight;
}

// Ввод
const ta = $('text');
ta.addEventListener('input', () => {
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight, 160) + 'px';
  updateComposer();
});
ta.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && reply) {
    e.preventDefault();
    return setReply(null);
  }
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    $('composer').requestSubmit();
  }
});
$('composer').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = ta.value;
  if (!text.trim() || !current) return;
  if (text.length > 20000) return toast(t('Слишком длинное сообщение'));
  ta.value = '';
  ta.style.height = 'auto';
  const replyTo = reply?.id || null;
  setReply(null);
  try {
    await client.sendText(current, text, { replyTo });
  } catch (err) {
    ta.value = text;
    toast(err.message);
  }
  updateComposer();
});

// ---------- Вложения ----------
// Файл шифруется здесь, на сервер уходит только шифротекст (см. shared/media.js).
// Расшифрованные файлы живут только в памяти этой страницы (blob:), на диск не пишутся.
const AUTO_LOAD = 8 * 1024 * 1024; // фото до 8 МБ скачиваются сами при показе чата
const MEDIA_CACHE = 300 * 1024 * 1024;
const MAX_PICK = 10;
const media = new Map(); // id → { blob, url } | { promise }
let mediaBytes = 0;

function putMedia(id, blob) {
  const entry = { blob, url: URL.createObjectURL(blob) };
  media.set(id, entry);
  mediaBytes += blob.size;
  // Самые давние — из памяти (Map хранит порядок добавления)
  for (const [k, v] of media) {
    if (mediaBytes <= MEDIA_CACHE || k === id) break;
    if (!v.url) continue;
    URL.revokeObjectURL(v.url);
    mediaBytes -= v.blob.size;
    media.delete(k);
  }
  return entry;
}

/** Тип для blob: — только тот, что можно показать; остальное — просто байты. */
const blobType = (f) => (f.kind !== 'file' && kindOf(f.mime) === f.kind ? f.mime : 'application/octet-stream');

function mediaProgress(id, p) {
  for (const n of document.querySelectorAll(`[data-media-id="${CSS.escape(id)}"]`)) {
    n.classList.add('loading');
    n.style.setProperty('--p', String(Math.round(p * 100)));
  }
}

/** Скачать и расшифровать вложение (один раз — дальше из памяти). */
function loadMedia(f) {
  const e = media.get(f.id);
  if (e?.url) {
    media.delete(f.id); // свежий — в конец очереди
    media.set(f.id, e);
    return Promise.resolve(e);
  }
  if (e?.promise) return e.promise;
  const promise = client
    .fetchFile(f, { onProgress: (p) => mediaProgress(f.id, p) })
    .then((bytes) => putMedia(f.id, new Blob([bytes], { type: blobType(f) })))
    .catch((err) => {
      media.delete(f.id);
      throw err;
    })
    .finally(() => {
      for (const n of document.querySelectorAll(`[data-media-id="${CSS.escape(f.id)}"]`)) n.classList.remove('loading');
    });
  media.set(f.id, { promise });
  return promise;
}

function fmtClock(sec) {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Размер превью в ленте: не больше 300×320, не меньше 120 по ширине. */
function fitBox(node, w, h) {
  if (!w || !h) return;
  const k = Math.min(1, 300 / w, 320 / h);
  node.style.width = Math.max(120, Math.round(w * k)) + 'px';
  node.style.aspectRatio = `${w} / ${h}`;
}

function mediaNode(f) {
  if (f.as === 'voice') return voiceNode(f);
  if (f.as === 'note') return noteNode(f);
  if (f.kind === 'image' || f.kind === 'video') {
    const box = el('button', 'media ' + f.kind);
    box.type = 'button';
    box.dataset.act = 'open';
    box.dataset.mediaId = f.id;
    box.setAttribute('aria-label', `${KIND_LABEL[f.kind]}: ${f.name}, ${sizeText(f.size)}`);
    fitBox(box, f.w, f.h);
    if (f.thumb) {
      const th = el('img', 'thumb');
      th.alt = '';
      th.src = f.thumb;
      box.append(th);
    }
    if (f.kind === 'image') {
      const full = el('img', 'full');
      full.alt = f.name;
      full.hidden = true;
      box.append(full);
      const show = ({ url }) => {
        full.onload = () => ((full.hidden = false), box.classList.add('loaded'));
        full.onerror = () => box.classList.add('broken');
        full.src = url;
      };
      const cached = media.get(f.id);
      if (cached?.url) show(cached);
      else if (f.size <= AUTO_LOAD) loadMedia(f).then(show, () => box.classList.add('broken'));
    } else {
      box.append(el('span', 'play', '▶'));
      box.append(el('span', 'media-meta', [f.dur ? fmtClock(f.dur) : '', sizeText(f.size)].filter(Boolean).join(' · ')));
    }
    box.append(el('span', 'ring'));
    return box;
  }
  const card = el('button', 'file-card');
  card.type = 'button';
  card.dataset.act = 'open';
  card.dataset.mediaId = f.id;
  card.title = t('Скачать');
  const info = el('span', 'file-info');
  info.append(el('span', 'file-name', f.name), el('span', 'file-size', sizeText(f.size)));
  card.append(icon(f.kind === 'audio' ? 'music' : 'file', 'file-icon'), info, el('span', 'ring'));
  return card;
}

// Просмотр
let viewing = null;
function closeViewer() {
  viewing = null;
  for (const v of $('viewer-body').querySelectorAll('video, audio')) v.pause();
  $('viewer-body').replaceChildren();
  if ($('viewer').open) $('viewer').close();
}
$('viewer-close').addEventListener('click', closeViewer);
$('viewer').addEventListener('close', () => viewing && closeViewer());
$('viewer').addEventListener('click', (e) => e.target === $('viewer-body') && closeViewer());
$('viewer-save').addEventListener('click', () => viewing && saveMedia(viewing));

/** Фото профиля на весь экран (большое, если владелец его прислал). */
async function openPhoto(username) {
  const photo = username && (await client.photoOf(username));
  if (!photo) return;
  viewing = null;
  $('viewer-save').hidden = true;
  $('viewer-name').textContent = nameOf(username);
  const img = el('img', 'viewer-photo');
  img.alt = t('Фото профиля');
  img.src = photo; // только проверенный data:-URL (validPhoto / validAvatar)
  $('viewer-body').replaceChildren(img);
  if (!$('viewer').open) $('viewer').showModal();
}
// Нажатие на фото в профиле собеседника и в своём профиле
$('pf-avatar').addEventListener('click', () => openPhoto(profileFor));
$('prof-avatar').addEventListener('click', () => pendingAvatar === undefined && openPhoto(client.account?.username));
for (const id of ['pf-avatar', 'prof-avatar']) {
  $(id).addEventListener('keydown', (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), $(id).click()));
}

async function openMedia(id) {
  const m = await findMsg(id);
  const f = m?.content?.file;
  if (!f) return;
  if (f.kind === 'file') return saveMedia(f);
  viewing = f;
  $('viewer-save').hidden = false;
  $('viewer-name').textContent = `${f.name} · ${sizeText(f.size)}`;
  const body = $('viewer-body');
  const wait = el('div', 'viewer-wait');
  wait.dataset.mediaId = f.id;
  wait.append(el('span', 'ring'), el('span', '', t('Расшифровываем…')));
  body.replaceChildren(wait);
  if (!$('viewer').open) $('viewer').showModal();
  let entry;
  try {
    entry = await loadMedia(f);
  } catch (err) {
    if (viewing === f) body.replaceChildren(el('p', 'viewer-error', err.message));
    return;
  }
  if (viewing !== f) return;
  let node;
  if (f.kind === 'image') {
    node = el('img');
    node.alt = f.name;
  } else {
    node = el(f.kind === 'video' ? 'video' : 'audio');
    node.controls = true;
    node.autoplay = true;
    node.playsInline = true;
    node.onerror = () => body.replaceChildren(el('p', 'viewer-error', t('Это устройство не может воспроизвести файл. Сохраните его и откройте в другом приложении.')));
  }
  node.src = entry.url;
  body.replaceChildren(node);
}

async function saveMedia(f) {
  let entry;
  try {
    entry = await loadMedia(f);
  } catch (err) {
    return toast(err.message);
  }
  if (desktop?.saveFile) {
    // Android: WebView не скачивает blob:-ссылки — передаём файл приложению
    try {
      if (await desktop.saveFile(f.name, f.mime, new Uint8Array(await entry.blob.arrayBuffer()))) toast(t('Файл сохранён'));
    } catch (err) {
      toast(t('Не удалось сохранить файл: {0}', err.message));
    }
    return;
  }
  const a = document.createElement('a');
  a.href = entry.url;
  a.download = f.name;
  a.rel = 'noopener';
  document.body.append(a);
  a.click();
  a.remove();
}

// Подготовка файла: размеры, длительность, крошечное превью (уходит внутри сообщения)
function thumbOf(src, w, h) {
  const k = Math.min(1, 160 / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * k));
  c.height = Math.max(1, Math.round(h * k));
  c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
  for (const q of [0.6, 0.45, 0.3]) {
    const d = c.toDataURL('image/jpeg', q);
    if (d.length <= THUMB_MAX) return d;
  }
  return undefined;
}

function videoInfo(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const v = document.createElement('video');
    v.muted = true;
    v.playsInline = true;
    v.preload = 'metadata';
    const done = (r) => {
      clearTimeout(timer);
      v.removeAttribute('src');
      v.load();
      URL.revokeObjectURL(url);
      resolve(r);
    };
    const timer = setTimeout(() => done({}), 8000);
    v.onloadedmetadata = () => {
      v.currentTime = Math.min(0.5, (v.duration || 0) / 2);
    };
    v.onseeked = () => {
      const w = v.videoWidth;
      const h = v.videoHeight;
      let thumb;
      try {
        thumb = w && h ? thumbOf(v, w, h) : undefined;
      } catch {}
      done({ w, h, dur: Number.isFinite(v.duration) ? Math.round(v.duration) : undefined, thumb });
    };
    v.onerror = () => done({});
    v.src = url;
  });
}

async function describeFile(file) {
  const mime = String(file.type || 'application/octet-stream').toLowerCase();
  const meta = { name: file.name || 'file', mime, kind: kindOf(mime) };
  try {
    if (meta.kind === 'image') {
      const bmp = await createImageBitmap(file);
      Object.assign(meta, { w: bmp.width, h: bmp.height, thumb: thumbOf(bmp, bmp.width, bmp.height) });
      bmp.close();
    } else if (meta.kind === 'video') {
      Object.assign(meta, await videoInfo(file));
    }
  } catch {
    if (meta.kind === 'image') meta.kind = 'file'; // браузер не смог открыть картинку — отправим как файл
  }
  return meta;
}

// Загрузки: по очереди, в ленте — «пузырь» с ходом загрузки и кнопкой отмены
const uploads = [];
let uploadChain = Promise.resolve();
let upSeq = 0;

function uploadNode(up) {
  const li = el('li', 'msg out uploading');
  li.dataset.up = up.key;
  const bubble = el('div', 'bubble has-media');
  if (up.preview) {
    const box = el('div', 'media ' + up.kind + (up.as === 'note' ? ' note' : ''));
    if (up.as !== 'note') fitBox(box, up.w, up.h);
    const img = el('img', 'full');
    img.alt = '';
    img.src = up.preview;
    box.append(img);
    bubble.append(box);
  } else {
    const card = el('div', 'file-card');
    const info = el('span', 'file-info');
    info.append(el('span', 'file-name', up.name), el('span', 'file-size', sizeText(up.size)));
    card.append(icon(up.as === 'voice' ? 'mic' : 'file', 'file-icon'), info);
    bubble.append(card);
  }
  const bar = el('div', 'up-bar');
  const fill = el('span', 'up-fill');
  fill.style.width = Math.round(up.progress * 100) + '%';
  const x = el('button', 'up-cancel');
  x.append(icon('close'));
  x.type = 'button';
  x.dataset.act = 'cancel-upload';
  x.dataset.up = up.key;
  x.title = t('Отменить');
  x.setAttribute('aria-label', t('Отменить загрузку'));
  const label = el('span', 'up-text', up.started ? t('Загрузка {0}%', Math.round(up.progress * 100)) : t('В очереди'));
  bar.append(fill);
  bubble.append(bar);
  const row = el('div', 'up-row');
  row.append(label, x);
  bubble.append(row);
  li.append(bubble);
  return li;
}

function updateUpload(up) {
  const node = $('messages').querySelector(`.msg.uploading[data-up="${up.key}"]`);
  if (!node) return;
  node.querySelector('.up-fill').style.width = Math.round(up.progress * 100) + '%';
  node.querySelector('.up-text').textContent = t('Загрузка {0}%', Math.round(up.progress * 100));
}

function dropUpload(up) {
  const i = uploads.indexOf(up);
  if (i >= 0) uploads.splice(i, 1);
  $('messages').querySelector(`.msg.uploading[data-up="${up.key}"]`)?.remove();
  if (up.preview?.startsWith('blob:')) URL.revokeObjectURL(up.preview);
}

function cancelUpload(key) {
  const up = uploads.find((u) => u.key === key);
  if (!up) return;
  up.ctrl.abort();
  dropUpload(up);
}

function queueFile(chat, file, caption, replyTo, preset = null) {
  const kind = kindOf(String(file.type || '').toLowerCase());
  const up = { key: 'u' + ++upSeq, chat, name: file.name || 'file', size: file.size, kind, progress: 0, started: false, ctrl: new AbortController() };
  if (kind === 'image') up.preview = URL.createObjectURL(file);
  // Записанное в чате: голосовое — карточкой, видеосообщение — квадратом с первым кадром
  if (preset?.as) Object.assign(up, { as: preset.as, name: AS_LABEL[preset.as], preview: preset.thumb, w: preset.w, h: preset.h });
  uploads.push(up);
  if (chat === current) {
    $('messages').append(uploadNode(up));
    $('messages').scrollTop = $('messages').scrollHeight;
  }
  uploadChain = uploadChain.then(async () => {
    if (up.ctrl.signal.aborted) return;
    try {
      const meta = preset || (await describeFile(file));
      Object.assign(up, { w: meta.w, h: meta.h, started: true });
      if (chat === current) $('messages').querySelector(`.msg.uploading[data-up="${up.key}"]`)?.replaceWith(uploadNode(up));
      await client.sendFile(chat, file, meta, {
        caption,
        replyTo,
        signal: up.ctrl.signal,
        onProgress: (p) => ((up.progress = p), updateUpload(up)),
        // Свой файл не скачиваем обратно — он уже есть на этом устройстве
        onReady: (f) => {
          if (f.size <= MEDIA_CACHE / 4) putMedia(f.id, file.slice(0, file.size, blobType(f)));
          dropUpload(up);
        },
      });
    } catch (err) {
      if (err.code !== 'cancelled') toast(`${up.name}: ${err.message}`, 6000);
    } finally {
      dropUpload(up);
    }
  });
}

// Выбор файлов: кнопка, вставка из буфера, перетаскивание
let picked = [];
function clearPicked() {
  for (const p of picked) if (p.url) URL.revokeObjectURL(p.url);
  picked = [];
  $('attach-list').replaceChildren();
}

// Тип файла по первым байтам. На Android файл из галереи часто приходит без типа (и без
// расширения в имени) — тогда фото и видео ушли бы обычными файлами.
const EXT_OF = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp', 'image/avif': 'avif', 'image/heic': 'heic', 'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm', 'video/3gpp': '3gp', 'audio/mp4': 'm4a', 'audio/mpeg': 'mp3', 'audio/ogg': 'ogg' };
const TYPE_OF_EXT = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', heic: 'image/heic', heif: 'image/heic', mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', '3gp': 'video/3gpp', m4a: 'audio/mp4', mp3: 'audio/mpeg', ogg: 'audio/ogg', opus: 'audio/ogg' };
async function sniffType(file) {
  let b;
  try {
    b = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  } catch {
    return null;
  }
  const str = (from, to) => String.fromCharCode(...b.subarray(from, to));
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (str(0, 8) === '\x89PNG\r\n\x1a\n') return 'image/png';
  if (str(0, 4) === 'GIF8') return 'image/gif';
  if (str(0, 4) === 'RIFF' && str(8, 12) === 'WEBP') return 'image/webp';
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'video/webm';
  if (str(0, 4) === 'OggS') return 'audio/ogg';
  if (str(0, 3) === 'ID3') return 'audio/mpeg';
  if (str(4, 8) === 'ftyp') {
    const brand = str(8, 12);
    if (brand === 'avif' || brand === 'avis') return 'image/avif';
    if (['heic', 'heix', 'hevc', 'heim', 'heis', 'mif1', 'msf1'].includes(brand)) return 'image/heic';
    if (brand === 'qt  ') return 'video/quicktime';
    if (brand === 'M4A ') return 'audio/mp4';
    if (brand.startsWith('3g')) return 'video/3gpp';
    return 'video/mp4';
  }
  return null;
}
/** HEIC (фото многих телефонов) браузеры показать не умеют — пробуем перевести в JPEG. */
async function heicToJpeg(file) {
  let bmp;
  try {
    bmp = await createImageBitmap(file);
    const c = document.createElement('canvas');
    c.width = bmp.width;
    c.height = bmp.height;
    c.getContext('2d').drawImage(bmp, 0, 0);
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.9));
    if (!blob) return null;
    return new File([blob], file.name.replace(/\.(heic|heif)$/i, '') + '.jpg', { type: 'image/jpeg', lastModified: file.lastModified });
  } catch {
    return null;
  } finally {
    bmp?.close?.();
  }
}
/** Файл с правильным типом (и расширением в имени): фото и видео — медиа, а не «файл». */
async function withRealType(file) {
  let type = String(file.type || '').toLowerCase();
  // Нет типа, общий тип или нестандартный («image/jpg» у некоторых галерей) — смотрим в сам файл
  if (kindOf(type) === 'file') {
    const ext = /\.([a-z0-9]{2,5})$/i.exec(file.name || '')?.[1]?.toLowerCase();
    const sniffed = await sniffType(file);
    if (sniffed) type = sniffed;
    else if (!type || type === 'application/octet-stream') type = TYPE_OF_EXT[ext] || type;
  }
  if (type === 'image/heif') type = 'image/heic';
  if (type !== 'image/heic' && type === file.type && /\.[a-z0-9]{2,5}$/i.test(file.name || '')) return file;
  let name = file.name || 'file';
  if (EXT_OF[type] && !/\.[a-z0-9]{2,5}$/i.test(name)) name += '.' + EXT_OF[type];
  const fixed = new File([file], name, { type, lastModified: file.lastModified });
  if (type === 'image/heic') return (await heicToJpeg(fixed)) || fixed;
  return fixed;
}

async function pickFiles(list) {
  if (!current || !client.account) return;
  let files = [...list].filter((f) => f.size > 0);
  if (files.length < list.length) toast(ERROR_TEXT.bad_size);
  if (!files.length) return;
  if (files.length > MAX_PICK) {
    toast(t('За один раз — не больше {0} файлов', MAX_PICK));
    files = files.slice(0, MAX_PICK);
  }
  files = await Promise.all(files.map(withRealType));
  clearPicked();
  picked = files.map((file) => ({ file, url: kindOf(String(file.type).toLowerCase()) === 'image' ? URL.createObjectURL(file) : null }));
  for (const p of picked) {
    const li = el('li', 'attach-item');
    if (p.url) {
      const img = el('img');
      img.alt = '';
      img.src = p.url;
      li.append(img);
    } else li.append(icon('file', 'file-icon'));
    const info = el('span', 'file-info');
    info.append(el('span', 'file-name', p.file.name || 'file'), el('span', 'file-size', sizeText(p.file.size)));
    li.append(info);
    $('attach-list').append(li);
  }
  $('attach-title').textContent = files.length === 1 ? t('Отправить файл') : t('Отправить файлы: {0}', files.length);
  $('attach-caption').value = ta.value;
  $('attach-dialog').returnValue = '';
  $('attach-dialog').showModal();
  $('attach-caption').focus();
}

// ---------- Скрепка: меню вложений, как в Telegram ----------
// По умолчанию — галерея. На Android — последние фото и видео телефона прямо в меню (с разрешения),
// в остальных версиях — кнопка системного выбора фото. Вкладка «Файлы» — любой файл.
const gallery = desktop?.gallery || null;
const asSel = []; // выбранные в галерее id (по порядку выбора)
let asItems = new Map(); // id → описание
let asLoading = false;
let asDone = false;
function openAttachSheet() {
  if ($('attach-btn').disabled) return;
  asSel.length = 0;
  asTab('gallery');
  if (!$('attach-sheet').open) $('attach-sheet').showModal();
  fillGallery(true);
}
function closeAttachSheet() {
  if ($('attach-sheet').open) $('attach-sheet').close();
}
function asTab(tab) {
  for (const b of document.querySelectorAll('#attach-sheet [data-as-tab]')) {
    b.classList.toggle('active', b.dataset.asTab === tab);
    b.setAttribute('aria-selected', String(b.dataset.asTab === tab));
  }
  $('as-gallery').hidden = tab !== 'gallery';
  $('as-files').hidden = tab !== 'files';
  updateAsSend();
}
for (const b of document.querySelectorAll('#attach-sheet [data-as-tab]')) b.addEventListener('click', () => asTab(b.dataset.asTab));
// Нажатие на затемнение вокруг меню закрывает его
$('attach-sheet').addEventListener('click', (e) => e.target === $('attach-sheet') && closeAttachSheet());
// Свайп вниз закрывает меню: за «ручку» сверху или по галерее, прокрученной до начала
{
  const sheet = $('attach-sheet');
  let drag = null;
  sheet.addEventListener('touchstart', (e) => {
    drag = null;
    if (e.touches.length !== 1) return;
    const grid = e.target.closest('.as-grid');
    if (grid && grid.scrollTop > 0) return;
    drag = { y: e.touches[0].clientY, x: e.touches[0].clientX, dy: 0, t: Date.now() };
  }, { passive: true });
  sheet.addEventListener('touchmove', (e) => {
    if (!drag) return;
    const dy = e.touches[0].clientY - drag.y;
    if (dy < 0 || Math.abs(e.touches[0].clientX - drag.x) > dy) return;
    drag.dy = dy;
    sheet.style.transition = 'none';
    sheet.style.transform = `translateY(${dy}px)`;
    if (e.cancelable && dy > 8) e.preventDefault(); // не прокручивать галерею, пока тянем меню
  }, { passive: false });
  sheet.addEventListener('touchend', () => {
    if (!drag) return;
    const { dy, t: t0 } = drag;
    drag = null;
    sheet.style.transition = 'transform .18s ease-out';
    const fast = dy > 40 && Date.now() - t0 < 250;
    if (dy > 110 || fast) {
      sheet.style.transform = 'translateY(100%)';
      setTimeout(() => {
        closeAttachSheet();
        sheet.style.transform = '';
        sheet.style.transition = '';
      }, 170);
    } else sheet.style.transform = '';
  });
}

async function fillGallery(reset) {
  const grid = $('as-grid');
  let access = 'none';
  if (gallery) {
    try {
      access = await gallery.access();
    } catch {}
  }
  if (access === 'none') {
    grid.hidden = true;
    $('as-gallery-empty').hidden = false;
    $('as-gallery-allow').hidden = !gallery;
    $('as-gallery-text').textContent = gallery
      ? t('Разрешите доступ к фото и видео — и последние снимки будут прямо здесь.')
      : t('Выберите фото и видео — они отправятся с превью, как в галерее.');
    return;
  }
  $('as-gallery-empty').hidden = true;
  grid.hidden = false;
  if (reset) {
    asItems = new Map();
    asDone = false;
    grid.replaceChildren(galleryTile('camera', 'camera', t('Камера')), galleryTile('more', 'image', t('Все фото')));
  }
  await loadGalleryPage();
}
function galleryTile(act, ico, label) {
  const b = el('button', 'as-cell as-action');
  b.type = 'button';
  b.dataset.asAct = act;
  b.append(icon(ico, 'as-action-ico'), el('span', 'as-action-label', label));
  return b;
}
async function loadGalleryPage() {
  if (asLoading || asDone || !gallery) return;
  asLoading = true;
  try {
    const last = [...asItems.values()].at(-1);
    const list = await gallery.list(60, last ? last.ts : 0);
    if (!Array.isArray(list) || list.length < 60) asDone = true;
    const grid = $('as-grid');
    for (const it of list || []) {
      if (asItems.has(it.id)) continue;
      asItems.set(it.id, it);
      const b = el('button', 'as-cell');
      b.type = 'button';
      b.dataset.id = it.id;
      b.setAttribute('aria-label', it.kind === 'video' ? t('Видео') : t('Фото'));
      const img = el('img');
      img.alt = '';
      img.loading = 'lazy';
      img.src = '/__gallery/thumb/' + it.id;
      b.append(img);
      if (it.kind === 'video') b.append(el('span', 'as-dur', fmtClock(it.dur || 0)));
      b.append(el('span', 'as-check'));
      grid.append(b);
    }
    paintAsSelection();
  } catch (err) {
    console.warn('gallery', err);
  } finally {
    asLoading = false;
  }
}
$('as-grid').addEventListener('scroll', () => {
  const g = $('as-grid');
  if (g.scrollTop + g.clientHeight > g.scrollHeight - 400) loadGalleryPage();
});
$('as-grid').addEventListener('click', (e) => {
  const b = e.target.closest('.as-cell');
  if (!b) return;
  if (b.dataset.asAct === 'camera') return $('camera-input').click();
  if (b.dataset.asAct === 'more') return $('media-input').click();
  const id = b.dataset.id;
  const i = asSel.indexOf(id);
  if (i >= 0) asSel.splice(i, 1);
  else if (asSel.length < MAX_PICK) asSel.push(id);
  else toast(t('За один раз — не больше {0} файлов', MAX_PICK));
  paintAsSelection();
});
function paintAsSelection() {
  for (const b of $('as-grid').querySelectorAll('.as-cell[data-id]')) {
    const n = asSel.indexOf(b.dataset.id);
    b.classList.toggle('selected', n >= 0);
    b.querySelector('.as-check').textContent = n >= 0 ? String(n + 1) : '';
  }
  updateAsSend();
}
function updateAsSend() {
  const show = asSel.length > 0 && !$('as-gallery').hidden;
  $('as-send-bar').hidden = !show;
  $('as-send').textContent = t('Отправить ({0})', asSel.length);
}
$('as-send').addEventListener('click', async () => {
  const ids = [...asSel];
  if (!ids.length) return;
  $('as-send').disabled = true;
  try {
    // Файлы целиком — с адреса самого приложения (их отдаёт Android из галереи)
    const files = [];
    for (const id of ids) {
      const it = asItems.get(id);
      const r = await fetch('/__gallery/file/' + id);
      if (!r.ok) throw new Error(t('Не удалось открыть файл из галереи'));
      const blob = await r.blob();
      files.push(new File([blob], it?.name || id, { type: it?.mime || blob.type || '' }));
    }
    closeAttachSheet();
    pickFiles(files);
  } catch (err) {
    toast(err.message);
  } finally {
    $('as-send').disabled = false;
  }
});
$('as-gallery-allow').addEventListener('click', async () => {
  try {
    const access = await gallery.ask();
    if (access === 'none') toast(t('Без доступа к галерее фото можно выбрать кнопкой ниже'));
  } catch {}
  fillGallery(true);
});
$('as-gallery-pick').addEventListener('click', () => $('media-input').click());
$('as-camera').addEventListener('click', () => $('camera-input').click());
$('as-files-pick').addEventListener('click', () => $('file-input').click());

$('attach-btn').addEventListener('click', openAttachSheet);
for (const id of ['file-input', 'media-input', 'camera-input']) {
  $(id).addEventListener('change', (e) => {
    const files = [...(e.target.files || [])];
    e.target.value = '';
    if (!files.length) return;
    closeAttachSheet();
    pickFiles(files);
  });
}
ta.addEventListener('paste', (e) => {
  const files = [...(e.clipboardData?.files || [])];
  if (!files.length || $('attach-btn').disabled) return;
  e.preventDefault();
  pickFiles(files);
});
$('attach-caption').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    $('attach-dialog').close('send');
  }
});
$('attach-dialog').addEventListener('close', () => {
  const files = picked.map((p) => p.file);
  clearPicked();
  if ($('attach-dialog').returnValue !== 'send' || !current || !files.length) return;
  const caption = $('attach-caption').value.trim();
  if (caption === ta.value.trim()) {
    ta.value = '';
    ta.style.height = 'auto';
  }
  const replyId = reply?.id || null;
  setReply(null);
  // Подпись и ответ — у первого файла, как в Telegram
  files.forEach((file, i) => queueFile(current, file, i === 0 ? caption : '', i === 0 ? replyId : null));
  updateComposer();
});

let dragDepth = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
$('chat-view').addEventListener('dragenter', (e) => {
  if (!hasFiles(e) || $('attach-btn').disabled) return;
  e.preventDefault();
  dragDepth++;
  $('drop-hint').hidden = false;
});
$('chat-view').addEventListener('dragover', (e) => {
  if (!hasFiles(e) || $('attach-btn').disabled) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
});
$('chat-view').addEventListener('dragleave', () => {
  if (--dragDepth <= 0) (dragDepth = 0), ($('drop-hint').hidden = true);
});
$('chat-view').addEventListener('drop', (e) => {
  dragDepth = 0;
  $('drop-hint').hidden = true;
  if (!hasFiles(e) || $('attach-btn').disabled) return;
  e.preventDefault();
  pickFiles(e.dataTransfer.files);
});
// Файл, брошенный мимо чата, браузер открыл бы вместо мессенджера
window.addEventListener('dragover', (e) => hasFiles(e) && e.preventDefault());
window.addEventListener('drop', (e) => hasFiles(e) && e.preventDefault());

// ---------- Голосовые и видеосообщения ----------
// Запись прямо в чате: голос — до 5 минут, видео — квадрат 384×384 с фронтальной камеры
// до минуты. Отправляются как обычные зашифрованные вложения с пометкой as: 'voice' | 'note'
// (и волной громкости для голосового) — см. cleanFile в shared/media.js.
const VOICE_MAX = 300;
const NOTE_MAX = 60;
const NOTE_SIZE = 384;
const WAVE_BARS = 64;
const AUDIO_TYPES = ['audio/mp4;codecs=mp4a.40.2', 'audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus', 'audio/webm'];
const VIDEO_TYPES = ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4;codecs=avc1,mp4a.40.2', 'video/webm;codecs=vp8,opus', 'video/mp4', 'video/webm'];
const pickType = (list) => list.find((m) => MediaRecorder.isTypeSupported?.(m)) || '';
const EXT = { 'audio/mp4': 'm4a', 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'video/mp4': 'mp4', 'video/webm': 'webm' };
let rec = null;

function encodeWave(levels) {
  if (!levels.length) return undefined;
  const out = new Uint8Array(Math.min(WAVE_BARS, levels.length));
  for (let i = 0; i < out.length; i++) {
    const a = Math.floor((i * levels.length) / out.length);
    const b = Math.max(a + 1, Math.floor(((i + 1) * levels.length) / out.length));
    out[i] = Math.max(...levels.slice(a, b));
  }
  const max = Math.max(...out) || 1;
  for (let i = 0; i < out.length; i++) out[i] = Math.round((out[i] / max) * 255);
  return btoa(String.fromCharCode(...out));
}
function decodeWave(b64, n = 40) {
  let bytes = [];
  try {
    bytes = [...atob(b64 || '')].map((c) => c.charCodeAt(0));
  } catch {}
  if (!bytes.length) return Array(n).fill(0.15);
  return Array.from({ length: n }, (_, i) => Math.max(0.12, bytes[Math.floor((i * bytes.length) / n)] / 255));
}

function drawRecWave(r) {
  const c = $('rec-wave');
  const w = (c.width = Math.round(c.clientWidth * devicePixelRatio) || 300);
  const h = (c.height = Math.round(c.clientHeight * devicePixelRatio) || 36);
  const g = c.getContext('2d');
  g.clearRect(0, 0, w, h);
  g.fillStyle = getComputedStyle(c).color;
  const step = 5 * devicePixelRatio;
  const n = Math.floor(w / step);
  const tail = r.levels.slice(-n);
  tail.forEach((v, i) => {
    const bh = Math.max(2 * devicePixelRatio, (v / 255) * h);
    g.fillRect(w - (tail.length - i) * step, (h - bh) / 2, 3 * devicePixelRatio, bh);
  });
}

function recTick(r) {
  if (rec !== r) return;
  if (current !== r.chat) return stopRec(false); // ушли в другой чат — запись отменяется
  const sec = (performance.now() - r.t0) / 1000;
  const max = r.as === 'note' ? NOTE_MAX : VOICE_MAX;
  $('rec-time').textContent = fmtClock(Math.floor(sec));
  if (r.an) {
    const buf = new Uint8Array(r.an.fftSize);
    r.an.getByteTimeDomainData(buf);
    let sum = 0;
    for (const v of buf) sum += (v - 128) ** 2;
    r.levels.push(Math.min(255, Math.round(Math.sqrt(sum / buf.length) * 6)));
    if (r.as === 'voice') drawRecWave(r);
  }
  if (r.as === 'note') {
    $('note-preview').style.setProperty('--p', String(Math.min(100, (sec / max) * 100)));
    if (!r.thumb && sec > 0.4) {
      try {
        r.thumb = thumbOf(r.canvas, NOTE_SIZE, NOTE_SIZE);
      } catch {}
    }
  }
  if (sec >= max) stopRec(true);
}

/** Вид поля ввода во время записи: удержание (подсказка, замок) или закреплённая запись (✕, ➤). */
function showRec(r) {
  const c = $('composer');
  c.classList.toggle('recording', !!r);
  c.classList.toggle('locked', !!r?.locked);
  c.classList.toggle('starting', !!r && !r.t0);
  c.classList.toggle('rec-note', r?.as === 'note');
  for (const id of ['voice-btn', 'note-btn']) $(id).classList.toggle('active', !!r && id === (r.as === 'note' ? 'note-btn' : 'voice-btn'));
  $('rec-hint').textContent = t('‹ Влево — отмена');
  if (r && !r.locked) {
    const b = $(r.as === 'note' ? 'note-btn' : 'voice-btn');
    $('rec-lock').style.left = b.offsetLeft + (b.offsetWidth - 40) / 2 + 'px';
    $('rec-lock').style.setProperty('--dy', '0');
  }
  $('note-preview').hidden = r?.as !== 'note';
  if (!r) {
    $('note-preview').style.setProperty('--p', '0');
    $('note-video').srcObject = null;
    $('note-flip').hidden = true;
    $('rec-time').textContent = '0:00';
    updateComposer();
  }
}

/** Закрепить запись: дальше палец можно убрать, отправка — кнопкой ➤. */
function lockRec() {
  if (!rec || rec.locked) return;
  rec.locked = true;
  hold = null;
  showRec(rec);
  navigator.vibrate?.(15);
}

function releaseRec(r) {
  clearInterval(r.tick);
  clearInterval(r.draw);
  r.stream?.getTracks().forEach((tr) => tr.stop());
  r.canvasStream?.getTracks().forEach((tr) => tr.stop());
  r.ac?.close().catch(() => {});
}

async function startRec(as, locked = false) {
  if (rec || !current || !client.account || $(as === 'note' ? 'note-btn' : 'voice-btn').disabled) return;
  if (!REC_OK || (as === 'note' && !NOTE_OK)) return toast(t('Это устройство не умеет записывать сообщения'));
  stopPlay();
  const r = { as, chat: current, levels: [], chunks: [], t0: 0, locked, facing: 'user' };
  rec = r;
  showRec(r);
  try {
    const audio = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
    if (audioPrefs.mic) audio.deviceId = { ideal: audioPrefs.mic };
    const video = as === 'note' ? { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 640 } } : false;
    r.stream = await navigator.mediaDevices.getUserMedia({ audio, video });
  } catch (err) {
    releaseRec(r);
    if (rec === r) (rec = null), showRec(null);
    const denied = err?.name === 'NotAllowedError' || err?.name === 'SecurityError';
    return toast(denied ? (as === 'note' ? t('Нет доступа к камере или микрофону') : t('Нет доступа к микрофону')) : t('Не удалось начать запись: {0}', err?.message || err), 6000);
  }
  if (rec !== r) return releaseRec(r); // отменили, пока ждали разрешения
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC) {
      r.ac = new AC();
      r.an = r.ac.createAnalyser();
      r.an.fftSize = 1024;
      r.ac.createMediaStreamSource(r.stream).connect(r.an);
      r.ac.resume?.().catch(() => {});
    }
  } catch {}
  let tracks = r.stream.getAudioTracks();
  if (as === 'note') {
    const v = $('note-video');
    v.srcObject = r.stream;
    $('note-preview').classList.add('mirror');
    await v.play().catch(() => {});
    navigator.mediaDevices.enumerateDevices().then((list) => {
      r.cams = list.filter((d) => d.kind === 'videoinput');
      if (rec === r) $('note-flip').hidden = r.cams.length < 2;
    }, () => {});
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = NOTE_SIZE;
    const g = canvas.getContext('2d');
    const draw = () => {
      const vw = v.videoWidth;
      const vh = v.videoHeight;
      if (!vw || !vh) return;
      const side = Math.min(vw, vh); // квадрат из середины кадра
      g.drawImage(v, (vw - side) / 2, (vh - side) / 2, side, side, 0, 0, NOTE_SIZE, NOTE_SIZE);
    };
    draw();
    r.draw = setInterval(draw, 1000 / 30);
    r.canvas = canvas;
    r.canvasStream = canvas.captureStream(30);
    tracks = [...r.canvasStream.getVideoTracks(), ...tracks];
  }
  const type = pickType(as === 'note' ? VIDEO_TYPES : AUDIO_TYPES);
  try {
    const opts = { audioBitsPerSecond: as === 'note' ? 64_000 : 48_000 };
    if (type) opts.mimeType = type;
    if (as === 'note') opts.videoBitsPerSecond = 900_000;
    r.mr = new MediaRecorder(new MediaStream(tracks), opts);
  } catch (err) {
    releaseRec(r);
    rec = null;
    showRec(null);
    return toast(t('Не удалось начать запись: {0}', err?.message || err), 6000);
  }
  r.mr.ondataavailable = (e) => e.data?.size && r.chunks.push(e.data);
  r.mr.onstop = () => finishRec(r);
  r.mr.start(1000);
  r.t0 = performance.now();
  $('composer').classList.remove('starting');
  r.tick = setInterval(() => recTick(r), 100);
}

/** Закончить запись: send — отправить, иначе выбросить. */
function stopRec(send) {
  const r = rec;
  if (!r) return;
  rec = null;
  r.send = send;
  r.dur = r.t0 ? (performance.now() - r.t0) / 1000 : 0;
  r.replyTo = reply?.id || null;
  if (send) setReply(null);
  showRec(null);
  clearInterval(r.tick);
  if (r.mr && r.mr.state !== 'inactive') {
    try {
      r.mr.requestData?.();
    } catch {}
    r.mr.stop(); // finishRec — по событию stop, когда придут последние данные
  } else finishRec(r);
}

function finishRec(r) {
  releaseRec(r);
  if (!r.send) return;
  if (r.dur < 1 || !r.chunks.length) return toast(t('Слишком короткая запись'));
  const type = String(r.mr?.mimeType || r.chunks[0]?.type || (r.as === 'note' ? 'video/webm' : 'audio/webm')).split(';')[0].trim().toLowerCase();
  const blob = new Blob(r.chunks, { type });
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');
  const name = `${r.as === 'note' ? 'video' : 'voice'}-${stamp}.${EXT[type] || (r.as === 'note' ? 'mp4' : 'm4a')}`;
  const file = new File([blob], name, { type });
  const meta = { name, mime: type, kind: r.as === 'note' ? 'video' : 'audio', as: r.as, dur: Math.max(1, Math.round(r.dur)) };
  if (r.as === 'voice') meta.wave = encodeWave(r.levels);
  else Object.assign(meta, { w: NOTE_SIZE, h: NOTE_SIZE, thumb: r.thumb });
  queueFile(r.chat, file, '', r.replyTo, meta);
}

/** Сменить камеру во время видеосообщения: передняя ↔ задняя (на компьютере — следующая по списку). */
async function flipCamera() {
  const r = rec;
  if (!r || r.as !== 'note' || r.flipping || !r.stream) return;
  r.flipping = true;
  $('note-flip').disabled = true;
  const old = r.stream.getVideoTracks()[0];
  const size = { width: { ideal: 640 }, height: { ideal: 640 } };
  let next = null;
  let facing = r.facing;
  try {
    // На телефоне — по направлению камеры; где его нет (компьютер) — по списку устройств
    if (old?.getSettings?.().facingMode) {
      facing = r.facing === 'user' ? 'environment' : 'user';
      old.stop(); // некоторые телефоны не открывают вторую камеру, пока занята первая
      next = await navigator.mediaDevices.getUserMedia({ video: { ...size, facingMode: { exact: facing } } });
    } else if (r.cams?.length > 1) {
      const i = r.cams.findIndex((c) => c.deviceId === old?.getSettings?.().deviceId);
      const cam = r.cams[(i + 1) % r.cams.length];
      next = await navigator.mediaDevices.getUserMedia({ video: { ...size, deviceId: { exact: cam.deviceId } } });
      facing = facing === 'user' ? 'environment' : 'user';
    }
  } catch {
    // Не получилось — пробуем вернуть прежнюю камеру
    try {
      if (old?.readyState === 'ended') next = await navigator.mediaDevices.getUserMedia({ video: { ...size, facingMode: r.facing } });
    } catch {}
    facing = r.facing;
    if (!next) toast(t('Не удалось переключить камеру'));
  }
  r.flipping = false;
  $('note-flip').disabled = false;
  if (!next) return;
  if (rec !== r) return next.getTracks().forEach((tr) => tr.stop());
  const track = next.getVideoTracks()[0];
  if (old && old !== track) {
    old.stop();
    r.stream.removeTrack(old);
  }
  r.stream.addTrack(track);
  r.facing = track.getSettings?.().facingMode || facing;
  $('note-preview').classList.toggle('mirror', r.facing !== 'environment');
  const v = $('note-video');
  v.srcObject = new MediaStream(r.stream.getVideoTracks());
  v.play().catch(() => {});
}

// Удержание кнопки: отпустили — отправить, потянули вверх — закрепить, влево — отменить.
// С клавиатуры (Enter/Пробел) запись сразу закреплённая.
const LOCK_DY = 70;
const CANCEL_DX = 110;
let hold = null; // { id: pointerId, x0, y0, t0 }

function onRecDown(e, as) {
  if (e.button !== 0 || rec || e.currentTarget.disabled) return;
  e.preventDefault();
  hold = { id: e.pointerId, x0: e.clientX, y0: e.clientY, t0: performance.now() };
  try {
    e.currentTarget.setPointerCapture(e.pointerId);
  } catch {}
  startRec(as);
}
function onRecMove(e) {
  if (!hold || e.pointerId !== hold.id || !rec) return;
  const dy = Math.max(0, hold.y0 - e.clientY);
  const dx = Math.max(0, hold.x0 - e.clientX);
  $('rec-lock').style.setProperty('--dy', String(Math.min(dy, LOCK_DY)));
  $('rec-hint').style.transform = `translateX(${-Math.min(dx, CANCEL_DX)}px)`;
  $('rec-hint').style.opacity = String(1 - Math.min(dx, CANCEL_DX) / CANCEL_DX / 1.5);
  if (dy >= LOCK_DY && dy > dx) lockRec();
  else if (dx >= CANCEL_DX && dx > dy) {
    hold = null;
    stopRec(false);
  }
}
function onRecUp(e) {
  if (!hold || e.pointerId !== hold.id) return;
  const short = performance.now() - hold.t0 < 400;
  hold = null;
  $('rec-hint').style.transform = '';
  $('rec-hint').style.opacity = '';
  if (!rec || rec.locked) return;
  if (e.type === 'pointercancel') return lockRec(); // жест перехватила система — не теряем запись
  if (short) {
    stopRec(false);
    return toast(t('Удерживайте кнопку, чтобы записать. Потяните вверх — запись закрепится'), 4000);
  }
  stopRec(true);
}
for (const [id, as] of [['voice-btn', 'voice'], ['note-btn', 'note']]) {
  const b = $(id);
  b.addEventListener('pointerdown', (e) => onRecDown(e, as));
  b.addEventListener('contextmenu', (e) => e.preventDefault()); // долгое нажатие на Android
  b.addEventListener('keydown', (e) => {
    if ((e.key !== 'Enter' && e.key !== ' ') || e.repeat) return;
    e.preventDefault();
    e.stopPropagation(); // иначе тот же Enter сразу отправит запись
    startRec(as, true);
  });
}
window.addEventListener('pointermove', onRecMove);
window.addEventListener('pointerup', onRecUp);
window.addEventListener('pointercancel', onRecUp);
$('rec-cancel').addEventListener('click', () => stopRec(false));
$('rec-send').addEventListener('click', () => stopRec(true));
$('note-flip').addEventListener('click', flipCamera);
document.addEventListener('keydown', (e) => {
  if (!rec) return;
  if (e.key === 'Escape') (e.preventDefault(), stopRec(false));
  else if (e.key === 'Enter' && !e.isComposing && rec.locked && e.target.id !== 'note-flip' && e.target.id !== 'rec-cancel') (e.preventDefault(), stopRec(true));
});

// Воспроизведение в ленте: одно сообщение за раз
let playing = null; // { id: сообщение, f: вложение, el: <audio>/<video>, raf }

function voiceNode(f) {
  const box = el('div', 'voice');
  box.dataset.mediaId = f.id;
  const btn = el('button', 'vplay');
  btn.append(icon('play'));
  btn.type = 'button';
  btn.dataset.act = 'vplay';
  btn.setAttribute('aria-label', t('Воспроизвести голосовое сообщение'));
  const wave = el('span', 'vwave');
  wave.append(...decodeWave(f.wave).map((v) => {
    const i = el('i');
    i.style.height = Math.round(v * 100) + '%';
    return i;
  }));
  const body = el('span', 'vbody');
  body.append(wave, el('span', 'vtime', fmtClock(f.dur || 0)));
  box.append(btn, body);
  if (playing?.f.id === f.id) requestAnimationFrame(paintPlay);
  return box;
}

function noteNode(f) {
  const box = el('button', 'media video note');
  box.type = 'button';
  box.dataset.act = 'vplay';
  box.dataset.mediaId = f.id;
  box.setAttribute('aria-label', `${AS_LABEL.note}, ${fmtClock(f.dur || 0)}`);
  if (f.thumb) {
    const th = el('img', 'thumb');
    th.alt = '';
    th.src = f.thumb;
    box.append(th);
  }
  const seek = el('span', 'note-seek'); // полоска перемотки — видна во время воспроизведения
  seek.append(el('span', 'note-bar'));
  box.append(el('span', 'play', '▶'), el('span', 'media-meta', fmtClock(f.dur || 0)), seek, el('span', 'ring'));
  if (playing?.f.id === f.id) requestAnimationFrame(paintPlay);
  return box;
}

const playNodes = (id) => document.querySelectorAll(`#messages [data-media-id="${CSS.escape(id)}"]`);

function paintPlay() {
  const p = playing;
  if (!p) return;
  const d = durOf(p);
  const frac = Math.min(1, p.el.currentTime / d);
  for (const n of playNodes(p.f.id)) {
    n.classList.toggle('playing', p.f.as === 'note' || !p.el.paused);
    n.classList.toggle('paused', p.el.paused);
    if (p.f.as === 'voice') {
      n.querySelector('.vplay').replaceChildren(icon(p.el.paused ? 'play' : 'pause'));
      const bars = n.querySelectorAll('.vwave i');
      bars.forEach((b, i) => b.classList.toggle('on', i < frac * bars.length));
      n.querySelector('.vtime').textContent = `${fmtClock(p.el.currentTime)} / ${fmtClock(p.f.dur || d)}`;
    } else {
      n.style.setProperty('--pos', String(frac * 100));
      n.querySelector('.media-meta').textContent = fmtClock(p.el.currentTime);
      if (p.el.parentNode !== n) n.prepend(p.el); // ленту перерисовали — переносим видео в новый узел
    }
  }
  if (!p.el.paused) p.raf = requestAnimationFrame(paintPlay);
}

function resetPlayNodes(p) {
  for (const n of playNodes(p.f.id)) {
    n.classList.remove('playing', 'paused');
    if (p.f.as === 'voice') {
      n.querySelector('.vplay').replaceChildren(icon('play'));
      n.querySelectorAll('.vwave i').forEach((b) => b.classList.remove('on'));
      n.querySelector('.vtime').textContent = fmtClock(p.f.dur || 0);
    } else {
      n.style.setProperty('--pos', '0');
      n.querySelector('.media-meta').textContent = fmtClock(p.f.dur || 0);
    }
  }
}

/** Длительность: у записей webm браузер узнаёт её не сразу — до этого берём из описания. */
const durOf = (p) => (Number.isFinite(p.el.duration) && p.el.duration > 0 ? p.el.duration : p.f.dur || 1);

/** Перемотка на долю frac (0…1); если файл ещё грузится — после загрузки. */
function seekTo(p, frac) {
  if (p.el.readyState >= 1) p.el.currentTime = Math.min(frac * durOf(p), Math.max(0, durOf(p) - 0.05));
  else p.pendingAt = frac;
  paintPlay();
}

function stopPlay() {
  const p = playing;
  if (!p) return;
  playing = null;
  cancelAnimationFrame(p.raf);
  p.el.pause();
  p.el.remove();
  p.el.removeAttribute('src');
  resetPlayNodes(p);
}

async function togglePlay(id, at = null) {
  if (rec) return;
  if (playing?.id === id && playing.el) {
    if (at !== null) return seekTo(playing, at); // перемотка не меняет «пауза/играет»
    if (playing.el.paused) playing.el.play().catch(() => {});
    else playing.el.pause();
    return;
  }
  stopPlay();
  const m = await findMsg(id);
  const f = m?.content?.file;
  if (!f) return;
  const node = document.createElement(f.as === 'note' ? 'video' : 'audio');
  node.playsInline = true;
  const p = { id, f, el: node, raf: 0 };
  playing = p;
  let entry;
  try {
    entry = await loadMedia(f);
  } catch (err) {
    if (playing === p) playing = null;
    return toast(err.message);
  }
  if (playing !== p) return;
  if (audioPrefs.speaker && node.setSinkId) node.setSinkId(audioPrefs.speaker).catch(() => {});
  node.onplay = () => ((p.raf = requestAnimationFrame(paintPlay)), paintPlay());
  node.onpause = paintPlay;
  node.onended = () => playing === p && stopPlay();
  node.onerror = () => {
    if (playing === p) stopPlay();
    toast(t('Это устройство не может воспроизвести файл. Сохраните его и откройте в другом приложении.'), 6000);
  };
  node.src = entry.url;
  if (at !== null) p.pendingAt = at;
  node.addEventListener('loadedmetadata', () => p.pendingAt != null && (seekTo(p, p.pendingAt), (p.pendingAt = null)), { once: true });
  node.onseeked = paintPlay;
  if (f.as === 'note') playNodes(f.id)[0]?.prepend(node);
  node.play().catch(() => {});
}

// Перемотка: нажать или вести пальцем по волне голосового / по полоске видеосообщения
$('messages').addEventListener('pointerdown', (e) => {
  const bar = e.target.closest('.vwave, .note-seek');
  if (!bar || e.button !== 0) return;
  const id = msgId(bar);
  if (!id) return;
  e.preventDefault();
  e.stopPropagation();
  const rect = bar.getBoundingClientRect();
  const frac = (ev) => Math.min(1, Math.max(0, (ev.clientX - rect.left) / rect.width));
  try {
    bar.setPointerCapture(e.pointerId);
  } catch {}
  togglePlay(id, frac(e));
  let raf = 0;
  const move = (ev) => {
    if (ev.pointerId !== e.pointerId) return;
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => playing?.id === id && seekTo(playing, frac(ev)));
  };
  const up = (ev) => {
    if (ev.pointerId !== e.pointerId) return;
    bar.removeEventListener('pointermove', move);
    bar.removeEventListener('pointerup', up);
    bar.removeEventListener('pointercancel', up);
  };
  bar.addEventListener('pointermove', move);
  bar.addEventListener('pointerup', up);
  bar.addEventListener('pointercancel', up);
});

// ---------- Код безопасности ----------
async function openSafety() {
  const code = await client.safetyNumber(current);
  $('sd-peer').textContent = nameOf(current);
  const box = $('sd-code');
  box.replaceChildren(...code.map((g) => el('span', '', g)));
  const c = (await client.contacts())[current];
  $('sd-verify').hidden = !!c.keyChanged;
  $('safety-dialog').showModal();
}
$('safety-btn').addEventListener('click', openSafety);
$('banner-check').addEventListener('click', openSafety);
$('safety-dialog').addEventListener('close', async () => {
  if ($('safety-dialog').returnValue === 'verify' && current) {
    await client.markVerified(current, true);
    toast(t('Отмечено как проверенный'));
  }
});
$('banner-accept').addEventListener('click', async () => {
  if (!confirm(t('Принять новый ключ? Делайте это, только если собеседник подтвердил, что переустановил мессенджер.'))) return;
  await client.acceptNewKey(current);
  await renderChat();
});

// ---------- Меню ----------
// ---------- Настройки: главный экран и разделы ----------
let setPage = 'main';
function showSetPage(name) {
  const page = document.querySelector(`#menu-dialog .set-page[data-page="${name}"]`);
  if (!page) return;
  setPage = name;
  for (const p of document.querySelectorAll('#menu-dialog .set-page')) p.hidden = p !== page;
  $('set-title').textContent = name === 'main' ? t('Настройки') : t(page.dataset.title);
  $('set-back').hidden = name === 'main';
  if (name === 'blocked') renderBlocked();
  if (name === 'profile') fillProfileEdit();
  if (name === 'premium') fillPremium();
  if (name === 'coins') fillCoins();
  if (name === 'shop') fillShop();
  if (name === 'media') openMediaPage();
  if (name === 'proxy') fillProxy();
  else stopMicMeter();
  page.scrollTop = 0;
  $('menu-dialog').querySelector('.settings-form').scrollTop = 0;
}
/** Назад из раздела; false — уже на главном экране. */
function setBack() {
  if (setPage === 'main') return false;
  const parent = document.querySelector(`#menu-dialog .set-page[data-page="${setPage}"]`)?.dataset.parent || 'main';
  showSetPage(parent);
  return true;
}
$('set-back').addEventListener('click', setBack);
$('menu-dialog').addEventListener('click', (e) => {
  const go = e.target.closest('[data-go]');
  if (go) showSetPage(go.dataset.go);
});
// Esc в разделе — на шаг назад, а не закрыть настройки (keydown: событие cancel браузер
// разрешает отменить только раз подряд)
$('menu-dialog').addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && setPage !== 'main') {
    e.preventDefault();
    setBack();
  }
});
$('menu-dialog').addEventListener('cancel', (e) => {
  if (setBack()) e.preventDefault();
});

async function fillSettings() {
  $('my-fp').textContent = await client.myFingerprint();
  $('my-server').textContent = client.url;
  renderPresenceToggle();
  $('get-apps-row').hidden = !!desktop; // в вебе — ссылка на загрузки
  if (desktop?.version) {
    $('my-version').textContent = await desktop.version();
    $('my-version-row').hidden = false;
  }
  paintAvatar($('set-avatar'), client.account.username);
  setName($('set-name'), client.account.username, client.verified);
  $('set-username').textContent = '@' + client.account.username;
  // Ссылка на главную: в вебе — этот сайт, в приложениях — сайт вашего сервера
  $('home-link').href = desktop ? client._httpBase() + '/?home' : '/?home';
  $('my-device').textContent = `${client.account.deviceName || t('Устройство')} (${t('№{0}', client.account.deviceId)})`;
  $('set-lang-value').textContent = LANGS.find(([c]) => c === LANG)?.[1] || '';
  $('set-blocked-value').textContent = client.blocked.size ? String(client.blocked.size) : '';
  fillPremiumRow();
  fillProxyRow();
  $('row-shop-group').hidden = !client.shopOn;
  await fillNotifSettings();
}

async function openSettings(page = 'main') {
  await fillSettings();
  showSetPage(page);
  if (!$('menu-dialog').open) $('menu-dialog').showModal();
}
$('menu-btn').addEventListener('click', () => openSettings());

// Свой профиль: фото, имя и «о себе» (юзернейм не меняется)
let pendingAvatar; // undefined — фото не меняли, null — убрать, строка — новое
let pendingPhoto = null; // большое фото к новому pendingAvatar
function fillProfileEdit() {
  $('prof-name').value = client.profile.name;
  $('prof-bio').value = client.profile.bio;
  $('prof-name').placeholder = client.account.username;
  $('prof-username').textContent = '@' + client.account.username;
  pendingAvatar = undefined;
  updateProfilePhoto();
  $('prof-shop-row').hidden = !client.shopOn;
  // Видео на фон — с сервера 0.47 (своё видео он закрепляет на хранении)
  bioCount();
  renderProfileChannels();
}

// Каналы в профиле: свои каналы, не больше двух (сохраняются сразу, отдельно от имени и «о себе»)
async function renderProfileChannels() {
  const own = await client.ownChannels();
  const pinned = (client.profile.channels || []).map((c) => c.ref);
  const box = $('prof-channels');
  box.replaceChildren();
  if (!own.length) {
    box.append(el('div', 'set-row set-static', t('У вас пока нет своих каналов. Создайте канал: 📢 вверху списка чатов → «Создать».')));
    $('prof-channels-note').hidden = true;
    return;
  }
  $('prof-channels-note').hidden = false;
  for (const ch of own) {
    const row = el('label', 'set-row set-toggle');
    const cb = el('input');
    cb.type = 'checkbox';
    cb.checked = pinned.includes(ch.ref);
    cb.disabled = !cb.checked && pinned.length >= PROFILE_CHANNELS_MAX;
    cb.addEventListener('change', async () => {
      const next = cb.checked ? [...pinned, ch.ref] : pinned.filter((r) => r !== ch.ref);
      try {
        await client.setProfileChannels(next);
        toast(cb.checked ? t('Канал прикреплён к профилю') : t('Канал убран из профиля'));
      } catch (err) {
        cb.checked = !cb.checked;
        toast(err.message);
      }
      renderProfileChannels();
    });
    const label = el('span', 'set-label');
    label.append(icon('channel'), el('span', '', ' ' + (ch.title || t('Канал'))), el('span', 'small muted', ' · ' + (ch.public ? ch.ref : t('приватный канал'))));
    row.append(label, cb);
    box.append(row);
  }
}
function updateProfilePhoto() {
  const premium = client.isPremium();
  const has = pendingAvatar === undefined ? !!client.profile.avatar : !!pendingAvatar;
  // Без подписки фото не показывается, но убрать сохранённое можно
  const shown = pendingAvatar === undefined ? client.avatarOf(client.account.username) : premium ? pendingAvatar : null;
  paintAvatar($('prof-avatar'), client.account.username, shown);
  paintCover($('prof-cover'), client.account.username);
  $('prof-photo-pick').hidden = !premium;
  $('prof-photo-pick').replaceChildren(icon('camera'), has ? t('Сменить фото') : t('Выбрать фото'));
  $('prof-photo-clear').hidden = !has;
  $('prof-photo-actions').hidden = !premium && !has;
  $('prof-photo-locked').hidden = premium || !client.billing;
}
/** Квадрат из середины картинки → JPEG-data:-URL, который проходит check (подбираем размер и качество). */
function squareJpeg(bmp, sizes, check) {
  for (const size of sizes) {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const g = canvas.getContext('2d');
    const side = Math.min(bmp.width, bmp.height);
    g.fillStyle = '#fff'; // прозрачный фон PNG → белый (JPEG без прозрачности)
    g.fillRect(0, 0, size, size);
    g.imageSmoothingQuality = 'high';
    g.drawImage(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side, 0, 0, size, size);
    for (const q of [0.85, 0.75, 0.6, 0.45]) {
      const url = canvas.toDataURL('image/jpeg', q);
      if (check(url)) return url;
    }
  }
  return null;
}
/**
 * Картинка → фото профиля: { avatar } — маленькое (AVATAR_SIZE, для списков и шапок) и
 * { photo } — большое (до PHOTO_SIZE, для просмотра на весь экран; не больше исходника).
 */
async function makeAvatar(file) {
  if (!file.type.startsWith('image/') || file.size > 40 * 1024 * 1024) throw new Error(t('Это не картинка или она слишком большая'));
  let bmp;
  try {
    bmp = await createImageBitmap(file);
  } catch {
    throw new Error(t('Не удалось открыть картинку'));
  }
  try {
    const avatar = squareJpeg(bmp, [AVATAR_SIZE, 128, 96], validAvatar);
    if (avatar) {
      const side = Math.min(bmp.width, bmp.height);
      const sizes = [PHOTO_SIZE, 512, 400].filter((x) => x <= side && x > AVATAR_SIZE);
      return { avatar, photo: squareJpeg(bmp, sizes, validPhoto) };
    }
  } finally {
    bmp.close?.();
  }
  throw new Error(t('Не удалось уменьшить картинку'));
}
$('prof-photo-pick').addEventListener('click', () => $('prof-photo-input').click());
$('prof-photo-input').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file) return;
  try {
    ({ avatar: pendingAvatar, photo: pendingPhoto } = await makeAvatar(file));
    updateProfilePhoto();
  } catch (err) {
    toast(err.message);
  }
});
$('prof-photo-clear').addEventListener('click', () => {
  pendingAvatar = null;
  updateProfilePhoto();
});
function bioCount() {
  $('prof-bio-count').textContent = String(140 - $('prof-bio').value.length);
}
$('prof-bio').addEventListener('input', bioCount);
$('prof-save').addEventListener('click', async () => {
  try {
    const next = { name: $('prof-name').value, bio: $('prof-bio').value };
    if (pendingAvatar !== undefined) Object.assign(next, { avatar: pendingAvatar, photo: pendingAvatar ? pendingPhoto : null });
    await client.setProfile(next);
    pendingAvatar = undefined;
    toast(t('Профиль сохранён'));
    setBack();
  } catch (err) {
    toast(err.message);
  }
});
client.on('profile', () => {
  setName($('me-name'), client.account.username, client.verified);
  paintAvatar($('me-avatar'), client.account.username);
  if ($('menu-dialog').open) {
    setName($('set-name'), client.account.username, client.verified);
    paintAvatar($('set-avatar'), client.account.username);
    if (setPage === 'shop') paintShopPreview();
    refreshVideoButtons();
  }
});
client.on('premium', () => client.account && refreshVideoButtons());
// ---------- Прокси (только в приложениях: десктоп и Android) ----------
// Сам прокси работает в нативной части (desktop/proxy.cjs, android/.../ProxyRelay.kt):
// пароль туда уходит один раз и обратно странице не возвращается.
const PROXY_ERR = {
  proxy_unreachable: t('Прокси не отвечает: проверьте адрес и порт'),
  proxy_auth: t('Прокси не принял логин или пароль'),
  proxy_refused: t('Прокси не пустил к серверу Тайника'),
  proxy_bad: t('Неверные настройки прокси'),
  proxy_timeout: t('Прокси не ответил вовремя'),
};
// Код ошибки может прийти внутри текста (ошибка IPC Electron: «…: Error: proxy_bad: host»)
const proxyErr = (code) => PROXY_ERR[/proxy_[a-z]+/.exec(String(code))?.[0]] || t('Не удалось подключиться через прокси');
let proxyState = null;
async function fillProxyRow() {
  $('row-proxy').hidden = !desktop?.proxy;
  if (!desktop?.proxy) return;
  try {
    proxyState = await desktop.proxy.get();
  } catch {
    proxyState = null;
  }
  $('set-proxy-value').textContent = proxyState?.enabled ? t('вкл.') : '';
}
function proxyForm() {
  const port = Number($('px-port').value.trim());
  const cfg = { enabled: $('px-on').checked, type: $('px-type').value, host: $('px-host').value.trim(), port, user: $('px-user').value };
  // Пустое поле пароля — оставить прежний (его не показываем)
  if ($('px-pass').value || !proxyState?.hasPass) cfg.pass = $('px-pass').value;
  return cfg;
}
function proxyStatus(text, ok) {
  $('px-status').textContent = text;
  $('px-status').className = 'small' + (ok === true ? ' ok' : ok === false ? ' bad' : '');
}
async function fillProxy() {
  await fillProxyRow();
  const p = proxyState || {};
  $('px-on').checked = !!p.enabled;
  $('px-type').value = p.type === 'http' ? 'http' : 'socks5';
  $('px-host').value = p.host || '';
  $('px-port').value = p.port || '';
  $('px-user').value = p.user || '';
  $('px-pass').value = '';
  $('px-pass').placeholder = p.hasPass ? t('сохранён — оставьте пустым') : t('необязательно');
  $('px-unsupported').hidden = p.supported !== false;
  proxyStatus(p.enabled ? (p.active ? t('Включён') : t('Не работает на этом устройстве')) : '', p.enabled ? !!p.active : undefined);
}
$('px-type').addEventListener('change', () => {
  if (!$('px-port').value) $('px-port').placeholder = $('px-type').value === 'http' ? '3128' : '1080';
});
$('px-test').addEventListener('click', async () => {
  $('px-test').disabled = true;
  proxyStatus(t('Проверяю…'));
  try {
    const r = await desktop.proxy.test(proxyForm(), client.url);
    if (r?.ok) proxyStatus(t('Прокси работает: сервер доступен ({0} мс)', r.ms), true);
    else proxyStatus(proxyErr(r?.code), false);
  } catch (err) {
    proxyStatus(proxyErr(err.message), false);
  } finally {
    $('px-test').disabled = false;
  }
});
$('px-save').addEventListener('click', async () => {
  const cfg = proxyForm();
  if (cfg.enabled && (!cfg.host || !(cfg.port >= 1 && cfg.port <= 65535))) return proxyStatus(PROXY_ERR.proxy_bad, false);
  $('px-save').disabled = true;
  try {
    proxyState = await desktop.proxy.set(cfg);
    await fillProxy();
    toast(cfg.enabled ? t('Прокси включён — переподключаюсь') : t('Прокси выключен'));
    // Новые соединения — уже через прокси (или напрямую)
    client.reconnectNow({ restart: true });
    for (const o of others.values()) o.client.reconnectNow({ restart: true });
  } catch (err) {
    proxyStatus(proxyErr(err.message), false);
  } finally {
    $('px-save').disabled = false;
  }
});

// ---------- Подписка «Тайник Премиум» ----------
// Оплата — криптовалютой через xRocket Pay: сервер выставляет счёт, пользователь платит
// в Telegram (@xRocket), сервер узнаёт об оплате сам (вебхук) или по «Проверить оплату».
const dateLong = new Intl.DateTimeFormat(LOCALE, { day: 'numeric', month: 'long', year: 'numeric' });
const dateShort = new Intl.DateTimeFormat(LOCALE, { day: 'numeric', month: 'short' });
let invoice = null; // последний выставленный счёт { id, url, days, price, currency, expiresAt }
let invoiceBase = 0; // до какого момента действовала подписка, когда счёт выставили
let premPoll = null;
let premCurrency = null; // выбранная валюта оплаты
// Как показывать коды валют xRocket
const CURRENCY_NAME = { TRX: 'TRON (TRX)', GRAM: 'Gram', TONCOIN: 'TON', TON: 'TON' };
function planName(days) {
  if (days % 365 === 0) return days === 365 ? t('1 год') : t('{0} г.', days / 365);
  if (days % 30 === 0) return days === 30 ? t('1 месяц') : t('{0} мес.', days / 30);
  return t('{0} дн.', days);
}
let premFor = 'me'; // 'me' — себе, 'gift' — в подарок
/** Отметка о подарке в чате дарителя и получателя. */
function giftText(g) {
  return g.from === client.account?.username
    ? t('🎁 Вы подарили {0} Премиум на {1}', nameOf(g.to), planName(g.days))
    : t('🎁 {0} дарит вам Премиум на {1}', nameOf(g.from), planName(g.days));
}
/** Открыть «Тайник Премиум» в режиме подарка для name. */
function giftPremium(name) {
  premFor = 'gift';
  $('prem-gift-to').value = name || '';
  if ($('profile-dialog').open) $('profile-dialog').close();
  openSettings('premium');
}
$('menu-dialog').addEventListener('close', () => (premFor = 'me')); // в следующий раз — снова «Себе»
for (const b of document.querySelectorAll('#prem-for .prem-cur')) {
  b.addEventListener('click', () => {
    if (premFor === b.dataset.for) return;
    premFor = b.dataset.for;
    invoice = null;
    fillPremium();
    if (premFor === 'gift' && !$('prem-gift-to').value) $('prem-gift-to').focus();
  });
}
const coinsSold = () => !!(client.billing?.packs?.length || client.billing?.plans?.[0]?.coins);
// Сумма в монетах: в тексте (подтверждения, всплывающие сообщения) — с эмодзи, в интерфейсе — со
// своей иконкой монеты на одной линии с числом (эмодзи на разных устройствах стоит по-разному)
const coinsText = (n) => `${n.toLocaleString(LOCALE)} 🪙`;
function coinsNode(n) {
  const s = el('span', 'coin-amt', n.toLocaleString(LOCALE));
  s.append(icon('coin', 'coin-ico'));
  s.setAttribute('aria-label', t('{0} монет', n.toLocaleString(LOCALE)));
  return s;
}
/** Перевод с узлами вместо {0}, {1}… (например, сумма с иконкой монеты внутри фразы). */
function tNodes(key, ...nodes) {
  return t(key, ...nodes.map((_, i) => `\u0000${i}\u0000`))
    .split('\u0000')
    .map((part, i) => (i % 2 ? nodes[Number(part)] : part))
    .filter((x) => x !== '');
}
function fillPremiumRow() {
  $('row-premium-group').hidden = !client.billing && !client.isPremium() && !client.coins;
  $('set-premium-value').textContent = client.isPremium() && client.premium.until ? t('до {0}', dateShort.format(client.premium.until)) : '';
  $('row-coins').hidden = !coinsSold() && !client.coins;
  $('set-coins-value').replaceChildren(...(client.coins ? [coinsNode(client.coins)] : []));
}
function fillPremium() {
  const on = client.isPremium();
  $('prem-status').textContent = on
    ? client.premium.until
      ? t('Подписка действует до {0}', dateLong.format(client.premium.until))
      : t('Подписка действует')
    : client.billing
      ? t('Подписка не оформлена')
      : t('На этом сервере подписка пока не продаётся');
  const plans = client.billing?.plans || [];
  $('prem-plans-title').textContent = premFor === 'gift' ? t('Подарить') : on ? t('Продлить') : t('Оплатить');
  $('prem-plans-title').hidden = $('prem-plans').hidden = $('prem-note').hidden = $('prem-for').hidden = !plans.length;
  for (const b of document.querySelectorAll('#prem-for .prem-cur')) {
    b.classList.toggle('active', b.dataset.for === premFor);
    b.setAttribute('aria-checked', String(b.dataset.for === premFor));
  }
  $('prem-gift').hidden = !plans.length || premFor !== 'gift';
  // На основной сети xRocket — напоминание, что оплата настоящая
  $('prem-real').hidden = !plans.length || !!client.billing?.testnet;
  // Валюта оплаты: цены тарифов — в основной (первой), в остальных — по курсу на момент счёта
  const curs = client.billing?.currencies?.length ? [...client.billing.currencies] : plans.length ? [plans[0].currency] : [];
  if (plans[0]?.coins) curs.push('COINS'); // оплата монетами с баланса
  if (!curs.includes(premCurrency)) premCurrency = curs[0] || null;
  $('prem-curs').hidden = curs.length < 2;
  $('prem-curs').replaceChildren(
    ...curs.map((c) => {
      const b = el('button', 'prem-cur' + (c === premCurrency ? ' active' : ''), c === 'COINS' ? null : CURRENCY_NAME[c] || c);
      if (c === 'COINS') b.replaceChildren(icon('coin', 'coin-ico'), t('Монеты ({0})', client.coins.toLocaleString(LOCALE)));
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(c === premCurrency));
      b.addEventListener('click', () => {
        premCurrency = c;
        fillPremium();
      });
      return b;
    })
  );
  const base = plans[0]?.currency;
  $('prem-plans').replaceChildren(
    ...plans.map((p) => {
      const b = el('button', 'set-row prem-plan');
      b.type = 'button';
      const price =
        premCurrency === 'COINS' ? coinsNode(p.coins) : premCurrency === base ? `${p.price} ${p.currency}` : t('≈ {0} {1} в {2}', p.price, p.currency, CURRENCY_NAME[premCurrency] || premCurrency);
      const ico = el('span', 'set-ico');
    ico.append(icon('calendar'));
    const value = el('span', 'set-value');
    value.append(price);
    b.append(ico, el('span', 'set-label', planName(p.days)), value);
      b.addEventListener('click', () => buyPlan(p, b));
      return b;
    })
  );
  if (invoice && invoice.expiresAt < Date.now()) invoice = null;
  showInvoice();
}
function showInvoice() {
  $('prem-pay').hidden = !invoice;
  if (!invoice) return;
  $('prem-pay-text').textContent = invoice.giftTo
    ? t('Подарок для {0}: {1} — {2} {3}. Откройте счёт в Telegram и оплатите в боте @xRocket.', '@' + invoice.giftTo, planName(invoice.days), invoice.price, invoice.currency)
    : t('Счёт: {0} — {1} {2}. Откройте его в Telegram и оплатите в боте @xRocket.', planName(invoice.days), invoice.price, invoice.currency);
  $('prem-link').href = invoice.url;
}
async function buyPlan(plan, btn) {
  const giftTo = premFor === 'gift' ? $('prem-gift-to').value.trim().replace(/^@/, '').toLowerCase() : null;
  if (premFor === 'gift' && !giftTo) {
    toast(t('Введите юзернейм получателя подарка'));
    return $('prem-gift-to').focus();
  }
  if (giftTo && giftTo === client.account?.username) {
    toast(t('Это ваш юзернейм. Чтобы купить подписку себе, выберите «Себе»'));
    return;
  }
  if (premCurrency === 'COINS') return payWithCoins(plan, btn, giftTo);
  btn.disabled = true;
  try {
    invoiceBase = client.premium.until || 0;
    invoice = await client.buyPremium(plan.id, premCurrency, giftTo);
    showInvoice();
  } catch (err) {
    // Причина от xRocket (например, минимальная сумма) — тоже показываем
    const why = err.data?.detail || err.data?.reason;
    toast(why ? `${err.message} (xRocket: ${why})` : err.message, why ? 8000 : 3500);
  } finally {
    btn.disabled = false;
  }
}
/** Премиум за монеты: подтверждение, списание, итог. */
async function payWithCoins(plan, btn, giftTo) {
  if (client.coins < plan.coins) {
    toast(t('Не хватает монет: нужно {0}, на балансе {1}', coinsText(plan.coins), coinsText(client.coins)), 5000);
    return showSetPage('coins');
  }
  const q = giftTo
    ? t('Подарить {0} Премиум на {1} за {2}?', '@' + giftTo, planName(plan.days), coinsText(plan.coins))
    : t('Оплатить Премиум на {0} монетами: {1}?', planName(plan.days), coinsText(plan.coins));
  if (!confirm(q)) return;
  btn.disabled = true;
  try {
    const r = await client.premiumForCoins(plan.id, plan.coins, giftTo);
    if (!r.gift) toast(t('Подписка Премиум оформлена — спасибо! ⭐'), 6000);
    fillPremium();
  } catch (err) {
    toast(err.message, 5000);
  } finally {
    btn.disabled = false;
  }
}

// ---------- Монеты — внутренняя валюта ----------
// Покупаются криптовалютой (тот же xRocket, счёт на пакет), тратятся на Премиум (позже — на подарки).
let coinInvoice = null; // { id, url, coins, price, currency, expiresAt }
let coinCurrency = null;
function fillCoins() {
  $('coins-balance').textContent = client.coins.toLocaleString(LOCALE);
  $('coins-balance-text').textContent = t('монет на балансе');
  $('coins-to-premium').hidden = !client.billing?.plans?.[0]?.coins;
  $('coins-to-shop').hidden = !client.shopOn;
  const packs = client.billing?.packs || [];
  $('coins-buy-title').hidden = $('coins-packs').hidden = $('coins-note').hidden = !packs.length;
  const curs = client.billing?.currencies?.length ? client.billing.currencies : packs.length ? [packs[0].currency] : [];
  if (!curs.includes(coinCurrency)) coinCurrency = curs[0] || null;
  $('coins-curs').hidden = curs.length < 2 || !packs.length;
  $('coins-curs').replaceChildren(
    ...curs.map((c) => {
      const b = el('button', 'prem-cur' + (c === coinCurrency ? ' active' : ''), CURRENCY_NAME[c] || c);
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(c === coinCurrency));
      b.addEventListener('click', () => {
        coinCurrency = c;
        fillCoins();
      });
      return b;
    })
  );
  const base = packs[0]?.currency;
  $('coins-packs').replaceChildren(
    ...packs.map((p) => {
      const b = el('button', 'set-row prem-plan');
      b.type = 'button';
      const price = coinCurrency === base ? `${p.price} ${p.currency}` : t('≈ {0} {1} в {2}', p.price, p.currency, CURRENCY_NAME[coinCurrency] || coinCurrency);
      const ico = el('span', 'set-ico');
    ico.append(icon('coin'));
    b.append(ico, el('span', 'set-label', t('{0} монет', p.coins.toLocaleString(LOCALE))), el('span', 'set-value', price));
      b.addEventListener('click', () => buyPack(p, b));
      return b;
    })
  );
  if (coinInvoice && coinInvoice.expiresAt < Date.now()) coinInvoice = null;
  showCoinInvoice();
}
function showCoinInvoice() {
  $('coins-pay').hidden = !coinInvoice;
  if (!coinInvoice) return;
  $('coins-pay-text').textContent = t('Счёт: {0} монет — {1} {2}. Откройте его в Telegram и оплатите в боте @xRocket.', coinInvoice.coins.toLocaleString(LOCALE), coinInvoice.price, coinInvoice.currency);
  $('coins-link').href = coinInvoice.url;
}
async function buyPack(pack, btn) {
  btn.disabled = true;
  try {
    coinInvoice = await client.buyCoins(pack.id, coinCurrency);
    showCoinInvoice();
  } catch (err) {
    const why = err.data?.detail || err.data?.reason;
    toast(why ? `${err.message} (xRocket: ${why})` : err.message, why ? 8000 : 3500);
  } finally {
    btn.disabled = false;
  }
}
$('coins-link').addEventListener('click', () => startPayPoll());
$('coins-check').addEventListener('click', async () => {
  $('coins-check').disabled = true;
  try {
    const before = client.coins;
    await client.checkPremium();
    await new Promise((r) => setTimeout(r, 300)); // зачисление приходит отдельным сообщением
    if (coinInvoice && client.coins === before) toast(t('Оплата пока не поступила. Если вы уже заплатили, подождите минуту и проверьте ещё раз.'), 6000);
  } catch (err) {
    toast(err.message);
  } finally {
    $('coins-check').disabled = false;
  }
});
client.on('coins', (n) => {
  if (coinInvoice) {
    toast(t('Монеты зачислены: на балансе {0}', coinsText(n)), 6000);
    coinInvoice = null;
  }
  if (!$('menu-dialog').open) return;
  fillPremiumRow();
  if (setPage === 'coins') fillCoins();
  if (setPage === 'premium') fillPremium();
  if (setPage === 'shop' && shopData) renderShop();
});

// ---------- Магазин: рамки и фоны профиля ----------
// Товары загружает администратор сервера, покупают за монеты. Товар с пометкой «Премиум»
// бесплатен подписчикам (и действует, пока подписка есть). Надетое видят все: сервер сообщает
// его вместе со статусом. Своё видео на фон — с Премиум, зашифровано, как фото профиля.
let shopData = null; // { items, owned, chosen, look }
let shopTab = 'frame';
let shopBusy = false;
function paintShopPreview() {
  const me = client.account.username;
  paintAvatar($('shop-avatar'), me);
  setName($('shop-name'), me, client.verified);
  paintCover($('shop-cover'), me);
}
async function fillShop() {
  paintShopPreview();
  $('shop-coins').textContent = client.coins.toLocaleString(LOCALE);
  $('shop-topup').hidden = !client.billing?.packs?.length;
  renderShopTabs();
  if (!shopData) {
    $('shop-grid').replaceChildren();
    $('shop-empty').hidden = false;
    $('shop-empty').textContent = t('Загружаем…');
  }
  try {
    shopData = await client.shopList();
  } catch (err) {
    $('shop-empty').hidden = false;
    $('shop-empty').textContent = err.message;
    return;
  }
  if (setPage === 'shop') renderShop();
}
function renderShopTabs() {
  for (const b of $('shop-tabs').querySelectorAll('[data-shop-tab]')) {
    const on = b.dataset.shopTab === shopTab;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', String(on));
  }
}
$('shop-tabs').addEventListener('click', (e) => {
  const b = e.target.closest('[data-shop-tab]');
  if (!b) return;
  shopTab = b.dataset.shopTab;
  renderShopTabs();
  if (shopData) renderShop();
});
/** Можно ли надеть без покупки (или уже куплено). */
function shopUsable(item) {
  return shopData.owned.includes(item.id) || (item.price === 0 && !item.premium) || (item.premium && client.isPremium());
}
function shopPriceText(item) {
  if (shopData.owned.includes(item.id)) return t('Куплено');
  if (item.premium && client.isPremium()) return t('С Премиум');
  if (item.price === 0) return item.premium ? t('Только с Премиум') : t('Бесплатно');
  return item.premium ? tNodes('{0} · или с Премиум', coinsNode(item.price)) : [coinsNode(item.price)];
}
function shopCard(item) {
  const kind = shopTab;
  const worn = item ? shopData.look[kind] === item.id : !shopData.look[kind] && !(kind === 'bg' && client.profileVideoOf(client.account.username));
  const waiting = item && !worn && shopData.chosen[kind] === item.id; // выбрано, но сейчас не действует (кончилась подписка)
  const b = el('button', 'shop-item' + (worn ? ' worn' : ''));
  b.type = 'button';
  const pv = el('span', 'shop-pv' + (kind === 'bg' ? ' bg' : ''));
  if (kind === 'frame') {
    const av = el('span', 'avatar big');
    paintAvatarBase(av, client.account.username, client.avatarOf(client.account.username));
    if (item) paintFrame(av, null, item.id);
    pv.append(av);
  } else if (item) {
    const box = el('span', 'shop-bg');
    shopFile(item.id)
      .then((f) => {
        let m;
        if (f.type.startsWith('video/')) {
          m = el('video');
          Object.assign(m, { muted: true, defaultMuted: true, loop: true, autoplay: true, playsInline: true, src: f.url });
          m.setAttribute('playsinline', '');
          m.setAttribute('muted', '');
          m.play?.().catch(() => {});
        } else {
          m = el('img');
          m.alt = '';
          m.src = f.url;
        }
        box.replaceChildren(m);
      })
      .catch(() => {});
    pv.append(box);
  } else pv.append(icon('close', 'shop-none'));
  // Звёздочка «бесплатно с Премиум» — в углу карточки
  let star = null;
  if (item?.premium) {
    star = el('span', 'shop-prem');
    star.append(icon('star'));
    star.title = t('Бесплатно с подпиской Премиум');
    star.setAttribute('aria-label', star.title);
  }
  const name = el('span', 'shop-name', item ? item.name : kind === 'frame' ? t('Без рамки') : t('Без фона'));
  const state = el('span', 'shop-state');
  state.append(...[].concat(worn ? t('Надето') : waiting ? t('Нужен Премиум') : item ? shopPriceText(item) : ''));
  b.append(pv, name, state);
  if (star) b.append(star);
  b.setAttribute('aria-pressed', String(worn));
  b.addEventListener('click', () => shopClick(item, kind, worn));
  return b;
}
function renderShop() {
  const items = shopData.items.filter((i) => i.kind === shopTab);
  $('shop-coins').textContent = client.coins.toLocaleString(LOCALE);
  $('shop-grid').replaceChildren(shopCard(null), ...items.map(shopCard));
  $('shop-empty').hidden = items.length > 0;
  $('shop-empty').textContent = shopTab === 'frame' ? t('Рамок пока нет — загляните позже.') : t('Фонов пока нет — загляните позже.');
  // Своё видео на фон — только на вкладке фонов
  $('shop-own').hidden = shopTab !== 'bg';
  fillVideoButtons($('pv-group'), t('Выбрать фото, GIF или видео'), t('Сменить свой фон'));
}
/**
 * Кнопки своего видео на фоне (в магазине и в «Моём профиле»): выбрать или сменить, убрать;
 * без подписки — строка «с Премиум» (ведёт на страницу подписки, если сервер её продаёт).
 */
function fillVideoButtons(box, pickText, changeText) {
  const premium = client.isPremium();
  const own = !!client.profile.video;
  box.querySelector('.pv-pick').hidden = !premium;
  box.querySelector('.pv-pick-label').textContent = videoBusy || (own ? changeText : pickText);
  box.querySelector('.pv-clear').hidden = !own;
  const locked = box.querySelector('.pv-locked');
  locked.hidden = premium;
  locked.disabled = !client.billing;
  if (client.billing) locked.dataset.go = 'premium';
  else delete locked.dataset.go;
}
let videoBusy = ''; // текст на кнопке, пока видео загружается
function refreshVideoButtons() {
  if (!$('menu-dialog').open) return;
  if (setPage === 'shop' && shopData) renderShop();
  if (setPage === 'profile') paintCover($('prof-cover'), client.account.username);
}
async function shopClick(item, kind, worn) {
  if (shopBusy || worn) return;
  shopBusy = true;
  try {
    if (item && !shopUsable(item)) {
      if (item.premium && !item.price) {
        toast(t('Этот товар бесплатен с подпиской Премиум'));
        if (client.billing) showSetPage('premium');
        return;
      }
      if (client.coins < item.price) {
        toast(t('Не хватает монет: нужно {0}, на балансе {1}', coinsText(item.price), coinsText(client.coins)), 5000);
        if (client.billing?.packs?.length) showSetPage('coins');
        return;
      }
      if (!confirm(t('Купить «{0}» за {1}?', item.name, coinsText(item.price)))) return;
      await client.buyShopItem(item.id, item.price);
      shopData.owned.push(item.id);
    }
    const r = await client.equipShopItem(kind, item ? item.id : null);
    Object.assign(shopData, { chosen: r.chosen, look: r.look });
    // На фоне — что-то одно: фон из магазина заменяет своё видео
    if (kind === 'bg' && client.profile.video) await client.setProfileVideo(null);
    toast(item ? (kind === 'frame' ? t('Рамка надета') : t('Фон поставлен')) : kind === 'frame' ? t('Рамка снята') : t('Фон убран'));
  } catch (err) {
    toast(err.message, 5000);
    if (err.code === 'shop_unknown' || err.code === 'price_changed') shopData = null;
  } finally {
    shopBusy = false;
    if (setPage === 'shop') fillShop();
  }
}
// Свой фон профиля (Премиум): фото, GIF или короткое видео
function videoMeta(file) {
  return new Promise((resolve, reject) => {
    const v = document.createElement('video');
    const url = URL.createObjectURL(file);
    const done = (fn, x) => {
      URL.revokeObjectURL(url);
      v.removeAttribute('src');
      fn(x);
    };
    v.preload = 'metadata';
    v.muted = true;
    v.onloadedmetadata = () => done(resolve, { dur: v.duration, w: v.videoWidth, h: v.videoHeight });
    // Чаще всего — видео в HEVC (iPhone) там, где оно не воспроизводится
    v.onerror = () => done(reject, new Error(t('Это видео не открывается на этом устройстве — его не увидят и собеседники. Выберите MP4 (H.264) или WebM, либо GIF или фото.')));
    v.src = url;
  });
}
const BG_EXT = { mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', gif: 'image/gif', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', heic: 'image/heic', heif: 'image/heif' };
/** Тип файла фона: от системы, иначе по расширению (на Android выбор файла иногда не сообщает тип). */
function bgType(file) {
  if (/^(video|image)\//.test(file.type)) return file.type;
  const ext = /\.([a-z0-9]+)$/i.exec(file.name || '')?.[1]?.toLowerCase();
  return BG_EXT[ext] || '';
}
/** Размеры GIF (длительность у GIF не проверяем — он крутится по кругу). */
async function gifMeta(file) {
  try {
    const bmp = await createImageBitmap(file);
    const meta = { w: bmp.width, h: bmp.height };
    bmp.close?.();
    return meta;
  } catch {
    throw new Error(t('Не удалось открыть GIF'));
  }
}
const BG_PHOTO_SIDE = 1600; // длинная сторона фото на фоне, пикселей
/** Фото → JPEG не больше BG_PHOTO_SIDE по длинной стороне: { blob, w, h }. */
async function bgPhoto(file) {
  let bmp;
  try {
    bmp = await createImageBitmap(file);
  } catch {
    throw new Error(t('Не удалось открыть картинку'));
  }
  try {
    const k = Math.min(1, BG_PHOTO_SIDE / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * k));
    const h = Math.max(1, Math.round(bmp.height * k));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const g = canvas.getContext('2d');
    g.fillStyle = '#000'; // прозрачный фон PNG → чёрный (как под видео)
    g.fillRect(0, 0, w, h);
    g.imageSmoothingQuality = 'high';
    g.drawImage(bmp, 0, 0, w, h);
    for (const q of [0.85, 0.7, 0.55]) {
      const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', q));
      if (blob && blob.size <= PROFILE_VIDEO_MAX) return { blob, w, h };
    }
  } finally {
    bmp.close?.();
  }
  throw new Error(t('Не удалось уменьшить картинку'));
}
$('menu-dialog').addEventListener('click', (e) => {
  if (e.target.closest('.pv-pick')) $('pv-input').click();
  else if (e.target.closest('.pv-clear')) clearProfileVideo();
});
$('pv-input').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file || videoBusy) return;
  const type = bgType(file);
  const kind = type === 'image/gif' ? 'gif' : type.startsWith('video/') ? 'video' : type.startsWith('image/') ? 'photo' : '';
  if (!kind) return toast(t('Нужно фото, GIF или видео'));
  // Фото уменьшается на устройстве — ограничение размера только для GIF и видео
  if (kind !== 'photo' && file.size > PROFILE_VIDEO_MAX) return toast(ERROR_TEXT.video_too_large);
  videoBusy = t('Загружаем…');
  refreshVideoButtons();
  try {
    let source = file;
    let meta;
    if (kind === 'photo') {
      const p = await bgPhoto(file);
      source = p.blob;
      meta = { mime: 'image/jpeg', w: p.w, h: p.h };
    } else if (kind === 'gif') {
      meta = { mime: type, ...(await gifMeta(file)) };
    } else {
      const v = await videoMeta(file);
      if (!(v.dur <= PROFILE_VIDEO_SEC + 0.5)) throw new Error(ERROR_TEXT.video_too_long);
      meta = { mime: type, w: v.w, h: v.h, dur: v.dur };
    }
    await client.setProfileVideo(source, meta, {
      onProgress: (x) => {
        videoBusy = t('Загружаем… {0}%', Math.round(x * 100));
        for (const l of document.querySelectorAll('#menu-dialog .pv-pick-label')) l.textContent = videoBusy;
      },
    });
    toast(kind === 'photo' ? t('Фото стоит на фоне профиля') : kind === 'gif' ? t('GIF стоит на фоне профиля') : t('Видео стоит на фоне профиля'));
  } catch (err) {
    toast(err.message, 7000);
  } finally {
    videoBusy = '';
    if (setPage === 'shop') fillShop();
    else refreshVideoButtons();
  }
});
async function clearProfileVideo() {
  if (videoBusy || !confirm(t('Убрать свой фон из профиля?'))) return;
  videoBusy = t('Убираем…');
  try {
    await client.setProfileVideo(null);
    toast(t('Фон убран'));
  } catch (err) {
    toast(err.message);
  } finally {
    videoBusy = '';
    if (setPage === 'shop') fillShop();
    else refreshVideoButtons();
  }
}
// Надетое изменилось (здесь, на другом своём устройстве или кончилась подписка)
client.on('look', () => {
  if (!client.account) return;
  paintAvatar($('me-avatar'), client.account.username);
  if (!$('menu-dialog').open) return;
  paintAvatar($('set-avatar'), client.account.username);
  if (setPage === 'profile') updateProfilePhoto();
  if (setPage === 'shop') {
    paintShopPreview();
    if (shopData) {
      shopData.look = client.look;
      renderShop();
    }
  }
});
client.on('shop', ({ owned, revoked }) => {
  if (shopData && owned && !shopData.owned.includes(owned)) shopData.owned.push(owned);
  if (shopData && revoked) shopData.owned = shopData.owned.filter((id) => id !== revoked);
  if ($('menu-dialog').open && setPage === 'shop' && shopData) renderShop();
});

function stopPremPoll() {
  clearInterval(premPoll);
  premPoll = null;
}
// После перехода к оплате — сами спрашиваем сервер раз в 15 секунд (на случай, если вебхук задержится)
function startPayPoll() {
  stopPremPoll();
  const end = Date.now() + 15 * 60_000;
  premPoll = setInterval(() => {
    if ((!invoice && !coinInvoice) || Date.now() > end) return stopPremPoll();
    if (client.status === 'online') client.checkPremium().catch(() => {});
  }, 15_000);
}
$('prem-link').addEventListener('click', startPayPoll);
$('prem-check').addEventListener('click', async () => {
  $('prem-check').disabled = true;
  try {
    await client.checkPremium();
    if (invoice) toast(t('Оплата пока не поступила. Если вы уже заплатили, подождите минуту и проверьте ещё раз.'), 6000);
  } catch (err) {
    toast(err.message);
  } finally {
    $('prem-check').disabled = false;
  }
});
client.on('gift', (g) => {
  const me = client.account?.username;
  if (g.from === me) {
    if (invoice?.id === g.id) {
      invoice = null;
      stopPremPoll();
      if (setPage === 'premium') showInvoice();
    }
    if (Date.now() - g.at < 86400_000) toast(t('Подарок оплачен: {0} получает Премиум на {1} 🎁', nameOf(g.to), planName(g.days)), 6000);
  } else if (Date.now() - g.at < 86400_000) {
    toast(t('🎁 {0} дарит вам Премиум на {1}!', nameOf(g.from), planName(g.days)), 8000);
  }
});
client.on('premium', (p) => {
  if (invoice && !invoice.giftTo && p.active && (p.until || 0) > invoiceBase) {
    invoice = null;
    stopPremPoll();
    toast(t('Подписка Премиум оформлена — спасибо! ⭐'), 6000);
  }
  if (!client.account) return;
  setName($('me-name'), client.account.username, client.verified);
  paintAvatar($('me-avatar'), client.account.username);
  if (!$('menu-dialog').open) return;
  setName($('set-name'), client.account.username, client.verified);
  paintAvatar($('set-avatar'), client.account.username);
  fillPremiumRow();
  if (setPage === 'premium') fillPremium();
  if (setPage === 'profile') updateProfilePhoto();
});

$('menu-dialog').addEventListener('close', async () => {
  const v = $('menu-dialog').returnValue;
  if (v === 'devices') return openDevices(true);
  if (v === 'accounts') return openAccounts();
  if (v === 'blocked') return openBlocked();
  if (v !== 'reset') return;
  if (!confirm(t('Стереть ключи и переписку этого аккаунта на этом устройстве? Другие устройства аккаунта и другие аккаунты здесь продолжат работать.'))) return;
  if (calls.busy) calls.hangup();
  await dropPush(true);
  await client.reset();
  await forgetActiveAccount();
  location.reload();
});

// ---------- Устройства (на уже привязанном устройстве) ----------
const relTime = new Intl.RelativeTimeFormat(LOCALE, { numeric: 'auto' });
function seenText(d) {
  if (d.current) return t('это устройство');
  if (d.online) return t('в сети');
  const min = Math.round((d.lastSeen - Date.now()) / 60000);
  if (min > -60) return t('был(о) ') + relTime.format(min, 'minute');
  if (min > -1440) return t('был(о) ') + relTime.format(Math.round(min / 60), 'hour');
  return t('был(о) ') + relTime.format(Math.round(min / 1440), 'day');
}

async function renderDevices() {
  const ul = $('device-list');
  let list;
  try {
    list = await client.listDevices();
  } catch (err) {
    ul.replaceChildren(el('li', 'muted', err.message));
    return;
  }
  ul.replaceChildren(
    ...list.map((d) => {
      const li = el('li');
      li.append(icon(/Приложение|^App /.test(d.name) ? 'monitor' : /Android|iOS/.test(d.name) ? 'smartphone' : 'globe', 'd-ico'));
      const body = el('div', 'd-body');
      const meta = el('div', 'd-meta', seenText(d));
      // Версия приложения на устройстве (старые версии её не сообщают)
      meta.append(' · ', el('span', 'd-ver', d.appVersion ? t('версия {0}', d.appVersion) : t('версия неизвестна')));
      if (d.ip) meta.append(' · ', el('code', 'd-ip', d.ip));
      body.append(el('div', 'd-name', `${d.name} · ${t('№{0}', d.id)}`), meta);
      li.append(body);
      if (!d.current) {
        const b = el('button', 'ghost', t('Отвязать'));
        b.addEventListener('click', async () => {
          if (!confirm(t('Отвязать «{0}»? Оно перестанет получать сообщения, а ключи на нём будут стёрты при следующем подключении.', d.name))) return;
          try {
            await client.unlinkDevice(d.id);
            toast(t('Устройство отвязано'));
          } catch (err) {
            toast(err.message);
          }
          renderDevices();
        });
        li.append(b);
      }
      return li;
    })
  );
}

let devicesFromSettings = false;
async function openDevices(fromSettings = false) {
  devicesFromSettings = fromSettings;
  $('link-form-error').textContent = '';
  $('link-input').value = '';
  $('devices-dialog').showModal();
  await renderDevices();
}

async function linkWithCode(code) {
  $('link-form-error').textContent = '';
  try {
    await client.linkDevice(code);
    $('link-input').value = '';
    toast(t('Ключи переданы. Новое устройство подключается…'), 5000);
    setTimeout(renderDevices, 1500);
  } catch (err) {
    $('link-form-error').textContent = err.message;
  }
}

$('link-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const code = $('link-input').value.trim();
  if (!code) return;
  if (!confirm(t('Передать ключ вашей личности устройству с этим кодом? Делайте это, только если код с вашего собственного экрана.'))) return;
  linkWithCode(code);
});

// ---------- Сканер QR-кода ----------
// Камера → кадры → распознавание. Где есть BarcodeDetector — он, иначе свой распознаватель
// (shared/qr-scan.js) в фоновом потоке: в приложениях для Windows, Linux и Android его нет.
const SCAN_MAX = 640; // кадр уменьшаем до этой ширины: быстрее и надёжнее
let scanner = null; // { stream, onResult, timer, cams, camIndex }
let qrWorker;
let qrSeq = 0;
const qrWaiting = new Map();

function qrDecodeWorker(imageData) {
  if (qrWorker === undefined) {
    try {
      qrWorker = new Worker('/shared/qr-worker.js', { type: 'module' });
      qrWorker.onmessage = (e) => {
        qrWaiting.get(e.data.id)?.(e.data.text);
        qrWaiting.delete(e.data.id);
      };
      qrWorker.onerror = () => {
        qrWorker = null; // поток не запустился — распознаём на странице
        for (const done of qrWaiting.values()) done(undefined);
        qrWaiting.clear();
      };
    } catch {
      qrWorker = null;
    }
  }
  if (!qrWorker) return null;
  const id = ++qrSeq;
  return new Promise((resolve) => {
    qrWaiting.set(id, resolve);
    qrWorker.postMessage({ id, width: imageData.width, height: imageData.height, data: imageData.data }, [imageData.data.buffer]);
  });
}

let scanModule = null;
async function decodeQr(source, w, h) {
  const k = Math.min(1, SCAN_MAX / Math.max(w, h));
  const cw = Math.max(1, Math.round(w * k));
  const ch = Math.max(1, Math.round(h * k));
  const canvas = document.createElement('canvas');
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(source, 0, 0, cw, ch);
  if ('BarcodeDetector' in window) {
    try {
      const found = await new BarcodeDetector({ formats: ['qr_code'] }).detect(canvas);
      if (found[0]) return found[0].rawValue;
    } catch {}
  }
  const imageData = ctx.getImageData(0, 0, cw, ch);
  const viaWorker = qrDecodeWorker(imageData);
  if (viaWorker) {
    const text = await viaWorker;
    if (text !== undefined) return text;
  }
  scanModule ||= await import('/shared/qr-scan.js');
  return scanModule.scanQR(ctx.getImageData(0, 0, cw, ch), { budgetMs: 150 });
}

function stopScan() {
  if (!scanner) return;
  clearTimeout(scanner.timer);
  scanner.stream?.getTracks().forEach((tr) => tr.stop());
  $('scanner-video').srcObject = null;
  scanner = null;
  if ($('scanner').open) $('scanner').close();
}

async function startCamera() {
  const s = scanner;
  s.stream?.getTracks().forEach((tr) => tr.stop());
  const cam = s.cams[s.camIndex];
  const video = { width: { ideal: 1280 }, height: { ideal: 720 } };
  if (cam) video.deviceId = { exact: cam.deviceId };
  else video.facingMode = 'environment'; // на телефоне — задняя камера
  s.stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
  if (scanner !== s) return s.stream.getTracks().forEach((tr) => tr.stop());
  const v = $('scanner-video');
  v.srcObject = s.stream;
  // Фронтальную камеру показываем зеркально, как зеркало (распознаётся и так)
  const facing = s.stream.getVideoTracks()[0]?.getSettings?.().facingMode;
  v.classList.toggle('mirror', facing === 'user' || (!facing && !android));
  await v.play().catch(() => {});
}

/** Открыть сканер; onResult(text) → true, если код подошёл (сканер закроется). */
async function openScanner(onResult) {
  stopScan();
  scanner = { stream: null, onResult, timer: null, cams: [], camIndex: 0 };
  const s = scanner;
  $('scanner-status').textContent = '';
  $('scanner-switch').hidden = true;
  $('scanner').showModal();
  if (!navigator.mediaDevices?.getUserMedia) {
    $('scanner-status').textContent = t('Камера недоступна. Можно выбрать картинку с QR-кодом.');
    return;
  }
  try {
    await startCamera();
    if (scanner !== s) return;
    // Список камер доступен после разрешения
    const cams = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
    const current = s.stream.getVideoTracks()[0]?.getSettings?.().deviceId;
    s.cams = cams;
    s.camIndex = Math.max(0, cams.findIndex((c) => c.deviceId === current));
    $('scanner-switch').hidden = cams.length < 2;
  } catch (err) {
    if (scanner !== s) return;
    $('scanner-status').textContent =
      err?.name === 'NotAllowedError' ? t('Нет доступа к камере. Разрешите его или выберите картинку с QR-кодом.') : t('Камера недоступна. Можно выбрать картинку с QR-кодом.');
    return;
  }
  const v = $('scanner-video');
  const tick = async () => {
    if (scanner !== s) return;
    let text = null;
    if (v.readyState >= 2 && v.videoWidth) {
      try {
        text = await decodeQr(v, v.videoWidth, v.videoHeight);
      } catch {}
    }
    if (scanner !== s) return;
    if (text && s.onResult(text)) return stopScan();
    s.timer = setTimeout(tick, 120);
  };
  tick();
}

$('scanner-close').addEventListener('click', stopScan);
$('scanner').addEventListener('close', stopScan);
$('scanner-switch').addEventListener('click', async () => {
  if (!scanner || scanner.cams.length < 2) return;
  scanner.camIndex = (scanner.camIndex + 1) % scanner.cams.length;
  try {
    await startCamera();
  } catch {
    $('scanner-status').textContent = t('Не удалось включить эту камеру');
  }
});
$('scanner-file').addEventListener('click', () => $('scanner-file-input').click());
$('scanner-file-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file || !scanner) return;
  const s = scanner;
  $('scanner-status').textContent = t('Ищем QR-код на картинке…');
  let text = null;
  try {
    const bmp = await createImageBitmap(file);
    text = await decodeQr(bmp, bmp.width, bmp.height);
    // Крупный код на большой картинке — попробовать без уменьшения
    if (!text && Math.max(bmp.width, bmp.height) > SCAN_MAX) {
      scanModule ||= await import('/shared/qr-scan.js');
      const c = document.createElement('canvas');
      c.width = Math.min(bmp.width, 2000);
      c.height = Math.round((bmp.height * c.width) / bmp.width);
      const ctx = c.getContext('2d');
      ctx.drawImage(bmp, 0, 0, c.width, c.height);
      text = scanModule.scanQR(ctx.getImageData(0, 0, c.width, c.height), { budgetMs: 1500 });
    }
    bmp.close();
  } catch {}
  if (scanner !== s) return;
  if (text && s.onResult(text)) return stopScan();
  $('scanner-status').textContent = text ? t('Это не код Тайника') : t('QR-код не найден на картинке');
});

// Привязка: код с экрана нового устройства
$('scan-btn').addEventListener('click', () =>
  openScanner((text) => {
    if (!/^TAINIK1:/i.test(text)) {
      $('scanner-status').textContent = t('Это не код привязки Тайника');
      return false;
    }
    setTimeout(() => {
      $('link-input').value = text;
      if (confirm(t('Найден код привязки. Передать ключи этому устройству?'))) linkWithCode(text);
    }, 50);
    return true;
  })
);
$('devices-close').addEventListener('click', () => {
  stopScan();
  $('devices-dialog').close();
});
$('devices-dialog').addEventListener('close', () => {
  stopScan();
  // Открыли из настроек — туда и возвращаемся, а не к списку чатов
  if (devicesFromSettings) {
    devicesFromSettings = false;
    openSettings('main');
  }
});
client.on('devices-changed', () => {
  if ($('devices-dialog').open) renderDevices();
});

// ---------- События клиента ----------
client.on('status', setStatus);
client.on('contacts', () => {
  renderContacts();
  if (current) renderHeader();
});
client.on('message', async ({ contact, message, quiet }) => {
  const incoming = message.dir === 'in' && !quiet;
  // Открытый чат в окне без фокуса не считаем прочитанным — иначе пропадёт счётчик
  if (contact === current && document.hasFocus()) {
    await client.markRead(contact);
    await renderChat();
  } else if (contact === current) {
    await renderChat();
  }
  if (incoming && !document.hasFocus()) notifyMessage(contact, message);
  renderContacts();
});
// Вернулись в окно — открытый чат прочитан
window.addEventListener('focus', async () => {
  if (!current || !client.account) return;
  clearChatNotices(current); // уведомления открытого чата больше не нужны
  const c = (await client.contacts())[current];
  if (c?.unread) {
    await client.markRead(current);
    renderContacts();
  }
});
client.on('status-change', ({ contact, id, status }) => {
  if (contact !== current) return;
  const node = document.querySelector(`.msg.out[data-id="${CSS.escape(id)}"]`);
  if (!node) return;
  node.classList.toggle('failed', status === 'failed');
  setStatusIcon(node.querySelector('.st'), status);
});
client.on('key-changed', (c) => toast(t('⚠ Ключ пользователя {0} изменился', c.username), 6000));
/** Стереть аккаунт на этом устройстве (ключи, переписку) и показать причину на экране входа. */
async function wipeLocal(textOf) {
  const name = client.account?.username || '';
  await dropPush(false);
  await client.reset();
  current = null;
  const text = textOf(name);
  if (await forgetActiveAccount()) {
    await settings.set('flash', text);
    return location.reload();
  }
  showAuth();
  $('auth-error').textContent = text;
}
client.on('error', async ({ code, text, self }) => {
  if (code === 'logged_in_elsewhere') return toast(text, 0);
  if (code === 'device_removed' || code === 'account_deleted') {
    // Устройство отвязано с другого устройства или аккаунт удалён — стираем ключи здесь
    return wipeLocal((name) =>
      code === 'account_deleted'
        ? self
          ? t('Аккаунт {0} удалён с другого вашего устройства. Ключи и переписка на этом устройстве стёрты.', name)
          : t('Аккаунт {0} удалён администратором сервера. Ключи и переписка на этом устройстве стёрты.', name)
        : t('Это устройство отвязано от аккаунта {0}. Ключи и переписка удалены.', name)
    );
  }
  toast(text);
});
// Поддержка: чат с администратором сервера
$('support-btn').addEventListener('click', async () => {
  $('menu-dialog').close();
  openChat(await client.openSupport());
});
// Удалить свой аккаунт: подтверждение — ввести свой юзернейм
$('delacc-btn').addEventListener('click', () => {
  $('delacc-name').textContent = '@' + (client.account?.username || '');
  $('delacc-input').value = '';
  $('delacc-error').textContent = '';
  $('delacc-dialog').showModal();
});
$('delacc-cancel').addEventListener('click', () => $('delacc-dialog').close());
$('delacc-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const typed = $('delacc-input').value.trim().replace(/^@/, '').toLowerCase();
  if (typed !== client.account?.username) {
    $('delacc-error').textContent = t('Юзернейм введён неверно');
    return;
  }
  $('delacc-confirm').disabled = true;
  try {
    await client.deleteAccount(typed);
    $('delacc-dialog').close();
    $('menu-dialog').close();
    await wipeLocal((name) => t('Аккаунт {0} удалён. Ключи и переписка на этом устройстве стёрты.', name));
  } catch (err) {
    $('delacc-error').textContent = err.message;
  } finally {
    $('delacc-confirm').disabled = false;
  }
});
// ---------- Уведомления и работа в фоне ----------
// Десктоп: приложение живёт в трее и получает сообщения само, уведомления — системные.
// Веб: пока вкладка открыта — уведомления от страницы; когда закрыта — Web Push
// (сервер будит браузер через его push-сервис; в пуше только имя отправителя, без текста).
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const webNotif = !desktop && 'Notification' in window;
const webPush = webNotif && 'serviceWorker' in navigator && 'PushManager' in window;
let swReady = null;
let notifiedCall = null;
let unreadTotal = 0;
let pushProblem = '';

function baseTitle() {
  return unreadTotal ? t('({0}) Тайник', unreadTotal) : t('Тайник — E2E-мессенджер');
}
function setUnread(n) {
  if (n === unreadTotal) return;
  unreadTotal = n;
  if (!document.title.startsWith('📞')) document.title = baseTitle();
  if (desktop?.setBadge) desktop.setBadge(n);
  else if (navigator.setAppBadge) (n ? navigator.setAppBadge(n) : navigator.clearAppBadge()).catch(() => {});
}

async function notifPrefs() {
  const v = await settings.get('notify');
  const enabled = desktop ? v !== '0' : v === '1' && webNotif && Notification.permission === 'granted';
  return { enabled, preview: (await settings.get('notify-preview')) === '1' };
}

function serviceWorker() {
  if (!webNotif || !('serviceWorker' in navigator)) return Promise.resolve(null);
  swReady ||= navigator.serviceWorker
    .register(`/sw.js?lang=${LANG}`, { scope: '/' }) // язык текстов уведомлений при закрытой вкладке
    .then(() => navigator.serviceWorker.ready)
    .catch((e) => {
      console.warn('service worker', e);
      return null;
    });
  return swReady;
}

async function showNotice({ title, body, chat, tag, call = false, force = false, reply = false, msg = '' }) {
  if (!(await notifPrefs()).enabled) return;
  if (desktop) return desktop.notify({ title, body, chat, call, force, reply, msg });
  const opts = { body, tag, renotify: true, icon: '/icon-192.png', badge: '/badge-72.png', data: { chat }, requireInteraction: call };
  const reg = await serviceWorker();
  try {
    if (reg) return await reg.showNotification(title, opts);
    const n = new Notification(title, opts);
    n.onclick = () => (window.focus(), openChatFromNotice(chat));
  } catch (e) {
    console.warn('notification', e);
  }
}

// Сразу после подключения приходит накопившееся: сообщения, а следом — отметки «прочитано»
// с других ваших устройств. Чтобы не всплывало уже прочитанное, уведомления в это время
// чуть придерживаем и показываем, только если чат всё ещё не прочитан.
const CATCHUP_MS = 4000;
let onlineAt = 0;
client.on('status', (st) => st === 'online' && (onlineAt = Date.now()));
async function stillUnread(c, contact, since = onlineAt) {
  if (Date.now() - since > CATCHUP_MS) return true;
  await new Promise((r) => setTimeout(r, 1500));
  return !!(await c.contacts())[contact]?.unread;
}

async function notifyMessage(contact, message) {
  if (!(await stillUnread(client, contact))) return;
  const { preview } = await notifPrefs();
  const text = preview ? textOf(message.content).replace(/\s+/g, ' ').slice(0, 160) : '';
  // Группа: в заголовке — название, в тексте — кто написал
  const who = message.from ? `${nameOf(message.from)}: ` : '';
  await showNotice({ title: nameOf(contact), body: who + (text || t('Новое сообщение')), chat: contact, tag: 'msg:' + contact, reply: await canReplyTo(client, contact), msg: message.id });
}

/** Можно ли ответить в этот чат прямо из уведомления. */
async function canReplyTo(c, chat) {
  const x = (await c.contacts())[chat];
  if (!x || x.system) return false;
  if (x.channel) return !x.channel.gone && (x.channel.role === 'owner' || x.channel.role === 'admin');
  if (x.group) return !x.group.left;
  return !x.keyChanged && !c.isBlocked(chat);
}

/**
 * Ответ из уведомления (Android, macOS): chat — как в уведомлении (для другого аккаунта —
 * «чат@id»). Отправляется от нужного аккаунта, чат отмечается прочитанным.
 */
/** msg — id сообщения из уведомления: ответ уйдёт ответом на него (с цитатой). */
async function replyFromNotice(chatRaw, text, msg = '') {
  text = String(text ?? '').trim();
  let chat = String(chatRaw ?? '');
  if (!text || !chat) return;
  let account = activeId;
  const at = chat.lastIndexOf('@');
  if (at > 0) {
    account = chat.slice(at + 1);
    chat = chat.slice(0, at);
  }
  const pick = () => (account === activeId ? client : others.get(account)?.client);
  // Страница могла только что запуститься по ответу — ждём входа в аккаунт
  let target = pick();
  for (let i = 0; i < 300 && !target?.account; i++) {
    await new Promise((r) => setTimeout(r, 100));
    target = pick();
  }
  if (!target?.account) return;
  try {
    // Ответ с цитатой — если сообщение есть в чате (у канала — нет ответов)
    const orig = msg && !isChannelChat(chat) ? (await target.messages(chat)).find((m) => m.id === msg && m.dir === 'in') : null;
    await target.sendText(chat, text.slice(0, 20000), { replyTo: orig ? msg : null });
    await target.markRead(chat);
  } catch (err) {
    showNotice({ title: t('Ответ не отправлен'), body: err.message, chat: chatRaw, tag: 'reply-error', force: true });
  }
}
if (desktop?.onReply) desktop.onReply((chat, text, msg) => replyFromNotice(chat, text, msg));

let pendingNoticeChat = null;
async function openChatFromNotice(chat) {
  if (!chat) return;
  const at = chat.lastIndexOf('@');
  if (at > 0) {
    const id = chat.slice(at + 1);
    chat = chat.slice(0, at);
    if (id !== activeId && accounts.some((a) => a.id === id && a.username)) {
      await settings.set('open-chat-after-switch', chat);
      return switchAccount(id);
    }
  }
  // Приложение могло только что запуститься по нажатию на уведомление: откроем после входа
  if (!client.account || $('app').hidden) return void (pendingNoticeChat = chat);
  if ((await client.contacts())[chat]) openChat(chat);
}
if (desktop?.onOpenChat) desktop.onOpenChat((chat) => openChatFromNotice(chat));
if (!desktop && 'serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data?.type === 'open-chat') openChatFromNotice(String(e.data.chat || ''));
  });
}

function b64uBytes(s) {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}
function sameBytes(a, b) {
  if (!a || !b) return false;
  a = new Uint8Array(a);
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/** Приводит подписку Web Push этого браузера в соответствие с настройкой. */
async function syncPush() {
  if (!webPush || client.status !== 'online') return;
  const want = (await notifPrefs()).enabled;
  try {
    const reg = await serviceWorker();
    if (!reg) return;
    let sub = await reg.pushManager.getSubscription();
    if (!want || !client.push.vapidKey) {
      if (client.push.endpoint) await client.setPushSubscription(null);
      if (!want && sub) await sub.unsubscribe();
      if (want && !client.push.vapidKey) pushProblem = 'server';
      return;
    }
    const key = b64uBytes(client.push.vapidKey);
    if (sub && !sameBytes(sub.options?.applicationServerKey, key)) {
      await sub.unsubscribe();
      sub = null;
    }
    sub ||= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    const json = sub.toJSON();
    if (client.push.endpoint !== json.endpoint) await client.setPushSubscription(json);
    pushProblem = '';
  } catch (e) {
    pushProblem = e.code === 'bad_subscription' ? 'browser' : 'error';
    console.warn('push', e);
  }
}
client.on('status', (st) => st === 'online' && syncPush());

/** Отписка при выходе: сервер и браузер забывают эту подписку. */
async function dropPush(tellServer) {
  if (!webPush) return;
  try {
    if (tellServer && client.push.endpoint) await client.setPushSubscription(null);
    const reg = await navigator.serviceWorker.getRegistration('/');
    await (await reg?.pushManager.getSubscription())?.unsubscribe();
  } catch {}
}

// Вызывается из обработчика нажатия: запрос разрешения должен идти сразу от действия пользователя
async function enableNotifications() {
  if (desktop) {
    await settings.set('notify', '1');
    return true;
  }
  if (!webNotif) {
    toast(t('Этот браузер не поддерживает уведомления'));
    return false;
  }
  if (isIOS && !standalone) {
    toast(t('На iPhone и iPad: «Поделиться» → «На экран „Домой“», откройте Тайник с экрана «Домой» и включите уведомления там'), 9000);
    return false;
  }
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') {
    toast(perm === 'denied' ? t('Уведомления запрещены для этого сайта в настройках браузера') : t('Уведомления не включены'));
    return false;
  }
  await settings.set('notify', '1');
  await syncPush();
  if (pushProblem === 'browser') toast(t('Уведомления будут приходить, пока вкладка открыта: этот браузер не поддерживает push-уведомления Тайника'), 7000);
  return true;
}
async function disableNotifications() {
  await settings.set('notify', '0');
  await syncPush();
}

async function initNotifications() {
  const v = await settings.get('notify');
  const canAsk = webNotif && !(isIOS && !standalone) && Notification.permission !== 'denied';
  $('notif-offer').hidden = !(canAsk && v == null && (await settings.get('notify-offer')) !== 'no');
  if (webNotif && v === '1') serviceWorker();
  syncPush();
  consumeChatLink();
}
// Ссылка вида /#chat=имя (из уведомления при закрытой вкладке) открывает чат
function consumeChatLink() {
  // Ссылка на канал: /app#ch=@имя или /app#ch=<id>.<ключ> — показать канал и предложить подписаться
  if (location.hash.startsWith('#ch=') && client.account) {
    const ref = location.hash;
    history.replaceState(null, '', location.pathname + location.search);
    return openChannels(ref);
  }
  if (!location.hash.startsWith('#chat=') || !client.account) return;
  let chat = '';
  try {
    chat = decodeURIComponent(location.hash.slice(6));
  } catch {}
  history.replaceState(null, '', location.pathname + location.search);
  openChatFromNotice(chat);
}
window.addEventListener('hashchange', consumeChatLink);
$('notif-offer-yes').addEventListener('click', async () => {
  $('notif-offer').hidden = true;
  if (await enableNotifications()) toast(t('Уведомления включены'));
});
$('notif-offer-no').addEventListener('click', async () => {
  $('notif-offer').hidden = true;
  await settings.set('notify-offer', 'no');
});

async function fillNotifSettings() {
  const { enabled, preview } = await notifPrefs();
  $('notif-enabled').checked = enabled;
  $('notif-preview').checked = preview;
  $('notif-preview').disabled = !enabled;
  let hint;
  if (android) hint = t('Пока включена работа в фоне, приложение само держит связь с вашим сервером — без Google и других push-сервисов.');
  else if (desktop) hint = t('Приложение получает сообщения, пока запущено, в том числе свёрнутым в трей.');
  else if (!webNotif) hint = t('Этот браузер не поддерживает уведомления.');
  else if (isIOS && !standalone) hint = t('На iPhone и iPad уведомления работают, если добавить Тайник на экран «Домой»: «Поделиться» → «На экран „Домой“».');
  else if (Notification.permission === 'denied') hint = t('Уведомления запрещены для этого сайта в настройках браузера (значок слева от адреса).');
  else if (enabled && webPush && !pushProblem)
    hint = t('Когда вкладка закрыта, сервер будит браузер через его push-сервис (Google, Mozilla или Apple). Текста сообщений там нет — только имя отправителя, зашифрованное для вашего браузера.');
  else if (enabled) hint = t('Уведомления приходят, пока вкладка открыта.');
  else hint = t('Текст сообщений по умолчанию не показывается: его увидят только те, кто смотрит на ваш экран.');
  $('notif-hint').textContent = hint;
  $('set-notif-value').textContent = enabled ? t('Вкл.') : t('Выкл.');
  if (desktop?.background) {
    const bg = await desktop.background.get();
    $('row-bg').hidden = false;
    $('bg-tray').checked = bg.tray;
    $('bg-autostart').checked = bg.autostart;
    $('bg-autostart').disabled = !bg.autostartSupported || (android && !bg.tray);
    if (android) {
      $('bg-tray-text').textContent = t('Получать сообщения и звонки, когда приложение закрыто (в шторке будет значок «Тайник на связи»)');
      $('bg-autostart-text').textContent = t('Включать после перезагрузки телефона');
      $('bg-hint').hidden = false;
      $('bg-hint').textContent = bg.batteryOptimized
        ? t('Система может усыплять Тайник для экономии батареи — тогда сообщения придут с задержкой. Разрешите работу без ограничений, когда телефон спросит, или в настройках приложения → «Батарея».')
        : t('На некоторых телефонах (Xiaomi, Huawei, Samsung и др.) дополнительно нужно разрешить автозапуск в настройках приложения.');
    }
  }
}
$('notif-enabled').addEventListener('change', async (e) => {
  const ok = e.target.checked ? await enableNotifications() : (await disableNotifications(), true);
  if (!ok) e.target.checked = false;
  $('notif-offer').hidden = true;
  await fillNotifSettings();
});
$('notif-preview').addEventListener('change', (e) => settings.set('notify-preview', e.target.checked ? '1' : '0'));
for (const id of ['bg-tray', 'bg-autostart']) {
  $(id).addEventListener('change', async (e) => {
    try {
      await desktop.background.set(id === 'bg-tray' ? 'tray' : 'autostart', e.target.checked);
    } catch (err) {
      e.target.checked = !e.target.checked;
      toast(err.message || t('Не удалось изменить настройку'));
    }
    if (android) fillNotifSettings();
  });
}

// ---------- Старт ----------
// Состояние храповика нельзя менять из двух вкладок сразу: держим блокировку.
function acquireInstanceLock() {
  if (desktop || !navigator.locks) return Promise.resolve(true);
  return new Promise((resolve) => {
    navigator.locks.request('tainik-instance', { ifAvailable: true }, (lock) => {
      resolve(!!lock);
      return lock ? new Promise(() => {}) : undefined; // держим до закрытия вкладки
    });
  });
}

// Адрес сервера для HTTP: ws(s)://хост/ws → http(s)://хост
const httpOrigin = (wsUrl) => {
  try {
    const u = new URL(wsUrl);
    return (u.protocol === 'wss:' ? 'https://' : 'http://') + u.host;
  } catch {
    return '';
  }
};
// Иконки: в вебе — с этого же сервера; в приложениях — встроенные сразу и свежие с сервера аккаунта
loadIcons(desktop ? httpOrigin(activeAccount()?.server || DEFAULT_SERVER) : '');

(async () => {
  if (!(await acquireInstanceLock())) {
    $('busy').hidden = false;
    return;
  }
  if (await client.load()) {
    client.url = activeAccount().server || (await settings.get('server')) || DEFAULT_SERVER;
    if (activeAccount().username !== client.account.username) await rememberAccount();
    await showApp();
    client.connect().catch((err) => toast(err.message, 0));
  } else {
    showAuth();
  }
})();


// ---------- Звонки ----------
// ---------- Выбор микрофона и динамика ----------
// Выбор хранится в настройках этого устройства (общий для аккаунтов). Идентификаторы устройств
// браузер выдаёт свои для каждого сайта/приложения; пропавшее устройство — значит системное.
// Объявлено до CallManager: звонок может прийти, пока настройки ещё читаются.
const canPickSpeaker = typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype;
const audioPrefs = { mic: '', speaker: '', micGain: 100, peerVol: 100 }; // громкость — в процентах
let remoteFx = null; // усиление звука собеседника больше 100%: { ctx, src, gain, stream }
let micMeter = null; // { stream, ctx, raf }
const calls = new CallManager({ client, onChange: renderCall });
audioPrefs.mic = (await settings.get('audio-in')) || '';
audioPrefs.speaker = (await settings.get('audio-out')) || '';
calls.micId = audioPrefs.mic;
const pct = (v, def = 100) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Math.min(200, Math.max(0, Math.round(Number(v)))) : def);
audioPrefs.micGain = pct(await settings.get('mic-gain'));
audioPrefs.peerVol = pct(await settings.get('peer-volume'));
calls.micGain = audioPrefs.micGain / 100;

async function listAudioDevices() {
  let list = [];
  try {
    list = await navigator.mediaDevices.enumerateDevices();
  } catch {}
  // «default» и «communications» (Chrome/Windows) — это то же, что «Системный»
  const pick = (kind) => list.filter((d) => d.kind === kind && d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications');
  return { mics: pick('audioinput'), speakers: pick('audiooutput'), labeled: list.some((d) => d.label) };
}
function fillDeviceSelect(sel, devices, current, fallbackName) {
  const opts = [el('option', '', t('Системный (по умолчанию)'))];
  opts[0].value = '';
  devices.forEach((d, i) => {
    const o = el('option', '', d.label || fallbackName(i + 1));
    o.value = d.deviceId;
    opts.push(o);
  });
  sel.replaceChildren(...opts);
  sel.value = devices.some((d) => d.deviceId === current) ? current : '';
}
async function renderAudioDevices() {
  const { mics, speakers, labeled } = await listAudioDevices();
  const micName = (n) => t('Микрофон {0}', n);
  const spkName = (n) => t('Динамик {0}', n);
  for (const id of ['dev-mic', 'call-dev-mic']) fillDeviceSelect($(id), mics, audioPrefs.mic, micName);
  for (const id of ['dev-speaker', 'call-dev-speaker']) fillDeviceSelect($(id), speakers, audioPrefs.speaker, spkName);
  const speakerOk = canPickSpeaker && speakers.length > 0;
  $('dev-speaker-row').hidden = $('call-dev-speaker-row').hidden = !speakerOk;
  $('dev-speaker-note').hidden = speakerOk;
  // Без разрешения на микрофон браузер не называет устройства
  $('dev-allow').hidden = labeled || !(mics.length || speakers.length);
}
/** Звук собеседника и гудки — в выбранное устройство вывода. */
async function applySpeaker() {
  calls.tones.setSink(audioPrefs.speaker);
  remoteFx?.ctx.setSinkId?.(audioPrefs.speaker).catch(() => remoteFx?.ctx.setSinkId?.('').catch(() => {}));
  if (!canPickSpeaker) return;
  for (const node of [$('remote-audio')]) {
    try {
      await node.setSinkId(audioPrefs.speaker);
    } catch {
      await node.setSinkId('').catch(() => {}); // устройство отключено — системное
    }
  }
}
async function chooseMic(id) {
  audioPrefs.mic = id;
  await settings.set('audio-in', id);
  try {
    await calls.setMicrophone(id);
  } catch (err) {
    toast(err?.name === 'NotAllowedError' ? t('Нет доступа к микрофону') : t('Не удалось включить этот микрофон'));
  }
  if (micMeter) startMicMeter();
  renderAudioDevices();
}
async function chooseSpeaker(id) {
  audioPrefs.speaker = id;
  await settings.set('audio-out', id);
  await applySpeaker();
  renderAudioDevices();
}
// ---------- Громкость: свой голос для собеседника и голос собеседника ----------
function dropRemoteFx() {
  if (!remoteFx) return;
  remoteFx.ctx.close().catch(() => {});
  remoteFx = null;
}
/**
 * Громкость собеседника. До 100% — громкость самого <audio>; больше — через WebAudio
 * (элемент при этом продолжает играть без звука: иначе Chrome не отдаёт звук WebRTC в WebAudio).
 * Элемент глушится, только когда WebAudio действительно заиграл, — иначе собеседника не было бы слышно.
 */
function applyPeerVolume() {
  const node = $('remote-audio');
  const vol = audioPrefs.peerVol / 100;
  const stream = node.srcObject;
  const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (vol <= 1 || !stream || !AC) {
    dropRemoteFx();
    node.muted = false;
    node.volume = Math.min(1, vol);
    return;
  }
  if (!remoteFx || remoteFx.stream !== stream) {
    dropRemoteFx();
    const ctx = new AC();
    const src = ctx.createMediaStreamSource(stream);
    const gain = ctx.createGain();
    src.connect(gain).connect(ctx.destination);
    remoteFx = { ctx, src, gain, stream };
    if (audioPrefs.speaker) ctx.setSinkId?.(audioPrefs.speaker).catch(() => {});
  }
  const fx = remoteFx;
  fx.gain.gain.value = vol;
  node.volume = 1;
  fx.ctx
    .resume()
    .catch(() => {})
    .then(() => {
      if (remoteFx === fx) node.muted = fx.ctx.state === 'running';
    });
}
function showVolumes() {
  for (const [id, v] of [['vol-mic', audioPrefs.micGain], ['call-vol-mic', audioPrefs.micGain], ['vol-peer', audioPrefs.peerVol], ['call-vol-peer', audioPrefs.peerVol]]) {
    if (document.activeElement !== $(id)) $(id).value = String(v);
    $(id + '-val').textContent = `${v}%`;
  }
}
async function setMicGain(v) {
  audioPrefs.micGain = pct(v);
  showVolumes();
  if (micMeter?.gain) micMeter.gain.gain.value = audioPrefs.micGain / 100;
  await calls.setMicGain(audioPrefs.micGain / 100).catch(() => {});
  await settings.set('mic-gain', String(audioPrefs.micGain));
}
async function setPeerVolume(v) {
  audioPrefs.peerVol = pct(v);
  showVolumes();
  applyPeerVolume();
  await settings.set('peer-volume', String(audioPrefs.peerVol));
}
for (const id of ['vol-mic', 'call-vol-mic']) $(id).addEventListener('input', (e) => setMicGain(e.target.value));
for (const id of ['vol-peer', 'call-vol-peer']) $(id).addEventListener('input', (e) => setPeerVolume(e.target.value));
showVolumes();

for (const id of ['dev-mic', 'call-dev-mic']) $(id).addEventListener('change', (e) => chooseMic(e.target.value));
for (const id of ['dev-speaker', 'call-dev-speaker']) $(id).addEventListener('change', (e) => chooseSpeaker(e.target.value));
navigator.mediaDevices?.addEventListener?.('devicechange', () => {
  renderAudioDevices();
  applySpeaker();
});
applySpeaker();

// Индикатор громкости микрофона на странице настроек — чтобы проверить, что выбран нужный
function stopMicMeter() {
  if (!micMeter) return;
  cancelAnimationFrame(micMeter.raf);
  micMeter.stream?.getTracks().forEach((tr) => tr.stop());
  micMeter.ctx?.close().catch(() => {});
  micMeter = null;
  $('dev-mic-level').style.width = '0';
}
async function startMicMeter() {
  stopMicMeter();
  if (calls.busy) return; // во время звонка микрофон занят звонком
  const m = (micMeter = {});
  try {
    const audio = audioPrefs.mic ? { deviceId: { ideal: audioPrefs.mic } } : true;
    m.stream = await navigator.mediaDevices.getUserMedia({ audio });
  } catch {
    if (micMeter === m) micMeter = null;
    return;
  }
  if (micMeter !== m) return m.stream.getTracks().forEach((tr) => tr.stop());
  const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
  m.ctx = new AC();
  const an = m.ctx.createAnalyser();
  an.fftSize = 512;
  m.gain = m.ctx.createGain(); // индикатор показывает громкость с учётом «Громкости моего голоса»
  m.gain.gain.value = audioPrefs.micGain / 100;
  m.ctx.createMediaStreamSource(m.stream).connect(m.gain).connect(an);
  const buf = new Uint8Array(an.fftSize);
  const tick = () => {
    an.getByteTimeDomainData(buf);
    let peak = 0;
    for (const v of buf) peak = Math.max(peak, Math.abs(v - 128));
    $('dev-mic-level').style.width = `${Math.min(100, (peak / 128) * 160)}%`;
    m.raf = requestAnimationFrame(tick);
  };
  tick();
  renderAudioDevices(); // после разрешения появились названия устройств
}
async function openMediaPage() {
  await renderAudioDevices();
  startMicMeter();
}
$('menu-dialog').addEventListener('close', stopMicMeter);
$('dev-allow').addEventListener('click', () => startMicMeter());

// Проверка динамика: короткий сигнал через выбранное устройство (WAV в памяти — без файлов)
function testTone() {
  const rate = 24000;
  const n = Math.floor(rate * 0.7);
  const view = new DataView(new ArrayBuffer(44 + n * 2));
  const str = (o, x) => [...x].forEach((ch, i) => view.setUint8(o + i, ch.charCodeAt(0)));
  str(0, 'RIFF');
  view.setUint32(4, 36 + n * 2, true);
  str(8, 'WAVEfmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  str(36, 'data');
  view.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    const tt = i / rate;
    const f = tt < 0.35 ? 660 : 880;
    const env = Math.min(1, (tt % 0.35) * 40, (0.35 - (tt % 0.35)) * 40);
    view.setInt16(44 + i * 2, Math.sin(2 * Math.PI * f * tt) * env * 9000, true);
  }
  return new Blob([view.buffer], { type: 'audio/wav' });
}
$('dev-speaker-test').addEventListener('click', async () => {
  const url = URL.createObjectURL(testTone());
  const a = new Audio(url);
  try {
    if (canPickSpeaker && audioPrefs.speaker) await a.setSinkId(audioPrefs.speaker).catch(() => {});
    await a.play();
  } catch {
    toast(t('Не удалось воспроизвести звук'));
  }
  a.onended = () => URL.revokeObjectURL(url);
});

// Во время звонка: кнопка «Звук» открывает выбор микрофона и динамика
function toggleCallDevMenu(open = $('call-dev-menu').hidden) {
  $('call-dev-menu').hidden = !open;
  $('call-devices').classList.toggle('on', open);
  $('call-devices').setAttribute('aria-expanded', String(open));
  if (open) {
    renderAudioDevices();
    showVolumes();
  }
}
$('call-devices').addEventListener('click', () => toggleCallDevMenu());
let callTicker = null;

function fmtDur(ms) {
  const sec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(sec / 3600);
  const mm = String(Math.floor((sec % 3600) / 60)).padStart(h ? 2 : 1, '0');
  const ss = String(sec % 60).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function callStatusText(c) {
  if (c.phase === 'ended') return CALL_RESULT_TEXT[c.result] === t('звонок') ? t('Звонок завершён') : (CALL_RESULT_TEXT[c.result] || t('Звонок завершён')).replace(/^./, (x) => x.toUpperCase());
  if (c.reconnecting) return t('Переподключение…');
  switch (c.phase) {
    case 'preparing':
      return t('Подготовка…');
    case 'outgoing':
      return t('Вызов…');
    case 'incoming':
      return c.video ? t('Входящий видеозвонок') : t('Входящий звонок');
    case 'connecting':
      return t('Соединение…');
    case 'active':
      return fmtDur(Date.now() - c.startedAt);
  }
  return '';
}

// Окошки с видео подстраиваются под пропорции картинки: вертикальная камера телефона
// и экран любого размера показываются целиком, а не обрезаются рамкой 16:10.
function trackAspect(video, box = video) {
  const apply = () => {
    const w = video.videoWidth;
    const h = video.videoHeight;
    if (!w || !h) return;
    box.style.aspectRatio = `${w} / ${h}`;
    box.classList.toggle('portrait', h > w);
    // Камера собеседника на весь экран обрезается, только если ориентации совпадают
    if (video === $('remote-main')) video.classList.toggle('mismatch', h > w !== video.clientHeight > video.clientWidth);
  };
  video.addEventListener('loadedmetadata', apply);
  video.addEventListener('resize', apply);
  window.addEventListener('resize', apply);
}
for (const v of document.querySelectorAll('video.fit-aspect')) trackAspect(v);
trackAspect($('remote-main'));
trackAspect($('call-float-video'), $('call-float'));

// MediaStream на каждый свой трек — один и тот же, иначе видео перезапускается при каждой перерисовке
const localStreams = new WeakMap();
function streamOf(track) {
  if (!track) return null;
  let s = localStreams.get(track);
  if (!s) localStreams.set(track, (s = new MediaStream([track])));
  return s;
}

function setVideo(node, stream, show) {
  if (show) {
    if (node.srcObject !== stream) node.srcObject = stream;
    node.hidden = false;
    node.play?.().catch(() => {});
  } else {
    node.hidden = true;
    if (node.srcObject) node.srcObject = null;
  }
}

// Нативной оболочке важно знать о звонке: снять уведомление «Входящий звонок»
// и, пока идёт разговор, не дать системе отнять микрофон в фоне.
let nativeCallActive = false;
let callNoticeUp = false;
function syncNativeCall(c) {
  const active = !!c && ['preparing', 'outgoing', 'connecting', 'active'].includes(c.phase);
  if (active !== nativeCallActive && desktop?.callActive) desktop.callActive(active, c?.peer || '');
  nativeCallActive = active;
  if (callNoticeUp && c?.phase !== 'incoming') {
    callNoticeUp = false;
    desktop?.dismissNotice?.({ call: true });
  }
}

// Свёрнутый звонок: экран звонка прячется, сверху — полоска «вернуться к звонку»,
// а видео собеседника (если есть) — в маленьком окошке, которое можно перетаскивать.
// Разговор продолжается, можно переписываться в любых чатах.
let callMinimized = false;
let callSwap = false; // экран и камера собеседника поменяны местами
let shownCallId = null;
let endedToastFor = null;
const canMinimize = (c) => !!c && c.phase !== 'incoming' && c.phase !== 'ended';

function minimizeCall() {
  if (!canMinimize(calls.call)) return false;
  callMinimized = true;
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  renderCall(calls.call);
  return true;
}
function expandCall() {
  if (!calls.call) return;
  callMinimized = false;
  renderCall(calls.call);
}

function renderMini(c, main) {
  const on = !!c && callMinimized && c.phase !== 'ended';
  $('call-mini').hidden = !on;
  document.body.classList.toggle('call-min', on);
  const float = on && !!main;
  setVideo($('call-float-video'), float ? main : null, float);
  $('call-float').hidden = !float;
  if (!on) return;
  setName($('call-mini-name'), c.peer, client.isVerified(c.peer));
  $('call-mini-status').textContent = callStatusText(c);
  const micOff = !c.local.mic || !c.local.mic.enabled;
  $('call-mini-mic').classList.toggle('off', micOff);
  $('call-mini-mic').setAttribute('aria-pressed', String(micOff));
}

function renderCall(c) {
  syncNativeCall(c);
  if ((c?.id ?? null) !== shownCallId) {
    shownCallId = c?.id ?? null;
    callMinimized = false;
    callSwap = false;
  }
  if (c?.phase === 'incoming') callMinimized = false;
  const box = $('call');
  if (!c) {
    box.hidden = true;
    renderMini(null, null);
    clearInterval(callTicker);
    callTicker = null;
    for (const id of ['remote-main', 'remote-pip', 'local-pip', 'local-screen']) setVideo($(id), null, false);
    $('remote-audio').srcObject = null;
    dropRemoteFx();
    toggleCallDevMenu(false);
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    document.title = baseTitle();
    return;
  }
  // Звонок закончился, пока был свёрнут, — не разворачиваем, просто сообщаем
  box.hidden = callMinimized;
  if (c.phase === 'ended' && callMinimized && endedToastFor !== c.id) {
    endedToastFor = c.id;
    toast(`${c.peer}: ${callStatusText(c).toLowerCase()}`);
  }
  setName($('call-name'), c.peer, client.isVerified(c.peer));
  setName($('call-top-name'), c.peer, client.isVerified(c.peer));
  paintAvatar($('call-avatar'), c.peer);
  const status = callStatusText(c);
  $('call-status').textContent = status;
  $('call-top-status').textContent = status;

  // Звук собеседника
  if (c.remote.audio.getTracks().length && $('remote-audio').srcObject !== c.remote.audio) {
    $('remote-audio').srcObject = c.remote.audio;
    applySpeaker().finally(() => {
      $('remote-audio').play().catch(() => {});
      applyPeerVolume();
    });
  }

  // Видео: экран собеседника — главный, камера — в окошке (нажатие меняет их местами)
  const live = c.phase === 'active' || c.phase === 'connecting';
  const rScreen = live && c.remoteState.screen && c.remote.screen.getTracks().length > 0;
  const rCam = live && c.remoteState.cam && c.remote.cam.getTracks().length > 0;
  const both = rScreen && rCam;
  const main = both && callSwap ? c.remote.cam : rScreen ? c.remote.screen : rCam ? c.remote.cam : null;
  const pip = both ? (callSwap ? c.remote.screen : c.remote.cam) : null;
  setVideo($('remote-main'), main, !!main);
  $('remote-main').classList.toggle('cover', !!main && main === c.remote.cam);
  setVideo($('remote-pip'), pip, !!pip);
  $('remote-pip').classList.toggle('contain', pip === c.remote.screen);
  $('call-placeholder').hidden = !!main;
  $('call-topbar').hidden = !main;
  $('call-fullscreen').hidden = !main || android || !document.fullscreenEnabled;

  // Своё превью: камера (зеркально) и показываемый экран — отдельно, экран целиком
  const ended = c.phase === 'ended';
  setVideo($('local-pip'), streamOf(c.local.cam), !!c.local.cam && !ended);
  setVideo($('local-screen'), streamOf(c.local.screen), !!c.local.screen && !ended);
  $('sharing-badge').hidden = !c.local.screen || ended;
  $('call-minimize').hidden = !canMinimize(c);
  renderMini(c, main);

  // Кнопки
  $('call-incoming').hidden = c.phase !== 'incoming';
  if (c.phase === 'incoming' || c.phase === 'ended') toggleCallDevMenu(false);
  $('call-active').hidden = c.phase === 'incoming' || c.phase === 'ended';
  const mic = $('call-mic');
  const micOff = !c.local.mic || !c.local.mic.enabled;
  mic.classList.toggle('off', micOff);
  mic.setAttribute('aria-pressed', String(micOff));
  mic.querySelector('span').textContent = micOff ? t('Вкл. микрофон') : t('Микрофон');
  $('call-cam').classList.toggle('on', !!c.local.cam);
  $('call-cam').setAttribute('aria-pressed', String(!!c.local.cam));
  $('call-screen').classList.toggle('on', !!c.local.screen);
  $('call-screen').setAttribute('aria-pressed', String(!!c.local.screen));
  const inCall = c.phase === 'active' || c.phase === 'connecting';
  $('call-cam').disabled = !inCall;
  $('call-screen').disabled = !inCall || !(navigator.mediaDevices?.getDisplayMedia);
  $('call-screen').hidden = android; // WebView в Android не умеет показывать экран

  if (c.phase === 'active' && !callTicker) {
    callTicker = setInterval(() => {
      if (calls.call?.phase === 'active') {
        const st = callStatusText(calls.call);
        $('call-status').textContent = st;
        $('call-top-status').textContent = st;
        $('call-mini-status').textContent = st;
      }
    }, 1000);
  }
  if (c.phase === 'incoming') {
    document.title = t('📞 {0} — входящий звонок', c.peer);
    if (!document.hasFocus() && notifiedCall !== c.id) {
      notifiedCall = c.id;
      callNoticeUp = true;
      showNotice({ title: nameOf(c.peer), body: c.video ? t('Входящий видеозвонок') : t('Входящий звонок'), chat: c.peer, tag: 'call:' + c.peer, call: true });
    }
  } else {
    document.title = baseTitle();
  }
}

async function startCall(video) {
  if (!current || isGroupChat(current)) return;
  try {
    await calls.start(current, { video });
  } catch (err) {
    if (err.message !== 'cancelled') toast(err.message || t('Не удалось позвонить'));
  }
}
$('call-audio-btn').addEventListener('click', () => startCall(false));
$('call-video-btn').addEventListener('click', () => startCall(true));
$('call-accept-audio').addEventListener('click', () => calls.accept({ video: false }).catch((e) => toast(e.message)));
$('call-accept-video').addEventListener('click', () => calls.accept({ video: true }).catch((e) => toast(e.message)));
$('call-decline').addEventListener('click', () => calls.decline());
$('call-hangup').addEventListener('click', () => calls.hangup());

// Свернуть и развернуть звонок
$('call-minimize').addEventListener('click', minimizeCall);
$('call-mini-open').addEventListener('click', expandCall);
$('call-mini-mic').addEventListener('click', () => calls.toggleMic());
$('call-mini-hangup').addEventListener('click', () => calls.hangup());
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || $('call').hidden || document.fullscreenElement || document.querySelector('dialog[open]')) return;
  minimizeCall();
});
$('remote-pip').addEventListener('click', () => {
  callSwap = !callSwap;
  renderCall(calls.call);
});
function toggleFullscreen() {
  if (android || !document.fullscreenEnabled) return;
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  else $('call').requestFullscreen().catch(() => {});
}
$('call-fullscreen').addEventListener('click', toggleFullscreen);
$('remote-main').addEventListener('dblclick', toggleFullscreen);

// Окошко с видео свёрнутого звонка: перетаскивается, нажатие — вернуться к звонку
{
  const f = $('call-float');
  let drag = null;
  const clampTo = (v, lo, hi) => Math.max(lo, Math.min(v, hi));
  const place = (x, y) => {
    const r = f.getBoundingClientRect();
    f.style.left = clampTo(x, 8, innerWidth - r.width - 8) + 'px';
    f.style.top = clampTo(y, 52, innerHeight - r.height - 8) + 'px';
    f.style.right = 'auto';
    f.style.bottom = 'auto';
  };
  f.addEventListener('pointerdown', (e) => {
    drag = { x: e.clientX, y: e.clientY, r: f.getBoundingClientRect(), moved: false };
    f.setPointerCapture(e.pointerId);
  });
  f.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < 6) return;
    drag.moved = true;
    f.classList.add('dragging');
    place(drag.r.left + dx, drag.r.top + dy);
  });
  f.addEventListener('pointerup', () => {
    if (drag && !drag.moved) expandCall();
    drag = null;
    f.classList.remove('dragging');
  });
  f.addEventListener('pointercancel', () => {
    drag = null;
    f.classList.remove('dragging');
  });
  window.addEventListener('resize', () => {
    if (f.style.left) place(parseFloat(f.style.left), parseFloat(f.style.top));
  });
}
$('call-mic').addEventListener('click', () => calls.toggleMic());
$('call-cam').addEventListener('click', () => calls.toggleCamera().catch(() => toast(t('Камера недоступна'))));
$('call-screen').addEventListener('click', () =>
  calls.toggleScreen().catch((e) => {
    if (e?.name !== 'NotAllowedError' && e?.name !== 'AbortError') toast(e.message || t('Не удалось показать экран'));
  })
);
window.addEventListener('beforeunload', () => calls.busy && calls.hangup());

// Десктоп: выбор экрана или окна для трансляции
if (desktop?.onPickSource) {
  desktop.onPickSource(
    (sources) =>
      new Promise((resolve) => {
        const dlg = $('screen-dialog');
        const box = $('screen-sources');
        let chosen = null;
        box.replaceChildren(
          ...sources.map((s) => {
            const b = el('button');
            b.type = 'button';
            const img = el('img');
            img.alt = '';
            img.src = s.thumb;
            b.append(img, el('span', '', s.name));
            b.addEventListener('click', () => {
              chosen = s.id;
              dlg.close();
            });
            return b;
          })
        );
        const onClose = () => {
          dlg.removeEventListener('close', onClose);
          resolve(chosen);
        };
        dlg.addEventListener('close', onClose);
        $('screen-cancel').onclick = () => dlg.close();
        dlg.showModal();
      })
  );
}


// ---------- Ответы и удаление ----------
let reply = null; // { id, name, text }

function setReply(r) {
  reply = r;
  $('reply-bar').hidden = !r;
  if (r) {
    $('reply-name').textContent = r.name;
    $('reply-text').textContent = r.text;
    $('text').focus();
  }
}
$('reply-cancel').addEventListener('click', () => setReply(null));

async function findMsg(id) {
  return (await client.messages(current)).find((m) => m.id === id);
}

async function replyTo(id) {
  const m = await findMsg(id);
  if (!m || m.dir === 'sys') return;
  setReply({ id, name: m.dir === 'out' ? t('Вы') : nameOf(m.from || current), text: textOf(m.content).replace(/\s+/g, ' ').slice(0, 120) });
}

// Меню сообщения
let menuFor = null;
async function openMenu(id, x, y) {
  menuFor = id;
  const menu = $('msg-menu');
  const m = await findMsg(id);
  if (menuFor !== id) return;
  menu.querySelector('[data-act="save"]').hidden = !m?.content?.file;
  const sys = isSystemChat(current) || isSupportChat(current);
  menu.querySelector('[data-act="reply"]').hidden = isChannelChat(current) || sys;
  menu.querySelector('[data-act="pin"]').hidden = sys;
  const pinnedId = (await client.contacts())[current]?.pinned?.id;
  menu.querySelector('[data-act="pin"]').replaceChildren(icon('pin'), pinnedId === id ? t('Открепить') : t('Закрепить'));
  menu.querySelector('[data-act="forward"]').hidden = !m || m.dir === 'sys' || sys;
  menu.querySelector('[data-act="copy"]').hidden = !!m?.content?.file && !m.content.body;
  menu.hidden = false;
  const w = menu.offsetWidth;
  const h = menu.offsetHeight;
  menu.style.left = Math.max(8, Math.min(x, innerWidth - w - 8)) + 'px';
  menu.style.top = Math.max(8, Math.min(y, innerHeight - h - 8)) + 'px';
  menu.querySelector('button').focus();
}
function closeMenu() {
  $('msg-menu').hidden = true;
  menuFor = null;
}
document.addEventListener('click', (e) => {
  if (!$('msg-menu').hidden && !e.target.closest('#msg-menu') && !e.target.closest('[data-act="menu"]')) closeMenu();
});
document.addEventListener('keydown', (e) => e.key === 'Escape' && closeMenu());
$('messages').addEventListener('scroll', closeMenu);

const msgId = (node) => node.closest('.msg[data-id]')?.dataset.id;

$('messages').addEventListener('click', (e) => {
  const q = e.target.closest('.quote');
  if (q) {
    const target = $('messages').querySelector(`.msg[data-id="${CSS.escape(q.dataset.target)}"]`);
    if (!target) return toast(t('Сообщение удалено'));
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    target.classList.remove('flash');
    void target.offsetWidth;
    target.classList.add('flash');
    return;
  }
  if (e.target.closest('.vwave, .note-seek')) return; // перемотка — в pointerdown
  const act = e.target.closest('[data-act]');
  if (!act) return;
  if (act.dataset.act === 'cancel-upload') return cancelUpload(act.dataset.up);
  if (act.dataset.act === 'from') return openProfile(act.dataset.user);
  const id = msgId(act);
  if (!id) return;
  if (act.dataset.act === 'reply') return replyTo(id);
  if (act.dataset.act === 'open') return openMedia(id);
  if (act.dataset.act === 'vplay') return togglePlay(id);
  if (act.dataset.act === 'menu') {
    const r = act.getBoundingClientRect();
    openMenu(id, r.left, r.bottom + 4);
  }
});
$('messages').addEventListener('contextmenu', (e) => {
  const id = msgId(e.target);
  if (!id || e.target.closest('.msg.sys')) return;
  e.preventDefault();
  openMenu(id, e.clientX, e.clientY);
});
// Долгое нажатие на телефоне
let pressTimer = null;
$('messages').addEventListener('touchstart', (e) => {
  const id = msgId(e.target);
  if (!id) return;
  const touch = e.touches[0];
  pressTimer = setTimeout(() => openMenu(id, touch.clientX, touch.clientY), 500);
}, { passive: true });
for (const ev of ['touchend', 'touchmove', 'touchcancel']) $('messages').addEventListener(ev, () => clearTimeout(pressTimer), { passive: true });

$('msg-menu').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-act]');
  if (!b || !menuFor) return;
  const id = menuFor;
  closeMenu();
  if (b.dataset.act === 'reply') return replyTo(id);
  if (b.dataset.act === 'forward') return openForward(id);
  if (b.dataset.act === 'pin') {
    const c = (await client.contacts())[current];
    return client.pinMessage(current, c?.pinned?.id === id ? null : id).catch((err) => toast(err.message));
  }
  if (b.dataset.act === 'save') {
    const m = await findMsg(id);
    if (m?.content?.file) saveMedia(m.content.file);
    return;
  }
  if (b.dataset.act === 'copy') {
    try {
      await copyText(msgText.get(id) ?? (await findMsg(id))?.content?.body ?? '');
      toast(t('Скопировано'));
    } catch {
      toast(t('Не удалось скопировать'));
    }
    return;
  }
  if (b.dataset.act === 'delete') {
    const m = await findMsg(id);
    const group = isGroupChat(current);
    const chan = isChannelChat(current);
    // В группе «у всех» — только для своих сообщений, в канале — для владельца и администраторов
    $('del-all').closest('label').hidden = isSystemChat(current) || isSupportChat(current) || (chan ? !isChAdmin(await client.channelOf(current)) : group && m?.dir !== 'out');
    $('del-peer').textContent = chan ? t('всех подписчиков') : group ? t('всех участников') : nameOf(current);
    $('del-all').checked = false;
    $('delete-dialog').dataset.id = id;
    $('delete-dialog').showModal();
  }
});

$('delete-dialog').addEventListener('close', async () => {
  const dlg = $('delete-dialog');
  if (dlg.returnValue !== 'delete' || !current) return;
  const id = dlg.dataset.id;
  if (reply?.id === id) setReply(null);
  try {
    await client.deleteMessages(current, [id], { forAll: $('del-all').checked });
  } catch (err) {
    toast(err.message);
  }
});

client.on('deleted', async ({ contact, ids, chat }) => {
  // Непрочитанных не осталось (удалили у всех или весь чат) — уведомление о них тоже не нужно
  if (!(await client.contacts())[contact]?.unread) clearChatNotices(contact);
  if (contact === current) renderPin();
  if (reply && ids.includes(reply.id) && contact === current) setReply(null);
  // Чат удалён (здесь или на другом своём устройстве) — закрываем его
  if (chat && contact === current && (await client.contacts())[contact]?.hidden) {
    $('back-btn').click();
    return;
  }
  if (contact === current) await renderChat();
  renderContacts();
});

// ---------- Профиль собеседника, как в Telegram ----------
let profileFor = null;
let profileTab = 'media';
async function openProfile(name) {
  if (isGroupChat(name)) return openGroup(name);
  if (isChannelChat(name)) return openChannelInfo(name);
  if (isSystemChat(name) || isSupportChat(name)) return;
  if (name === client.account?.username) return openSettings('profile');
  profileFor = name;
  profileTab = 'media';
  await renderProfile();
  if (!$('profile-dialog').open) $('profile-dialog').showModal();
  $('profile-dialog').querySelector('.settings-form').scrollTop = 0;
}

async function renderProfile() {
  const name = profileFor;
  if (!name) return;
  const c = (await client.contacts())[name];
  const prof = c?.profile;
  paintAvatar($('pf-avatar'), name);
  paintCover($('pf-cover'), name);
  setName($('pf-name'), name, client.isVerified(name));
  if (client.isBlocked(name)) iconText($('pf-status'), 'block', t('заблокирован'));
  else $('pf-status').textContent = presenceText(client.presenceOf(name)) || '';
  $('pf-status').classList.toggle('online', !!client.presenceOf(name)?.online && !client.isBlocked(name));
  $('pf-username').textContent = '@' + name;
  $('pf-bio-row').hidden = !prof?.bio;
  $('pf-bio').replaceChildren();
  linkNodes($('pf-bio'), prof?.bio || '');
  // Каналы, которые собеседник прикрепил к профилю: нажатие — открыть канал (подписаться)
  $('pf-channels').replaceChildren(
    ...(prof?.channels || []).map((ch) => {
      const b = el('button', 'set-row pf-info');
      b.type = 'button';
      const text = el('span', 'pf-info-text');
      text.append(el('b', '', ch.title || t('Канал')), el('span', 'small muted', ch.ref.startsWith('@') ? t('Канал · {0}', ch.ref) : t('Канал · приватный')));
      const ico = el('span', 'set-ico');
      ico.append(icon('channel'));
      b.append(ico, text, el('span', 'set-chev', '›'));
      b.addEventListener('click', () => {
        $('profile-dialog').close();
        openChannels(ch.ref);
      });
      return b;
    })
  );
  if (c?.keyChanged) iconText($('pf-key'), 'warning', t('ключ изменился — сверьте код'));
  else if (c?.verified) iconText($('pf-key'), 'check', t('ключ проверен'));
  else iconText($('pf-key'), 'lock', t('ключ не проверен'));
  const noCall = !c || !!c.keyChanged || client.isBlocked(name) || client.status !== 'online' || !window.RTCPeerConnection;
  $('pf-call').disabled = noCall;
  $('pf-video').disabled = noCall;
  $('pf-gift').hidden = !client.billing?.plans?.length || client.isBlocked(name);
  const blocked = client.isBlocked(name);
  $('pf-block').classList.toggle('danger', !blocked);
  const blockIco = el('span', 'set-ico');
  blockIco.append(icon(blocked ? 'check' : 'block'));
  $('pf-block').replaceChildren(blockIco, el('span', 'set-label', blocked ? t('Разблокировать') : t('Заблокировать')));
  for (const b of document.querySelectorAll('#profile-dialog .pf-tab')) b.classList.toggle('active', b.dataset.tab === profileTab);
  // Медиа и файлы из переписки (новые сверху)
  const files = (await client.messages(name)).filter((m) => m.content?.t === 'file' && m.content.file).reverse();
  if (profileFor !== name) return;
  const pics = files.filter((m) => m.content.file.kind === 'image' || m.content.file.kind === 'video');
  const docs = files.filter((m) => m.content.file.kind === 'file' || m.content.file.kind === 'audio');
  $('pf-media').hidden = profileTab !== 'media';
  $('pf-files').hidden = profileTab !== 'files' || !docs.length;
  const list = profileTab === 'media' ? pics : docs;
  $('pf-empty').hidden = list.length > 0;
  $('pf-empty').textContent = profileTab === 'media' ? t('Здесь будут фото и видео из переписки') : t('Здесь будут файлы из переписки');
  if (profileTab === 'media') {
    $('pf-media').replaceChildren(
      ...pics.slice(0, 90).map((m) => {
        const f = m.content.file;
        const b = el('button', 'pf-thumb');
        b.type = 'button';
        b.dataset.msg = m.id;
        b.setAttribute('aria-label', `${KIND_LABEL[f.kind]}: ${f.name}`);
        const cached = cachedImage(f);
        if (cached || f.thumb) {
          const img = el('img');
          img.alt = '';
          img.src = cached || f.thumb;
          if (!cached) img.className = 'blur';
          b.append(img);
        }
        if (f.kind === 'video') b.append(el('span', 'pf-play', '▶'));
        return b;
      })
    );
  } else {
    $('pf-files').replaceChildren(
      ...docs.slice(0, 200).map((m) => {
        const f = m.content.file;
        const li = el('li');
        const b = el('button', 'set-row');
        b.type = 'button';
        b.dataset.msg = m.id;
        const info = el('span', 'file-info');
        info.append(el('span', 'file-name', f.name), el('span', 'file-size', `${sizeText(f.size)} · ${dayLabel(m.ts)}`));
        b.append(icon(f.kind === 'audio' ? 'music' : 'file', 'file-icon'), info);
        li.append(b);
        return li;
      })
    );
  }
}
/** Уже расшифрованное фото из памяти (без скачивания). */
function cachedImage(f) {
  const e = media.get(f.id);
  return f.kind === 'image' && e?.url ? e.url : null;
}

$('pf-close').addEventListener('click', () => $('profile-dialog').close());
// Собеседник прислал новый профиль (имя, фото, своё видео на фон)
client.on('profile-changed', ({ username }) => {
  if ($('profile-dialog').open && profileFor === username) renderProfile();
});
$('profile-dialog').addEventListener('close', () => (profileFor = null));
$('profile-dialog').addEventListener('click', async (e) => {
  const tab = e.target.closest('.pf-tab');
  if (tab) {
    profileTab = tab.dataset.tab;
    return renderProfile();
  }
  const item = e.target.closest('[data-msg]');
  if (item && profileFor) {
    const name = profileFor;
    if (current !== name) await openChat(name);
    openMedia(item.dataset.msg);
  }
});
$('pf-chat').addEventListener('click', async () => {
  const name = profileFor;
  $('profile-dialog').close();
  if (name) await openChat(name);
});
for (const [id, video] of [['pf-call', false], ['pf-video', true]]) {
  $(id).addEventListener('click', async () => {
    const name = profileFor;
    $('profile-dialog').close();
    if (!name) return;
    if (current !== name) await openChat(name);
    startCall(video);
  });
}
$('pf-username-row').addEventListener('click', async () => {
  try {
    await copyText('@' + profileFor);
    toast(t('Юзернейм скопирован'));
  } catch {}
});
$('pf-key-row').addEventListener('click', async () => {
  const name = profileFor;
  $('profile-dialog').close();
  if (current !== name) await openChat(name);
  openSafety();
});
$('pf-gift').addEventListener('click', () => profileFor && giftPremium(profileFor));
$('pf-block').addEventListener('click', () => {
  const name = profileFor;
  if (client.isBlocked(name)) return setBlocked(name, false);
  $('profile-dialog').close();
  $('block-peer').textContent = nameOf(name);
  $('block-delete').checked = false;
  $('block-dialog').dataset.name = name;
  $('block-dialog').returnValue = '';
  $('block-dialog').showModal();
});
$('pf-delete').addEventListener('click', () => {
  const name = profileFor;
  $('profile-dialog').close();
  $('delchat-peer').textContent = nameOf(name);
  $('delchat-peer2').textContent = nameOf(name);
  $('delchat-all').checked = false;
  $('delchat-all').closest('label').hidden = false;
  $('delchat-dialog').dataset.name = name;
  $('delchat-dialog').returnValue = '';
  $('delchat-dialog').showModal();
});
// Нажатие на имя или аватар в шапке чата
for (const id of ['peer-open', 'peer-avatar']) {
  $(id).addEventListener('click', () => current && openProfile(current));
  $(id).addEventListener('keydown', (e) => (e.key === 'Enter' || e.key === ' ') && current && (e.preventDefault(), openProfile(current)));
}
for (const ev of ['contacts', 'presence', 'blocks']) client.on(ev, () => $('profile-dialog').open && renderProfile());

// ---------- Группы ----------
// Новая группа: название и участники (из ваших чатов или по юзернейму)
const ngPicked = new Set();
function renderPickList(all) {
  const me = client.account.username;
  const people = Object.values(all)
    .filter((c) => !c.group && !c.hidden && c.username !== me)
    .sort((a, b) => b.lastTs - a.lastTs)
    .map((c) => c.username);
  for (const u of ngPicked) if (!people.includes(u)) people.unshift(u);
  $('ng-none').hidden = people.length > 0;
  $('ng-list').replaceChildren(
    ...people.map((u) => {
      const li = el('li');
      const lab = el('label');
      const cb = el('input');
      cb.type = 'checkbox';
      cb.checked = ngPicked.has(u);
      cb.addEventListener('change', () => (cb.checked ? ngPicked.add(u) : ngPicked.delete(u)));
      const av = el('span', 'avatar');
      paintAvatar(av, u);
      const body = el('span', 'p-name');
      body.append(document.createTextNode(nameOf(u) + ' '), el('span', 'p-user', '@' + u));
      lab.append(cb, av, body);
      li.append(lab);
      return li;
    })
  );
}
async function openNewGroup() {
  ngPicked.clear();
  $('ng-name').value = '';
  $('ng-add').value = '';
  $('ng-error').textContent = '';
  renderPickList(await client.contacts());
  $('newgroup-dialog').showModal();
  $('ng-name').focus();
}
$('new-group-btn').addEventListener('click', () => client.account && openNewGroup());
async function ngAdd() {
  const u = $('ng-add').value.trim().replace(/^@/, '').toLowerCase();
  $('ng-error').textContent = '';
  if (!u) return;
  if (u === client.account.username) return ($('ng-error').textContent = t('Это вы'));
  try {
    if (!(await client.fetchIdentity(u))) throw new Error(ERROR_TEXT.unknown_recipient);
  } catch (err) {
    $('ng-error').textContent = err.message;
    return;
  }
  ngPicked.add(u);
  $('ng-add').value = '';
  renderPickList(await client.contacts());
}
$('ng-add-btn').addEventListener('click', ngAdd);
$('ng-add').addEventListener('keydown', (e) => e.key === 'Enter' && (e.preventDefault(), ngAdd()));
$('ng-create').addEventListener('click', async () => {
  $('ng-error').textContent = '';
  if (!$('ng-name').value.trim()) return ($('ng-error').textContent = ERROR_TEXT.group_name);
  if (ngPicked.size + 1 > GROUP_MAX) return ($('ng-error').textContent = ERROR_TEXT.group_too_big);
  $('ng-create').disabled = true;
  try {
    const chat = await client.createGroup($('ng-name').value, [...ngPicked]);
    $('newgroup-dialog').close();
    await openChat(chat);
  } catch (err) {
    $('ng-error').textContent = err.user ? t('Нет пользователя @{0}', err.user) : err.message;
  } finally {
    $('ng-create').disabled = false;
  }
});

// О группе: состав, админы, название; админ добавляет и исключает
// ---------- Каналы ----------
// Найти (по @имени или ссылке-приглашению) или создать; «О канале» — ссылка, описание, администраторы.
let cnPreview = null;
function cnTab(tab) {
  for (const b of document.querySelectorAll('#channel-new [data-cn-tab]')) {
    b.classList.toggle('active', b.dataset.cnTab === tab);
    b.setAttribute('aria-selected', String(b.dataset.cnTab === tab));
  }
  $('cn-find').hidden = tab !== 'find';
  $('cn-create').hidden = tab !== 'create';
  $('cn-error').textContent = '';
  (tab === 'find' ? $('cn-ref') : $('cn-title')).focus();
}
function openChannels(ref = '') {
  if (!client.account) return;
  cnPreview = null;
  $('cn-preview').hidden = true;
  $('cn-ref').value = ref;
  $('cn-error').textContent = '';
  if (!$('channel-new').open) $('channel-new').showModal();
  cnTab('find');
  if (ref) cnSearch();
}
$('new-channel-btn').addEventListener('click', () => openChannels());
for (const b of document.querySelectorAll('#channel-new [data-cn-tab]')) b.addEventListener('click', () => cnTab(b.dataset.cnTab));
for (const r of document.querySelectorAll('input[name="cn-type"]')) {
  r.addEventListener('change', () => {
    $('cn-handle-row').hidden = document.querySelector('input[name="cn-type"]:checked').value !== 'public';
  });
}
async function cnSearch() {
  const ref = $('cn-ref').value.trim();
  $('cn-error').textContent = '';
  if (!ref) return;
  $('cn-search').disabled = true;
  try {
    const pre = await client.channelPreview(ref);
    cnPreview = pre;
    paintAvatar($('cn-pv-avatar'), pre.chat);
    $('cn-pv-avatar').textContent = [...(pre.title || '?')][0].toUpperCase();
    $('cn-pv-title').textContent = pre.title;
    if (pre.verified) $('cn-pv-title').append(verifiedBadge());
    $('cn-pv-sub').textContent = [pre.public ? '@' + pre.handle : t('приватный канал'), t('подписчиков: {0}', pre.subs)].join(' · ');
    $('cn-pv-about').replaceChildren();
    linkNodes($('cn-pv-about'), pre.about);
    $('cn-pv-about').hidden = !pre.about;
    $('cn-pv-posts').replaceChildren(...pre.posts.slice(-3).map((m) => el('li', '', textOf(m.content))));
    $('cn-join').textContent = pre.role ? t('Открыть') : t('Подписаться');
    $('cn-preview').hidden = false;
  } catch (err) {
    $('cn-preview').hidden = true;
    $('cn-error').textContent = err.message;
  } finally {
    $('cn-search').disabled = false;
  }
}
$('cn-search').addEventListener('click', cnSearch);
$('cn-ref').addEventListener('keydown', (e) => e.key === 'Enter' && (e.preventDefault(), cnSearch()));
$('cn-join').addEventListener('click', async () => {
  if (!cnPreview) return;
  $('cn-join').disabled = true;
  try {
    const chat = cnPreview.role ? cnPreview.chat : await client.joinChannel(cnPreview);
    $('channel-new').close();
    await openChat(chat);
  } catch (err) {
    $('cn-error').textContent = err.message;
  } finally {
    $('cn-join').disabled = false;
  }
});
$('cn-create-btn').addEventListener('click', async () => {
  const isPublic = document.querySelector('input[name="cn-type"]:checked').value === 'public';
  $('cn-error').textContent = '';
  $('cn-create-btn').disabled = true;
  try {
    const chat = await client.createChannel({ title: $('cn-title').value, about: $('cn-about').value, isPublic, handle: $('cn-handle').value });
    for (const id of ['cn-title', 'cn-about', 'cn-handle']) $(id).value = '';
    $('channel-new').close();
    await openChat(chat);
    if (!isPublic) toast(t('Канал создан. Пригласите читателей ссылкой — она в «О канале»'), 6000);
  } catch (err) {
    $('cn-error').textContent = err.message;
  } finally {
    $('cn-create-btn').disabled = false;
  }
});
for (const id of ['cn-title', 'cn-handle']) $(id).addEventListener('keydown', (e) => e.key === 'Enter' && (e.preventDefault(), $('cn-create-btn').click()));

let channelFor = null;
async function openChannelInfo(chat) {
  channelFor = chat;
  await renderChannelInfo();
  if (!$('channel-info').open) $('channel-info').showModal();
}
async function renderChannelInfo() {
  const chat = channelFor;
  const ch = chat && (await client.channelOf(chat));
  if (!ch) return $('channel-info').open && $('channel-info').close();
  const owner = ch.role === 'owner' && !ch.gone;
  const admin = isChAdmin(ch);
  paintAvatar($('ci-avatar'), chat);
  setName($('ci-name'), chat, client.isVerified(chat));
  $('ci-sub').textContent = channelSubText(ch);
  $('ci-about-row').hidden = !ch.about;
  $('ci-about').replaceChildren();
  linkNodes($('ci-about'), ch.about);
  const link = client.channelLink(ch, location.origin);
  $('ci-link').textContent = ch.public ? '@' + ch.handle : link;
  $('ci-link-label').textContent = ch.public ? t('Публичная ссылка — нажмите, чтобы скопировать') : t('Ссылка-приглашение — по ней можно читать канал. Нажмите, чтобы скопировать');
  $('ci-link-row').hidden = !!ch.gone;
  $('ci-edit').hidden = !admin;
  if (admin && document.activeElement !== $('ci-title-input') && document.activeElement !== $('ci-about-input')) {
    $('ci-title-input').value = ch.title;
    $('ci-about-input').value = ch.about;
  }
  $('ci-admins-box').hidden = !owner;
  if (owner) {
    $('ci-admins').replaceChildren(
      ...[client.account.username, ...(ch.admins || [])].map((u) => {
        const li = el('li');
        const av = el('span', 'avatar');
        paintAvatar(av, u);
        const body = el('div', 'm-body');
        const nm = el('span', 'm-name');
        setName(nm, u, client.isVerified(u));
        body.append(nm, el('span', 'm-sub', '@' + u + ' · ' + (u === client.account.username ? t('владелец') : t('администратор'))));
        li.append(av, body);
        if (u !== client.account.username) {
          const acts = el('div', 'm-acts');
          const rb = el('button', 'ghost danger', t('Снять админа'));
          rb.type = 'button';
          rb.addEventListener('click', () => channelAction(() => client.setChannelAdmin(chat, u, false)));
          acts.append(rb);
          li.append(acts);
        }
        return li;
      })
    );
  }
  $('ci-note').textContent = ch.gone
    ? t('Канал удалён или вы больше не подписаны. История осталась только у вас.')
    : owner
      ? t('Вы владелец: можете менять название и описание, назначать администраторов и удалить канал.')
      : admin
        ? t('Вы администратор: можете публиковать и удалять посты, менять название и описание.')
        : ch.public
          ? t('Публичный канал: посты видит любой, кто его найдёт.')
          : t('Приватный канал: посты могут прочитать только те, у кого есть ссылка-приглашение.');
  $('ci-leave').hidden = owner || !!ch.gone;
  $('ci-delete').querySelector('.set-label').textContent = owner ? t('Удалить канал') : t('Удалить чат');
  $('ci-delete').hidden = !owner && !ch.gone;
}
async function channelAction(fn) {
  try {
    await fn();
    await renderChannelInfo();
  } catch (err) {
    toast(err.message);
  }
}
$('ci-close').addEventListener('click', () => $('channel-info').close());
$('ci-link-row').addEventListener('click', async () => {
  const ch = channelFor && (await client.channelOf(channelFor));
  if (!ch) return;
  try {
    await copyText(client.channelLink(ch, location.origin));
    toast(t('Ссылка скопирована'));
  } catch {
    toast(client.channelLink(ch, location.origin), 8000);
  }
});
$('ci-save').addEventListener('click', () => channelFor && channelAction(() => client.updateChannel(channelFor, { title: $('ci-title-input').value, about: $('ci-about-input').value })));
async function ciAddAdmin() {
  const u = $('ci-admin-input').value.trim().replace(/^@/, '').toLowerCase();
  if (!u || !channelFor) return;
  await channelAction(() => client.setChannelAdmin(channelFor, u, true));
  $('ci-admin-input').value = '';
}
$('ci-admin-add').addEventListener('click', ciAddAdmin);
$('ci-admin-input').addEventListener('keydown', (e) => e.key === 'Enter' && (e.preventDefault(), ciAddAdmin()));
$('ci-leave').addEventListener('click', async () => {
  const chat = channelFor;
  if (!chat || !confirm(t('Отписаться от канала «{0}»? Его посты на этом и других ваших устройствах пропадут.', nameOf(chat)))) return;
  $('channel-info').close();
  await channelGone(chat, () => client.leaveChannel(chat));
});
$('ci-delete').addEventListener('click', async () => {
  const chat = channelFor;
  if (chat) await removeChannelChat(chat);
});
/** Удалить канал (владелец) или чат канала, которого больше нет / от которого отписались. */
async function removeChannelChat(chat) {
  const ch = await client.channelOf(chat);
  if (!ch) return;
  if (ch.role === 'owner' && !ch.gone) {
    if (!confirm(t('Удалить канал «{0}» навсегда? Все посты пропадут у всех подписчиков.', nameOf(chat)))) return;
    if ($('channel-info').open) $('channel-info').close();
    return channelGone(chat, () => client.deleteChannel(chat));
  }
  if (!ch.gone) {
    if (!confirm(t('Отписаться от канала «{0}»? Его посты на этом и других ваших устройствах пропадут.', nameOf(chat)))) return;
    if ($('channel-info').open) $('channel-info').close();
    return channelGone(chat, () => client.leaveChannel(chat));
  }
  if ($('channel-info').open) $('channel-info').close();
  await channelGone(chat, () => client.leaveChannel(chat));
}
async function channelGone(chat, fn) {
  try {
    await fn();
  } catch (err) {
    return toast(err.message);
  }
  if (current === chat) $('back-btn').click();
  renderContacts();
}
$('channel-bar-btn').addEventListener('click', async () => {
  if (!current) return;
  const ch = await client.channelOf(current);
  if (ch?.gone) return removeChannelChat(current);
  openChannelInfo(current);
});
client.on('channel', ({ chat }) => {
  if ($('channel-info').open && channelFor === chat) renderChannelInfo();
  if (chat === current) renderHeader();
  renderContacts();
});
client.on('channel-removed', ({ chat }) => {
  if ($('channel-info').open && channelFor === chat) renderChannelInfo();
  if (chat === current) renderHeader();
  renderContacts();
});
client.on('contacts', () => $('channel-info').open && renderChannelInfo());

let groupFor = null;
async function openGroup(chat) {
  groupFor = chat;
  await renderGroup();
  if (!$('group-dialog').open) $('group-dialog').showModal();
}
async function renderGroup() {
  const chat = groupFor;
  if (!chat) return;
  const g = await client.groupOf(chat);
  if (!g) return $('group-dialog').close();
  const me = client.account.username;
  const admin = !g.left && g.admins.includes(me);
  paintAvatar($('gd-avatar'), chat);
  setName($('gd-name'), chat, client.isVerified(chat));
  $('gd-count').textContent = membersText(g);
  $('gd-rename').hidden = !admin;
  if (admin && document.activeElement !== $('gd-name-input')) $('gd-name-input').value = g.name;
  $('gd-add').hidden = !admin;
  $('gd-leave').hidden = !!g.left;
  $('gd-note').textContent = g.left
    ? t('Вы больше не участник: новые сообщения сюда не приходят. История осталась только у вас.')
    : admin
      ? t('Вы администратор: можете добавлять и исключать участников, назначать администраторов и менять название.')
      : t('Менять состав и название могут администраторы группы.');
  const members = [...g.members].sort((a, b) => (a === me ? -1 : b === me ? 1 : g.admins.includes(b) - g.admins.includes(a)));
  $('gd-members').replaceChildren(
    ...members.map((u) => {
      const li = el('li');
      const av = el('span', 'avatar');
      paintAvatar(av, u);
      const body = el('div', 'm-body');
      const nm = el('span', 'm-name');
      setName(nm, u, client.isVerified(u));
      if (u === me) nm.append(document.createTextNode(' ' + t('(вы)')));
      body.append(nm, el('span', 'm-sub', '@' + u + (g.admins.includes(u) ? ' · ' + t('администратор') : '')));
      li.append(av, body);
      if (u !== me) {
        av.classList.add('clickable');
        av.addEventListener('click', () => ($('group-dialog').close(), openProfile(u)));
      }
      if (admin && u !== me) {
        const acts = el('div', 'm-acts');
        const isAdm = g.admins.includes(u);
        const ab = el('button', 'ghost', isAdm ? t('Снять админа') : t('Сделать админом'));
        ab.type = 'button';
        ab.addEventListener('click', () => groupAction(chat, { admins: isAdm ? g.admins.filter((a) => a !== u) : [...g.admins, u] }));
        const rb = el('button', 'ghost danger', t('Исключить'));
        rb.type = 'button';
        rb.addEventListener('click', () => confirm(t('Исключить {0} из группы?', nameOf(u))) && groupAction(chat, { remove: [u] }));
        acts.append(ab, rb);
        li.append(acts);
      }
      return li;
    })
  );
}
async function groupAction(chat, change) {
  try {
    await client.updateGroup(chat, change);
  } catch (err) {
    toast(err.user ? t('Нет пользователя @{0}', err.user) : err.message);
  }
}
$('gd-close').addEventListener('click', () => $('group-dialog').close());
$('gd-rename-save').addEventListener('click', () => groupFor && groupAction(groupFor, { name: $('gd-name-input').value }));
async function gdAdd() {
  const u = $('gd-add-input').value.trim().replace(/^@/, '').toLowerCase();
  if (!u || !groupFor) return;
  await groupAction(groupFor, { add: [u] });
  $('gd-add-input').value = '';
}
$('gd-add-btn').addEventListener('click', gdAdd);
$('gd-add-input').addEventListener('keydown', (e) => e.key === 'Enter' && (e.preventDefault(), gdAdd()));
async function leaveGroup(chat) {
  if (!confirm(t('Покинуть группу «{0}»? Вы перестанете получать её сообщения.', nameOf(chat)))) return;
  try {
    await client.leaveGroup(chat);
  } catch (err) {
    toast(err.message);
  }
}
async function deleteGroupChat(chat) {
  const g = await client.groupOf(chat);
  const ask = g && !g.left ? t('Удалить группу «{0}» из списка? Вы выйдете из неё, переписка пропадёт на всех ваших устройствах.', nameOf(chat)) : t('Удалить чат «{0}»? Переписка пропадёт на всех ваших устройствах.', nameOf(chat));
  if (!confirm(ask)) return;
  try {
    if (g && !g.left) await client.leaveGroup(chat);
    await deleteChat(chat, false);
  } catch (err) {
    toast(err.message);
  }
}
$('gd-leave').addEventListener('click', () => groupFor && leaveGroup(groupFor));
$('gd-delete').addEventListener('click', () => {
  const chat = groupFor;
  $('group-dialog').close();
  if (chat) deleteGroupChat(chat);
});
client.on('group', ({ chat }) => {
  if ($('group-dialog').open && groupFor === chat) renderGroup();
  if (chat === current) renderHeader();
});
for (const ev of ['contacts', 'presence']) client.on(ev, () => $('group-dialog').open && renderGroup());

// ---------- Блокировка и удаление чата ----------
let chatMenuFor = null;
function openChatMenu(name, x, y) {
  chatMenuFor = name;
  const menu = $('chat-menu');
  const isBlocked = client.isBlocked(name);
  const chan = isChannelChat(name);
  const group = isGroupChat(name);
  const sys = isSystemChat(name) || isSupportChat(name);
  menu.querySelector('[data-act="block"]').hidden = isBlocked || group || chan || sys;
  menu.querySelector('[data-act="unblock"]').hidden = !isBlocked || group || chan || sys;
  menu.querySelector('[data-act="profile"]').hidden = group || chan || sys;
  menu.querySelector('[data-act="group"]').hidden = !group;
  menu.querySelector('[data-act="channel"]').hidden = !chan;
  menu.querySelector('[data-act="leave"]').hidden = !group;
  const pinned = client.isChatPinned(name);
  menu.querySelector('[data-act="top"]').hidden = pinned;
  menu.querySelector('[data-act="untop"]').hidden = !pinned;
  const arch = client.isArchived(name);
  menu.querySelector('[data-act="archive"]').hidden = arch;
  menu.querySelector('[data-act="unarchive"]').hidden = !arch;
  menu.hidden = false;
  menu.style.left = Math.max(8, Math.min(x, innerWidth - menu.offsetWidth - 8)) + 'px';
  menu.style.top = Math.max(8, Math.min(y, innerHeight - menu.offsetHeight - 8)) + 'px';
  menu.querySelector('button:not([hidden])').focus();
}
function closeChatMenu() {
  $('chat-menu').hidden = true;
  chatMenuFor = null;
}
document.addEventListener('click', (e) => {
  if (!$('chat-menu').hidden && !e.target.closest('#chat-menu') && !e.target.closest('#chat-menu-btn')) closeChatMenu();
});
document.addEventListener('keydown', (e) => e.key === 'Escape' && closeChatMenu());
$('chat-menu-btn').addEventListener('click', () => {
  if (!current) return;
  if (!$('chat-menu').hidden) return closeChatMenu();
  const r = $('chat-menu-btn').getBoundingClientRect();
  openChatMenu(current, r.right - 200, r.bottom + 4);
});
// Правый клик или долгое нажатие на чат в списке
$('contacts').addEventListener('contextmenu', (e) => {
  const b = e.target.closest('[data-chat]');
  if (!b) return;
  e.preventDefault();
  openChatMenu(b.dataset.chat, e.clientX, e.clientY);
});
let chatPress = null;
$('contacts').addEventListener('touchstart', (e) => {
  const b = e.target.closest('[data-chat]');
  if (!b) return;
  const touch = e.touches[0];
  chatPress = setTimeout(() => {
    chatPress = 'fired';
    openChatMenu(b.dataset.chat, touch.clientX, touch.clientY);
  }, 500);
}, { passive: true });
for (const ev of ['touchend', 'touchmove', 'touchcancel']) {
  $('contacts').addEventListener(ev, (e) => {
    // Меню открылось — не открывать заодно и сам чат
    if (chatPress === 'fired' && ev === 'touchend') e.preventDefault();
    clearTimeout(chatPress);
    chatPress = null;
  });
}

$('chat-menu').addEventListener('click', (e) => {
  const b = e.target.closest('[data-act]');
  if (!b || !chatMenuFor) return;
  const name = chatMenuFor;
  closeChatMenu();
  if (b.dataset.act === 'unblock') return setBlocked(name, false);
  if (b.dataset.act === 'top' || b.dataset.act === 'untop') {
    client.setChatPinned(name, b.dataset.act === 'top').catch((err) => toast(err.message));
    return;
  }
  if (b.dataset.act === 'folders') return openChatFolders(name);
  if (b.dataset.act === 'archive' || b.dataset.act === 'unarchive') {
    const on = b.dataset.act === 'archive';
    client.setArchived(name, on).then(() => {
      toast(on ? t('Чат в архиве') : t('Чат возвращён из архива'));
      // Убрали открытый чат в архив на телефоне — назад к списку
      if (on && name === current && $('app').classList.contains('in-chat') && matchMedia('(max-width: 720px)').matches) $('back-btn').click();
    });
    return;
  }
  if (b.dataset.act === 'profile') return openProfile(name);
  if (b.dataset.act === 'group') return openGroup(name);
  if (b.dataset.act === 'channel') return openChannelInfo(name);
  if (b.dataset.act === 'delete-chat' && isChannelChat(name)) return removeChannelChat(name);
  if (b.dataset.act === 'leave') return leaveGroup(name);
  if (b.dataset.act === 'delete-chat' && isGroupChat(name)) return deleteGroupChat(name);
  if (b.dataset.act === 'block') {
    $('block-peer').textContent = nameOf(name);
    $('block-delete').checked = false;
    $('block-dialog').dataset.name = name;
    $('block-dialog').returnValue = '';
    return $('block-dialog').showModal();
  }
  if (b.dataset.act === 'delete-chat') {
    $('delchat-peer').textContent = nameOf(name);
    $('delchat-peer2').textContent = nameOf(name);
    $('delchat-all').checked = false;
    $('delchat-all').closest('label').hidden = isSystemChat(name);
    $('delchat-dialog').dataset.name = name;
    $('delchat-dialog').returnValue = '';
    $('delchat-dialog').showModal();
  }
});

async function setBlocked(name, on) {
  try {
    await client.setBlocked(name, on);
    toast(on ? t('{0} заблокирован', nameOf(name)) : t('{0} разблокирован', nameOf(name)));
  } catch (err) {
    toast(err.message);
  }
}

async function deleteChat(name, forAll) {
  try {
    await client.deleteChat(name, { forAll });
    if (name === current) $('back-btn').click();
    await renderContacts();
  } catch (err) {
    toast(err.message);
  }
}

$('block-dialog').addEventListener('close', async () => {
  const dlg = $('block-dialog');
  if (dlg.returnValue !== 'block') return;
  const name = dlg.dataset.name;
  if (calls.busy && calls.call?.peer === name) calls.hangup();
  await setBlocked(name, true);
  if ($('block-delete').checked) await deleteChat(name, false);
});
$('delchat-dialog').addEventListener('close', () => {
  const dlg = $('delchat-dialog');
  if (dlg.returnValue === 'delete') deleteChat(dlg.dataset.name, $('delchat-all').checked);
});
$('unblock-btn').addEventListener('click', () => current && setBlocked(current, false));

function renderBlocked() {
  const names = [...client.blocked].sort();
  $('blocked-empty').hidden = names.length > 0;
  $('blocked-list').replaceChildren(
    ...names.map((name) => {
      const li = el('li', 'blocked-item');
      const av = el('span', 'avatar');
      paintAvatar(av, name);
      const b = el('button', 'ghost', t('Разблокировать'));
      b.type = 'button';
      b.addEventListener('click', () => setBlocked(name, false));
      li.append(av, el('span', 'blocked-name', name), b);
      return li;
    })
  );
}
function openBlocked() {
  return openSettings('blocked');
}

client.on('blocks', () => {
  renderContacts();
  if (current) {
    updateComposer();
    renderPresence();
  }
  if ($('menu-dialog').open && setPage === 'blocked') renderBlocked();
  $('set-blocked-value').textContent = client.blocked.size ? String(client.blocked.size) : '';
});

// ---------- Статус «в сети» ----------
client.on('presence', ({ username }) => {
  if (username === current) {
    renderPresence();
    renderHeader(); // галочку или подписку (а с ней фото) могли поставить или снять
  }
  if ($('profile-dialog').open && profileFor === username) renderProfile();
  renderContacts();
});
client.on('verified', (on) => client.account && setName($('me-name'), client.account.username, on));
client.on('status', renderPresence);
// Скрыть статус — возможность Премиум: без подписки статус виден, переключатель заблокирован
function renderPresenceToggle() {
  const premium = client.isPremium();
  $('presence-visible').checked = !(client.presenceHidden && premium);
  $('presence-visible').disabled = !premium;
  $('presence-locked').hidden = premium;
}
client.on('premium', () => client.account && renderPresenceToggle());
$('presence-visible').addEventListener('change', async (e) => {
  try {
    await client.setPresenceVisible(e.target.checked);
    toast(e.target.checked ? t('Другие видят, когда вы в сети') : t('Ваш статус скрыт: другие видят «был(а) недавно»'));
  } catch (err) {
    e.target.checked = !e.target.checked;
    toast(err.message);
  }
});


// ---------- Мобильное приложение ----------
// Системная кнопка «Назад»: закрыть меню или диалог, выйти из чата.
// false — назад некуда, приложение уйдёт в фон (и продолжит работать).
window.__tainikBack = () => {
  if (!$('msg-menu').hidden) return closeMenu(), true;
  if ($('scanner').open) return stopScan(), true;
  if (!$('chat-menu').hidden) return closeChatMenu(), true;
  if ($('viewer').open) return closeViewer(), true;
  const dlg = [...document.querySelectorAll('dialog[open]')].pop();
  if (dlg === $('menu-dialog') && setBack()) return true;
  if (dlg) return dlg.close(), true;
  if (!$('call').hidden && minimizeCall()) return true;
  if (reply) return setReply(null), true;
  if (!$('call').hidden) return false; // входящий звонок: уйти в фон, звонок продолжит звонить
  if ($('app').classList.contains('in-chat')) return $('back-btn').click(), true;
  return false;
};
// Жест «назад», как на Android: свайп от края экрана внутрь (слева направо или справа налево),
// а в открытом чате — свайп вправо из любого места
{
  let sw = null;
  document.addEventListener('touchstart', (e) => {
    sw = null;
    if (e.touches.length !== 1) return;
    const tch = e.touches[0];
    // Не мешаем перемотке, записи, выделению текста и полям ввода
    if (e.target.closest('input, textarea, .vwave, .note-seek, .rec-btn, .as-grid, .viewer-body, #call')) return;
    const edge = tch.clientX < 28 ? 'left' : tch.clientX > innerWidth - 28 ? 'right' : null;
    const inChat = $('app').classList.contains('in-chat') && !document.querySelector('dialog[open]');
    if (!edge && !inChat) return;
    sw = { x: tch.clientX, y: tch.clientY, t: Date.now(), edge };
  }, { passive: true });
  document.addEventListener('touchend', (e) => {
    const s = sw;
    sw = null;
    if (!s || rec) return;
    const tch = e.changedTouches[0];
    const dx = tch.clientX - s.x;
    const dy = tch.clientY - s.y;
    if (Date.now() - s.t > 700 || Math.abs(dx) < 70 || Math.abs(dx) < Math.abs(dy) * 2) return;
    const back = s.edge === 'right' ? dx < 0 : dx > 0; // внутрь от края; без края — только вправо
    if (back && window.__tainikBack) window.__tainikBack();
  }, { passive: true });
}
// Нажали на уведомление «Звонок: …» — развернуть звонок
window.__tainikShowCall = () => expandCall();
// Сеть вернулась или телефон проснулся: проверить соединение, при необходимости — переподключиться.
window.__tainikWake = (restart = false) => {
  for (const c of [client, ...[...others.values()].map((o) => o.client)]) {
    if (!c.account) continue;
    if (restart) c.reconnectNow({ restart: true });
    else c.checkConnection().catch(() => {});
  }
};


// ---------- Несколько аккаунтов ----------

function othersUnread() {
  let n = 0;
  for (const o of others.values()) n += o.unread;
  return n;
}
function renderAccountsBadge() {
  const n = othersUnread();
  $('accounts-badge').hidden = !n;
  $('accounts-badge').textContent = n > 99 ? '99+' : String(n);
  setUnread(ownUnread + n);
  if ($('accounts-dialog').open) renderAccounts();
}

async function rememberAccount() {
  const a = activeAccount();
  a.username = client.account.username;
  a.server = client.url;
  await saveAccounts();
  await settings.set('active-account', activeId);
}

/** Убрать активный аккаунт из списка. true — есть другой, на который переключились. */
async function forgetActiveAccount() {
  const a = activeAccount();
  if (a.id === 'main') {
    delete a.username;
    delete a.server;
  } else {
    accounts = accounts.filter((x) => x.id !== a.id);
  }
  if (!accounts.length) accounts = [{ id: 'main' }];
  const next = savedAccounts()[0];
  activeId = next ? next.id : accounts[0].id;
  await saveAccounts();
  await settings.set('active-account', activeId);
  return !!next;
}

async function switchAccount(id) {
  if (id === activeId) return;
  if (calls.busy) {
    if (!confirm(t('Идёт звонок. Переключить аккаунт? Звонок завершится.'))) return;
    calls.hangup();
  }
  await settings.set('active-account', id);
  // Страница загружается заново с другим аккаунтом: у каждого свои ключи и переписка,
  // и состояние шифрования одного аккаунта никогда не используется дважды.
  location.reload();
}

async function addAccount() {
  if (savedAccounts().length >= MAX_ACCOUNTS) return toast(t('На одном устройстве — не больше {0} аккаунтов', MAX_ACCOUNTS));
  let slot = accounts.find((a) => !a.username && a.id !== activeId);
  if (!slot) {
    const rnd = crypto.getRandomValues(new Uint8Array(4));
    slot = { id: 'a' + [...rnd].map((b) => b.toString(16).padStart(2, '0')).join('') };
    accounts.push(slot);
  }
  await saveAccounts();
  await switchAccount(slot.id);
}

$('auth-cancel').addEventListener('click', async () => {
  const back = savedAccounts().find((a) => a.id !== activeId);
  if (!back) return;
  if (activeId !== 'main') accounts = accounts.filter((a) => a.id !== activeId);
  await saveAccounts();
  await switchAccount(back.id);
});

function renderAccounts() {
  const list = savedAccounts().map((a) => {
    const li = el('li', a.id === activeId ? 'active' : '');
    const av = el('span', 'avatar');
    paintAvatar(av, a.username);
    const body = el('div', 'd-body');
    body.append(el('div', 'd-name', a.username));
    let host = '';
    try {
      host = new URL(a.server || DEFAULT_SERVER).host;
    } catch {}
    const o = others.get(a.id);
    const st = a.id === activeId ? STATUS_TEXT[client.status] : o ? STATUS_TEXT[o.client.status] : t('не подключён');
    body.append(el('div', 'd-meta', `${host} · ${st || ''}`));
    li.append(av, body);
    if (a.id === activeId) li.append(el('span', 'a-state', t('открыт')));
    else {
      if (o?.unread) li.append(el('span', 'badge', String(o.unread)));
      li.title = t('Переключиться');
      li.addEventListener('click', () => switchAccount(a.id));
    }
    return li;
  });
  $('account-list').replaceChildren(...list);
  $('account-add').disabled = savedAccounts().length >= MAX_ACCOUNTS;
}
function openAccounts() {
  renderAccounts();
  $('accounts-dialog').showModal();
}
$('me-btn').addEventListener('click', openAccounts);
$('account-add').addEventListener('click', () => {
  $('accounts-dialog').close();
  addAccount();
});
client.on('status', () => $('accounts-dialog').open && renderAccounts());

/** Убрать уведомления чата другого (неактивного) аккаунта. */
async function clearOtherNotices(accId, contact) {
  if (desktop?.dismissNotice) return desktop.dismissNotice({ chat: `${contact}@${accId}` });
  try {
    const reg = await navigator.serviceWorker?.getRegistration('/');
    for (const n of (await reg?.getNotifications({ tag: `msg:${accId}:${contact}` })) || []) n.close();
  } catch {}
}

async function notifyOther(acc, contact, message) {
  const { preview } = await notifPrefs();
  const text = preview ? textOf(message.content).replace(/\s+/g, ' ').slice(0, 160) : '';
  await showNotice({
    title: `${others.get(acc.id)?.client.nameOf(contact) || contact} → ${acc.username}`,
    // Группа: в заголовке — название, в тексте — кто написал
    body: (message.from ? `${others.get(acc.id)?.client.nameOf(message.from) || message.from}: ` : '') + (text || t('Новое сообщение')),
    chat: `${contact}@${acc.id}`,
    tag: `msg:${acc.id}:${contact}`,
    force: true,
    reply: await canReplyTo(others.get(acc.id)?.client || client, contact),
    msg: message.id,
  });
}

/** Остальные аккаунты: подключаются в фоне, принимают сообщения, считают непрочитанные. */
async function startOthers() {
  for (const acc of savedAccounts()) {
    if (acc.id === activeId || others.has(acc.id)) continue;
    const c = new MessengerClient({ url: acc.server || DEFAULT_SERVER, storage: storageFor(acc.id), appVersion: APP_VERSION });
    c.active = false; // фоновый аккаунт: собеседники видят «был(а) …», а не «в сети»
    const item = { acc, client: c, unread: 0 };
    others.set(acc.id, item);
    try {
      if (!(await c.load())) throw new Error(t('нет ключей'));
    } catch (e) {
      console.warn(t('аккаунт'), acc.username, e);
      others.delete(acc.id);
      continue;
    }
    c.url = acc.server || DEFAULT_SERVER;
    const recount = async () => {
      item.unread = Object.values(await c.contacts()).reduce((n, x) => n + (x.unread || 0), 0);
      renderAccountsBadge();
    };
    c.on('contacts', recount);
    c.on('status', (st) => {
      if (st === 'online') item.onlineAt = Date.now();
      if ($('accounts-dialog').open) renderAccounts();
    });
    c.on('message', async ({ contact, message, quiet }) => {
      recount();
      if (message.dir === 'in' && !quiet && (await stillUnread(c, contact, item.onlineAt || 0))) notifyOther(acc, contact, message);
    });
    // Прочитано на другом устройстве этого аккаунта (или сообщения удалены) — убрать его уведомление
    c.on('read-sync', ({ contact, unread }) => !unread && clearOtherNotices(acc.id, contact));
    c.on('deleted', async ({ contact }) => !(await c.contacts())[contact]?.unread && clearOtherNotices(acc.id, contact));
    // Звонок на неактивный аккаунт: принять его можно только в активном — подсказываем
    c.on('call-signal', ({ from, data }) => {
      if (data?.kind !== 'offer') return;
      showNotice({
        title: `${c.nameOf(from)} → ${acc.username}`,
        body: t('Звонит. Откройте этот аккаунт, чтобы ответить'),
        chat: `${from}@${acc.id}`,
        tag: `msg:${acc.id}:${from}`,
        force: true,
      });
    });
    c.on('error', async ({ code, self }) => {
      if (code !== 'device_removed' && code !== 'account_deleted') return;
      c.disconnect();
      await c.reset();
      others.delete(acc.id);
      accounts = accounts.filter((a) => a.id !== acc.id || a.id === 'main');
      if (acc.id === 'main') {
        delete acc.username;
        delete acc.server;
      }
      await saveAccounts();
      renderAccountsBadge();
      toast(
        code === 'account_deleted'
          ? self
            ? t('Аккаунт {0} удалён с другого вашего устройства', acc.username || '')
            : t('Аккаунт {0} удалён администратором', acc.username || '')
          : t('Это устройство отвязано от аккаунта {0}', acc.username || '')
      );
    });
    await recount();
    c.connect().catch(() => {});
  }
}


// ---------- Обновления приложения (десктоп и Android) ----------
// Состояние приходит из нативной части: { status, current, version, progress, error, reason, downloadUrl, auto }.
const updates = desktop?.updates || null;
let upd = null;
const dismissedUpdate = { v: null };
const isAndroidApp = android;

function updText(st) {
  const v = st.version;
  switch (st.status) {
    case 'checking':
      return t('Проверяем обновления…');
    case 'latest':
      return t('Установлена последняя версия ({0}).', st.current);
    case 'available':
      return t('Доступна версия {0}.', v);
    case 'downloading':
      return t('Скачиваем версию {0}… {1}%', v, Math.round((st.progress || 0) * 100));
    case 'ready':
      return t('Версия {0} скачана и проверена.', v);
    case 'installing':
      return t('Устанавливаем версию {0}…', v);
    case 'manual':
      return t('Доступна версия {0}. {1}', v, st.reason || '');
    case 'error':
      return st.error || t('Не удалось проверить обновления.');
    default:
      return t('Версия {0}.', st.current || '');
  }
}
function updAction(st) {
  if (st.status === 'ready') return isAndroidApp ? t('Установить') : st.kind === 'linux-deb' ? t('Открыть установщик') : t('Перезапустить и обновить');
  if (st.status === 'available') return t('Скачать и обновить');
  if (st.status === 'manual') return t('Скачать');
  return null;
}
async function updGo() {
  if (!upd) return;
  try {
    if (upd.status === 'ready') {
      const r = await updates.install();
      if (r === 'opened') toast(t('Откройте скачанный файл, чтобы завершить установку'), 6000);
      if (r === 'permission') toast(t('Разрешите Тайнику установку приложений, вернитесь и нажмите «Установить» ещё раз'), 8000);
    } else if (upd.status === 'available') await updates.download();
    else if (upd.status === 'manual' && upd.downloadUrl) window.open(upd.downloadUrl, '_blank', 'noopener');
  } catch (e) {
    toast(e.message || t('Не удалось обновить'));
  }
}
function renderUpdates(st) {
  upd = st;
  const on = !!st && st.status !== 'unsupported';
  $('row-upd').hidden = !on;
  const action = on ? updAction(st) : null;
  const show = on && !!action && dismissedUpdate.v !== st.version;
  $('upd-banner').hidden = !show;
  if (!on) return;
  $('upd-text').textContent = updText(st);
  $('set-upd-value').textContent = action ? t('Доступно') : '';
  $('upd-go').hidden = !action || st.status === 'manual';
  $('upd-go').textContent = action || '';
  $('upd-manual').hidden = st.status !== 'manual' || !st.downloadUrl;
  if (st.downloadUrl) $('upd-manual').href = st.downloadUrl;
  $('upd-check').disabled = st.status === 'checking' || st.status === 'downloading';
  $('upd-auto').checked = st.auto !== false;
  $('upd-hint').textContent = isAndroidApp
    ? t('Новая версия скачивается с вашего сервера; Android проверяет, что она подписана тем же ключом, и спросит подтверждение установки.')
    : t('Новая версия скачивается с вашего сервера и ставится, только если подпись выпуска верна. Скачанное обновление ставится и при выходе из приложения.');
  if (show) {
    $('upd-banner-text').textContent =
      st.status === 'ready' ? t('🎉 Версия {0} готова', st.version) : t('Доступна версия {0}', st.version);
    $('upd-banner-go').textContent = st.status === 'ready' && !isAndroidApp && st.kind !== 'linux-deb' ? t('Перезапустить') : action;
  }
}
if (updates) {
  updates.onChange(renderUpdates);
  updates.get().then(renderUpdates).catch(() => {});
  $('upd-check').addEventListener('click', () => updates.check().catch((e) => toast(e.message)));
  $('upd-go').addEventListener('click', updGo);
  $('upd-banner-go').addEventListener('click', updGo);
  $('upd-banner-no').addEventListener('click', () => {
    dismissedUpdate.v = upd?.version || null;
    $('upd-banner').hidden = true;
  });
  $('upd-auto').addEventListener('change', (e) => updates.setAuto(e.target.checked).catch(() => {}));
}
