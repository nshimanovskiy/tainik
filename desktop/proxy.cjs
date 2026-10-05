// Подключение через прокси (SOCKS5 или HTTP, с логином и паролем или без).
//
// Chromium (и Electron, и Android WebView) не умеет SOCKS5 с паролем, поэтому приложение
// поднимает на 127.0.0.1 маленький ретранслятор: Chromium ходит в него как в обычный
// HTTP-прокси (CONNECT host:port — так идут wss:// и https://), а ретранслятор открывает
// соединение через настоящий прокси пользователя — уже с логином и паролем. Внутри
// туннеля по-прежнему TLS до сервера Тайника: прокси видит только адрес сервера.
// Та же логика на Kotlin — android/.../ProxyRelay.kt.
'use strict';
const net = require('node:net');

const HOST_RE = /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)*[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$|^\[?[0-9A-Fa-f:.]+\]?$/;
const TIMEOUT = 15_000;
const MAX_HEAD = 8192;

class ProxyError extends Error {
  /** code: proxy_unreachable | proxy_auth | proxy_refused | proxy_bad | proxy_timeout */
  constructor(code, detail = '') {
    super(code + (detail ? `: ${detail}` : ''));
    this.code = code;
  }
}

/** Настройки прокси из страницы → { enabled, type, host, port, user, pass } или ошибка. */
function cleanProxy(p) {
  const type = p?.type === 'http' ? 'http' : 'socks5';
  const host = String(p?.host ?? '').trim().replace(/^\[|\]$/g, '');
  const port = Number(p?.port);
  const user = String(p?.user ?? '');
  const pass = String(p?.pass ?? '');
  const enabled = !!p?.enabled;
  if (enabled || host) {
    if (!HOST_RE.test(host) || host.length > 253) throw new ProxyError('proxy_bad', 'host');
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ProxyError('proxy_bad', 'port');
  }
  if (Buffer.byteLength(user) > 255 || Buffer.byteLength(pass) > 255) throw new ProxyError('proxy_bad', 'credentials');
  return { enabled, type, host, port: Number.isInteger(port) ? port : 0, user, pass };
}

/** Чтение из сокета ровно по нужным порциям (рукопожатия прокси). */
function reader(sock) {
  let buf = Buffer.alloc(0);
  let waiter = null;
  let err = null;
  const wake = () => waiter && waiter();
  const onData = (d) => {
    buf = Buffer.concat([buf, d]);
    wake();
  };
  const onEnd = () => {
    err ||= new ProxyError('proxy_refused', 'closed');
    wake();
  };
  const onErr = (e) => {
    err ||= new ProxyError('proxy_unreachable', e.code || e.message);
    wake();
  };
  sock.on('data', onData);
  sock.on('end', onEnd);
  sock.on('close', onEnd);
  sock.on('error', onErr);
  const until = (ready) =>
    new Promise((resolve, reject) => {
      const tryNow = () => {
        const r = ready();
        if (r !== null) {
          waiter = null;
          resolve(r);
        } else if (err) {
          waiter = null;
          reject(err);
        }
      };
      waiter = tryNow;
      tryNow();
    });
  return {
    /** n байт */
    read: (n) =>
      until(() => {
        if (buf.length < n) return null;
        const out = buf.subarray(0, n);
        buf = buf.subarray(n);
        return out;
      }),
    /** заголовки HTTP до пустой строки */
    head: () =>
      until(() => {
        const i = buf.indexOf('\r\n\r\n');
        if (i < 0) {
          if (buf.length > MAX_HEAD) err ||= new ProxyError('proxy_bad', 'header too long');
          return null;
        }
        const out = buf.subarray(0, i + 4).toString('latin1');
        buf = buf.subarray(i + 4);
        return out;
      }),
    /** отключиться от сокета; возвращает непрочитанный остаток */
    release() {
      sock.off('data', onData);
      sock.off('end', onEnd);
      sock.off('close', onEnd);
      sock.off('error', onErr);
      const rest = buf;
      buf = Buffer.alloc(0);
      return rest;
    },
  };
}

function connectTcp(host, port, timeout) {
  return new Promise((resolve, reject) => {
    const s = net.connect({ host, port });
    const t = setTimeout(() => (s.destroy(), reject(new ProxyError('proxy_timeout'))), timeout);
    s.once('connect', () => (clearTimeout(t), resolve(s)));
    s.once('error', (e) => (clearTimeout(t), reject(new ProxyError('proxy_unreachable', e.code || e.message))));
  });
}

const SOCKS_REPLY = { 2: 'not allowed', 3: 'network unreachable', 4: 'host unreachable', 5: 'connection refused', 6: 'ttl expired', 7: 'command not supported', 8: 'address type not supported' };

/**
 * Соединение с host:port через прокси пользователя. Возвращает { sock, rest } —
 * сокет-туннель и уже полученные сверх рукопожатия байты.
 */
async function openTunnel(cfg, host, port, timeout = TIMEOUT) {
  const sock = await connectTcp(cfg.host, cfg.port, timeout);
  const timer = setTimeout(() => sock.destroy(new ProxyError('proxy_timeout')), timeout);
  const r = reader(sock);
  try {
    if (cfg.type === 'http') {
      const h = [`CONNECT ${host}:${port} HTTP/1.1`, `Host: ${host}:${port}`];
      if (cfg.user || cfg.pass) h.push(`Proxy-Authorization: Basic ${Buffer.from(`${cfg.user}:${cfg.pass}`).toString('base64')}`);
      sock.write(h.join('\r\n') + '\r\n\r\n');
      const resp = await r.head();
      const code = Number(/^HTTP\/1\.[01] (\d{3})/.exec(resp)?.[1]);
      if (code === 407) throw new ProxyError('proxy_auth');
      if (code !== 200) throw new ProxyError('proxy_refused', `HTTP ${code || '?'}`);
    } else {
      const auth = !!(cfg.user || cfg.pass);
      sock.write(Buffer.from(auth ? [5, 2, 0, 2] : [5, 1, 0]));
      const [ver, method] = await r.read(2);
      if (ver !== 5) throw new ProxyError('proxy_bad', 'not a SOCKS5 proxy');
      if (method === 2) {
        const u = Buffer.from(cfg.user);
        const p = Buffer.from(cfg.pass);
        sock.write(Buffer.concat([Buffer.from([1, u.length]), u, Buffer.from([p.length]), p]));
        const [, status] = await r.read(2);
        if (status !== 0) throw new ProxyError('proxy_auth');
      } else if (method === 0xff) {
        throw new ProxyError(auth ? 'proxy_refused' : 'proxy_auth', 'no acceptable auth method');
      } else if (method !== 0) {
        throw new ProxyError('proxy_bad', 'auth method ' + method);
      }
      const h = Buffer.from(host);
      sock.write(Buffer.concat([Buffer.from([5, 1, 0, 3, h.length]), h, Buffer.from([port >> 8, port & 255])]));
      const [v2, rep, , atyp] = await r.read(4);
      if (v2 !== 5) throw new ProxyError('proxy_bad', 'bad reply');
      if (rep !== 0) throw new ProxyError('proxy_refused', SOCKS_REPLY[rep] || 'code ' + rep);
      const alen = atyp === 1 ? 4 : atyp === 4 ? 16 : atyp === 3 ? (await r.read(1))[0] : -1;
      if (alen < 0) throw new ProxyError('proxy_bad', 'address type');
      await r.read(alen + 2);
    }
    clearTimeout(timer);
    return { sock, rest: r.release() };
  } catch (e) {
    clearTimeout(timer);
    r.release();
    sock.destroy();
    throw e instanceof ProxyError ? e : new ProxyError('proxy_unreachable', e.message);
  }
}

/**
 * Локальный ретранслятор на 127.0.0.1 (порт выбирает система). getUpstream() — текущие
 * настройки прокси. Возвращает { port, close() }.
 */
function startRelay(getUpstream, { onError = () => {} } = {}) {
  const conns = new Set();
  const server = net.createServer((client) => {
    conns.add(client);
    client.on('close', () => conns.delete(client));
    client.on('error', () => {});
    const r = reader(client);
    const fail = (status) => {
      r.release();
      client.end(`HTTP/1.1 ${status}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
    };
    r.head()
      .then(async (head) => {
        const m = /^CONNECT (\[[0-9A-Fa-f:.]+\]|[^\s:]+):(\d{1,5}) HTTP\/1\.[01]\r\n/.exec(head);
        const port = Number(m?.[2]);
        if (!m || port < 1 || port > 65535) return fail('405 Method Not Allowed');
        const host = m[1].replace(/^\[|\]$/g, '');
        let tunnel;
        try {
          tunnel = await openTunnel(getUpstream(), host, port);
        } catch (e) {
          onError(e);
          return fail('502 Bad Gateway');
        }
        const early = r.release();
        conns.add(tunnel.sock);
        tunnel.sock.on('close', () => conns.delete(tunnel.sock));
        tunnel.sock.on('error', () => client.destroy());
        client.on('error', () => tunnel.sock.destroy());
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (tunnel.rest.length) client.write(tunnel.rest);
        if (early.length) tunnel.sock.write(early);
        client.pipe(tunnel.sock);
        tunnel.sock.pipe(client);
      })
      .catch(() => fail('400 Bad Request'));
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        close() {
          for (const c of conns) c.destroy();
          return new Promise((r) => server.close(() => r()));
        },
      });
    });
  });
}

/** Проверить прокси: открыть через него соединение с сервером. Возвращает время в мс. */
async function testProxy(cfg, host, port) {
  const t0 = Date.now();
  const { sock } = await openTunnel(cfg, host, port);
  sock.destroy();
  return Date.now() - t0;
}

module.exports = { cleanProxy, openTunnel, startRelay, testProxy, ProxyError };
