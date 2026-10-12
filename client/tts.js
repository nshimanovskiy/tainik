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

// Голоса: список приходит не сразу (особенно в Safari) — держим его заранее, чтобы при нажатии
// «Озвучить» говорить сразу, не теряя жест пользователя (без жеста iOS молчит).
let voiceList = [];
function loadVoices() {
  const sy = synth();
  if (!sy) return;
  try {
    const l = sy.getVoices();
    if (l?.length) voiceList = l;
  } catch {}
}
loadVoices();
try {
  synth()?.addEventListener?.('voiceschanged', loadVoices);
} catch {}

async function voices() {
  loadVoices();
  if (voiceList.length) return voiceList;
  const sy = synth();
  await new Promise((ok) => {
    const done = () => (sy.removeEventListener?.('voiceschanged', done), ok());
    sy.addEventListener?.('voiceschanged', done);
    setTimeout(done, 1500);
  });
  loadVoices();
  return voiceList;
}

let primed = false;
let primer = null; // беззвучная фраза-«ключ» ещё звучит — её не отменяем (иначе Safari съест следующую)
/**
 * Вызывать синхронно в обработчике нажатия: iOS разрешает речь только по жесту пользователя,
 * а до озвучки ещё идут асинхронные шаги. Беззвучная фраза «открывает» синтез речи.
 */
export function primeSpeech() {
  const sy = synth();
  if (native() || !sy || primed) return;
  primed = true;
  try {
    if (sy.paused) sy.resume();
    const u = new SpeechSynthesisUtterance(' ');
    u.volume = 0;
    u.onend = u.onerror = () => primer === u && (primer = null);
    primer = u;
    setTimeout(() => primer === u && (primer = null), 3000);
    sy.speak(u);
  } catch {}
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
let restart = null; // () => void — прервать текущую фразу, чтобы прочитать её заново (новая громкость)

// Громкость озвучки 0…1 (доля от громкости устройства); хранится на этом устройстве
const VOL_KEY = 'tainik:tts-volume';
let volume = (() => {
  try {
    const v = Number(localStorage.getItem(VOL_KEY));
    return localStorage.getItem(VOL_KEY) != null && v >= 0 && v <= 1 ? v : 1;
  } catch {
    return 1;
  }
})();
export const getVolume = () => volume;
/** Сменить громкость; если сейчас что-то читается — текущая фраза звучит заново, уже с новой. */
export function setVolume(v) {
  v = Math.min(1, Math.max(0, Number(v) || 0));
  if (v === volume) return volume;
  volume = v;
  try {
    localStorage.setItem(VOL_KEY, String(v));
  } catch {}
  restart?.();
  return volume;
}

/** Остановить озвучку. */
export function stopSpeaking() {
  token++;
  restart = null;
  native()?.stop().catch(() => {});
  const sy = synth();
  // Safari: cancel() прямо перед speak() иногда «съедает» новую фразу — отменяем, только если есть что
  if (sy && (sy.speaking || sy.pending) && !primer) sy.cancel();
}

let utterance = null; // ссылка на текущую фразу: иначе Safari может «потерять» её и не сообщить о конце

const ttsError = (code) => Object.assign(new Error(code), { code });

/**
 * Озвучить text. lang — 'ru' и т. п. allowRemote — можно ли сетевой голос.
 * Читает по фразам с текущей громкостью (getVolume / setVolume).
 * Резолвится, когда дочитано (true) или остановлено (false). Ошибки: code tts_no_voice,
 * tts_cloud_needed (есть только сетевой голос), tts_unavailable.
 */
export async function speak(text, { lang, allowRemote = false } = {}) {
  stopSpeaking();
  const my = ++token;
  const n = native();
  let say; // (фраза) => Promise<true — дочитана | false — прервана>
  let cancel;
  if (n) {
    say = async (part) => {
      try {
        return await n.speak(part, lang, volume);
      } catch (e) {
        throw ttsError(/tts_[a-z_]+/.exec(String(e?.message))?.[0] || 'tts_unavailable');
      }
    };
    cancel = () => n.stop().catch(() => {});
  } else {
    const sy = synth();
    if (!sy) throw ttsError('tts_unavailable');
    const list = voiceList.length ? voiceList : await voices();
    // Список голосов пуст (так бывает в Safari и в приложении на iPhone) — голос выберет система по языку
    const pick = list.length ? pickVoice(list, lang, allowRemote) : { voice: null };
    if (!pick) throw ttsError('tts_no_voice');
    if (pick.remote) throw ttsError('tts_cloud_needed');
    say = (part) =>
      new Promise((resolve) => {
        const u = new SpeechSynthesisUtterance(part);
        if (pick.voice) u.voice = pick.voice;
        u.lang = pick.voice?.lang || lang;
        u.volume = volume;
        let started = false;
        let watch = 0;
        const end = (ok) => {
          clearInterval(watch);
          if (utterance === u) utterance = null;
          resolve(ok);
        };
        u.onstart = () => (started = true);
        u.onend = () => end(true);
        u.onerror = (e) => end(e?.error === 'interrupted' || e?.error === 'canceled' ? false : !started ? false : true);
        // Safari иногда не присылает onend — следим, не замолчал ли синтез
        watch = setInterval(() => started && !sy.speaking && !sy.pending && end(true), 700);
        utterance = u;
        if (sy.paused) sy.resume();
        sy.speak(u);
      });
    cancel = () => sy.cancel();
  }
  const parts = splitText(text);
  for (let i = 0; i < parts.length; i++) {
    if (my !== token) return false;
    let again = false;
    restart = () => ((again = true), cancel());
    const done = await say(parts[i]);
    if (my !== token) return false;
    if (again) {
      i--; // громкость сменили посреди фразы — читаем её заново
      continue;
    }
    if (!done) return false;
  }
  if (my === token) restart = null;
  return true;
}
