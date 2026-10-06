// Service worker Тайника: только уведомления. Ничего не кеширует и к ключам доступа не имеет.
// Пуш приходит, когда вкладка закрыта: сервер сообщает лишь тип события и имя отправителя
// (зашифровано ключом браузера). Текст сообщения расшифровывается только в открытом приложении.
'use strict';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

const NAME_RE = /^[a-z0-9_]{3,32}$/;
// Язык уведомлений страница передаёт при регистрации: /sw.js?lang=en
const EN = new URL(self.location.href).searchParams.get('lang') === 'en';
const TEXT = EN
  ? { app: 'Tainik', missed: 'Missed call', msg: 'New message', notice: 'New notification' }
  : { app: 'Тайник', missed: 'Пропущенный звонок', msg: 'Новое сообщение', notice: 'Новое уведомление' };
const SYSTEM_CHAT = '~tainik'; // служебный чат «Тайник» (см. shared/client-core.js)

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {}
  const from = typeof data.from === 'string' && NAME_RE.test(data.from) ? data.from : '';
  const call = data.t === 'call';
  const notice = data.t === 'notice';
  event.waitUntil(
    (async () => {
      // Открытая и видимая вкладка сама показывает новые сообщения
      const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      if (wins.some((w) => w.visibilityState === 'visible' && w.focused)) return;
      const chat = notice ? SYSTEM_CHAT : from;
      await self.registration.showNotification(notice ? TEXT.app : from || TEXT.app, {
        body: call ? TEXT.missed : notice ? TEXT.notice : TEXT.msg,
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
