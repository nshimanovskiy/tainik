// Ретрансляция релизов с GitHub: сайт отдаёт установщики сам, со своего домена.
// Нужна там, где GitHub недоступен или медленный, и для самообновления приложений:
// они спрашивают о новой версии ваш сервер, а не GitHub.
//
//   GET /api/releases                 — последний релиз: версия, файлы, размеры, есть ли подпись
//   GET /download/<имя файла>         — файл последнего релиза (поток с GitHub, с поддержкой Range)
//   GET /download/latest/<платформа>  — то же по короткому имени: android, win, win-portable,
//                                        mac-arm64, mac-x64, linux-appimage, linux-deb
//
// Отдаются только файлы последнего опубликованного релиза настроенного репозитория
// (RELEASES_REPO, например owner/tainik). GITHUB_TOKEN нужен только для приватного репозитория.
// Сервер ничего не хранит на диске: файлы идут потоком.
import { Readable } from 'node:stream';

const CACHE_MS = 10 * 60_000;
const ERROR_CACHE_MS = 60_000;
const MAX_PARALLEL_PER_IP = 3;
const REPO_RE = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const NAME_RE = /^[A-Za-z0-9._-]{1,200}$/;

/** Платформа файла по его имени (имена задаёт electron-builder и сборка Android). */
export function platformOf(name) {
  const rules = [
    [/-android\.apk$/, 'android'],
    [/-win-x64-portable\.exe$/, 'win-portable'],
    [/-win-x64\.exe$/, 'win'],
    [/-mac-arm64\.dmg$/, 'mac-arm64'],
    [/-mac-x64\.dmg$/, 'mac-x64'],
    [/-linux-x86_64\.AppImage$/, 'linux-appimage'],
    [/-linux-amd64\.deb$/, 'linux-deb'],
    [/^SHA256SUMS\.txt$/, 'sums'],
    [/^SHA256SUMS\.txt\.sig$/, 'sums-sig'],
  ];
  for (const [re, p] of rules) if (re.test(name)) return p;
  return null;
}

const MIME = {
  apk: 'application/vnd.android.package-archive',
  exe: 'application/vnd.microsoft.portable-executable',
  dmg: 'application/x-apple-diskimage',
  AppImage: 'application/octet-stream',
  deb: 'application/vnd.debian.binary-package',
  txt: 'text/plain; charset=utf-8',
  sig: 'text/plain; charset=utf-8',
};

