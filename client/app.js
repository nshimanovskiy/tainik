import { MessengerClient, ERROR_TEXT } from '/shared/client-core.js';
import { formatLinkCode } from '/shared/protocol/provision.js';
import { qrEncode } from '/shared/qr.js';
import { IdbStorage, settings as webSettings } from './idb-storage.js';
import config from './config.js';
import { CallManager, CALL_RESULT_TEXT } from './call.js';
import { t, LANG, LOCALE, setLang, translateDom } from '/shared/i18n.js';
import { fmtSize, kindOf, THUMB_MAX } from '/shared/media.js';

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

const client = new MessengerClient({ url: DEFAULT_SERVER, storage: storageFor(activeId) });
let ownUnread = 0;
const others = new Map(); // id → { acc, client, unread } — остальные аккаунты, работают в фоне
let current = null;

// ---------- Утилиты ----------
function hue(name) {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)) % 360;
  return h;
}
function paintAvatar(node, name) {
  node.textContent = (name || '?').slice(0, 1);
  node.style.background = `hsl(${hue(name || '')} 42% 42%)`;
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
  bg.setAttribute('d', 'M12 1.5l2.6 1.9 3.2-.2 1 3.1 2.6 1.9-1 3.1 1 3.1-2.6 1.9-1 3.1-3.2-.2L12 22.5l-2.6-1.9-3.2.2-1-3.1-2.6-1.9 1-3.1-1-3.1 2.6-1.9 1-3.1 3.2.2z');
  const ck = document.createElementNS(NS, 'path');
  ck.setAttribute('class', 'official-check');
  ck.setAttribute('d', 'M7.6 12.3l3 3 5.8-6.2');
  svg.append(titleEl, bg, ck);
  return svg;
}
/** Имя с галочкой, если аккаунт официальный. */
function setName(node, name, verified) {
  node.replaceChildren(document.createTextNode(name));
  if (verified) node.append(verifiedBadge());
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
const STATUS_ICON = { sending: '⏳', sent: '✓', delivered: '✓✓', failed: t('⚠ не отправлено') };
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
function fileLabel(content) {
  const f = content.file;
  const base = f.kind === 'image' || f.kind === 'video' ? KIND_LABEL[f.kind] : `${f.kind === 'audio' ? '🎵' : '📄'} ${f.name}`;
  const cap = String(content.body || '').replace(/\s+/g, ' ').trim();
  return cap ? `${base} · ${cap}` : base;
}
/** Текст сообщения одной строкой: для вложения — вид и подпись. */
const textOf = (content) => (content?.t === 'file' && content.file ? fileLabel(content) : String(content?.body ?? ''));

function previewOf(m) {
  if (!m) return t('Нет сообщений');
  if (m.dir === 'sys' && m.content?.t === 'call') return callText(m.content);
  if (m.dir === 'sys') return t('Служебное сообщение');
  const body = textOf(m.content);
  return (m.dir === 'out' ? t('Вы: ') : '') + body.replace(/\s+/g, ' ');
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
    toast('Устройство привязано. Контакты перенесены, старая переписка — нет.', 6000);
  } catch (err) {
    linking = null;
    resetLinkPane();
    if (err.code !== 'cancelled') {
      $('link-error').textContent =
        err.code === 'offline' ? t('Соединение прервано. Нажмите, чтобы получить новый код.') : err.message;
    }
  }
});
$('link-copy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('link-code').textContent);
    toast('Код скопирован');
  } catch {
    toast('Не удалось скопировать — выделите код вручную');
  }
});

