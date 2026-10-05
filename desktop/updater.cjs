// Самообновление десктопа (без зависимостей; Electron передаётся снаружи — модуль тестируется в Node).
//
// Откуда: ваш сервер ретранслирует релизы GitHub (/api/releases, /download/…), см. server/releases.js.
// Чему верим: только подписи. Сервер может быть взломан, поэтому файл устанавливается, лишь если
//   1) SHA256SUMS.txt подписан ключом выпусков (Ed25519; закрытый ключ — только в секретах GitHub
//      Actions, открытый — release-key.pem в самом приложении), и
//   2) sha256 скачанного файла совпадает со строкой из этого подписанного списка.
// Без подписи приложение лишь сообщает о новой версии и предлагает скачать её вручную.
'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { t } = require('./i18n.cjs');

const CHECK_EVERY = 6 * 3600_000;
const FIRST_CHECK = 20_000;

/** -1, 0, 1. Версии вида 1.2.3 (суффикс -beta меньше релиза). */
function compareVersions(a, b) {
  const parse = (v) => {
    const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(v).trim());
    return m ? [Number(m[1]), Number(m[2]), Number(m[3]), m[4] || null] : null;
  };
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return 0;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  if (x[3] === y[3]) return 0;
  if (!x[3]) return 1;
  if (!y[3]) return -1;
  return x[3] < y[3] ? -1 : 1;
}

/** Какой файл выпуска нужен этой установке. */
function updateKind({ platform, arch, env = {} }) {
  if (platform === 'win32') return env.PORTABLE_EXECUTABLE_FILE ? 'win-portable' : 'win';
  if (platform === 'darwin') return arch === 'arm64' ? 'mac-arm64' : 'mac-x64';
  if (platform === 'linux') return env.APPIMAGE ? 'linux-appimage' : 'linux-deb';
  return null;
}

/** «хеш  имя» → Map(имя → хеш) */
function parseSums(text) {
  const map = new Map();
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^([0-9a-f]{64})\s+\*?(\S+)$/.exec(line.trim());
    if (m) map.set(m[2], m[1]);
  }
  return map;
}

function verifySums(sumsText, sigText, publicKeyPem) {
  try {
    const sig = Buffer.from(String(sigText).trim(), 'base64');
    if (sig.length !== 64) return false;
    return crypto.verify(null, Buffer.from(sumsText), crypto.createPublicKey(publicKeyPem), sig);
  } catch {
    return false;
  }
}

/** wss://chat.example.com/ws → https://chat.example.com */
function serverBase(wsUrl) {
  try {
    const u = new URL(String(wsUrl));
    if (u.protocol !== 'ws:' && u.protocol !== 'wss:') return null;
    return `${u.protocol === 'wss:' ? 'https:' : 'http:'}//${u.host}`;
  } catch {
    return null;
  }
}

async function sha256File(file) {
  const h = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(file), h);
  return h.digest('hex');
}

/**
 * @param {object} o
 * @param {string} o.current       текущая версия приложения
 * @param {string|null} o.kind     updateKind()
 * @param {string} o.dir           папка для загрузок
 * @param {() => string|null} o.base   адрес сервера (https://…)
 * @param {string|null} o.publicKey     открытый ключ выпусков (PEM)
 * @param {Function} o.fetch
 * @param {(state) => void} o.onChange
 * @param {() => boolean} o.auto   скачивать автоматически
 */
class Updater {
  constructor({ current, kind, dir, base, publicKey, fetch, onChange = () => {}, auto = () => true }) {
    Object.assign(this, { current, kind, dir, base, publicKey, fetchImpl: fetch, onChange, auto });
    this.state = { status: 'idle', current, kind, supported: !!kind };
    this.ready = null; // { version, file }
    this._busy = null;
    this._timer = null;
  }

  _set(patch) {
    this.state = { ...this.state, ...patch };
    this.onChange(this.state);
  }

  start() {
    const tick = () => this.check({ auto: true }).catch(() => {});
    this._first = setTimeout(tick, FIRST_CHECK);
    this._timer = setInterval(tick, CHECK_EVERY);
    this._first.unref?.();
    this._timer.unref?.();
    this.cleanup().catch(() => {});
  }

  stop() {
    clearTimeout(this._first);
    clearInterval(this._timer);
  }

  /** Убрать старые загрузки (всё, кроме готового обновления). */
  async cleanup() {
    const keep = this.ready && path.basename(this.ready.file);
    for (const f of await fsp.readdir(this.dir).catch(() => [])) {
      if (f !== keep) await fsp.rm(path.join(this.dir, f), { force: true, recursive: true }).catch(() => {});
    }
  }

  async _get(url, as = 'json') {
    const r = await this.fetchImpl(url, { cache: 'no-store' });
    if (!r.ok) throw new Error(t('сервер ответил {0}', r.status));
    return as === 'json' ? r.json() : r.text();
  }

  check({ auto = false } = {}) {
    if (this._busy) return this._busy;
    this._busy = this._check(auto).finally(() => (this._busy = null));
    return this._busy;
  }

