// Мост между страницей и главным процессом. Странице доступны только эти функции —
// ни Node.js, ни файловой системы у неё нет (contextIsolation + sandbox).
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

function storageFor(ns) {
  ns = ns ? String(ns) : undefined;
  return {
    get: (k) => ipcRenderer.invoke('store:get', k, ns),
    set: (k, v) => ipcRenderer.invoke('store:set', k, v, ns),
    del: (k) => ipcRenderer.invoke('store:del', k, ns),
    clear: () => ipcRenderer.invoke('store:clear', ns),
  };
}

contextBridge.exposeInMainWorld('desktop', {
  storage: storageFor(''),
  // Хранилище дополнительного аккаунта (у каждого свой зашифрованный файл)
  storageFor,
  settings: {
    get: (k) => ipcRenderer.invoke('settings:get', k),
    set: (k, v) => ipcRenderer.invoke('settings:set', k, v),
  },
  // Системное уведомление: { title, body, chat, call }. Клик открывает окно и чат.
  notify: (n) =>
    ipcRenderer.send('notify', {
      title: String(n?.title ?? 'Тайник'),
      body: String(n?.body ?? ''),
      chat: String(n?.chat ?? ''),
      call: !!n?.call,
      force: !!n?.force,
    }),
  dismissNotice: (n) => ipcRenderer.send('dismiss-notice', { chat: String(n?.chat ?? ''), call: !!n?.call }),
  onOpenChat: (handler) => {
    ipcRenderer.removeAllListeners('open-chat');
    ipcRenderer.on('open-chat', (_e, chat) => handler(String(chat)));
  },
  // Счётчик непрочитанных: значок в доке/панели задач и подсказка у значка в трее
  setBadge: (n) => ipcRenderer.send('badge', Number(n) || 0),
  // Работа в фоне: { tray, autostart, autostartSupported }
  background: {
    get: () => ipcRenderer.invoke('bg:get'),
    set: (key, value) => ipcRenderer.invoke('bg:set', String(key), !!value),
  },
  version: () => ipcRenderer.invoke('app:version'),
  // Самообновление: состояние { status, version, progress, error, auto, … }
  updates: {
    get: () => ipcRenderer.invoke('upd:get'),
    check: () => ipcRenderer.invoke('upd:check'),
    download: () => ipcRenderer.invoke('upd:download'),
    install: () => ipcRenderer.invoke('upd:install'),
    setAuto: (on) => ipcRenderer.invoke('upd:auto', !!on),
    onChange: (handler) => {
      ipcRenderer.removeAllListeners('upd:state');
      ipcRenderer.on('upd:state', (_e, st) => handler(st));
    },
  },
  // Выбор экрана/окна для трансляции. handler(list) → Promise<id | null>
  onPickSource: (handler) => {
    ipcRenderer.removeAllListeners('pick-source');
    ipcRenderer.on('pick-source', async (_e, reqId, list) => {
      let id = null;
      try {
        id = await handler(list);
      } catch {}
      ipcRenderer.send('pick-source-result', reqId, id ?? null);
    });
  },
});
