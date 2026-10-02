// Вспомогательный код десктопа без зависимости от Electron (его можно тестировать в Node).
'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

/**
 * Зашифрованное хранилище «ключ → JSON» в одном файле.
 * encrypt/decrypt в приложении — это Electron safeStorage, то есть ключ
 * шифрования хранит ОС: Keychain (macOS), DPAPI (Windows), libsecret/kwallet (Linux).
 */
class SecureStore {
  constructor({ file, encrypt, decrypt }) {
    this.file = file;
    this.encrypt = encrypt;
    this.decrypt = decrypt;
    this.data = {};
    this._writing = null;
    this._dirty = false;
    if (fs.existsSync(file)) {
      this.data = JSON.parse(this.decrypt(fs.readFileSync(file)));
    }
  }

  /** Имя хранилища дополнительного аккаунта: часть имени файла, поэтому строго [a-z0-9]. */
  static validNs(ns) {
    return typeof ns === 'string' && /^[a-z0-9]{1,16}$/.test(ns);
  }

  static validKey(k) {
    return typeof k === 'string' && k.length > 0 && k.length <= 256;
  }

  get(k) {
    return Object.prototype.hasOwnProperty.call(this.data, k) ? structuredClone(this.data[k]) : undefined;
  }

  async set(k, v) {
    this.data[k] = structuredClone(v);
    await this._persist();
  }

  async del(k) {
    delete this.data[k];
    await this._persist();
  }

  async clear() {
    this.data = {};
    await this._persist();
  }

  // Каждая запись сохраняется сразу (состояние храповика нельзя терять),
  // но параллельные записи склеиваются в одну.
  async _persist() {
    this._dirty = true;
    while (this._writing) await this._writing;
    if (!this._dirty) return;
    this._dirty = false;
    this._writing = this._writeFile().finally(() => (this._writing = null));
    await this._writing;
  }

  async _writeFile() {
    const tmp = this.file + '.tmp';
    await fsp.mkdir(path.dirname(this.file), { recursive: true });
    await fsp.writeFile(tmp, this.encrypt(JSON.stringify(this.data)), { mode: 0o600 });
    await fsp.rename(tmp, this.file);
  }

  flushSync() {
    if (!this._dirty && !this._writing) return;
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, this.encrypt(JSON.stringify(this.data)), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    this._dirty = false;
  }
}

/** Безопасно сопоставляет URL app://app/... с файлом внутри папки renderer. */
function resolveAppPath(rendererDir, url) {
  const u = new URL(url);
  if (u.protocol !== 'app:' || u.host !== 'app') return null;
  let rel;
  try {
    rel = decodeURIComponent(u.pathname);
  } catch {
    return null;
  }
  if (rel === '/' || rel === '') rel = '/index.html';
  const base = path.resolve(rendererDir);
  const file = path.resolve(path.join(base, rel));
  return file.startsWith(base + path.sep) ? file : null;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

/**
 * Файл автозапуска для Linux (~/.config/autostart/tainik.desktop, стандарт XDG).
 * exec — путь к исполняемому файлу (для AppImage — сам .AppImage).
 */
function linuxAutostartEntry(exec) {
  // Спецификация Desktop Entry: аргумент в кавычках, внутри экранируются " ` $ \
  const quoted = '"' + String(exec).replace(/(["`$\\])/g, '\\$1').replace(/\\/g, '\\\\') + '"';
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=Тайник',
    'Comment=E2E-мессенджер',
    `Exec=${quoted} --hidden`,
    'Terminal=false',
    'X-GNOME-Autostart-enabled=true',
    '',
  ].join('\n');
}

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  'connect-src ws: wss:', // адрес сервера выбирает пользователь
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

module.exports = { SecureStore, resolveAppPath, MIME, CSP, linuxAutostartEntry };
