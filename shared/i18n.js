// Перевод интерфейса. Исходные строки — русские; ключ перевода — сама строка
// (как в gettext), параметры — {0}, {1}…:  t('был(а) {0} мин. назад', 5)
// Язык: выбор пользователя (localStorage «tainik:lang») или язык системы.
// Вне браузера (сервер, тесты) — всегда русский.
import EN from './i18n-en.js';

const DICTS = { en: EN };
export const LANGS = [
  ['ru', 'Русский'],
  ['en', 'English'],
];

function detect() {
  if (typeof document === 'undefined') return 'ru';
  try {
    const saved = globalThis.localStorage?.getItem('tainik:lang');
    if (saved === 'ru' || saved === 'en') return saved;
  } catch {}
  const langs = globalThis.navigator?.languages?.length ? navigator.languages : [globalThis.navigator?.language || 'ru'];
  // Русский — для тех, у кого в системе русский или близкий язык; остальным — английский
  for (const l of langs) {
    if (/^(ru|be|uk|kk|ky|uz|tg|hy|az|ka)\b/i.test(l)) return 'ru';
    if (/^en\b/i.test(l)) return 'en';
  }
  return 'en';
}

export const LANG = detect();
export const LOCALE = LANG === 'ru' ? 'ru-RU' : 'en-GB';
if (typeof document !== 'undefined') document.documentElement.lang = LANG;

export function t(s, ...args) {
  const out = LANG === 'ru' ? s : (DICTS[LANG]?.[s] ?? s);
  return args.length ? out.replace(/\{(\d+)\}/g, (m, i) => (args[i] ?? '') + '') : out;
}

/** Сменить язык (страницу нужно перезагрузить). */
export function setLang(lang) {
  try {
    localStorage.setItem('tainik:lang', lang);
  } catch {}
}

const ATTRS = ['placeholder', 'title', 'aria-label', 'alt', 'content'];
const norm = (s) => s.replace(/\s+/g, ' ').trim();

/** Перевести статический текст страницы: текстовые узлы и подписи (placeholder, title…). */
export function translateDom(root = document) {
  if (LANG === 'ru') return;
  const dict = DICTS[LANG];
  const walker = document.createTreeWalker(root.body || root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const n of nodes) {
    const key = norm(n.nodeValue);
    if (!key || !(key in dict)) continue;
    const lead = /^\s/.test(n.nodeValue) ? ' ' : '';
    const trail = /\s$/.test(n.nodeValue) ? ' ' : '';
    n.nodeValue = lead + dict[key] + trail;
  }
  for (const el of (root.body || root).querySelectorAll('*')) {
    for (const a of ATTRS) {
      const v = el.getAttribute(a);
      if (v && norm(v) in dict) el.setAttribute(a, dict[norm(v)]);
    }
  }
  const title = norm(document.title);
  if (title in dict) document.title = dict[title];
  const desc = document.querySelector('meta[name="description"]');
  if (desc && norm(desc.content) in dict) desc.content = dict[norm(desc.content)];
}
