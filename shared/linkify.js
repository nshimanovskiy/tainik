// Ссылки в тексте: разбор строки на куски «текст» / «ссылка». Только http(s); без innerHTML —
// вызывающий код строит узлы DOM сам (см. linkNodes в client/app.js).

const URL_RE = /(?:https?:\/\/|www\.|t\.me\/)[^\s<>"'«»]+/giu;
const TRAIL = /[.,;:!?…]$/u;
const PAIRS = { ')': '(', ']': '[', '}': '{' };

/** Отрезает знаки препинания и «лишние» закрывающие скобки в конце найденной ссылки. */
function trimUrl(u) {
  for (;;) {
    if (TRAIL.test(u)) u = u.slice(0, -1);
    else if (PAIRS[u.at(-1)] && count(u, u.at(-1)) > count(u, PAIRS[u.at(-1)])) u = u.slice(0, -1);
    else return u;
  }
}
const count = (s, ch) => s.split(ch).length - 1;

/** Полный адрес для перехода или null, если это не безопасная http(s)-ссылка. */
export function hrefOf(raw) {
  const s = /^https?:\/\//i.test(raw) ? raw : 'https://' + raw;
  try {
    const u = new URL(s);
    if ((u.protocol !== 'https:' && u.protocol !== 'http:') || !u.hostname.includes('.')) return null;
    if (u.username || u.password) return null; // https://bank.com@evil.ru — маскировка адреса
    return u.href;
  } catch {
    return null;
  }
}

/** Ссылка на пользователя или публичный канал Тайника вида https://сервер/@имя → { host, name } или null. */
export function profileLinkOf(href) {
  try {
    const u = new URL(href);
    const m = /^\/@([a-z0-9_]{3,32})\/?$/i.exec(u.pathname);
    return m && !u.search && !u.hash ? { host: u.host.toLowerCase(), name: m[1].toLowerCase() } : null;
  } catch {
    return null;
  }
}

/** «текст со ссылками» → [{ text } | { text, href, ch }], ch — ссылка на канал Тайника. */
export function linkify(text) {
  const src = String(text ?? '');
  const out = [];
  let last = 0;
  for (const m of src.matchAll(URL_RE)) {
    const raw = trimUrl(m[0]);
    const href = hrefOf(raw);
    if (!href || (m.index > 0 && /[\p{L}\p{N}_@]/u.test(src[m.index - 1]))) continue;
    if (m.index > last) out.push({ text: src.slice(last, m.index) });
    const p = profileLinkOf(href);
    out.push({ text: raw, href, ch: /#ch=/.test(href), ...(p ? { at: p } : {}) });
    last = m.index + raw.length;
  }
  if (last < src.length) out.push({ text: src.slice(last) });
  return out;
}
