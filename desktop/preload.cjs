// Мост между страницей и главным процессом. Странице доступны только эти функции —
// ни Node.js, ни файловой системы у неё нет (contextIsolation + sandbox).
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  storage: {
    get: (k) => ipcRenderer.invoke('store:get', k),
    set: (k, v) => ipcRenderer.invoke('store:set', k, v),
    del: (k) => ipcRenderer.invoke('store:del', k),
    clear: () => ipcRenderer.invoke('store:clear'),
  },
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
    }),
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
