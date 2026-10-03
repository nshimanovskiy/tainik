import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server/server.js';
import { platformOf } from '../server/releases.js';

const APK = Buffer.from('apk-данные-'.repeat(1000));

// Поддельный GitHub: API последнего релиза и файлы (с переадресацией, как настоящий)
function fakeGithub() {
  const calls = [];
  let fail = false;
  const release = {
    tag_name: 'v0.13.0',
    name: 'Тайник 0.13.0',
    published_at: '2026-10-03T06:00:00Z',
    body: 'Что нового',
    assets: [
      { name: 'Tainik-0.13.0-android.apk', size: APK.length, url: 'https://api.github.com/assets/1', browser_download_url: 'https://github.com/o/r/releases/download/v0.13.0/Tainik-0.13.0-android.apk' },
      { name: 'Tainik-0.13.0-win-x64.exe', size: 10, url: 'https://api.github.com/assets/2', browser_download_url: 'https://github.com/o/r/releases/download/v0.13.0/Tainik-0.13.0-win-x64.exe' },
      { name: 'SHA256SUMS.txt', size: 5, url: 'https://api.github.com/assets/3', browser_download_url: 'https://github.com/o/r/releases/download/v0.13.0/SHA256SUMS.txt' },
      { name: '../../etc/passwd', size: 1, url: 'x', browser_download_url: 'x' },
    ],
  };
  async function fetch(url, opts = {}) {
    calls.push({ url: String(url), headers: opts.headers || {} });
    if (fail) throw new Error('сеть недоступна');
    if (String(url).endsWith('/releases/latest')) return Response.json(release);
    if (String(url).includes('android.apk') || String(url).endsWith('/assets/1')) {
      const range = opts.headers?.Range;
      if (range) {
        const [, a, b] = /bytes=(\d+)-(\d*)/.exec(range);
        const end = b ? Number(b) : APK.length - 1;
        return new Response(APK.subarray(Number(a), end + 1), {
          status: 206,
          headers: { 'content-length': String(end + 1 - Number(a)), 'content-range': `bytes ${a}-${end}/${APK.length}` },
        });
      }
      return new Response(APK, { headers: { 'content-length': String(APK.length) } });
    }
    return new Response('нет', { status: 404 });
  }
  return { fetch, calls, release, setFail: (v) => (fail = v) };
}

async function setup(t, releases) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tainik-rel-'));
  const srv = await startServer({ port: 0, host: '127.0.0.1', dataDir, log: false, releases });
  t.after(async () => {
    await srv.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  return `http://127.0.0.1:${srv.port}`;
}

test('загрузки: имена файлов → платформы', () => {
  assert.equal(platformOf('Tainik-0.13.0-android.apk'), 'android');
  assert.equal(platformOf('Tainik-0.13.0-win-x64.exe'), 'win');
  assert.equal(platformOf('Tainik-0.13.0-win-x64-portable.exe'), 'win-portable');
  assert.equal(platformOf('Tainik-0.13.0-mac-arm64.dmg'), 'mac-arm64');
  assert.equal(platformOf('Tainik-0.13.0-mac-x64.dmg'), 'mac-x64');
  assert.equal(platformOf('Tainik-0.13.0-linux-x86_64.AppImage'), 'linux-appimage');
  assert.equal(platformOf('Tainik-0.13.0-linux-amd64.deb'), 'linux-deb');
  assert.equal(platformOf('SHA256SUMS.txt.sig'), 'sums-sig');
  assert.equal(platformOf('readme.md'), null);
});

test('загрузки: сведения о выпуске и файлы идут через сервер', async (t) => {
  const gh = fakeGithub();
  const base = await setup(t, { repo: 'owner/tainik', fetch: gh.fetch });

  let r = await fetch(`${base}/api/releases`);
  assert.equal(r.status, 200);
  const rel = await r.json();
  assert.equal(rel.version, '0.13.0');
  assert.equal(rel.signed, false);
  assert.deepEqual(rel.assets.map((a) => a.platform), ['android', 'win', 'sums']);
  assert.equal(rel.assets[0].url, '/download/Tainik-0.13.0-android.apk');
  assert.ok(!JSON.stringify(rel.assets).includes('github.com'), 'файлы — только через этот сервер');
  assert.equal(rel.page, 'https://github.com/owner/tainik/releases/latest');
  await fetch(`${base}/api/releases`);
  assert.equal(gh.calls.filter((c) => c.url.endsWith('/latest')).length, 1, 'сведения кешируются');

  r = await fetch(`${base}/download/Tainik-0.13.0-android.apk`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'application/vnd.android.package-archive');
  assert.match(r.headers.get('content-disposition'), /Tainik-0\.13\.0-android\.apk/);
  assert.deepEqual(Buffer.from(await r.arrayBuffer()), APK);

  r = await fetch(`${base}/download/latest/android`, { headers: { Range: 'bytes=10-19' } });
  assert.equal(r.status, 206, 'докачка поддерживается');
  assert.equal(r.headers.get('content-range'), `bytes 10-19/${APK.length}`);
  assert.deepEqual(Buffer.from(await r.arrayBuffer()), APK.subarray(10, 20));

  assert.equal((await fetch(`${base}/download/latest/mac-arm64`)).status, 404);
  assert.equal((await fetch(`${base}/download/..%2F..%2Fetc%2Fpasswd`)).status, 404, 'только файлы выпуска');
  assert.equal((await fetch(`${base}/download/other.apk`)).status, 404);
  assert.ok(!gh.calls.some((c) => c.headers.Authorization), 'без токена — без авторизации');
});

test('загрузки: приватный репозиторий через токен; GitHub недоступен; выключено', async (t) => {
  const gh = fakeGithub();
  const base = await setup(t, { repo: 'owner/tainik', token: 'secret-token', fetch: gh.fetch });
  const r = await fetch(`${base}/download/Tainik-0.13.0-android.apk`);
  assert.equal(r.status, 200);
  await r.arrayBuffer();
  const asset = gh.calls.find((c) => c.url.endsWith('/assets/1'));
  assert.equal(asset.headers.Authorization, 'Bearer secret-token');
  assert.equal(asset.headers.Accept, 'application/octet-stream');

  const down = fakeGithub();
  down.setFail(true);
  const base2 = await setup(t, { repo: 'owner/tainik', fetch: down.fetch });
  const e = await fetch(`${base2}/api/releases`);
  assert.equal(e.status, 503);
  assert.match((await e.json()).error, /недоступны/);

  const off = await setup(t, null);
  assert.equal((await fetch(`${off}/api/releases`)).status, 404);
  const bad = await setup(t, { repo: 'не репозиторий', fetch: gh.fetch });
  assert.equal((await fetch(`${bad}/api/releases`)).status, 404);
});