// ---------- Контакты ----------
// Перерисовки идут подряд (contacts, status, presence, сообщения из очереди) и
// внутри ждут хранилище. Строим список целиком и применяем только последнюю
// перерисовку — иначе вызовы перемешиваются и в списке появляются дубли.
let contactsGen = 0;
async function renderContacts() {
  const gen = ++contactsGen;
  // Удалённые чаты не показываем (ключ собеседника хранится — чат вернётся с новым сообщением)
  const all = Object.values(await client.contacts())
    .filter((c) => !c.hidden || c.username === current)
    .sort((a, b) => b.lastTs - a.lastTs);
  const lasts = [];
  for (const c of all) {
    const msgs = await client.messages(c.username);
    lasts.push(msgs[msgs.length - 1]);
    if (gen !== contactsGen) return;
  }
  if (gen !== contactsGen) return;
  const frag = document.createDocumentFragment();
  all.forEach((c, i) => {
    const li = el('li');
    const btn = el('button', c.username === current ? 'active' : '');
    const avWrap = el('span', 'avatar-wrap');
    const av = el('span', 'avatar');
    paintAvatar(av, c.username);
    avWrap.append(av);
    if (client.presenceOf(c.username)?.online) avWrap.append(el('span', 'online-dot'));
    const body = el('div', 'c-body');
    const top = el('div', 'c-top');
    const cn = el('span', 'c-name');
    setName(cn, c.username, client.isVerified(c.username));
    top.append(cn);
    if (client.isBlocked(c.username)) top.append(el('span', 'shield warn', t('🚫 заблокирован')));
    else if (c.keyChanged) top.append(el('span', 'shield warn', t('⚠ ключ изменён')));
    else if (c.verified) top.append(el('span', 'shield', t('✔ проверен')));
    body.append(top, el('div', 'c-preview', previewOf(lasts[i])));
    btn.append(avWrap, body);
    if (c.unread && c.username !== current) btn.append(el('span', 'badge', String(c.unread)));
    btn.dataset.chat = c.username;
    btn.addEventListener('click', () => openChat(c.username));
    li.append(btn);
    frag.append(li);
  });
  $('contacts').replaceChildren(frag);
  $('no-contacts').hidden = all.length > 0;
  ownUnread = all.reduce((n, c) => n + (c.unread || 0), 0);
  setUnread(ownUnread + othersUnread());
}

$('add-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('add-input').value.trim().toLowerCase();
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
  $('text').focus();
}

