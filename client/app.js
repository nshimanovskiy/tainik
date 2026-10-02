import { MessengerClient, ERROR_TEXT } from '/shared/client-core.js';
import { formatLinkCode } from '/shared/protocol/provision.js';
import { qrEncode } from '/shared/qr.js';
import { IdbStorage, settings as webSettings } from './idb-storage.js';
import config from './config.js';
import { CallManager, CALL_RESULT_TEXT } from './call.js';

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

if (!window.isSecureContext || !globalThis.crypto?.subtle || (!desktop && !window.indexedDB)) {
  $('unsupported').hidden = false;
  throw new Error('Небезопасный контекст: WebCrypto недоступен');
}

const settings = desktop
  ? desktop.settings
  : { get: async (k) => webSettings.get(k), set: async (k, v) => webSettings.set(k, v) };
const storage = desktop ? desktop.storage : new IdbStorage('tainik-v3');
const sameOriginWs = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
const DEFAULT_SERVER = desktop ? config.defaultServer || 'ws://localhost:8080/ws' : sameOriginWs;

const client = new MessengerClient({ url: DEFAULT_SERVER, storage });
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
const timeFmt = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' });
const dayFmt = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long' });
function dayLabel(ts) {
  const d = new Date(ts);
  const today = new Date();
  const y = new Date(Date.now() - 86400000);
  if (d.toDateString() === today.toDateString()) return 'Сегодня';
  if (d.toDateString() === y.toDateString()) return 'Вчера';
  return dayFmt.format(d);
}
let toastTimer;
function toast(text, ms = 3500) {
  const t = $('toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  if (ms) toastTimer = setTimeout(() => (t.hidden = true), ms);
}
const STATUS_ICON = { sending: '⏳', sent: '✓', delivered: '✓✓', failed: '⚠ не отправлено' };
const STATUS_TEXT = { online: 'в сети', connecting: 'подключение…', offline: 'нет связи', replaced: 'открыт в другом месте' };

function callText(ct) {
  const dir = ct.direction === 'out' ? 'Исходящий' : 'Входящий';
  const kind = ct.video ? 'видеозвонок' : 'звонок';
  if (ct.result === 'answered') {
    const d = ct.duration || 0;
    const dur = d >= 3600 ? `${Math.floor(d / 3600)}:${String(Math.floor((d % 3600) / 60)).padStart(2, '0')}:${String(d % 60).padStart(2, '0')}` : `${Math.floor(d / 60)}:${String(d % 60).padStart(2, '0')}`;
    return `📞 ${dir} ${kind} · ${dur}`;
  }
  if (ct.result === 'missed') return `📞 Пропущенный ${kind}`;
  return `📞 ${dir} ${kind} · ${CALL_RESULT_TEXT[ct.result] || ct.result}`;
}

function previewOf(m) {
  if (!m) return 'Нет сообщений';
  if (m.dir === 'sys' && m.content?.t === 'call') return callText(m.content);
  if (m.dir === 'sys') return 'Служебное сообщение';
  const body = m.content?.body ?? '';
  return (m.dir === 'out' ? 'Вы: ' : '') + body.replace(/\s+/g, ' ');
}

// ---------- Экраны ----------
function showAuth() {
  $('auth').hidden = false;
  $('app').hidden = true;
  if (desktop) {
    $('server-field').hidden = false;
    if (!$('server').value) $('server').value = DEFAULT_SERVER;
  }
  $('username').focus();
}
async function showApp() {
  $('auth').hidden = true;
  $('app').hidden = false;
  $('me-name').textContent = client.account.username;
  paintAvatar($('me-avatar'), client.account.username);
  setStatus(client.status);
  await renderContacts();
  initNotifications().catch((e) => console.warn('notifications', e));
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
  if (u.protocol !== 'ws:' && u.protocol !== 'wss:') throw new Error('Адрес должен начинаться с ws:// или wss://');
  if (u.pathname === '/' || u.pathname === '') u.pathname = '/ws';
  return u.toString();
}

function readServer(errorNode) {
  try {
    return desktop ? normalizeServer($('server').value) : DEFAULT_SERVER;
  } catch (err) {
    errorNode.textContent = err.message.startsWith('Адрес') ? err.message : 'Неверный адрес сервера';
    return null;
  }
}

// Понятное имя устройства для списка устройств
function deviceName() {
  const ua = navigator.userAgent;
  const os = /Windows/.test(ua) ? 'Windows' : /Mac OS X|Macintosh/.test(ua) ? (/iPhone|iPad/.test(ua) ? 'iOS' : 'macOS') : /Android/.test(ua) ? 'Android' : /Linux/.test(ua) ? 'Linux' : 'ОС';
  if (desktop) return `Приложение · ${os}`;
  const br = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Браузер';
  return `${br} · ${os}`;
}

$('auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('username').value.trim().toLowerCase();
  $('auth-error').textContent = '';
  const server = readServer($('auth-error'));
  if (!server) return;
  $('auth-btn').disabled = true;
  $('auth-btn').textContent = 'Создаём ключи…';
  try {
    client.url = server;
    await client.register(name, { deviceName: deviceName() });
    await settings.set('server', server);
    await showApp();
  } catch (err) {
    $('auth-error').textContent = err.code === 'timeout' ? 'Сервер недоступен' : err.message;
  } finally {
    $('auth-btn').disabled = false;
    $('auth-btn').textContent = 'Создать ключи и войти';
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
    await showApp();
    toast('Устройство привязано. Контакты перенесены, старая переписка — нет.', 6000);
  } catch (err) {
    linking = null;
    resetLinkPane();
    if (err.code !== 'cancelled') {
      $('link-error').textContent =
        err.code === 'offline' ? 'Соединение прервано. Нажмите, чтобы получить новый код.' : err.message;
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
async function renderContacts() {
  const all = Object.values(await client.contacts()).sort((a, b) => b.lastTs - a.lastTs);
  const ul = $('contacts');
  ul.replaceChildren();
  $('no-contacts').hidden = all.length > 0;
  setUnread(all.reduce((n, c) => n + (c.unread || 0), 0));
  for (const c of all) {
    const msgs = await client.messages(c.username);
    const li = el('li');
    const btn = el('button', c.username === current ? 'active' : '');
    const avWrap = el('span', 'avatar-wrap');
    const av = el('span', 'avatar');
    paintAvatar(av, c.username);
    avWrap.append(av);
    if (client.presenceOf(c.username)?.online) avWrap.append(el('span', 'online-dot'));
    const body = el('div', 'c-body');
    const top = el('div', 'c-top');
    top.append(el('span', 'c-name', c.username));
    if (c.keyChanged) top.append(el('span', 'shield warn', '⚠ ключ изменён'));
    else if (c.verified) top.append(el('span', 'shield', '✔ проверен'));
    body.append(top, el('div', 'c-preview', previewOf(msgs[msgs.length - 1])));
    btn.append(avWrap, body);
    if (c.unread && c.username !== current) btn.append(el('span', 'badge', String(c.unread)));
    btn.addEventListener('click', () => openChat(c.username));
    li.append(btn);
    ul.append(li);
  }
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
  await renderChat();
  await renderContacts();
  $('text').focus();
}

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
  $('peer-name').textContent = c.username;
  paintAvatar($('peer-avatar'), c.username);
  const v = $('peer-verify');
  if (c.keyChanged) {
    v.className = 'peer-verify bad';
    v.textContent = '⚠ ключ изменился — сверьте код';
  } else if (c.verified) {
    v.className = 'peer-verify ok';
    v.textContent = '✔ ключ проверен';
  } else {
    v.className = 'peer-verify';
    v.textContent = '🔒 ключ не проверен';
  }
  renderPresence();
  $('key-banner').hidden = !c.keyChanged;
  updateComposer(c);
}

// ---------- Статус собеседника ----------
const hmFmt = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' });
const dmFmt = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short' });
function presenceText(p) {
  if (!p) return '';
  if (p.online) return 'в сети';
  if (p.hidden || !p.lastSeen) return 'был(а) недавно';
  const diff = Date.now() - p.lastSeen;
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'был(а) только что';
  if (min < 60) return `был(а) ${min} мин. назад`;
  const d = new Date(p.lastSeen);
  const today = new Date();
  const y = new Date(Date.now() - 86400000);
  if (d.toDateString() === today.toDateString()) return `был(а) сегодня в ${hmFmt.format(d)}`;
  if (d.toDateString() === y.toDateString()) return `был(а) вчера в ${hmFmt.format(d)}`;
  return `был(а) ${dmFmt.format(d)}`;
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
  const blocked = !c || !!c.keyChanged;
  $('send-btn').disabled = blocked || client.status !== 'online';
  const noCall = blocked || client.status !== 'online' || !window.RTCPeerConnection;
  $('call-audio-btn').disabled = noCall;
  $('call-video-btn').disabled = noCall;
  $('text').disabled = blocked;
  $('text').placeholder = blocked ? 'Отправка остановлена: ключ изменился' : client.status === 'online' ? 'Сообщение' : 'Нет связи — сообщение уйдёт позже';
  if (!blocked) $('send-btn').disabled = !$('text').value.trim();
}

const REJECT_TEXT = {
  identity_mismatch: 'Сообщение отклонено: ключ отправителя не совпадает с проверенным',
  unknown_spk: 'Не удалось расшифровать: сообщение слишком старое (ключ уже удалён)',
  no_session: 'Не удалось расшифровать: нет сессии. Попросите собеседника написать ещё раз',
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
      ? REJECT_TEXT[m.content.reason] || 'Сообщение отклонено: не удалось подтвердить его подлинность'
      : 'Вы приняли новый ключ собеседника. Сверьте код безопасности.';
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
    q.append(el('b', '', r.from === client.account.username ? 'Вы' : r.from), el('span', '', r.body || 'Сообщение'));
    bubble.append(q);
  }
  bubble.append(document.createTextNode(m.content?.body ?? ''));
  li.append(bubble);
  const acts = el('div', 'msg-actions');
  const rb = el('button', '', '↩︎');
  rb.type = 'button';
  rb.dataset.act = 'reply';
  rb.title = 'Ответить';
  rb.setAttribute('aria-label', 'Ответить');
  const mb = el('button', '', '⋯');
  mb.type = 'button';
  mb.dataset.act = 'menu';
  mb.title = 'Ещё';
  mb.setAttribute('aria-label', 'Действия с сообщением');
  acts.append(rb, mb);
  li.append(acts);
  const meta = el('div', 'meta');
  meta.append(el('span', '', timeFmt.format(new Date(m.ts))));
  if (m.dir === 'out') meta.append(el('span', 'st', STATUS_ICON[m.status] || ''));
  li.append(meta);
  return li;
}

async function renderChat() {
  if (!current) return;
  await renderHeader();
  const list = await client.messages(current);
  const ol = $('messages');
  ol.replaceChildren(el('li', 'e2e-note', '🔒 Сообщения в этом чате защищены сквозным шифрованием'));
  let lastDay = '';
  for (const m of list) {
    const d = dayLabel(m.ts);
    if (d !== lastDay) {
      ol.append(el('li', 'day', d));
      lastDay = d;
    }
    ol.append(messageNode(m));
  }
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
  if (!confirm('Принять новый ключ? Делайте это, только если собеседник подтвердил, что переустановил мессенджер.')) return;
  await client.acceptNewKey(current);
  await renderChat();
});

// ---------- Меню ----------
$('menu-btn').addEventListener('click', async () => {
  $('my-fp').textContent = await client.myFingerprint();
  $('my-server').textContent = client.url;
  $('presence-visible').checked = !client.presenceHidden;
  if (desktop?.version) {
    $('my-version').textContent = await desktop.version();
    $('my-version-row').hidden = false;
  }
  $('my-device').textContent = `${client.account.deviceName || 'Устройство'} (№${client.account.deviceId})`;
  await fillNotifSettings();
  $('menu-dialog').showModal();
});
$('menu-dialog').addEventListener('close', async () => {
  const v = $('menu-dialog').returnValue;
  if (v === 'devices') return openDevices();
  if (v !== 'reset') return;
  if (!confirm('Стереть ключи и переписку на этом устройстве? Другие устройства аккаунта продолжат работать.')) return;
  await dropPush(true);
  await client.reset();
  location.reload();
});

// ---------- Устройства (на уже привязанном устройстве) ----------
const relTime = new Intl.RelativeTimeFormat('ru', { numeric: 'auto' });
function seenText(d) {
  if (d.current) return 'это устройство';
  if (d.online) return 'в сети';
  const min = Math.round((d.lastSeen - Date.now()) / 60000);
  if (min > -60) return 'был(о) ' + relTime.format(min, 'minute');
  if (min > -1440) return 'был(о) ' + relTime.format(Math.round(min / 60), 'hour');
  return 'был(о) ' + relTime.format(Math.round(min / 1440), 'day');
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
      li.append(el('span', 'd-ico', /Приложение/.test(d.name) ? '🖥' : /Android|iOS/.test(d.name) ? '📱' : '🌐'));
      const body = el('div', 'd-body');
      body.append(el('div', 'd-name', `${d.name} · №${d.id}`), el('div', 'd-meta', seenText(d)));
      li.append(body);
      if (!d.current) {
        const b = el('button', 'ghost', 'Отвязать');
        b.addEventListener('click', async () => {
          if (!confirm(`Отвязать «${d.name}»? Оно перестанет получать сообщения, а ключи на нём будут стёрты при следующем подключении.`)) return;
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
  if (!confirm('Передать ключ вашей личности устройству с этим кодом? Делайте это, только если код с вашего собственного экрана.')) return;
  linkWithCode(code);
});

// Сканирование QR камерой (где браузер поддерживает BarcodeDetector)
let scanStream = null;
function stopScan() {
  if (scanStream) scanStream.getTracks().forEach((t) => t.stop());
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
        if (confirm('Найден код привязки. Передать ключи этому устройству?')) linkWithCode(hit.rawValue);
        return;
      }
      requestAnimationFrame(tick);
    };
    tick();
  } catch {
    stopScan();
    $('link-form-error').textContent = 'Камера недоступна — введите код вручную';
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
  if (code === 'device_removed') {
    // Устройство отвязано с другого устройства — стираем ключи здесь
    await dropPush(false);
    await client.reset();
    current = null;
    showAuth();
    $('auth-error').textContent = 'Это устройство отвязано от аккаунта. Ключи и переписка удалены.';
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
  return unreadTotal ? `(${unreadTotal}) Тайник` : 'Тайник — E2E-мессенджер';
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
    .register('/sw.js', { scope: '/' })
    .then(() => navigator.serviceWorker.ready)
    .catch((e) => {
      console.warn('service worker', e);
      return null;
    });
  return swReady;
}

async function showNotice({ title, body, chat, tag, call = false }) {
  if (!(await notifPrefs()).enabled) return;
  if (desktop) return desktop.notify({ title, body, chat, call });
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
  const text = preview && message.content?.t === 'text' ? String(message.content.body || '').replace(/\s+/g, ' ').slice(0, 160) : '';
  await showNotice({ title: contact, body: text || 'Новое сообщение', chat: contact, tag: 'msg:' + contact });
}

async function openChatFromNotice(chat) {
  if (!chat || !client.account) return;
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
    toast(perm === 'denied' ? 'Уведомления запрещены для этого сайта в настройках браузера' : 'Уведомления не включены');
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
  if (desktop) hint = 'Приложение получает сообщения, пока запущено, в том числе свёрнутым в трей.';
  else if (!webNotif) hint = 'Этот браузер не поддерживает уведомления.';
  else if (isIOS && !standalone) hint = 'На iPhone и iPad уведомления работают, если добавить Тайник на экран «Домой»: «Поделиться» → «На экран „Домой“».';
  else if (Notification.permission === 'denied') hint = 'Уведомления запрещены для этого сайта в настройках браузера (значок слева от адреса).';
  else if (enabled && webPush && !pushProblem)
    hint = 'Когда вкладка закрыта, сервер будит браузер через его push-сервис (Google, Mozilla или Apple). Текста сообщений там нет — только имя отправителя, зашифрованное для вашего браузера.';
  else if (enabled) hint = 'Уведомления приходят, пока вкладка открыта.';
  else hint = 'Текст сообщений по умолчанию не показывается: его увидят только те, кто смотрит на ваш экран.';
  $('notif-hint').textContent = hint;
  if (desktop?.background) {
    const bg = await desktop.background.get();
    $('bg-settings').hidden = false;
    $('bg-tray').checked = bg.tray;
    $('bg-autostart').checked = bg.autostart;
    $('bg-autostart').disabled = !bg.autostartSupported;
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
      toast(err.message || 'Не удалось изменить настройку');
    }
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
    client.url = (await settings.get('server')) || DEFAULT_SERVER;
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
  const t = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(t / 3600);
  const mm = String(Math.floor((t % 3600) / 60)).padStart(h ? 2 : 1, '0');
  const ss = String(t % 60).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function callStatusText(c) {
  if (c.phase === 'ended') return CALL_RESULT_TEXT[c.result] === 'звонок' ? 'Звонок завершён' : (CALL_RESULT_TEXT[c.result] || 'Звонок завершён').replace(/^./, (x) => x.toUpperCase());
  if (c.reconnecting) return 'Переподключение…';
  switch (c.phase) {
    case 'preparing':
      return 'Подготовка…';
    case 'outgoing':
      return 'Вызов…';
    case 'incoming':
      return c.video ? 'Входящий видеозвонок' : 'Входящий звонок';
    case 'connecting':
      return 'Соединение…';
    case 'active':
      return fmtDur(Date.now() - c.startedAt);
  }
  return '';
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

function renderCall(c) {
  const box = $('call');
  if (!c) {
    box.hidden = true;
    clearInterval(callTicker);
    callTicker = null;
    for (const id of ['remote-main', 'remote-pip', 'local-pip']) setVideo($(id), null, false);
    $('remote-audio').srcObject = null;
    document.title = baseTitle();
    return;
  }
  box.hidden = false;
  $('call-name').textContent = c.peer;
  $('call-top-name').textContent = c.peer;
  paintAvatar($('call-avatar'), c.peer);
  const status = callStatusText(c);
  $('call-status').textContent = status;
  $('call-top-status').textContent = status;

  // Звук собеседника
  if (c.remote.audio.getTracks().length && $('remote-audio').srcObject !== c.remote.audio) {
    $('remote-audio').srcObject = c.remote.audio;
    $('remote-audio').play().catch(() => {});
  }

  // Видео: экран собеседника — главный, камера — в углу
  const live = c.phase === 'active' || c.phase === 'connecting';
  const rScreen = live && c.remoteState.screen && c.remote.screen.getTracks().length > 0;
  const rCam = live && c.remoteState.cam && c.remote.cam.getTracks().length > 0;
  const main = rScreen ? c.remote.screen : rCam ? c.remote.cam : null;
  setVideo($('remote-main'), main, !!main);
  $('remote-main').classList.toggle('cover', !rScreen);
  setVideo($('remote-pip'), c.remote.cam, rScreen && rCam);
  $('call-placeholder').hidden = !!main;
  $('call-topbar').hidden = !main;

  // Своё превью: камера (зеркально) или показываемый экран
  const mine = c.local.cam || c.local.screen;
  const localStream = mine ? new MediaStream([mine]) : null;
  const lp = $('local-pip');
  if (mine && lp.srcObject?.getTracks()[0] !== mine) lp.srcObject = localStream;
  lp.hidden = !mine || c.phase === 'ended';
  lp.classList.toggle('screen', !c.local.cam && !!c.local.screen);
  $('sharing-badge').hidden = !c.local.screen;

  // Кнопки
  $('call-incoming').hidden = c.phase !== 'incoming';
  $('call-active').hidden = c.phase === 'incoming' || c.phase === 'ended';
  const mic = $('call-mic');
  const micOff = !c.local.mic || !c.local.mic.enabled;
  mic.classList.toggle('off', micOff);
  mic.setAttribute('aria-pressed', String(micOff));
  mic.querySelector('span').textContent = micOff ? 'Вкл. микрофон' : 'Микрофон';
  $('call-cam').classList.toggle('on', !!c.local.cam);
  $('call-cam').setAttribute('aria-pressed', String(!!c.local.cam));
  $('call-screen').classList.toggle('on', !!c.local.screen);
  $('call-screen').setAttribute('aria-pressed', String(!!c.local.screen));
  const inCall = c.phase === 'active' || c.phase === 'connecting';
  $('call-cam').disabled = !inCall;
  $('call-screen').disabled = !inCall || !(navigator.mediaDevices?.getDisplayMedia);

  if (c.phase === 'active' && !callTicker) {
    callTicker = setInterval(() => {
      if (calls.call?.phase === 'active') {
        const t = callStatusText(calls.call);
        $('call-status').textContent = t;
        $('call-top-status').textContent = t;
      }
    }, 1000);
  }
  if (c.phase === 'incoming') {
    document.title = `📞 ${c.peer} — входящий звонок`;
    if (!document.hasFocus() && notifiedCall !== c.id) {
      notifiedCall = c.id;
      showNotice({ title: c.peer, body: c.video ? 'Входящий видеозвонок' : 'Входящий звонок', chat: c.peer, tag: 'call:' + c.peer, call: true });
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
    if (err.message !== 'cancelled') toast(err.message || 'Не удалось позвонить');
  }
}
$('call-audio-btn').addEventListener('click', () => startCall(false));
$('call-video-btn').addEventListener('click', () => startCall(true));
$('call-accept-audio').addEventListener('click', () => calls.accept({ video: false }).catch((e) => toast(e.message)));
$('call-accept-video').addEventListener('click', () => calls.accept({ video: true }).catch((e) => toast(e.message)));
$('call-decline').addEventListener('click', () => calls.decline());
$('call-hangup').addEventListener('click', () => calls.hangup());
$('call-mic').addEventListener('click', () => calls.toggleMic());
$('call-cam').addEventListener('click', () => calls.toggleCamera().catch(() => toast('Камера недоступна')));
$('call-screen').addEventListener('click', () =>
  calls.toggleScreen().catch((e) => {
    if (e?.name !== 'NotAllowedError' && e?.name !== 'AbortError') toast(e.message || 'Не удалось показать экран');
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
  setReply({ id, name: m.dir === 'out' ? 'Вы' : current, text: (m.content?.body || '').replace(/\s+/g, ' ').slice(0, 120) });
}

// Меню сообщения
let menuFor = null;
function openMenu(id, x, y) {
  menuFor = id;
  const menu = $('msg-menu');
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
  const id = msgId(act);
  if (!id) return;
  if (act.dataset.act === 'reply') return replyTo(id);
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
  const t = e.touches[0];
  pressTimer = setTimeout(() => openMenu(id, t.clientX, t.clientY), 500);
}, { passive: true });
for (const ev of ['touchend', 'touchmove', 'touchcancel']) $('messages').addEventListener(ev, () => clearTimeout(pressTimer), { passive: true });

$('msg-menu').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-act]');
  if (!b || !menuFor) return;
  const id = menuFor;
  closeMenu();
  if (b.dataset.act === 'reply') return replyTo(id);
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

client.on('deleted', async ({ contact, ids }) => {
  if (reply && ids.includes(reply.id) && contact === current) setReply(null);
  if (contact === current) await renderChat();
  renderContacts();
});

// ---------- Статус «в сети» ----------
client.on('presence', ({ username }) => {
  if (username === current) renderPresence();
  renderContacts();
});
client.on('status', renderPresence);
$('presence-visible').addEventListener('change', async (e) => {
  try {
    await client.setPresenceVisible(e.target.checked);
    toast(e.target.checked ? 'Другие видят, когда вы в сети' : 'Ваш статус скрыт: другие видят «был(а) недавно»');
  } catch (err) {
    e.target.checked = !e.target.checked;
    toast(err.message);
  }
});
