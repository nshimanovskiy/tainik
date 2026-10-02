// Панель администратора: пользователи, их устройства, статус «в сети», текущий и последний IP
// устройств; удаление аккаунтов и блокировка IP. Текста сообщений сервер не знает, и панель тоже.
//
// Включается переменной ADMIN_PASSWORD (не короче 12 символов). Адрес — ADMIN_PATH
// (по умолчанию /adminadminadmin). Без пароля панели нет: адрес отвечает 404.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

const UI = path.join(path.dirname(fileURLToPath(import.meta.url)), 'admin-ui');
const COOKIE = 'tainik_admin';
const SESSION_MS = 12 * 3600_000;
const LOGIN_LIMIT = 10; // неудачных попыток входа с одного IP
const LOGIN_WINDOW = 15 * 60_000; // за 15 минут
const MIN_PASSWORD = 12;

const FILES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/admin.js': ['admin.js', 'text/javascript; charset=utf-8'],
  '/admin.css': ['admin.css', 'text/css; charset=utf-8'],
};

const SECURITY_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'X-Robots-Tag': 'noindex, nofollow',
  'Content-Security-Policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
};

export function normalizeAdminPath(p) {
  let s = String(p || '/adminadminadmin').trim();
  if (!s.startsWith('/')) s = '/' + s;
  s = s.replace(/\/+$/, '');
  if (!/^\/[A-Za-z0-9_-]{4,64}$/.test(s) || s === '/shared' || s === '/ws' || s === '/healthz') {
    throw new Error('ADMIN_PATH: нужен путь вида /secret-panel (латиница, цифры, - и _, 4–64 символа)');
  }
  return s;
}

/**
 * @returns {null | (req, res) => boolean}  обработчик: true, если запрос был к панели
 */
