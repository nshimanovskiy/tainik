// Уведомления Тайника — свои окошки в углу экрана, как в Telegram Desktop, а не системные:
// аватар, имя, текст, ответ прямо в карточке, «Ответить»/«Отклонить» у звонка. Карточки
// складываются стопкой снизу вверх, сообщение из того же чата обновляет свою карточку,
// под курсором карточка не исчезает.
'use strict';

const WIDTH = 372; // ширина окна (карточка + поля под тень)
const MIN_H = 84;
const MAX_H = 220;
const GAP = 2; // окна уже с полями под тень
const MARGIN = 10; // от края рабочей области экрана
const SHOW_MS = 6000;
const MAX_VISIBLE = 4;

const AVATAR_RE = /^data:image\/(jpeg|png|webp|gif);base64,[A-Za-z0-9+/=]+$/;

/** Положение карточек снизу вверх у правого края рабочей области: [{ x, y }] для высот heights. */
function layoutToasts(area, heights, { width = WIDTH, gap = GAP, margin = MARGIN } = {}) {
  const out = [];
  let bottom = area.y + area.height - margin;
  for (const h of heights) {
    bottom -= h;
    out.push({ x: area.x + area.width - width - margin, y: bottom, width, height: h });
    bottom -= gap;
  }
  return out;
}

/** Данные карточки от страницы — только известные поля и проверенные значения. */
function cleanToast(n) {
  const hue = Number(n.hue);
  return {
    title: String(n.title || '').slice(0, 64),
    body: String(n.body || '').slice(0, 200),
    account: String(n.account || '').slice(0, 40),
    avatar: typeof n.avatar === 'string' && n.avatar.length <= 40_000 && AVATAR_RE.test(n.avatar) ? n.avatar : null,
    letter: [...String(n.letter || '')].slice(0, 1).join(''),
    hue: Number.isFinite(hue) ? Math.round(Math.abs(hue)) % 360 : 0,
    call: !!n.call,
    canReply: !!n.canReply && !n.call,
  };
}

class Toasts {
  /**
   * @param {object} o
   * @param {typeof import('electron').BrowserWindow} o.BrowserWindow
   * @param {import('electron').Screen} o.screen
   * @param {import('electron').IpcMain} o.ipcMain
   * @param {string} o.preload  путь к toast-preload.cjs
   * @param {string} o.url      адрес страницы карточки (app://toast/toast.html)
   * @param {(key: string, act: string, text?: string) => void} o.onAction  open | accept | decline | reply | closed
   * @param {() => object} o.labels  подписи кнопок на языке приложения
   */
  constructor({ BrowserWindow, screen, ipcMain, preload, url, onAction, labels }) {
    Object.assign(this, { BrowserWindow, screen, preload, url, onAction, labels });
    this.items = []; // показанные, снизу вверх: { key, win, data, height, timer, hover, closing }
    this.queue = []; // не поместились — ждут своей очереди
    const own = (event) => this.items.find((x) => x.win && !x.win.isDestroyed() && x.win.webContents.id === event.sender.id);
    ipcMain.on('toast:act', (event, act) => {
      const it = own(event);
      if (!it) return;
      if (act === 'hover') {
        it.hover = true;
        clearTimeout(it.timer);
      } else if (act === 'unhover') {
        it.hover = false;
        if (!it.replying) this._arm(it);
      } else if (act === 'focus') {
        it.replying = true;
        clearTimeout(it.timer);
        it.win.focus();
      } else if (act === 'close') {
        this._close(it);
      } else if (['open', 'accept', 'decline'].includes(act)) {
        this._close(it);
        this.onAction(it.key, act);
      }
    });
    ipcMain.on('toast:reply', (event, text) => {
      const it = own(event);
      text = String(text || '').trim().slice(0, 20000);
      if (!it || !text) return;
      this._close(it);
      this.onAction(it.key, 'reply', text);
    });
    ipcMain.on('toast:size', (event, h) => {
      const it = own(event);
      if (!it) return;
      const height = Math.max(MIN_H, Math.min(MAX_H, Math.round(Number(h) || MIN_H)));
      if (height === it.height) return;
      it.height = height;
      this._layout();
    });
  }

