// Поиск GIF через KLIPY или GIPHY (их API, совместимые с бывшим Tenor v2: /v2/search, /v2/featured).
//
// Запросы идут через сервер Тайника: провайдер не видит IP пользователей и не знает, кто что ищет,
// а приложению не нужны чужие адреса в CSP. Картинки тоже отдаёт сервер — по адресу
// /api/gif/m/<токен>, где токен подписан ключом сервера: проксируются только адреса, которые
// сервер сам получил от провайдера (открытым прокси он не становится).
//
// Отправленная GIF — обычное зашифрованное вложение: собеседник получает её от вашего сервера,
// к провайдеру не ходит.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const MEDIA_MAX = 20 * 1024 * 1024; // байт на одну картинку или ролик
const MEDIA_TYPES = /^(image\/(gif|webp|png|jpeg)|video\/(mp4|webm))$/;
const LIMIT = 24;
const FORMATS = 'tinygif,nanogif,gif,mediumgif,mp4,tinymp4';

/** Название провайдера для подписи «Поиск: …» (условие провайдеров) по адресу API. */
export function gifProviderName(api) {
  try {
    const host = new URL(api).hostname;
    if (/(^|\.)klipy\.com$/.test(host)) return 'KLIPY';
    if (/(^|\.)giphy\.com$/.test(host)) return 'GIPHY';
    return host;
  } catch {
    return '';
  }
}

const b64u = (s) => Buffer.from(s).toString('base64url');

export function createGifs({ api = '', key = '', clientKey = 'tainik', contentFilter = 'medium', fetch = globalThis.fetch, secret = randomBytes(32), say = () => {} } = {}) {
  api = String(api || '').replace(/\/+$/, '');
  const enabled = !!(api && key && /^https:\/\//.test(api));
  const provider = enabled ? gifProviderName(api) : '';
  const sign = (url) => createHmac('sha256', secret).update(url).digest('base64url').slice(0, 32);
  const mediaPath = (url) => `/api/gif/m/${b64u(url)}.${sign(url)}`;
  const ipHits = new Map(); // ip -> [время запросов картинок]

  /** Вариант картинки из ответа провайдера: { u, w, h, size } (u — адрес через сервер) или null. */
  function format(f) {
    if (!f || typeof f.url !== 'string' || !/^https:\/\//.test(f.url) || f.url.length > 2048) return null;
    const [w, h] = Array.isArray(f.dims) ? f.dims.map(Number) : [];
    const out = { u: mediaPath(f.url) };
    if (Number.isInteger(w) && Number.isInteger(h) && w > 0 && h > 0 && w <= 4096 && h <= 4096) Object.assign(out, { w, h });
    if (Number.isSafeInteger(f.size) && f.size > 0) out.size = f.size;
    return out;
  }

  /** Результат поиска в нашем виде: { id, desc, preview, gif?, mp4? }. */
  function item(r) {
    const m = r?.media_formats;
    if (!m || typeof m !== 'object') return null;
    const preview = format(m.tinygif) || format(m.nanogif) || format(m.gif);
    const gif = format(m.gif) || format(m.mediumgif) || format(m.tinygif);
    const mp4 = format(m.mp4) || format(m.tinymp4);
    if (!preview || !(gif || mp4)) return null;
    const out = { id: String(r.id ?? '').slice(0, 64), desc: String(r.content_description || r.title || '').slice(0, 200), preview };
    if (gif) out.gif = gif;
    if (mp4) out.mp4 = mp4;
    return out;
  }

  /** Поиск (q) или подборка (без q). pos — продолжение (как вернул провайдер). */
  async function search({ q = '', pos = '', locale = '' } = {}) {
    if (!enabled) throw Object.assign(new Error('gifs_off'), { code: 'gifs_off' });
    q = String(q || '').trim().slice(0, 100);
    const params = new URLSearchParams({ key, client_key: clientKey, limit: String(LIMIT), media_filter: FORMATS, contentfilter: contentFilter });
    if (q) params.set('q', q);
    if (pos) params.set('pos', String(pos).slice(0, 200));
    if (/^[a-z]{2}(_[A-Z]{2})?$/.test(locale)) params.set('locale', locale);
    let res;
    try {
      res = await fetch(`${api}/v2/${q ? 'search' : 'featured'}?${params}`, { signal: AbortSignal.timeout(10_000) });
    } catch {
      throw Object.assign(new Error('gifs_unavailable'), { code: 'gifs_unavailable' });
    }
    if (!res.ok) {
      say(`поиск GIF: провайдер ответил ${res.status}`);
      throw Object.assign(new Error('gifs_unavailable'), { code: res.status === 429 ? 'gifs_busy' : 'gifs_unavailable' });
    }
    const data = await res.json().catch(() => null);
    const results = (Array.isArray(data?.results) ? data.results : []).map(item).filter(Boolean);
    const next = typeof data?.next === 'string' && data.next && data.next !== '0' ? data.next.slice(0, 200) : null;
    return { results, next };
  }

  /** GET /api/gif/m/<url в base64url>.<подпись> — картинка или ролик провайдера. */
  function handleHttp(req, res, ip = '') {
    const url = new URL(req.url, 'http://x');
    if (!url.pathname.startsWith('/api/gif/')) return false;
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Max-Age': '86400' };
    if (req.method === 'OPTIONS') return res.writeHead(204, cors).end(), true;
    const m = /^\/api\/gif\/m\/([A-Za-z0-9_-]{8,3000})\.([A-Za-z0-9_-]{32})$/.exec(url.pathname);
    if (req.method !== 'GET' || !m) return res.writeHead(404, cors).end(), true;
    let target;
    try {
      target = Buffer.from(m[1], 'base64url').toString('utf8');
    } catch {
      return res.writeHead(404, cors).end(), true;
    }
    const want = Buffer.from(sign(target));
    const got = Buffer.from(m[2]);
    if (!enabled || want.length !== got.length || !timingSafeEqual(want, got) || !/^https:\/\//.test(target)) return res.writeHead(404, cors).end(), true;
    // Не больше 600 картинок в минуту с одного адреса (сетка поиска — 24 штуки)
    const now = Date.now();
    const hits = (ipHits.get(ip) || []).filter((x) => now - x < 60_000);
    if (hits.length >= 600) return res.writeHead(429, cors).end(), true;
    hits.push(now);
    ipHits.set(ip, hits);
    if (ipHits.size > 5000) ipHits.delete(ipHits.keys().next().value);
    proxy(target, res, cors).catch(() => {
      if (!res.headersSent) res.writeHead(502, cors);
      res.end();
    });
    return true;
  }

  async function proxy(target, res, cors) {
    const r = await fetch(target, { signal: AbortSignal.timeout(20_000) });
    const type = String(r.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    const len = Number(r.headers.get('content-length') || 0);
    if (!r.ok || !MEDIA_TYPES.test(type) || len > MEDIA_MAX) {
      res.writeHead(r.ok ? 415 : 502, cors).end();
      return;
    }
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > MEDIA_MAX) return res.writeHead(413, cors).end();
    res.writeHead(200, {
      ...cors,
      'Content-Type': type,
      'Content-Length': buf.length,
      'Cache-Control': 'private, max-age=3600',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(buf);
  }

  return { enabled, provider, search, handleHttp, mediaPath };
}