export function createReleases({ repo, token = null, fetch: fetchImpl = globalThis.fetch, say = () => {}, clientIp = () => '' } = {}) {
  if (!repo) return null;
  if (!REPO_RE.test(repo)) {
    say('RELEASES_REPO: нужен вид владелец/репозиторий — загрузки выключены');
    return null;
  }
  const api = `https://api.github.com/repos/${repo}/releases/latest`;
  const ghHeaders = (accept = 'application/vnd.github+json') => ({
    Accept: accept,
    'User-Agent': 'tainik-server',
    'X-GitHub-Api-Version': '2022-11-28',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  });
  let cache = null; // { at, data, error }
  let inflight = null;
  const active = new Map(); // ip -> число идущих загрузок

  async function load() {
    const r = await fetchImpl(api, { headers: ghHeaders() });
    if (!r.ok) throw new Error(r.status === 404 ? 'релизов пока нет' : `GitHub ответил ${r.status}`);
    const rel = await r.json();
    const assets = (rel.assets || [])
      .filter((a) => a && NAME_RE.test(String(a.name)) && a.state !== 'starter')
      .map((a) => ({
        name: a.name,
        size: a.size,
        platform: platformOf(a.name),
        url: `/download/${encodeURIComponent(a.name)}`,
        _api: a.url,
        _browser: a.browser_download_url,
      }));
    const version = String(rel.tag_name || '').replace(/^v/, '');
    return {
      version,
      tag: rel.tag_name,
      name: rel.name || `Тайник ${version}`,
      publishedAt: rel.published_at || null,
      page: /^https:\/\/github\.com\//.test(rel.html_url || '') ? rel.html_url : `https://github.com/${repo}/releases/latest`,
      notes: String(rel.body || '').slice(0, 20_000),
      signed: assets.some((a) => a.platform === 'sums-sig'),
      assets,
    };
  }

  async function latest() {
    const now = Date.now();
    if (cache && now - cache.at < (cache.error ? ERROR_CACHE_MS : CACHE_MS)) {
      if (cache.error) throw cache.error;
      return cache.data;
    }
    inflight ||= load()
      .then((data) => ((cache = { at: Date.now(), data }), data))
      .catch((e) => {
        say('релизы: ' + e.message);
        // Старые данные лучше, чем ничего: GitHub мог быть недоступен минуту
        if (cache?.data) return (cache = { at: Date.now() - CACHE_MS + ERROR_CACHE_MS, data: cache.data }).data;
        cache = { at: Date.now(), error: e };
        throw e;
      })
      .finally(() => (inflight = null));
    return inflight;
  }

  const publicView = (d) => ({ ...d, assets: d.assets.map(({ _api, _browser, ...a }) => a) });

  function json(res, status, obj) {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Access-Control-Allow-Origin': '*', // десктоп и Android спрашивают со своих адресов
    });
    res.end(JSON.stringify(obj));
  }

  async function download(req, res, asset) {
    const ip = clientIp(req);
    const n = active.get(ip) || 0;
    if (n >= MAX_PARALLEL_PER_IP) return json(res, 429, { error: 'Слишком много одновременных загрузок' });
    active.set(ip, n + 1);
    const done = () => {
      const left = (active.get(ip) || 1) - 1;
      if (left > 0) active.set(ip, left);
      else active.delete(ip);
    };
    const ctrl = new AbortController();
    res.on('close', () => ctrl.abort());
    try {
      // С токеном — через API (так скачиваются файлы приватного репозитория), иначе — прямая ссылка
      const url = token ? asset._api : asset._browser;
      const headers = token ? ghHeaders('application/octet-stream') : { 'User-Agent': 'tainik-server' };
      const range = String(req.headers.range || '');
      if (/^bytes=\d*-\d*$/.test(range)) headers.Range = range;
      const up = await fetchImpl(url, { headers, redirect: 'follow', signal: ctrl.signal });
      if (!up.ok && up.status !== 206) {
        await up.body?.cancel?.().catch(() => {});
        return json(res, 502, { error: `GitHub ответил ${up.status}` });
      }
      const ext = asset.name.split('.').pop();
      const out = {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${asset.name}"`,
        'Cache-Control': 'public, max-age=3600',
        'X-Content-Type-Options': 'nosniff',
        'Accept-Ranges': 'bytes',
      };
      for (const h of ['content-length', 'content-range', 'etag', 'last-modified']) {
        const v = up.headers.get(h);
        if (v) out[h.replace(/(^|-)\w/g, (c) => c.toUpperCase())] = v;
      }
      res.writeHead(up.status === 206 ? 206 : 200, out);
      if (req.method === 'HEAD' || !up.body) {
        await up.body?.cancel?.().catch(() => {});
        return res.end();
      }
      await new Promise((resolve) => {
        const s = Readable.fromWeb(up.body);
        s.on('error', () => (res.destroy(), resolve()));
        res.on('close', resolve);
        s.pipe(res);
      });
    } catch (e) {
      if (!res.headersSent) json(res, 502, { error: 'Не удалось получить файл с GitHub' });
      else res.destroy();
    } finally {
      done();
    }
  }

  return function handleReleases(req, res) {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    if (p !== '/api/releases' && !p.startsWith('/download/')) return false;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end();
      return true;
    }
    latest()
      .then((data) => {
        if (p === '/api/releases') return json(res, 200, publicView(data));
        let name;
        try {
          name = decodeURIComponent(p.slice('/download/'.length));
        } catch {
          return json(res, 400, { error: 'Неверное имя файла' });
        }
        const asset = name.startsWith('latest/')
          ? data.assets.find((a) => a.platform === name.slice('latest/'.length))
          : data.assets.find((a) => a.name === name);
        if (!asset) return json(res, 404, { error: 'Нет такого файла в последнем выпуске' });
        return download(req, res, asset);
      })
      .catch((e) => json(res, 503, { error: 'Сведения о выпусках недоступны: ' + e.message }));
    return true;
  };
}
