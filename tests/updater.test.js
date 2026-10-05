// Самообновление десктопа: проверка подписи выпуска и файла (desktop/updater.cjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Updater, compareVersions, updateKind, parseSums, verifySums, serverBase, macInstallScript } = require('../desktop/updater.cjs');

const keys = crypto.generateKeyPairSync('ed25519');
const PUB = keys.publicKey.export({ type: 'spki', format: 'pem' });
const sign = (text, key = keys.privateKey) => crypto.sign(null, Buffer.from(text), key).toString('base64');
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

test('обновления: сравнение версий, тип установки, адрес сервера', () => {
  assert.equal(compareVersions('0.13.0', '0.12.9'), 1);
  assert.equal(compareVersions('0.9.0', '0.10.0'), -1);
  assert.equal(compareVersions('v1.0.0', '1.0.0'), 0);
  assert.equal(compareVersions('1.0.0-beta', '1.0.0'), -1);
  assert.equal(compareVersions('мусор', '1.0.0'), 0);

  assert.equal(updateKind({ platform: 'win32', arch: 'x64', env: {} }), 'win');
  assert.equal(updateKind({ platform: 'win32', arch: 'x64', env: { PORTABLE_EXECUTABLE_FILE: 'C:\\T.exe' } }), 'win-portable');
  assert.equal(updateKind({ platform: 'darwin', arch: 'arm64' }), 'mac-arm64');
  assert.equal(updateKind({ platform: 'darwin', arch: 'x64' }), 'mac-x64');
  assert.equal(updateKind({ platform: 'linux', arch: 'x64', env: { APPIMAGE: '/a/T.AppImage' } }), 'linux-appimage');
  assert.equal(updateKind({ platform: 'linux', arch: 'x64', env: {} }), 'linux-deb');

  assert.equal(serverBase('wss://chat.example.com/ws'), 'https://chat.example.com');
  assert.equal(serverBase('ws://localhost:8080/ws'), 'http://localhost:8080');
  assert.equal(serverBase('https://x'), null);

  const sums = `${'a'.repeat(64)}  Tainik-1.0.0-win-x64.exe\n${'b'.repeat(64)} *Tainik-1.0.0-android.apk\nмусор\n`;
  assert.deepEqual([...parseSums(sums)], [['Tainik-1.0.0-win-x64.exe', 'a'.repeat(64)], ['Tainik-1.0.0-android.apk', 'b'.repeat(64)]]);
  assert.equal(verifySums(sums, sign(sums), PUB), true);
  assert.equal(verifySums(sums + ' ', sign(sums), PUB), false, 'изменённый список не проходит');
  const other = crypto.generateKeyPairSync('ed25519').privateKey;
  assert.equal(verifySums(sums, sign(sums, other), PUB), false, 'чужой ключ не проходит');
  assert.equal(verifySums(sums, 'не подпись', PUB), false);

  const sh = macInstallScript({ pid: 42, dmg: "/tmp/it's.dmg", bundle: '/Applications/Tainik.app', relaunch: true });
  assert.match(sh, /PID=42; DMG='\/tmp\/it'\\''s\.dmg'/, 'пути экранируются');
  assert.match(sh, /open "\$BUNDLE"/);
  assert.doesNotMatch(macInstallScript({ pid: 1, dmg: '/d', bundle: '/b', relaunch: false }), /open "/);
});

function fakeServer({ version = '1.0.0', file = Buffer.from('новый установщик'), signed = true, tamperFile = false, badSig = false }) {
  const name = `Tainik-${version}-win-x64.exe`;
  const sums = `${sha(file)}  ${name}\n${sha(Buffer.from('x'))}  Tainik-${version}-android.apk\n`;
  const sig = badSig ? sign(sums, crypto.generateKeyPairSync('ed25519').privateKey) : sign(sums);
  const assets = [
    { name, size: file.length, platform: 'win', url: `/download/${name}` },
    { name: 'SHA256SUMS.txt', size: sums.length, platform: 'sums', url: '/download/SHA256SUMS.txt' },
  ];
  if (signed) assets.push({ name: 'SHA256SUMS.txt.sig', size: 88, platform: 'sums-sig', url: '/download/SHA256SUMS.txt.sig' });
  const calls = [];
  const fetch = async (url) => {
    calls.push(url);
    const p = new URL(url).pathname;
    if (p === '/api/releases') return Response.json({ version, signed, assets });
    if (p === '/download/SHA256SUMS.txt') return new Response(sums);
    if (p === '/download/SHA256SUMS.txt.sig') return new Response(sig);
    if (p === `/download/${name}`) return new Response(tamperFile ? Buffer.concat([file, Buffer.from('!')]) : file, { headers: { 'content-length': String(file.length) } });
    return new Response('нет', { status: 404 });
  };
  return { fetch, calls, file, name };
}

function mk(t, srv, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tainik-upd-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const states = [];
  const u = new Updater({ current: '0.9.0', kind: 'win', dir, base: () => 'https://chat.example.com', publicKey: PUB, fetch: srv.fetch, onChange: (s) => states.push(s.status), ...extra });
  return { u, dir, states };
}

test('обновления: подписанный выпуск скачивается и проверяется', async (t) => {
  const srv = fakeServer({});
  const { u, dir, states } = mk(t, srv);
  await u.check();
  assert.equal(u.state.status, 'ready');
  assert.equal(u.state.version, '1.0.0');
  assert.deepEqual(fs.readFileSync(u.ready.file), srv.file);
  assert.equal(path.dirname(u.ready.file), dir);
  assert.ok(states.includes('checking') && states.includes('downloading'));
  assert.deepEqual(fs.readdirSync(dir), [srv.name], 'временных файлов не осталось');
  // Повторная проверка спрашивает сервер, но тот же файл заново не качает
  const n = srv.calls.length;
  await u.check();
  assert.ok(!srv.calls.slice(n).some((c) => c.endsWith(srv.name)));
  assert.equal(u.state.status, 'ready');
  // Уборка оставляет готовое обновление
  fs.writeFileSync(path.join(dir, 'старое.exe'), 'x');
  await u.cleanup();
  assert.deepEqual(fs.readdirSync(dir), [srv.name]);
});

test('обновления: подмена отклоняется, неподписанный выпуск — только вручную', async (t) => {
  for (const [opts, re] of [
    [{ badSig: true }, /подпись выпуска не прошла проверку/],
    [{ tamperFile: true }, /контрольная сумма не совпала/],
  ]) {
    const { u, dir } = mk(t, fakeServer(opts));
    await u.check();
    assert.equal(u.state.status, 'error');
    assert.match(u.state.error, re);
    assert.equal(u.ready, null);
    assert.deepEqual(fs.readdirSync(dir).filter((f) => !f.endsWith('.part')), [], 'ничего не готово к установке');
  }

  const uns = mk(t, fakeServer({ signed: false }));
  await uns.u.check();
  assert.equal(uns.u.state.status, 'manual');
  assert.equal(uns.u.state.downloadUrl, 'https://chat.example.com/?home#download');

  const nokey = mk(t, fakeServer({}), { publicKey: null });
  await nokey.u.check();
  assert.equal(nokey.u.state.status, 'manual');

  const latest = mk(t, fakeServer({ version: '0.9.0' }));
  await latest.u.check();
  assert.equal(latest.u.state.status, 'latest');

  const mac = mk(t, fakeServer({}), { kind: 'mac-arm64' });
  await mac.u.check();
  assert.equal(mac.u.state.status, 'manual', 'файла для этой системы нет');

  // Автопроверка без автоскачивания — только сообщает
  const ask = mk(t, fakeServer({}), { auto: () => false });
  await ask.u.check({ auto: true });
  assert.equal(ask.u.state.status, 'available');
  await ask.u.download();
  assert.equal(ask.u.state.status, 'ready');

  const off = mk(t, fakeServer({}), { kind: null });
  await off.u.check();
  assert.equal(off.u.state.status, 'unsupported');
});

test('обновления: скачано, но не установлено — более новая версия всё равно находится', async (t) => {
  const v1 = fakeServer({ version: '1.0.0', file: Buffer.from('версия 1') });
  const v2 = fakeServer({ version: '1.1.0', file: Buffer.from('версия 1.1') });
  let srv = v1;
  const { u, dir } = mk(t, { fetch: (url) => srv.fetch(url) });
  await u.check();
  assert.equal(u.ready.version, '1.0.0');
  srv = v2; // вышла ещё одна версия, а первую так и не установили
  await u.check();
  assert.equal(u.state.status, 'ready');
  assert.equal(u.ready.version, '1.1.0');
  assert.deepEqual(fs.readFileSync(u.ready.file), v2.file);
  assert.deepEqual(fs.readdirSync(dir), [v2.name], 'старый скачанный файл удалён');
  // Сервер недоступен — готовое обновление остаётся готовым
  srv = { fetch: async () => { throw new Error('нет сети'); } };
  await u.check();
  assert.equal(u.state.status, 'ready');
});
