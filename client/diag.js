// Проверка сети до сервера Тайника: HTTPS и WebSocket, в обе стороны, разного размера.
// Помогает понять, что именно режет сеть (провайдер, роутер, VPN), когда приложение не подключается.
const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};
const TIMEOUT = 15_000;
const WS_URL = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
const results = [];
// Случайные данные, а не нули: сеть может сжимать или пропускать однообразный поток иначе
function randomBytes(n) {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i += 65536) crypto.getRandomValues(b.subarray(i, Math.min(n, i + 65536)));
  return b;
}
function randomText(n) {
  let out = '';
  while (out.length < n) out += btoa(String.fromCharCode.apply(null, randomBytes(3072)));
  return out.slice(0, n);
}

function row(name) {
  const tr = el('tr');
  const st = el('td', 'r wait', '…');
  const ms = el('td', 'r muted', '');
  tr.append(el('td', '', name), ms, st);
  $('rows').append(tr);
  return (ok, info, time) => {
    st.className = 'r ' + (ok ? 'ok' : 'bad');
    st.textContent = ok ? '✓' : '✗ ' + (info || '');
    ms.textContent = time != null ? `${time} мс` : '';
    results.push(`${ok ? 'OK ' : 'ERR'} ${name}${time != null ? ` ${time}ms` : ''}${!ok && info ? ` (${info})` : ''}`);
  };
}

const withTimeout = (p, ms = TIMEOUT) =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('нет ответа ' + ms / 1000 + ' с')), ms))]);

async function step(name, fn) {
  const done = row(name);
  const t0 = performance.now();
  try {
    await withTimeout(fn());
    done(true, '', Math.round(performance.now() - t0));
    return true;
  } catch (e) {
    done(false, e.message || String(e), Math.round(performance.now() - t0));
    return false;
  }
}

async function download(kb) {
  const r = await fetch(`/api/diag/down?kb=${kb}&r=${Math.random()}`, { cache: 'no-store' });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const n = (await r.arrayBuffer()).byteLength;
  if (n !== kb * 1024) throw new Error(`получено ${n} байт`);
}
async function upload(kb) {
  const r = await fetch('/api/diag/up', { method: 'POST', body: randomBytes(kb * 1024), cache: 'no-store' });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const { got } = await r.json();
  if (got !== kb * 1024) throw new Error(`сервер получил ${got} байт`);
}

// Постоянное соединение: одно на несколько шагов; после сбоя — новое, чтобы шаги не мешали друг другу
let ws = null;
let seq = 0;
const waiting = new Map();
function openWs() {
  return new Promise((resolve, reject) => {
    const s = new WebSocket(WS_URL);
    s.onopen = () => resolve((ws = s));
    s.onerror = () => reject(new Error('ошибка соединения'));
    s.onclose = (e) => {
      if (ws === s) ws = null;
      for (const w of waiting.values()) w.reject(new Error('соединение закрыто, код ' + e.code));
      waiting.clear();
      reject(new Error('закрыто, код ' + e.code));
    };
    s.onmessage = (e) => {
      let m;
      try {
        m = JSON.parse(e.data);
      } catch {
        return;
      }
      const w = waiting.get(m.reqId);
      if (!w) return;
      waiting.delete(m.reqId);
      m.type === 'error' ? w.reject(new Error(m.code)) : w.resolve(m);
    };
  });
}
async function echo({ up = 0, down = 0 }) {
  if (!ws || ws.readyState !== WebSocket.OPEN) await openWs();
  const reqId = ++seq;
  const data = up ? randomText(up * 1024) : '';
  const p = new Promise((resolve, reject) => waiting.set(reqId, { resolve, reject }));
  ws.send(JSON.stringify({ type: 'diag-echo', reqId, data, down }));
  const m = await p;
  if (m.got !== data.length) throw new Error(`сервер получил ${m.got}`);
  if (down && m.data.length !== down * 1024) throw new Error(`получено ${m.data.length}`);
}
function resetWs() {
  try {
    ws?.close();
  } catch {}
  ws = null;
}

async function run() {
  $('run').disabled = true;
  $('copy').hidden = true;
  $('rows').replaceChildren();
  $('summary').textContent = '';
  results.length = 0;
  const net = navigator.connection?.effectiveType ? ` · сеть: ${navigator.connection.type || ''} ${navigator.connection.effectiveType}` : '';
  results.push(`${new Date().toISOString()} · ${navigator.userAgent}${net}`);

  const fails = [];
  const go = async (name, fn, ws) => {
    const ok = await step(name, fn);
    if (!ok) {
      fails.push(name);
      if (ws) resetWs();
    }
  };
  for (const kb of [16, 64, 512]) await go(`Скачать ${kb} КБ (HTTPS)`, () => download(kb));
  for (const kb of [16, 64, 512]) await go(`Отправить ${kb} КБ (HTTPS)`, () => upload(kb));
  await go('Постоянное соединение (WebSocket)', () => (resetWs(), openWs()), true);
  await go('Короткое сообщение туда и обратно', () => echo({ up: 1 }), true);
  for (const kb of [16, 40, 150]) await go(`Получить ${kb} КБ по соединению`, () => echo({ down: kb }), true);
  for (const kb of [16, 40, 150]) await go(`Отправить ${kb} КБ по соединению`, () => echo({ up: kb }), true);
  resetWs();

  $('summary').textContent = fails.length ? `Не прошло: ${fails.length} из ${results.length - 1}. Скопируйте результаты и пришлите их.` : 'Всё прошло: сеть до сервера работает.';
  $('summary').className = fails.length ? 'bad' : 'ok';
  $('run').disabled = false;
  $('copy').hidden = false;
}

$('run').addEventListener('click', run);
$('copy').addEventListener('click', async () => {
  const text = results.join('\n');
  try {
    await navigator.clipboard.writeText(text);
    $('copy').textContent = 'Скопировано';
  } catch {
    prompt('Скопируйте результаты:', text);
  }
});