  /** Показать (или обновить карточку того же чата). key — 'msg:<чат>' / 'call:<чат>'. */
  show(key, n) {
    const data = { ...cleanToast(n), labels: this.labels() };
    const it = this.items.find((x) => x.key === key && !x.closing);
    if (it) {
      it.data = data;
      it.win.webContents.send('toast:data', data);
      if (!it.hover && !it.replying) this._arm(it);
      return;
    }
    const q = this.queue.find((x) => x.key === key);
    if (q) return void (q.data = data);
    if (this.items.filter((x) => !x.closing).length >= MAX_VISIBLE) {
      // Места нет: самая старая обычная карточка уступает (звонки и набираемый ответ — нет)
      const old = this.items.findLast((x) => !x.closing && !x.data.call && !x.replying && !x.hover); // в начале списка — новые
      if (old) this._close(old);
      else return void this.queue.push({ key, data });
    }
    this._open(key, data);
  }

  /** Убрать карточку (чат прочитан, звонок закончился). */
  dismiss(key) {
    this.queue = this.queue.filter((x) => x.key !== key);
    const it = this.items.find((x) => x.key === key && !x.closing);
    if (it) this._close(it);
  }

  /** Ключи показанных и ждущих карточек. */
  keys() {
    return [...this.items.filter((x) => !x.closing).map((x) => x.key), ...this.queue.map((x) => x.key)];
  }

  dismissAll() {
    this.queue = [];
    for (const it of [...this.items]) this._close(it);
  }

  _area() {
    try {
      return this.screen.getPrimaryDisplay().workArea;
    } catch {
      return { x: 0, y: 0, width: 1280, height: 720 };
    }
  }

  _open(key, data) {
    const it = { key, data, height: MIN_H, hover: false, replying: false, closing: false, timer: null };
    const [pos] = layoutToasts(this._area(), [it.height]);
    const win = new this.BrowserWindow({
      ...pos,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      hasShadow: false,
      focusable: true,
      webPreferences: { preload: this.preload, contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: true, backgroundThrottling: false },
    });
    it.win = win;
    this.items.unshift(it); // новая — внизу, остальные поднимаются
    win.setAlwaysOnTop?.(true, 'screen-saver');
    win.setVisibleOnAllWorkspaces?.(true, { visibleOnFullScreen: true });
    // Никаких переходов и новых окон из карточки
    win.webContents.on?.('will-navigate', (e) => e.preventDefault());
    win.webContents.setWindowOpenHandler?.(() => ({ action: 'deny' }));
    win.webContents.once?.('did-finish-load', () => {
      if (win.isDestroyed()) return;
      win.webContents.send('toast:data', it.data);
      win.showInactive(); // без перехвата фокуса — печатать в другом окне можно дальше
    });
    win.on('closed', () => {
      clearTimeout(it.timer);
      this.items = this.items.filter((x) => x !== it);
      this._layout();
      this._next();
    });
    win.loadURL(this.url);
    this._layout();
    this._arm(it);
  }

  _arm(it) {
    clearTimeout(it.timer);
    if (it.data.call) return; // звонок висит, пока не ответят или не закончится
    it.timer = setTimeout(() => this._close(it), SHOW_MS);
  }

  _close(it) {
    if (it.closing) return;
    it.closing = true;
    clearTimeout(it.timer);
    if (!it.win || it.win.isDestroyed()) return;
    it.win.webContents.send('toast:leave');
    setTimeout(() => {
      if (!it.win.isDestroyed()) it.win.destroy();
    }, 200);
  }

  _next() {
    while (this.queue.length && this.items.filter((x) => !x.closing).length < MAX_VISIBLE) {
      const { key, data } = this.queue.shift();
      this._open(key, data);
    }
  }

  _layout() {
    const live = this.items.filter((x) => x.win && !x.win.isDestroyed());
    const pos = layoutToasts(
      this._area(),
      live.map((x) => x.height)
    );
    live.forEach((x, i) => x.win.setBounds(pos[i]));
  }
}

module.exports = { Toasts, layoutToasts, cleanToast, AVATAR_RE };
