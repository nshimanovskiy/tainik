// Перевод сообщений. Сообщения в Тайнике сквозные — сервер их не видит, поэтому перевод
// делается на устройстве:
//   1. встроенным переводчиком браузера (Translator API, Chrome 138+): текст никуда не уходит;
//   2. иначе — бесплатным переводчиком Google (translate.googleapis.com, как на translate.sdsds.top),
//      только с согласия: текст этого сообщения уходит в Google. Сервер Тайника в этом не участвует.

const CLOUD = 'https://translate.googleapis.com/translate_a/single';
export const CLOUD_HOST = 'https://translate.googleapis.com';
const MAX = 5000; // символов за раз
const cache = new Map(); // `${язык}|${текст}` → { text, from, via }

/** Встроенный переводчик браузера доступен (модель может понадобиться скачать). */
export const hasLocal = () => typeof self !== 'undefined' && 'Translator' in self && 'LanguageDetector' in self;

/** Язык текста по встроенному определителю; null — не уверен. */
async function detectLocal(text) {
  const det = await self.LanguageDetector.create();
  try {
    const [best] = await det.detect(text);
    return best && best.confidence >= 0.5 && best.detectedLanguage !== 'und' ? best.detectedLanguage : null;
  } finally {
    det.destroy?.();
  }
}

async function translateLocal(text, to) {
  const from = await detectLocal(text);
  if (!from) return null;
  if (from === to) return { text, from, via: 'local', same: true };
  const avail = await self.Translator.availability({ sourceLanguage: from, targetLanguage: to });
  if (avail === 'unavailable') return null;
  const tr = await self.Translator.create({ sourceLanguage: from, targetLanguage: to });
  try {
    return { text: await tr.translate(text), from, via: 'local' };
  } finally {
    tr.destroy?.();
  }
}

async function translateCloud(text, to, fetchImpl) {
  const url = `${CLOUD}?client=gtx&dt=t&dj=1&sl=auto&tl=${encodeURIComponent(to)}&q=${encodeURIComponent(text)}`;
  const res = await fetchImpl(url, { credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store' });
  if (!res.ok) throw Object.assign(new Error('translate_failed'), { code: 'translate_failed' });
  const data = await res.json();
  const out = (Array.isArray(data?.sentences) ? data.sentences : []).map((s) => (typeof s?.trans === 'string' ? s.trans : '')).join('');
  if (!out) throw Object.assign(new Error('translate_failed'), { code: 'translate_failed' });
  const from = typeof data.src === 'string' ? data.src.toLowerCase() : null;
  return { text: out, from, via: 'cloud', same: !!from && from.split('-')[0] === to };
}

/**
 * Перевести text на язык to ('ru', 'en'…). cloud — можно ли отправить текст в Google (true — да).
 * Возвращает { text, from, via: 'local' | 'cloud', same? } — same: текст уже на этом языке.
 * Бросает { code: 'translate_cloud_needed' }, если без облака не получилось, а оно не разрешено.
 */
export async function translateText(text, to, { cloud = false, fetchImpl = (...a) => fetch(...a) } = {}) {
  text = String(text ?? '').trim().slice(0, MAX);
  if (!text) throw Object.assign(new Error('translate_empty'), { code: 'translate_empty' });
  const key = `${to}|${text}`;
  if (cache.has(key)) return cache.get(key);
  let r = null;
  if (hasLocal()) {
    try {
      r = await translateLocal(text, to);
    } catch {
      r = null; // модель не скачалась, язык не поддерживается — попробуем облако
    }
  }
  if (!r) {
    if (!cloud) throw Object.assign(new Error('translate_cloud_needed'), { code: 'translate_cloud_needed' });
    r = await translateCloud(text, to, fetchImpl);
  }
  cache.set(key, r);
  if (cache.size > 500) cache.delete(cache.keys().next().value);
  return r;
}
