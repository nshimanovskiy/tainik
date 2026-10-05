// Прокси в приложениях: локальный ретранслятор (CONNECT) → SOCKS5 / HTTP с логином и паролем.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { cleanProxy, startRelay, testProxy } = require('../desktop/proxy.cjs');

const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));

/** Целевой сервер: отвечает «эхо:» и тем, что получил. */
async function echoServer(t) {
  const s = net.createServer((c) => c.on('data', (d) => c.write('эхо:' + d)));
  const port = await listen(s);
  t.after(() => s.close());
  return port;
}

/** Мини-SOCKS5 с логином и паролем (RFC 1928/1929). log — куда он подключался. */
async function socksServer(t, { user = 'u', pass = 'p' } = {}) {
  const log = [];
  const s = net.createServer((c) => {
    let stage = 'hello';
    let buf = Buffer.alloc(0);
    c.on('error', () => {});
    c.on('data', function onData(d) {
      buf = Buffer.concat([buf, d]);
      if (stage === 'hello' && buf.length >= 2 && buf.length >= 2 + buf[1]) {
        const methods = [...buf.subarray(2, 2 + buf[1])];
        buf = buf.subarray(2 + buf[1]);
        if (!methods.includes(2)) return c.end(Buffer.from([5, 0xff]));
        c.write(Buffer.from([5, 2]));
        stage = 'auth';
      }
      if (stage === 'auth' && buf.length >= 2 && buf.length >= 3 + buf[1] && buf.length >= 3 + buf[1] + buf[2 + buf[1]]) {
        const ul = buf[1];
        const u = buf.subarray(2, 2 + ul).toString();
        const pl = buf[2 + ul];
        const p = buf.subarray(3 + ul, 3 + ul + pl).toString();
        buf = buf.subarray(3 + ul + pl);
        if (u !== user || p !== pass) return c.end(Buffer.from([1, 1]));
        c.write(Buffer.from([1, 0]));
        stage = 'connect';
      }
      if (stage === 'connect' && buf.length >= 5 && buf.length >= 7 + buf[4]) {
        const host = buf.subarray(5, 5 + buf[4]).toString();
        const port = buf.readUInt16BE(5 + buf[4]);
        buf = buf.subarray(7 + buf[4]);
        log.push(`${host}:${port}`);
        stage = 'pipe';
        c.off('data', onData);
        const up = net.connect(port, host, () => {
          c.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
          if (buf.length) up.write(buf);
          c.pipe(up).pipe(c);
        });
        up.on('error', () => c.end(Buffer.from([5, 5, 0, 1, 0, 0, 0, 0, 0, 0])));
      }
    });
  });
  const port = await listen(s);
  t.after(() => s.close());
  return { port, log };
}

