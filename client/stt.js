// Расшифровка голосовых в текст — на этом устройстве (см. stt-worker.js).
// Здесь: перевод звука в 16 кГц моно (так его ждёт Whisper) и очередь к воркеру.

const RATE = 16000;
const MAX_SEC = 10 * 60; // дольше не расшифровываем: на телефоне это слишком долго

/** Звук (ArrayBuffer файла) → Float32Array 16 кГц моно. */
export async function decodeAudio(buf) {
  const Ctx = self.AudioContext || self.webkitAudioContext;
  if (!Ctx) throw Object.assign(new Error('stt_audio'), { code: 'stt_audio' });
  const ctx = new Ctx();
  let audio;
  try {
    audio = await ctx.decodeAudioData(buf.slice(0));
  } catch {
    throw Object.assign(new Error('stt_audio'), { code: 'stt_audio' });
  } finally {
    ctx.close?.().catch(() => {});
  }
  if (audio.duration > MAX_SEC) throw Object.assign(new Error('stt_long'), { code: 'stt_long' });
  const len = Math.max(1, Math.ceil(audio.duration * RATE));
  try {
    // Пересчёт частоты средствами браузера (со сглаживанием)
    const off = new OfflineAudioContext(1, len, RATE);
    const src = off.createBufferSource();
    src.buffer = audio;
    src.connect(off.destination);
    src.start();
    return (await off.startRendering()).getChannelData(0);
  } catch {
    return resample(mixdown(audio), audio.sampleRate, RATE);
  }
}

function mixdown(audio) {
  const n = audio.numberOfChannels;
  const out = new Float32Array(audio.length);
  for (let c = 0; c < n; c++) {
    const d = audio.getChannelData(c);
    for (let i = 0; i < d.length; i++) out[i] += d[i] / n;
  }
  return out;
}

/** Простой пересчёт частоты (линейный), если OfflineAudioContext не умеет 16 кГц. */
export function resample(data, from, to) {
  if (from === to) return data;
  const out = new Float32Array(Math.max(1, Math.round((data.length * to) / from)));
  const k = from / to;
  for (let i = 0; i < out.length; i++) {
    const x = i * k;
    const j = Math.floor(x);
    const f = x - j;
    out[i] = (data[j] ?? 0) * (1 - f) + (data[j + 1] ?? data[j] ?? 0) * f;
  }
  return out;
}

let worker = null;
let seq = 0;
const waiting = new Map(); // id → { resolve, reject, onProgress }

function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('./stt-worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = ({ data }) => {
    const w = waiting.get(data?.id);
    if (!w) return;
    if (data.progress != null) return w.onProgress?.({ stage: 'load', frac: data.progress });
    if (data.stage) return w.onProgress?.({ stage: data.stage });
    waiting.delete(data.id);
    if (data.error) w.reject(Object.assign(new Error(data.message || data.error), { code: data.error }));
    else w.resolve({ text: data.text || '', language: data.language || null, model: data.model });
  };
  worker.onerror = () => {
    for (const w of waiting.values()) w.reject(Object.assign(new Error('stt_failed'), { code: 'stt_failed' }));
    waiting.clear();
    worker = null;
  };
  return worker;
}

/**
 * Расшифровать звук → { text, language, model }. base — адрес сервера (https://…), откуда берутся
 * модель и wasm; model — 'whisper-small' (точная) или 'whisper-base' (быстрая); prefer — языки
 * пользователя (['ru']), их выбираем, если запись неоднозначна.
 * onProgress({ stage: 'load', frac } | { stage: 'run' }). Расшифровки идут по одной.
 */
let chain = Promise.resolve();
export function transcribe(buf, { base, model = 'whisper-base', prefer = [], onProgress } = {}) {
  const job = chain.then(async () => {
    const audio = await decodeAudio(buf);
    const id = ++seq;
    return new Promise((resolve, reject) => {
      waiting.set(id, { resolve, reject, onProgress });
      getWorker().postMessage({ id, base, model, prefer, audio }, [audio.buffer]);
    });
  });
  chain = job.catch(() => {});
  return job;
}

/** Есть ли на сервере эта модель (true/false; не знаем — null). */
export async function sttOnServer(base, model = 'whisper-base') {
  try {
    const r = await fetch(`${base}/stt/v1/models/${model}/config.json`, { method: 'HEAD', credentials: 'omit', cache: 'no-store' });
    return r.ok;
  } catch {
    return null;
  }
}