  async _check(auto) {
    if (!this.kind) return this._set({ status: 'unsupported' });
    const base = this.base();
    if (!base) return this._set({ status: 'error', error: t('Не задан сервер') });
    // Обновление уже скачано — всё равно спрашиваем сервер: вдруг вышла версия ещё новее
    if (!this.ready) this._set({ status: 'checking', error: null });
    let rel;
    try {
      rel = await this._get(`${base}/api/releases`);
    } catch (e) {
      if (this.ready) return this._set({ status: 'ready', version: this.ready.version });
      return this._set({ status: 'error', error: t('Не удалось проверить обновления: ') + e.message, checkedAt: Date.now() });
    }
    const checkedAt = Date.now();
    if (this.ready) {
      if (compareVersions(rel.version, this.ready.version) <= 0) return this._set({ status: 'ready', version: this.ready.version, checkedAt });
      await this._dropReady(); // скачанное устарело — качаем новое
    }
    if (compareVersions(rel.version, this.current) <= 0) return this._set({ status: 'latest', version: rel.version, checkedAt });
    const asset = (rel.assets || []).find((a) => a.platform === this.kind);
    const manual = `${base}/?home#download`;
    if (!asset) return this._set({ status: 'manual', version: rel.version, downloadUrl: manual, reason: t('Для этой системы в выпуске нет файла'), checkedAt });
    if (!rel.signed || !this.publicKey) {
      return this._set({ status: 'manual', version: rel.version, downloadUrl: manual, reason: t('Выпуск не подписан — установите вручную'), checkedAt });
    }
    if (auto && !this.auto()) return this._set({ status: 'available', version: rel.version, size: asset.size, checkedAt });
    return this._download(base, rel, asset);
  }

  async _dropReady() {
    const old = this.ready;
    this.ready = null;
    if (old?.file) await fsp.rm(old.file, { force: true }).catch(() => {});
  }

  /** Скачать без проверки «auto» (кнопка «Обновить»). */
  download() {
    if (this._busy) return this._busy;
    this._busy = (async () => {
      const base = this.base();
      const rel = await this._get(`${base}/api/releases`);
      const asset = (rel.assets || []).find((a) => a.platform === this.kind);
      if (!asset || !rel.signed) return this._check(false);
      if (this.ready && compareVersions(rel.version, this.ready.version) <= 0) return this._set({ status: 'ready', version: this.ready.version });
      if (this.ready) await this._dropReady();
      return this._download(base, rel, asset);
    })()
      .catch((e) => this._set({ status: 'error', error: e.message }))
      .finally(() => (this._busy = null));
    return this._busy;
  }

  async _download(base, rel, asset) {
    this._set({ status: 'downloading', version: rel.version, progress: 0, error: null });
    try {
      const sums = await this._get(`${base}/download/SHA256SUMS.txt`, 'text');
      const sig = await this._get(`${base}/download/SHA256SUMS.txt.sig`, 'text');
      if (!verifySums(sums, sig, this.publicKey)) throw new Error(t('подпись выпуска не прошла проверку'));
      const want = parseSums(sums).get(asset.name);
      if (!want) throw new Error(t('файла нет в подписанном списке'));
      if (!/^[A-Za-z0-9._-]+$/.test(asset.name)) throw new Error(t('недопустимое имя файла'));

      await fsp.mkdir(this.dir, { recursive: true });
      const file = path.join(this.dir, asset.name);
      const part = file + '.part';
      const r = await this.fetchImpl(`${base}${asset.url}`, { cache: 'no-store' });
      if (!r.ok || !r.body) throw new Error(t('сервер ответил {0}', r.status));
      const total = Number(r.headers.get('content-length')) || asset.size || 0;
      let got = 0;
      let last = 0;
      const src = Readable.fromWeb(r.body);
      src.on('data', (c) => {
        got += c.length;
        const now = Date.now();
        if (total && now - last > 300) {
          last = now;
          this._set({ progress: Math.min(1, got / total) });
        }
      });
      await pipeline(src, fs.createWriteStream(part, { mode: 0o644 }));
      const have = await sha256File(part);
      if (have !== want) {
        await fsp.rm(part, { force: true });
        throw new Error(t('контрольная сумма не совпала — файл повреждён или подменён'));
      }
      await fsp.rename(part, file);
      this.ready = { version: rel.version, file, name: asset.name };
      this._set({ status: 'ready', version: rel.version, progress: 1 });
      return this.state;
    } catch (e) {
      this._set({ status: 'error', error: t('Обновление не скачалось: ') + e.message });
      return this.state;
    }
  }
}

/** Сценарий для macOS: дождаться выхода, заменить .app из .dmg, (по желанию) запустить снова. */
function macInstallScript({ pid, dmg, bundle, relaunch }) {
  const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
  return [
    '#!/bin/sh',
    `PID=${Number(pid)}; DMG=${q(dmg)}; BUNDLE=${q(bundle)}`,
    'while kill -0 "$PID" 2>/dev/null; do sleep 0.5; done',
    'MNT="$(mktemp -d)" || exit 1',
    'hdiutil attach -nobrowse -noautoopen -quiet -mountpoint "$MNT" "$DMG" || exit 1',
    'APP="$(ls -d "$MNT"/*.app 2>/dev/null | head -1)"',
    'if [ -n "$APP" ]; then',
    '  rm -rf "$BUNDLE.old"',
    '  if mv "$BUNDLE" "$BUNDLE.old" && ditto "$APP" "$BUNDLE"; then rm -rf "$BUNDLE.old"; else rm -rf "$BUNDLE"; mv "$BUNDLE.old" "$BUNDLE"; fi',
    'fi',
    'hdiutil detach -quiet "$MNT"; rmdir "$MNT" 2>/dev/null',
    'rm -f "$DMG"',
    relaunch ? 'open "$BUNDLE"' : ':',
    '',
  ].join('\n');
}

module.exports = { Updater, compareVersions, updateKind, parseSums, verifySums, serverBase, sha256File, macInstallScript };