// Уведомления о сообщениях чата больше не нужны: он прочитан здесь или на другом устройстве
async function clearChatNotices(chat) {
  if (desktop?.dismissNotice) return desktop.dismissNotice({ chat });
  try {
    const reg = await navigator.serviceWorker?.getRegistration('/');
    for (const n of (await reg?.getNotifications({ tag: 'msg:' + chat })) || []) n.close();
  } catch {}
}
// ---------- Язык ----------
const LANGS = [['ru', 'Русский'], ['en', 'English']];
{
  for (const [code, name] of LANGS) {
    const b = el('button', 'set-row set-radio');
    b.type = 'button';
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(code === LANG));
    b.append(el('span', 'set-label', name), el('span', 'set-check', code === LANG ? '✓' : ''));
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
  if (c.keyChanged) {
    v.className = 'peer-verify bad';
    v.textContent = t('⚠ ключ изменился — сверьте код');
  } else if (c.verified) {
    v.className = 'peer-verify ok';
    v.textContent = t('✔ ключ проверен');
  } else {
    v.className = 'peer-verify';
    v.textContent = t('🔒 ключ не проверен');
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
  if (!current) return;
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
  $('blocked-bar').hidden = !iBlocked;
  $('composer').hidden = iBlocked;
  if (iBlocked) setReply(null);
  const blocked = !c || !!c.keyChanged || iBlocked;
  $('send-btn').disabled = blocked || client.status !== 'online';
  $('attach-btn').disabled = blocked || client.status !== 'online';
  const noCall = blocked || client.status !== 'online' || !window.RTCPeerConnection;
  $('call-audio-btn').disabled = noCall;
  $('call-video-btn').disabled = noCall;
  $('text').disabled = blocked;
  $('text').placeholder = blocked ? t('Отправка остановлена: ключ изменился') : client.status === 'online' ? t('Сообщение') : t('Нет связи — сообщение уйдёт позже');
  if (!blocked) $('send-btn').disabled = !$('text').value.trim();
}

const REJECT_TEXT = {
  identity_mismatch: t('Сообщение отклонено: ключ отправителя не совпадает с проверенным'),
  unknown_spk: t('Не удалось расшифровать: сообщение слишком старое (ключ уже удалён)'),
  no_session: t('Не удалось расшифровать: нет сессии. Попросите собеседника написать ещё раз'),
};
function messageNode(m) {
  if (m.dir === 'sys' && m.content?.t === 'call') {
    const li = el('li', 'msg sys call' + (m.content.result === 'missed' ? ' missed' : ''));
    li.append(el('div', 'bubble', `${callText(m.content)} · ${timeFmt.format(new Date(m.ts))}`));
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
  const bubble = el('div', 'bubble');
  const r = m.content?.reply;
  if (r) {
    const q = el('button', 'quote');
    q.type = 'button';
    q.dataset.target = r.id;
    const label = r.kind ? [KIND_LABEL[r.kind], r.body].filter(Boolean).join(' · ') : r.body || t('Сообщение');
    q.append(el('b', '', r.from === client.account.username ? t('Вы') : r.from), el('span', '', label));
    bubble.append(q);
  }
  if (m.content?.t === 'file' && m.content.file) {
    bubble.classList.add('has-media');
    bubble.append(mediaNode(m.content.file));
    if (m.content.body) bubble.append(el('div', 'caption', m.content.body));
  } else {
    bubble.append(document.createTextNode(m.content?.body ?? ''));
  }
  li.append(bubble);
  const acts = el('div', 'msg-actions');
  const rb = el('button', '', '↩︎');
  rb.type = 'button';
  rb.dataset.act = 'reply';
  rb.title = t('Ответить');
  rb.setAttribute('aria-label', t('Ответить'));
  const mb = el('button', '', '⋯');
  mb.type = 'button';
  mb.dataset.act = 'menu';
  mb.title = t('Ещё');
  mb.setAttribute('aria-label', t('Действия с сообщением'));
  acts.append(rb, mb);
  li.append(acts);
  const meta = el('div', 'meta');
  meta.append(el('span', '', timeFmt.format(new Date(m.ts))));
  if (m.dir === 'out') meta.append(el('span', 'st', STATUS_ICON[m.status] || ''));
  li.append(meta);
  return li;
}

let chatGen = 0;
async function renderChat() {
  if (!current) return;
  const gen = ++chatGen;
  await renderHeader();
  const list = await client.messages(current);
  if (gen !== chatGen) return;
  const ol = $('messages');
  ol.replaceChildren(el('li', 'e2e-note', t('🔒 Сообщения в этом чате защищены сквозным шифрованием')));
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
  if (text.length > 20000) return toast('Слишком длинное сообщение');
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
  card.append(el('span', 'file-icon', f.kind === 'audio' ? '🎵' : '📄'), info, el('span', 'ring'));
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

async function openMedia(id) {
  const m = await findMsg(id);
  const f = m?.content?.file;
  if (!f) return;
  if (f.kind === 'file') return saveMedia(f);
  viewing = f;
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
    const box = el('div', 'media ' + up.kind);
    fitBox(box, up.w, up.h);
    const img = el('img', 'full');
    img.alt = '';
    img.src = up.preview;
    box.append(img);
    bubble.append(box);
  } else {
    const card = el('div', 'file-card');
    const info = el('span', 'file-info');
    info.append(el('span', 'file-name', up.name), el('span', 'file-size', sizeText(up.size)));
    card.append(el('span', 'file-icon', '📄'), info);
    bubble.append(card);
  }
  const bar = el('div', 'up-bar');
  const fill = el('span', 'up-fill');
  fill.style.width = Math.round(up.progress * 100) + '%';
  const x = el('button', 'up-cancel', '✕');
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
  if (up.preview) URL.revokeObjectURL(up.preview);
}

function cancelUpload(key) {
  const up = uploads.find((u) => u.key === key);
  if (!up) return;
  up.ctrl.abort();
  dropUpload(up);
}

function queueFile(chat, file, caption, replyTo) {
  const kind = kindOf(String(file.type || '').toLowerCase());
  const up = { key: 'u' + ++upSeq, chat, name: file.name || 'file', size: file.size, kind, progress: 0, started: false, ctrl: new AbortController() };
  if (kind === 'image') up.preview = URL.createObjectURL(file);
  uploads.push(up);
  if (chat === current) {
    $('messages').append(uploadNode(up));
    $('messages').scrollTop = $('messages').scrollHeight;
  }
  uploadChain = uploadChain.then(async () => {
    if (up.ctrl.signal.aborted) return;
    try {
      const meta = await describeFile(file);
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

function pickFiles(list) {
  if (!current || !client.account) return;
  let files = [...list].filter((f) => f.size > 0);
  if (files.length < list.length) toast(ERROR_TEXT.bad_size);
  if (!files.length) return;
  if (files.length > MAX_PICK) {
    toast(t('За один раз — не больше {0} файлов', MAX_PICK));
    files = files.slice(0, MAX_PICK);
  }
  clearPicked();
  picked = files.map((file) => ({ file, url: kindOf(String(file.type).toLowerCase()) === 'image' ? URL.createObjectURL(file) : null }));
  for (const p of picked) {
    const li = el('li', 'attach-item');
    if (p.url) {
      const img = el('img');
      img.alt = '';
      img.src = p.url;
      li.append(img);
    } else li.append(el('span', 'file-icon', '📄'));
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

$('attach-btn').addEventListener('click', () => $('file-input').click());
$('file-input').addEventListener('change', (e) => {
  pickFiles(e.target.files);
  e.target.value = '';
});
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

// ---------- Код безопасности ----------
async function openSafety() {
  const code = await client.safetyNumber(current);
  $('sd-peer').textContent = current;
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
    toast('Отмечено как проверенный');
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
  $('presence-visible').checked = !client.presenceHidden;
  $('get-apps-row').hidden = !!desktop; // в вебе — ссылка на загрузки
  if (desktop?.version) {
    $('my-version').textContent = await desktop.version();
    $('my-version-row').hidden = false;
  }
  paintAvatar($('set-avatar'), client.account.username);
  setName($('set-name'), client.account.username, client.verified);
  $('my-device').textContent = `${client.account.deviceName || t('Устройство')} (${t('№{0}', client.account.deviceId)})`;
  $('set-lang-value').textContent = LANGS.find(([c]) => c === LANG)?.[1] || '';
  $('set-blocked-value').textContent = client.blocked.size ? String(client.blocked.size) : '';
  await fillNotifSettings();
}

async function openSettings(page = 'main') {
  await fillSettings();
  showSetPage(page);
  if (!$('menu-dialog').open) $('menu-dialog').showModal();
}
$('menu-btn').addEventListener('click', () => openSettings());
$('menu-dialog').addEventListener('close', async () => {
  const v = $('menu-dialog').returnValue;
  if (v === 'devices') return openDevices();
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
      li.append(el('span', 'd-ico', /Приложение|^App /.test(d.name) ? '🖥' : /Android|iOS/.test(d.name) ? '📱' : '🌐'));
      const body = el('div', 'd-body');
      const meta = el('div', 'd-meta', seenText(d));
      if (d.ip) meta.append(' · ', el('code', 'd-ip', d.ip));
      body.append(el('div', 'd-name', `${d.name} · ${t('№{0}', d.id)}`), meta);
      li.append(body);
      if (!d.current) {
        const b = el('button', 'ghost', t('Отвязать'));
        b.addEventListener('click', async () => {
          if (!confirm(t('Отвязать «{0}»? Оно перестанет получать сообщения, а ключи на нём будут стёрты при следующем подключении.', d.name))) return;
          try {
            await client.unlinkDevice(d.id);
            toast('Устройство отвязано');
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

async function openDevices() {
  $('link-form-error').textContent = '';
  $('link-input').value = '';
  $('scan-btn').hidden = !('BarcodeDetector' in window && navigator.mediaDevices?.getUserMedia);
  $('devices-dialog').showModal();
  await renderDevices();
}

async function linkWithCode(code) {
  $('link-form-error').textContent = '';
  try {
    await client.linkDevice(code);
    $('link-input').value = '';
    toast('Ключи переданы. Новое устройство подключается…', 5000);
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

// Сканирование QR камерой (где браузер поддерживает BarcodeDetector)
let scanStream = null;
function stopScan() {
  if (scanStream) scanStream.getTracks().forEach((tr) => tr.stop());
  scanStream = null;
  $('scan-video').hidden = true;
}
$('scan-btn').addEventListener('click', async () => {
  if (scanStream) return stopScan();
  try {
    const detector = new BarcodeDetector({ formats: ['qr_code'] });
    scanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    const video = $('scan-video');
    video.srcObject = scanStream;
    video.hidden = false;
    await video.play();
    const tick = async () => {
      if (!scanStream) return;
      const found = await detector.detect(video).catch(() => []);
      const hit = found.find((f) => /^TAINIK1:/i.test(f.rawValue));
      if (hit) {
        stopScan();
        $('link-input').value = hit.rawValue;
        if (confirm(t('Найден код привязки. Передать ключи этому устройству?'))) linkWithCode(hit.rawValue);
        return;
      }
      requestAnimationFrame(tick);
    };
    tick();
  } catch {
    stopScan();
    $('link-form-error').textContent = t('Камера недоступна — введите код вручную');
  }
});
$('devices-close').addEventListener('click', () => {
  stopScan();
  $('devices-dialog').close();
});
$('devices-dialog').addEventListener('close', stopScan);
client.on('devices-changed', () => {
  if ($('devices-dialog').open) renderDevices();
});

// ---------- События клиента ----------
client.on('status', setStatus);
client.on('contacts', () => {
  renderContacts();
  if (current) renderHeader();
});
client.on('message', async ({ contact, message }) => {
  const incoming = message.dir === 'in';
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
  node.querySelector('.st').textContent = STATUS_ICON[status] || '';
});
client.on('key-changed', (c) => toast(`⚠ Ключ пользователя ${c.username} изменился`, 6000));
client.on('error', async ({ code, text }) => {
  if (code === 'logged_in_elsewhere') return toast(text, 0);
  if (code === 'device_removed' || code === 'account_deleted') {
    // Устройство отвязано с другого устройства или аккаунт удалён — стираем ключи здесь
    const name = client.account?.username || '';
    await dropPush(false);
    await client.reset();
    current = null;
    const text =
      code === 'account_deleted'
        ? t('Аккаунт {0} удалён администратором сервера. Ключи и переписка на этом устройстве стёрты.', name)
        : t('Это устройство отвязано от аккаунта {0}. Ключи и переписка удалены.', name);
    if (await forgetActiveAccount()) {
      await settings.set('flash', text);
      return location.reload();
    }
    showAuth();
    $('auth-error').textContent = text;
    return;
  }
  toast(text);
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

async function showNotice({ title, body, chat, tag, call = false, force = false }) {
  if (!(await notifPrefs()).enabled) return;
  if (desktop) return desktop.notify({ title, body, chat, call, force });
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

async function notifyMessage(contact, message) {
  const { preview } = await notifPrefs();
  const text = preview ? textOf(message.content).replace(/\s+/g, ' ').slice(0, 160) : '';
  await showNotice({ title: contact, body: text || t('Новое сообщение'), chat: contact, tag: 'msg:' + contact });
}

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
    toast('Этот браузер не поддерживает уведомления');
    return false;
  }
  if (isIOS && !standalone) {
    toast('На iPhone и iPad: «Поделиться» → «На экран „Домой“», откройте Тайник с экрана «Домой» и включите уведомления там', 9000);
    return false;
  }
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') {
    toast(perm === 'denied' ? t('Уведомления запрещены для этого сайта в настройках браузера') : t('Уведомления не включены'));
    return false;
  }
  await settings.set('notify', '1');
  await syncPush();
  if (pushProblem === 'browser') toast('Уведомления будут приходить, пока вкладка открыта: этот браузер не поддерживает push-уведомления Тайника', 7000);
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
  if (await enableNotifications()) toast('Уведомления включены');
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
const calls = new CallManager({ client, onChange: renderCall });
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
    $('remote-audio').play().catch(() => {});
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
      showNotice({ title: c.peer, body: c.video ? t('Входящий видеозвонок') : t('Входящий звонок'), chat: c.peer, tag: 'call:' + c.peer, call: true });
    }
  } else {
    document.title = baseTitle();
  }
}

async function startCall(video) {
  if (!current) return;
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
$('call-cam').addEventListener('click', () => calls.toggleCamera().catch(() => toast('Камера недоступна')));
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
  setReply({ id, name: m.dir === 'out' ? t('Вы') : current, text: textOf(m.content).replace(/\s+/g, ' ').slice(0, 120) });
}

// Меню сообщения
let menuFor = null;
async function openMenu(id, x, y) {
  menuFor = id;
  const menu = $('msg-menu');
  const m = await findMsg(id);
  if (menuFor !== id) return;
  menu.querySelector('[data-act="save"]').hidden = !m?.content?.file;
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
    if (!target) return toast('Сообщение удалено');
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    target.classList.remove('flash');
    void target.offsetWidth;
    target.classList.add('flash');
    return;
  }
  const act = e.target.closest('[data-act]');
  if (!act) return;
  if (act.dataset.act === 'cancel-upload') return cancelUpload(act.dataset.up);
  const id = msgId(act);
  if (!id) return;
  if (act.dataset.act === 'reply') return replyTo(id);
  if (act.dataset.act === 'open') return openMedia(id);
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
  if (b.dataset.act === 'save') {
    const m = await findMsg(id);
    if (m?.content?.file) saveMedia(m.content.file);
    return;
  }
  if (b.dataset.act === 'copy') {
    const m = await findMsg(id);
    try {
      await navigator.clipboard.writeText(m?.content?.body || '');
      toast('Скопировано');
    } catch {
      toast('Не удалось скопировать');
    }
    return;
  }
  if (b.dataset.act === 'delete') {
    $('del-peer').textContent = current;
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
  if (reply && ids.includes(reply.id) && contact === current) setReply(null);
  // Чат удалён (здесь или на другом своём устройстве) — закрываем его
  if (chat && contact === current && (await client.contacts())[contact]?.hidden) {
    $('back-btn').click();
    return;
  }
  if (contact === current) await renderChat();
  renderContacts();
});

// ---------- Блокировка и удаление чата ----------
let chatMenuFor = null;
function openChatMenu(name, x, y) {
  chatMenuFor = name;
  const menu = $('chat-menu');
  const isBlocked = client.isBlocked(name);
  menu.querySelector('[data-act="block"]').hidden = isBlocked;
  menu.querySelector('[data-act="unblock"]').hidden = !isBlocked;
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
  if (b.dataset.act === 'block') {
    $('block-peer').textContent = name;
    $('block-delete').checked = false;
    $('block-dialog').dataset.name = name;
    $('block-dialog').returnValue = '';
    return $('block-dialog').showModal();
  }
  if (b.dataset.act === 'delete-chat') {
    $('delchat-peer').textContent = name;
    $('delchat-peer2').textContent = name;
    $('delchat-all').checked = false;
    $('delchat-dialog').dataset.name = name;
    $('delchat-dialog').returnValue = '';
    $('delchat-dialog').showModal();
  }
});

async function setBlocked(name, on) {
  try {
    await client.setBlocked(name, on);
    toast(on ? t('{0} заблокирован', name) : t('{0} разблокирован', name));
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
    renderHeader(); // галочку могли поставить или снять
  }
  renderContacts();
});
client.on('verified', (on) => client.account && setName($('me-name'), client.account.username, on));
client.on('status', renderPresence);
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
  if (savedAccounts().length >= MAX_ACCOUNTS) return toast(`На одном устройстве — не больше ${MAX_ACCOUNTS} аккаунтов`);
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

async function notifyOther(acc, contact, message) {
  const { preview } = await notifPrefs();
  const text = preview ? textOf(message.content).replace(/\s+/g, ' ').slice(0, 160) : '';
  await showNotice({
    title: `${contact} → ${acc.username}`,
    body: text || t('Новое сообщение'),
    chat: `${contact}@${acc.id}`,
    tag: `msg:${acc.id}:${contact}`,
    force: true,
  });
}

/** Остальные аккаунты: подключаются в фоне, принимают сообщения, считают непрочитанные. */
async function startOthers() {
  for (const acc of savedAccounts()) {
    if (acc.id === activeId || others.has(acc.id)) continue;
    const c = new MessengerClient({ url: acc.server || DEFAULT_SERVER, storage: storageFor(acc.id) });
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
    c.on('status', () => $('accounts-dialog').open && renderAccounts());
    c.on('message', ({ contact, message }) => {
      recount();
      if (message.dir === 'in') notifyOther(acc, contact, message);
    });
    // Звонок на неактивный аккаунт: принять его можно только в активном — подсказываем
    c.on('call-signal', ({ from, data }) => {
      if (data?.kind !== 'offer') return;
      showNotice({
        title: `${from} → ${acc.username}`,
        body: t('Звонит. Откройте этот аккаунт, чтобы ответить'),
        chat: `${from}@${acc.id}`,
        tag: `msg:${acc.id}:${from}`,
        force: true,
      });
    });
    c.on('error', async ({ code }) => {
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
      toast(code === 'account_deleted' ? t('Аккаунт {0} удалён администратором', acc.username || '') : t('Это устройство отвязано от аккаунта {0}', acc.username || ''));
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
      if (r === 'opened') toast('Откройте скачанный файл, чтобы завершить установку', 6000);
      if (r === 'permission') toast('Разрешите Тайнику установку приложений, вернитесь и нажмите «Установить» ещё раз', 8000);
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