/** Мини-HTTP-прокси с Basic-авторизацией. */
async function httpProxy(t, { user = 'u', pass = 'p' } = {}) {
  const s = net.createServer((c) => {
    let buf = '';
    c.on('error', () => {});
    c.on('data', function onData(d) {
      buf += d.toString('latin1');
      const i = buf.indexOf('\r\n\r\n');
      if (i < 0) return;
      c.off('data', onData);
      const m = /^CONNECT ([^:]+):(\d+)/.exec(buf);
      const okAuth = buf.includes(`Proxy-Authorization: Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`);
      if (!okAuth) return c.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n');
      const up = net.connect(Number(m[2]), m[1], () => {
        c.write('HTTP/1.1 200 OK\r\n\r\n');
        c.pipe(up).pipe(c);
      });
      up.on('error', () => c.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'));
    });
  });
  const port = await listen(s);
  t.after(() => s.close());
  return { port };
}

/** Как Chromium: CONNECT к ретранслятору, затем данные по туннелю. */
function viaRelay(relayPort, target) {
  return new Promise((resolve, reject) => {
    const c = net.connect(relayPort, '127.0.0.1', () => c.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
    let buf = '';
    let open = false;
    c.on('data', (d) => {
      buf += d.toString();
      if (!open && buf.includes('\r\n\r\n')) {
        const status = buf.slice(0, buf.indexOf('\r\n'));
        if (!/ 200 /.test(status)) return (c.destroy(), resolve({ status }));
        open = true;
        buf = '';
        c.write('привет');
      } else if (open && buf.includes('привет')) {
        c.destroy();
        resolve({ status: '200', body: buf });
      }
    });
    c.on('error', reject);
  });
}

test('прокси: проверка настроек', () => {
  assert.deepEqual(cleanProxy({ enabled: true, type: 'socks5', host: ' proxy.example.com ', port: '1080', user: 'a', pass: 'b' }), {
    enabled: true,
    type: 'socks5',
    host: 'proxy.example.com',
    port: 1080,
    user: 'a',
    pass: 'b',
  });
  assert.equal(cleanProxy({ enabled: true, type: 'http', host: '10.0.0.1', port: 3128 }).type, 'http');
  assert.equal(cleanProxy({ enabled: true, host: '[::1]', port: 1 }).host, '::1');
  assert.throws(() => cleanProxy({ enabled: true, host: 'bad host', port: 1080 }), /proxy_bad/);
  assert.throws(() => cleanProxy({ enabled: true, host: 'x.com', port: 70000 }), /proxy_bad/);
  assert.throws(() => cleanProxy({ enabled: true, host: 'x.com', port: 1, pass: 'я'.repeat(200) }), /proxy_bad/);
  assert.equal(cleanProxy({ enabled: false }).enabled, false, 'выключенный — без адреса');
});

test('прокси: SOCKS5 с логином и паролем через локальный ретранслятор', async (t) => {
  const target = await echoServer(t);
  const socks = await socksServer(t);
  let cfg = { type: 'socks5', host: '127.0.0.1', port: socks.port, user: 'u', pass: 'p' };
  const errors = [];
  const relay = await startRelay(() => cfg, { onError: (e) => errors.push(e.code) });
  t.after(() => relay.close());

  const r = await viaRelay(relay.port, `localhost:${target}`);
  assert.equal(r.status, '200');
  assert.equal(r.body, 'эхо:привет');
  assert.deepEqual(socks.log, [`localhost:${target}`], 'имя сервера уходит прокси, DNS — на его стороне');

  // Неверный пароль — ретранслятор отвечает 502, причина — proxy_auth
  cfg = { ...cfg, pass: 'нет' };
  assert.match((await viaRelay(relay.port, `localhost:${target}`)).status, / 502 /);
  assert.deepEqual(errors, ['proxy_auth']);
  await assert.rejects(testProxy(cfg, 'localhost', target), (e) => e.code === 'proxy_auth');
  // Без пароля такой прокси не пускает
  await assert.rejects(testProxy({ ...cfg, user: '', pass: '' }, 'localhost', target), (e) => e.code === 'proxy_auth');
  assert.ok((await testProxy({ ...cfg, pass: 'p' }, 'localhost', target)) >= 0);

  // Не CONNECT — отказ
  const plain = await new Promise((resolve) => {
    const c = net.connect(relay.port, '127.0.0.1', () => c.write('GET http://x/ HTTP/1.1\r\nHost: x\r\n\r\n'));
    c.on('data', (d) => (c.destroy(), resolve(d.toString())));
  });
  assert.match(plain, /405/);
});

test('прокси: HTTP с паролем, недоступный прокси', async (t) => {
  const target = await echoServer(t);
  const hp = await httpProxy(t);
  const cfg = { type: 'http', host: '127.0.0.1', port: hp.port, user: 'u', pass: 'p' };
  const relay = await startRelay(() => cfg);
  t.after(() => relay.close());
  const r = await viaRelay(relay.port, `127.0.0.1:${target}`);
  assert.equal(r.body, 'эхо:привет');
  await assert.rejects(testProxy({ ...cfg, pass: 'x' }, '127.0.0.1', target), (e) => e.code === 'proxy_auth');

  // Прокси не запущен
  const dead = net.createServer();
  const deadPort = await listen(dead);
  await new Promise((r2) => dead.close(r2));
  await assert.rejects(testProxy({ ...cfg, port: deadPort }, '127.0.0.1', target), (e) => e.code === 'proxy_unreachable');
});
