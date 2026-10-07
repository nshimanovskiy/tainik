// Service worker Тайника: только уведомления. Ничего не кеширует и к ключам доступа не имеет.
// Пуш приходит, когда вкладка закрыта: сервер сообщает лишь тип события и имя отправителя
// (зашифровано ключом браузера). Текст сообщения расшифровывается только в открытом приложении.
'use strict';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

const NAME_RE = /^[a-z0-9_]{3,32}$/;
const GROUP_RE = /^[0-9a-f]{24}$/;
// Название группы от сервера — только как текст: без управляющих и «переворачивающих» символов
const cleanTitle = (s) => String(s ?? '').replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069\u200b-\u200f\ufeff]/g, '').trim().slice(0, 64);
// Язык уведомлений страница передаёт при регистрации: /sw.js?lang=en (ru, en, es, ja)
const TEXTS = {
  ru: { app: 'Тайник', missed: 'Пропущенный звонок', msg: 'Новое сообщение', notice: 'Новое уведомление', support: 'Ответ поддержки', group: 'Группа' },
  en: { app: 'Tainik', missed: 'Missed call', msg: 'New message', notice: 'New notification', support: 'Reply from support', group: 'Group' },
  es: { app: 'Tainik', missed: 'Llamada perdida', msg: 'Mensaje nuevo', notice: 'Notificación nueva', support: 'Respuesta de soporte', group: 'Grupo' },
  ja: { app: 'Tainik', missed: '不在着信', msg: '新しいメッセージ', notice: '新しい通知', support: 'サポートからの返信', group: 'グループ' },
};
const TEXT = TEXTS[new URL(self.location.href).searchParams.get('lang')] || TEXTS.ru;
const SYSTEM_CHAT = '~tainik'; // служебный чат «Тайник» (см. shared/client-core.js)
const SUPPORT_CHAT = '~support'; // чат поддержки

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {}
  const from = typeof data.from === 'string' && NAME_RE.test(data.from) ? data.from : '';
  const call = data.t === 'call';
  const notice = data.t === 'notice';
  const support = data.t === 'support';
  // Сообщение в группе: в заголовке — название группы, в тексте — кто написал
  const group = data.t === 'msg' && typeof data.g === 'string' && GROUP_RE.test(data.g) ? data.g : null;
  event.waitUntil(
    (async () => {
      // Открытая и видимая вкладка сама показывает новые сообщения
      const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      if (wins.some((w) => w.visibilityState === 'visible' && w.focused)) return;
      const chat = notice ? SYSTEM_CHAT : support ? SUPPORT_CHAT : group ? '#' + group : from;
      const title = notice || support ? TEXT.app : group ? cleanTitle(data.gn) || TEXT.group : from || TEXT.app;
      await self.registration.showNotification(title, {
        body: call ? TEXT.missed : notice ? TEXT.notice : support ? TEXT.support : group && from ? `${from}: ${TEXT.msg}` : TEXT.msg,
        tag: (call ? 'call:' : 'msg:') + chat,
        renotify: true,
        icon: '/icon-192.png',
        badge: '/badge-72.png',
        data: { chat },
      });
    })()
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const chat = event.notification.data?.chat || '';
  event.waitUntil(
    (async () => {
      const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const win = wins.find((w) => new URL(w.url).origin === self.location.origin);
      if (win) {
        await win.focus().catch(() => {});
        if (chat) win.postMessage({ type: 'open-chat', chat });
        return;
      }
      await self.clients.openWindow(chat ? `/app#chat=${encodeURIComponent(chat)}` : '/app');
    })()
  );
});