export function createAdmin({ password, basePath, overview, actions = {}, clientIp, say = () => {} }) {
  if (!password) return null;
  if (String(password).length < MIN_PASSWORD) {
    say(`панель администратора выключена: ADMIN_PASSWORD короче ${MIN_PASSWORD} символов`);
    return null;
  }
  const base = normalizeAdminPath(basePath);
  // Ключ подписи сессий выводится из пароля: смена пароля завершает все сессии
  const key = createHmac('sha256', 'tainik/admin/session').update(String(password)).digest();
  const pwHash = createHash('sha256').update(String(password)).digest();
  const failures = new Map(); // ip -> [время неудачных попыток]

  const sign = (exp) => createHmac('sha256', key).update(String(exp)).digest('base64url');
  const makeToken = () => {
    const exp = Date.now() + SESSION_MS;
    return `${exp}.${sign(exp)}`;
  };
  function validToken(t) {
    const m = /^(\d{10,16})\.([A-Za-z0-9_-]{43})$/.exec(t || '');
    if (!m || Number(m[1]) < Date.now()) return false;
    const want = Buffer.from(sign(m[1]));
    const got = Buffer.from(m[2]);
    return want.length === got.length && timingSafeEqual(want, got);
  }
  function cookieOf(req) {
    for (const part of String(req.headers.cookie || '').split(';')) {
      const [k, ...v] = part.trim().split('=');
      if (k === COOKIE) return v.join('=');
    }
    return null;
  }
  const isLocal = (req) => /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(String(req.headers.host || ''));
  const cookieAttrs = (req) => `Path=${base}; HttpOnly; SameSite=Strict${isLocal(req) ? '' : '; Secure'}`;

  function send(res, status, body, type = 'text/plain; charset=utf-8', extra = {}) {
    res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': type, ...extra });
    res.end(body);
  }
  function redirect(res, to, extra = {}) {
    res.writeHead(303, { ...SECURITY_HEADERS, Location: to, ...extra });
    res.end();
  }
  function readBody(req, limit = 4096) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > limit) {
          reject(new Error('too large'));
          req.destroy();
        } else chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }
  function tooManyFailures(ip) {
    const now = Date.now();
    const list = (failures.get(ip) || []).filter((t) => now - t < LOGIN_WINDOW);
    if (list.length) failures.set(ip, list);
    else failures.delete(ip);
    return list.length >= LOGIN_LIMIT;
  }
  function passwordOk(given) {
    const h = createHash('sha256').update(String(given)).digest();
    return timingSafeEqual(h, pwHash);
  }
  function serveFile(res, name, type) {
    fs.readFile(path.join(UI, name), (err, data) => (err ? send(res, 500, 'Ошибка') : send(res, 200, data, type)));
  }

  async function login(req, res) {
    const ip = clientIp(req);
    if (tooManyFailures(ip)) return redirect(res, `${base}/?e=limit`);
    let pw = '';
    try {
      pw = new URLSearchParams(await readBody(req)).get('password') || '';
    } catch {
      return send(res, 413, 'Слишком большой запрос');
    }
    if (!passwordOk(pw)) {
      failures.set(ip, [...(failures.get(ip) || []), Date.now()]);
      say('панель администратора: неверный пароль');
      return redirect(res, `${base}/?e=bad`);
    }
    failures.delete(ip);
    redirect(res, `${base}/`, { 'Set-Cookie': `${COOKIE}=${makeToken()}; Max-Age=${SESSION_MS / 1000}; ${cookieAttrs(req)}` });
  }

  return function handleAdmin(req, res) {
    const url = new URL(req.url, 'http://x');
    if (url.pathname !== base && !url.pathname.startsWith(base + '/')) return false;
    const sub = url.pathname.slice(base.length) || '/';
    if (sub === '/' && url.pathname === base) {
      redirect(res, `${base}/`); // относительные адреса скриптов работают только со слэшем
      return true;
    }
    const authed = validToken(cookieOf(req));

    if (req.method === 'POST' && sub === '/login') {
      login(req, res).catch(() => send(res, 400, 'Ошибка'));
      return true;
    }
    // Действия: только с сессией, только JSON и только со своим заголовком — чужой сайт
    // не может отправить такой запрос из браузера администратора (CSRF).
    const act = /^\/api\/(delete-user|ban|unban)$/.exec(sub);
    if (req.method === 'POST' && act) {
      const json = (status, obj) => send(res, status, JSON.stringify(obj), 'application/json; charset=utf-8');
      if (!authed) return json(401, { error: 'unauthorized' }), true;
      if (req.headers['x-tainik-admin'] !== '1' || !/^application\/json\b/.test(String(req.headers['content-type'] || ''))) {
        return json(403, { error: 'forbidden' }), true;
      }
      readBody(req)
        .then((text) => {
          const body = JSON.parse(text || '{}');
          if (act[1] === 'delete-user') actions.deleteUser(body.name);
          else if (act[1] === 'ban') actions.ban(body.ip, body.note);
          else actions.unban(body.ip);
          json(200, { ok: true });
        })
        .catch((e) => json(400, { error: e instanceof SyntaxError ? 'Неверный запрос' : e.message || 'Ошибка' }));
      return true;
    }
    if (req.method === 'POST' && sub === '/logout') {
      redirect(res, `${base}/`, { 'Set-Cookie': `${COOKIE}=; Max-Age=0; ${cookieAttrs(req)}` });
      return true;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      send(res, 405, 'Метод не поддерживается');
      return true;
    }
    if (sub === '/api/overview') {
      if (!authed) send(res, 401, JSON.stringify({ error: 'unauthorized' }), 'application/json; charset=utf-8');
      else send(res, 200, JSON.stringify(overview()), 'application/json; charset=utf-8');
      return true;
    }
    if (sub === '/' && !authed) {
      serveFile(res, 'login.html', 'text/html; charset=utf-8');
      return true;
    }
    // Страница входа и её оформление доступны без сессии
    if (sub === '/admin.css' || sub === '/login.js') {
      serveFile(res, sub.slice(1), sub.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8');
      return true;
    }
    const f = FILES[sub];
    if (!f || !authed) {
      send(res, 404, 'Не найдено');
      return true;
    }
    serveFile(res, f[0], f[1]);
    return true;
  };
}
