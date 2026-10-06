// Иконки интерфейса — свои, в SVG, набор лежит на сервере (/icons.json).
//
// В разметке иконка — пустой элемент с data-icon: <i class="ic" data-icon="lock"></i>. Модуль сам
// рисует в нём SVG, в том числе в элементах, добавленных позже (MutationObserver). Набор берётся
// с сервера: в вебе — с этого же сайта, в приложениях — с сервера аккаунта (и кэшируется);
// пока его нет — копия, встроенная в приложение. Набор рисуется только из разрешённых элементов
// (path, circle, rect, line…) и атрибутов — никакого innerHTML.

const NS = 'http://www.w3.org/2000/svg';
const TAGS = new Set(['path', 'circle', 'rect', 'line', 'polyline', 'polygon', 'ellipse']);
// Атрибут → какие значения допустимы
const NUM = /^-?\d{1,4}(\.\d{1,4})?$/;
const ATTRS = {
  d: /^[MmLlHhVvCcSsQqTtAaZz0-9.,\s-]{1,2000}$/,
  points: /^[0-9.,\s-]{1,1000}$/,
  fill: /^(none|currentColor)$/,
  stroke: /^(none|currentColor)$/,
  'stroke-width': NUM,
  opacity: NUM,
};
for (const a of ['cx', 'cy', 'r', 'rx', 'ry', 'x', 'y', 'width', 'height', 'x1', 'y1', 'x2', 'y2']) ATTRS[a] = NUM;
const CACHE_KEY = 'tainik:icons';

let set = null; // { viewBox, icons: { name: [[tag, attrs], ...] } }

/** Проверить набор иконок: только известные элементы и атрибуты. null — набор не годится. */
export function cleanIconSet(raw) {
  if (!raw || typeof raw !== 'object' || !raw.icons || typeof raw.icons !== 'object') return null;
  const viewBox = typeof raw.viewBox === 'string' && /^[\d.\s-]{3,40}$/.test(raw.viewBox) ? raw.viewBox : '0 0 24 24';
  const icons = {};
  for (const [name, parts] of Object.entries(raw.icons)) {
    if (!/^[a-z0-9-]{1,40}$/.test(name) || !Array.isArray(parts) || parts.length > 20) continue;
    const ok = [];
    for (const p of parts) {
      if (!Array.isArray(p) || !TAGS.has(p[0]) || !p[1] || typeof p[1] !== 'object') continue;
      const attrs = {};
      for (const [k, v] of Object.entries(p[1])) if (Object.hasOwn(ATTRS, k) && ATTRS[k].test(String(v))) attrs[k] = String(v);
      if (Object.keys(attrs).length) ok.push([p[0], attrs]);
    }
    if (ok.length) icons[name] = ok;
  }
  return Object.keys(icons).length ? { viewBox, icons } : null;
}

/** SVG-иконка name (пустая, если такой нет в наборе). */
function draw(name) {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', set?.viewBox || '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  for (const [tag, attrs] of set?.icons[name] || []) {
    const n = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    svg.append(n);
  }
  return svg;
}

function fill(node) {
  const name = node.dataset.icon;
  if (!set || node.dataset.drawn === name + '|' + set.stamp) return;
  node.replaceChildren(draw(name));
  node.dataset.drawn = name + '|' + set.stamp;
}

/** Нарисовать все иконки внутри root. */
export function drawIcons(root = document) {
  if (root.nodeType === 1 && root.dataset?.icon) fill(root);
  for (const n of root.querySelectorAll?.('[data-icon]') || []) fill(n);
}

/** Элемент-иконка для кода: icon('lock') → <i class="ic" data-icon="lock">. */
export function icon(name, cls = '') {
  const i = document.createElement('i');
  i.className = 'ic' + (cls ? ' ' + cls : '');
  i.dataset.icon = name;
  i.setAttribute('aria-hidden', 'true');
  if (set) fill(i);
  return i;
}

function apply(raw, stamp) {
  const clean = cleanIconSet(raw);
  if (!clean) return false;
  set = { ...clean, stamp };
  drawIcons(document);
  return true;
}

/**
 * Загрузить набор: сначала сохранённый с сервера (если есть), иначе встроенный; затем — свежий
 * с сервера (serverOrigin: https://… сервера аккаунта; в вебе — этот же сайт).
 */
export async function loadIcons(serverOrigin = '') {
  let cached = null;
  try {
    cached = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
  } catch {}
  if (!(cached && apply(cached, 'cache'))) {
    try {
      apply(await (await fetch('/icons.json')).json(), 'local');
    } catch {}
  }
  new MutationObserver((list) => {
    for (const m of list) for (const n of m.addedNodes) if (n.nodeType === 1) drawIcons(n);
  }).observe(document.documentElement, { childList: true, subtree: true });
  if (!serverOrigin) return;
  try {
    const r = await fetch(serverOrigin.replace(/\/+$/, '') + '/icons.json', { cache: 'no-cache' });
    if (!r.ok) return;
    const raw = await r.json();
    if (apply(raw, 'server:' + (raw.v ?? ''))) {
      try {
        localStorage.setItem(CACHE_KEY, JSON.stringify(raw));
      } catch {}
    }
  } catch {}
}
