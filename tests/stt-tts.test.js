// Расшифровка голосовых (файлы движка и модели, их раздача) и озвучка сообщений.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server/server.js';
import { untar, STT_VERSION } from '../scripts/fetch-stt.mjs';
import { resample } from '../client/stt.js';
import { guessLang, pickVoice, splitText, speak, stopSpeaking, getVolume, setVolume } from '../client/tts.js';

const read = (f) => fs.readFileSync(new URL('../' + f, import.meta.url), 'utf8');

/** Минимальный tar (ustar) для проверки распаковщика. */
function tar(files) {
  const blocks = [];
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text);
    const h = Buffer.alloc(512);
    const long = name.length > 100;
    if (long) {
      // GNU: длинное имя — отдельной записью типа L
      const nb = Buffer.from(name + '\0');
      const lh = Buffer.alloc(512);
      lh.write('././@LongLink');
      lh.write(nb.length.toString(8).padStart(11, '0'), 124);
      lh.write('L', 156);
      blocks.push(lh, nb, Buffer.alloc((512 - (nb.length % 512)) % 512));
    }
    h.write(long ? name.slice(0, 100) : name);
    h.write(data.length.toString(8).padStart(11, '0'), 124);
    h.write('0', 156);
    blocks.push(h, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

test('распаковка npm-пакета (tar) и закреплённые файлы', () => {
  const long = 'package/' + 'x'.repeat(120) + '.js';
  const files = untar(tar({ 'package/dist/a.js': 'export default 1', [long]: 'длинное' }));
  assert.equal(files['package/dist/a.js'].toString(), 'export default 1');
  assert.equal(files[long].toString(), 'длинное');
  // wasm, который проверяет воркер, — тот же, что скачивает сервер
  const src = read('scripts/fetch-stt.mjs');
  const pinned = /'runtime\/ort-wasm-simd-threaded\.wasm': '([0-9a-f]{64})'/.exec(src)[1];
  assert.equal(/WASM_SHA256 = '([0-9a-f]{64})'/.exec(read('client/stt-worker.js'))[1], pinned);
  assert.match(read('client/stt-worker.js'), new RegExp(`'/stt/${STT_VERSION}'`));
  // У каждого файла есть sha256
  for (const f of ['transformers.min.js', 'ort-wasm-simd-threaded.mjs']) assert.match(src, new RegExp(`'runtime/${f.replace(/\./g, '\\.')}': '[0-9a-f]{64}'`));
  for (const f of ['config.json', 'tokenizer.json', 'onnx/encoder_model_quantized.onnx', 'onnx/decoder_model_merged_quantized.onnx'])
    assert.ok(src.includes(`'models/whisper-base/${f}': '`), f);
});

test('сервер раздаёт файлы распознавания речи, и только их', async (tt) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tainik-stt-'));
  const sttDir = path.join(dataDir, 'stt');
  fs.mkdirSync(path.join(sttDir, 'v1/models/whisper-base/onnx'), { recursive: true });
  fs.mkdirSync(path.join(sttDir, 'v1/runtime'), { recursive: true });
  fs.writeFileSync(path.join(sttDir, 'v1/models/whisper-base/config.json'), '{"a":1}');
  fs.writeFileSync(path.join(sttDir, 'v1/models/whisper-base/onnx/encoder_model_quantized.onnx'), Buffer.alloc(3000, 7));
  fs.writeFileSync(path.join(sttDir, 'v1/runtime/ort-wasm-simd-threaded.wasm'), Buffer.from([0, 97, 115, 109]));
  fs.writeFileSync(path.join(dataDir, 'secret.txt'), 'нельзя');
  const srv = await startServer({ port: 0, host: '127.0.0.1', dataDir: path.join(dataDir, 'db'), log: false, sttDir });
  tt.after(async () => {
    await srv.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${srv.port}`;
  let r = await fetch(base + '/stt/v1/models/whisper-base/config.json');
  assert.equal(r.status, 200);
  assert.equal(await r.text(), '{"a":1}');
  assert.equal(r.headers.get('access-control-allow-origin'), '*', 'приложения скачивают модель со своих адресов');
  assert.match(r.headers.get('cache-control'), /immutable/);
  r = await fetch(base + '/stt/v1/runtime/ort-wasm-simd-threaded.wasm');
  assert.equal(r.headers.get('content-type'), 'application/wasm');
  assert.equal((await r.arrayBuffer()).byteLength, 4);
  r = await fetch(base + '/stt/v1/models/whisper-base/onnx/encoder_model_quantized.onnx', { method: 'HEAD' });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-length'), '3000');
  for (const bad of ['/stt/v1/../secret.txt', '/stt/v1/models/whisper-base/../../../secret.txt', '/stt/v1/runtime/x.txt', '/stt/v1/models/whisper-base/nope.json', '/stt/'])
    assert.equal((await fetch(base + bad)).status, 404, bad);
  // Страница разрешает WebAssembly (движок) — и больше ничего нового
  const csp = (await fetch(base + '/app')).headers.get('content-security-policy');
  assert.match(csp, /script-src 'self' 'wasm-unsafe-eval';/);
  assert.doesNotMatch(csp.replace("'wasm-unsafe-eval'", ''), /unsafe/);
});

test('приложения: WebAssembly разрешён, .mjs отдаётся', () => {
  assert.match(read('desktop/lib.cjs'), /"script-src 'self' 'wasm-unsafe-eval'"/);
  assert.match(read('desktop/lib.cjs'), /'\.mjs': 'text\/javascript/);
  const kt = read('android/app/src/main/java/dev/tainik/android/AssetServer.kt');
  assert.match(kt, /"script-src 'self' 'wasm-unsafe-eval'"/);
  assert.match(kt, /"mjs" to "text\/javascript"/);
});

test('пересчёт частоты звука', () => {
  const x = new Float32Array(48000).map((_, i) => Math.sin(i / 10));
  const y = resample(x, 48000, 16000);
  assert.equal(y.length, 16000);
  assert.ok(Math.abs(y[100] - x[300]) < 1e-6);
  assert.equal(resample(x, 16000, 16000), x);
});

test('озвучка: язык текста, выбор голоса, деление на фразы', () => {
  assert.equal(guessLang('Привет, как дела?', 'en'), 'ru');
  assert.equal(guessLang('Hello there', 'ru'), 'en');
  assert.equal(guessLang('¿Qué tal?', 'ru'), 'es');
  assert.equal(guessLang('Hola amigo', 'es'), 'es');
  assert.equal(guessLang('こんにちは', 'ru'), 'ja');
  assert.equal(guessLang('123 !!!', 'ru'), 'ru');

  const voices = [
    { name: 'Google русский', lang: 'ru-RU', localService: false },
    { name: 'Milena', lang: 'ru_RU', localService: true },
    { name: 'Samantha', lang: 'en-US', localService: true, default: true },
    { name: 'Google español', lang: 'es-ES', localService: false },
  ];
  assert.equal(pickVoice(voices, 'ru', false).voice.name, 'Milena', 'голос на устройстве — в первую очередь');
  assert.deepEqual(pickVoice(voices, 'es', false), { remote: true }, 'сетевой — только с согласия');
  assert.equal(pickVoice(voices, 'es', true).voice.name, 'Google español');
  assert.equal(pickVoice(voices, 'ja', true), null);

  const long = 'Первая фраза. ' + 'слово '.repeat(80) + 'конец! Третья?';
  const parts = splitText(long, 100);
  assert.ok(parts.every((p) => p.length <= 100));
  assert.equal(parts.join(' ').replace(/\s+/g, ' '), long.trim().replace(/\s+/g, ' '));
});

test('озвучка в приложении для Android — через мост', async () => {
  const calls = [];
  globalThis.window = {
    desktop: {
      speech: {
        speak: async (text, lang, volume) => (calls.push(['speak', text, lang, volume]), true),
        stop: async () => calls.push(['stop']),
      },
    },
  };
  try {
    assert.equal(await speak('Привет', { lang: 'ru' }), true);
    stopSpeaking();
    assert.deepEqual(calls, [['stop'], ['speak', 'Привет', 'ru', 1], ['stop']]);
    window.desktop.speech.speak = async () => {
      throw new Error('tts_no_voice');
    };
    await assert.rejects(speak('x', { lang: 'ja' }), { code: 'tts_no_voice' });
  } finally {
    delete globalThis.window;
  }
});

test('громкость озвучки: сохраняется, применяется сразу — текущая фраза звучит заново', async () => {
  const said = [];
  let finish = null; // завершить текущую фразу: true — дочитана, false — прервана
  globalThis.window = {
    desktop: {
      speech: {
        speak: (text, lang, volume) => (said.push([text, volume]), new Promise((ok) => (finish = ok))),
        stop: async () => finish?.(false),
      },
    },
  };
  const tick = () => new Promise((r) => setTimeout(r, 0));
  try {
    assert.equal(getVolume(), 1);
    const p = speak('Первая фраза. Вторая фраза.', { lang: 'ru' });
    await tick();
    assert.deepEqual(said, [['Первая фраза.', 1]]);
    assert.equal(setVolume(0.4), 0.4);
    await tick();
    assert.deepEqual(said.at(-1), ['Первая фраза.', 0.4], 'прерванная фраза — заново, уже тише');
    finish(true);
    await tick();
    assert.deepEqual(said.at(-1), ['Вторая фраза.', 0.4]);
    finish(true);
    assert.equal(await p, true);
    assert.equal(setVolume(7), 1, 'не больше 100%');
    assert.equal(setVolume(-1), 0);
    setVolume(1);
  } finally {
    delete globalThis.window;
  }
});
