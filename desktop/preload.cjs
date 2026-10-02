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
  notify: (body) => ipcRenderer.send('notify', String(body)),
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
