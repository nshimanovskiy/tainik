// Озвучка текста голосом системы. В браузере и на компьютере — speechSynthesis,
// в приложении для Android — нативный TextToSpeech через мост (window.desktop.speech).
// Предпочитаем голоса, работающие на устройстве; «сетевые» голоса браузера (например,
// голоса Google в Chrome) отправляют текст в интернет — только с согласия.

const native = () => (typeof window !== 'undefined' && window.desktop?.speech) || null;
const synth = () => (typeof speechSynthesis !== 'undefined' ? speechSynthesis : null);

export const ttsSupported = () => !!(native() || synth());

/** Язык текста по письменности: кириллица → ru, кана/иероглифы → ja и т. п.; латиница — fallback. */
export function guessLang(text, fallback = 'en') {
  const s = String(text || '');
  const count = (re) => (s.match(re) || []).length;
  const scores = [
    ['ru', count(/[Ѐ-ӿ]/g)],
    ['ja', count(/[぀-ヿ一-鿿]/g)],
    ['ko', count(/[가-힯]/g)],
    ['ar', count(/[؀-ۿ]/g)],
    ['he', count(/[֐-׿]/g)],
    ['el', count(/[Ͱ-Ͽ]/g)],
    ['latin', count(/[A-Za-zÀ-ɏ]/g)],
  ].sort((a, b) => b[1] - a[1]);
  const [lang, n] = scores[0];
  if (!n) return fallback;
  if (lang !== 'latin') return lang;
  if (/[ñ¿¡]/i.test(s)) return 'es';
  return ['en', 'es', 'de', 'fr', 'it', 'pt'].includes(fallback) ? fallback : 'en';
}

async function voices() {
  const sy = synth();
  let list = sy.getVoices();
  if (list.length) return list;
  // Список голосов приходит не сразу
  await new Promise((ok) => {
    const done = () => (sy.removeEventListener?.('voiceschanged', done), ok());
    sy.addEventListener?.('voiceschanged', done);
    setTimeout(done, 1500);
  });
  return sy.getVoices();
}

/** Подходящий голос: { voice } или { remote: true } (есть только сетевой) или null. */
export function pickVoice(list, lang, allowRemote) {
  const ok = list.filter((v) => String(v.lang || '').toLowerCase().replace('_', '-').split('-')[0] === lang);
  const local = ok.filter((v) => v.localService !== false);
  const best = (arr) => arr.find((v) => v.default) || arr[0];
  if (local.length) return { voice: best(local) };
  if (ok.length) return allowRemote ? { voice: best(ok) } : { remote: true };
  return null;
}

/** Фразы не длиннее max символов (Chrome обрывает длинные). */
export function splitText(text, max = 180) {
  const out = [];
  for (const sent of String(text).match(/[^.!?…\n]+[.!?…]*\s*|\n+/g) || []) {
    let s = sent.trim();
    while (s.length > max) {
      const cut = s.lastIndexOf(' ', max) > max / 2 ? s.lastIndexOf(' ', max) : max;
      out.push(s.slice(0, cut));
      s = s.slice(cut).trim();
    }
    if (s) out.push(s);
  }
  return out;
}

let token = 0; // номер текущей озвучки: новая или «стоп» отменяет прежнюю

/** Остановить озвучку. */
export function stopSpeaking() {
  token++;
  native()?.stop().catch(() => {});
  synth()?.cancel();
}

/**
 * Озвучить text. lang — 'ru' и т. п. allowRemote — можно ли сетевой голос.
 * Резолвится, когда дочитано (true) или остановлено (false). Ошибки: code tts_no_voice,
 * tts_cloud_needed (есть только сетевой голос), tts_unavailable.
 */
export async function speak(text, { lang, allowRemote = false } = {}) {
  stopSpeaking();
  const my = ++token;
  const n = native();
  if (n) {
    try {
      return await n.speak(text, lang);
    } catch (e) {
      const code = /tts_[a-z_]+/.exec(String(e?.message))?.[0] || 'tts_unavailable';
      throw Object.assign(new Error(code), { code });
    }
  }
  const sy = synth();
  if (!sy) throw Object.assign(new Error('tts_unavailable'), { code: 'tts_unavailable' });
  const pick = pickVoice(await voices(), lang, allowRemote);
  if (!pick) throw Object.assign(new Error('tts_no_voice'), { code: 'tts_no_voice' });
  if (pick.remote) throw Object.assign(new Error('tts_cloud_needed'), { code: 'tts_cloud_needed' });
  if (my !== token) return false;
  for (const part of splitText(text)) {
    const ok = await new Promise((resolve) => {
      const u = new SpeechSynthesisUtterance(part);
      u.voice = pick.voice;
      u.lang = pick.voice.lang;
      u.onend = () => resolve(true);
      u.onerror = () => resolve(false);
      sy.speak(u);
    });
    if (!ok || my !== token) return false;
  }
  return true;
}
