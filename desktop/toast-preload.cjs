// Мост для окна уведомления (app://toast): только показ данных и действия этой карточки.
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('toast', {
  onData: (fn) => ipcRenderer.on('toast:data', (_e, d) => fn(d)),
  onLeave: (fn) => ipcRenderer.on('toast:leave', () => fn()),
  act: (a) => ipcRenderer.send('toast:act', String(a)),
  reply: (text) => ipcRenderer.send('toast:reply', String(text).slice(0, 20000)),
  size: (h) => ipcRenderer.send('toast:size', Number(h) || 0),
});
