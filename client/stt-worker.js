// Воркер расшифровки голосовых: Whisper (whisper-base) на этом устройстве — transformers.js
// и onnxruntime-web (WebAssembly). Голосовое не покидает устройство.
//
// Код движка (transformers.min.js, ort-*.mjs) — свой: в вебе с этого же сайта, в приложениях —
// из самого приложения. С сервера скачиваются только модель и двоичный wasm; wasm сверяется
// по sha256, прежде чем запуститься.

import { chooseLanguage } from './stt-lang.js';

const V = '/stt/v1';
const WASM = 'ort-wasm-simd-threaded.wasm';
export const WASM_SHA256 = '06ba057753da3847e4c24f02d91ab133455b0817c69a44993a9a53a2146df9e3';
const MODELS = ['whisper-small', 'whisper-base']; // точная и быстрая

const pipes = new Map(); // модель → Promise конвейера
let wasmBin = null; // проверенный wasm (общий для моделей)
let tf = null; // модуль transformers.js

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const fail = (code) => Object.assign(new Error(code), { code });

/** Скачать с отчётом о ходе: onBytes(получено, всего). */
async function download(url, onBytes) {
  const r = await fetch(url, { credentials: 'omit' });
  if (!r.ok) throw fail(r.status === 404 ? 'stt_missing' : 'stt_download');
  const total = Number(r.headers.get('content-length')) || 0;
  if (!r.body) return r.arrayBuffer();
  const reader = r.body.getReader();
  const parts = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    got += value.length;
    onBytes(got, total);
  }
  const out = new Uint8Array(got);
  let off = 0;
  for (const p of parts) out.set(p, (off += p.length) - p.length);
  return out.buffer;
}

function load(base, model, progress) {
  if (pipes.has(model)) return pipes.get(model);
  const p = (async () => {
    // Ход загрузки: сумма по всем файлам
    const files = new Map();
    const report = () => {
      let loaded = 0;
      let total = 0;
      for (const f of files.values()) (loaded += f.loaded), (total += f.total);
      progress(total ? loaded / total : 0);
    };
    if (!tf) {
      try {
        tf = await import(V + '/runtime/transformers.min.js');
      } catch {
        throw fail('stt_missing');
      }
    }
    if (!wasmBin) {
      const wasm = await download(`${base}${V}/runtime/${WASM}`, (loaded, total) => (files.set(WASM, { loaded, total }), report()));
      if (hex(await crypto.subtle.digest('SHA-256', wasm)) !== WASM_SHA256) throw fail('stt_corrupt');
      wasmBin = wasm;
    }
    const { env, pipeline } = tf;
    env.allowLocalModels = false;
    env.allowRemoteModels = true;
    env.remoteHost = `${base}${V}/models/`;
    env.remotePathTemplate = '{model}/';
    env.useWasmCache = false; // свой wasm уже скачан и проверен
    const onnx = env.backends.onnx;
    onnx.wasm.wasmPaths = { mjs: new URL(V + '/runtime/ort-wasm-simd-threaded.mjs', self.location.href).href };
    onnx.wasm.wasmBinary = wasmBin;
    onnx.wasm.proxy = false;
    onnx.wasm.numThreads = 1;
    // Держим в памяти одну модель: две сразу телефону не по силам
    for (const [m, other] of pipes) {
      if (m === model) continue;
      pipes.delete(m);
      other.then((x) => x.dispose?.()).catch(() => {});
    }
    return pipeline('automatic-speech-recognition', model, {
      device: 'wasm',
      dtype: { encoder_model: 'q8', decoder_model_merged: 'q8' },
      progress_callback: (p) => {
        if (p.status === 'progress' && p.file) files.set(p.file, { loaded: p.loaded || 0, total: p.total || 0 }), report();
      },
    });
  })();
  pipes.set(model, p);
  p.catch(() => pipes.get(model) === p && pipes.delete(model)); // не вышло — в следующий раз попробуем заново
  return p;
}

/**
 * Язык речи: transformers.js сам его не определяет (без подсказки считает речь английской),
 * поэтому, как в Whisper, смотрим, какой языковой токен модель ставит первым.
 */
async function detectLanguage(run, audio, prefer) {
  const cfg = run.model.generation_config || {};
  const langs = Object.entries(cfg.lang_to_id || {});
  if (!langs.length) return null;
  const { input_features } = await run.processor(audio.subarray(0, 30 * 16000));
  const sot = BigInt(cfg.decoder_start_token_id);
  const out = await run.model({ input_features, decoder_input_ids: new tf.Tensor('int64', BigInt64Array.from([sot]), [1, 1]) });
  const data = out.logits.data;
  const off = data.length - out.logits.dims.at(-1); // последняя позиция
  // Вероятности языков (softmax по языковым токенам)
  const logits = langs.map(([tok, id]) => [tok.slice(2, -2), data[off + id]]);
  const max = Math.max(...logits.map(([, v]) => v));
  const sum = logits.reduce((a, [, v]) => a + Math.exp(v - max), 0);
  const prob = new Map(logits.map(([l, v]) => [l, Math.exp(v - max) / sum]));
  return chooseLanguage(prob, prefer);
}

self.onmessage = async ({ data }) => {
  const { id, base, audio } = data || {};
  const model = MODELS.includes(data?.model) ? data.model : 'whisper-base';
  const prefer = (Array.isArray(data?.prefer) ? data.prefer : []).filter((l) => /^[a-z]{2,3}$/.test(l));
  try {
    const run = await load(String(base || ''), model, (frac) => self.postMessage({ id, progress: frac }));
    self.postMessage({ id, stage: 'run' });
    const language = (await detectLanguage(run, audio, prefer).catch(() => null)) || prefer[0] || null;
    const out = await run(audio, { task: 'transcribe', language, chunk_length_s: 30, stride_length_s: 5 });
    const text = (Array.isArray(out) ? out.map((x) => x.text).join(' ') : out?.text || '').replace(/\s+/g, ' ').trim();
    self.postMessage({ id, text, language, model });
  } catch (e) {
    self.postMessage({ id, error: e?.code || 'stt_failed', message: String(e?.message || e) });
  }
};
