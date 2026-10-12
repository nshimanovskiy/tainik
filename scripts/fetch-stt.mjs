#!/usr/bin/env node
// Скачивает всё для расшифровки голосовых на устройстве (Whisper в браузере):
//   runtime/ — transformers.js и onnxruntime-web (wasm), из npm;
//   models/whisper-base/ — модель распознавания речи (~76 МБ), с Hugging Face.
// Версии закреплены, каждый файл сверяется по sha256 — подменённый файл не ляжет на диск.
// Сервер Тайника отдаёт эти файлы по /stt/…; сообщения и голосовые туда не уходят.
//
//   node scripts/fetch-stt.mjs [папка=stt] [--runtime-only] [--print-hashes]
// Без внешних зависимостей: npm-пакеты (tgz) распаковываются здесь же.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

export const STT_VERSION = 'v1'; // меняется вместе с набором файлов (адреса /stt/v1/… кешируются навсегда)
const TRANSFORMERS = '4.3.1';
const ORT = '1.31.0-dev.20260914-8d85527a0'; // ровно та версия, с которой собран transformers.js
const MODEL = 'onnx-community/whisper-base';
const MODEL_REV = '1846881b6b3a3024392c1eea3ad983695bc23925';

// Что берём: [куда, откуда, sha256]
const NPM = [
  { pkg: '@huggingface/transformers', ver: TRANSFORMERS, files: { 'package/dist/transformers.min.js': 'runtime/transformers.min.js', 'package/LICENSE': 'runtime/LICENSE-transformers' } },
  {
    pkg: 'onnxruntime-web',
    ver: ORT,
    files: {
      'package/dist/ort-wasm-simd-threaded.mjs': 'runtime/ort-wasm-simd-threaded.mjs',
      'package/dist/ort-wasm-simd-threaded.wasm': 'runtime/ort-wasm-simd-threaded.wasm',
      'package/dist/ort-wasm-simd-threaded.asyncify.mjs': 'runtime/ort-wasm-simd-threaded.asyncify.mjs',
      'package/dist/ort-wasm-simd-threaded.asyncify.wasm': 'runtime/ort-wasm-simd-threaded.asyncify.wasm',
      'package/LICENSE': 'runtime/LICENSE-onnxruntime',
    },
  },
];
const MODEL_FILES = ['config.json', 'generation_config.json', 'preprocessor_config.json', 'tokenizer.json', 'tokenizer_config.json', 'onnx/encoder_model_quantized.onnx', 'onnx/decoder_model_merged_quantized.onnx'];

const SHA256 = {
  'runtime/transformers.min.js': '8d6716d9086f57c30a4bf367dba61b887593573c770c454465e8019b2703e743',
  'models/whisper-base/onnx/encoder_model_quantized.onnx': '5862993336bf33acd23736071aae2b32261d3b1b2f37780194460d4ef974dd46',
  'models/whisper-base/onnx/decoder_model_merged_quantized.onnx': 'fa3ef9902734ce5ae6f9ef2bdb2ba9a6c4b5785b09f4f420ce036573dc9d090b',
};

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

async function get(url) {
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(url, { redirect: 'follow' });
      if (!r.ok) throw new Error(`${r.status} ${url}`);
      return Buffer.from(await r.arrayBuffer());
    } catch (e) {
      if (i >= 2) throw e;
      await new Promise((ok) => setTimeout(ok, 2000 * (i + 1)));
    }
  }
}

/** Файлы из tar (ustar): { путь → Buffer }. */
export function untar(buf) {
  const out = {};
  let longName = null;
  for (let off = 0; off + 512 <= buf.length; ) {
    const h = buf.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    const str = (a, b) => h.subarray(a, b).toString('utf8').replace(/\0.*$/s, '');
    let name = str(0, 100);
    const prefix = str(345, 500);
    if (prefix) name = prefix + '/' + name;
    const size = parseInt(str(124, 136).trim() || '0', 8);
    const type = String.fromCharCode(h[156] || 48);
    const data = buf.subarray(off + 512, off + 512 + size);
    if (type === 'L') longName = data.toString('utf8').replace(/\0.*$/s, '');
    else {
      if (longName) (name = longName), (longName = null);
      if (type === '0' || type === '\0') out[name] = Buffer.from(data);
    }
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}

async function npmFiles({ pkg, ver, files }) {
  const meta = JSON.parse((await get(`https://registry.npmjs.org/${pkg.replace('/', '%2F')}/${encodeURIComponent(ver)}`)).toString());
  const tgz = await get(meta.dist.tarball);
  // Целостность пакета — как у npm (sha512 из реестра)
  const [alg, b64] = String(meta.dist.integrity || '').split('-');
  if (alg !== 'sha512' || crypto.createHash('sha512').update(tgz).digest('base64') !== b64) throw new Error(`integrity mismatch: ${pkg}@${ver}`);
  const tar = untar(zlib.gunzipSync(tgz));
  const res = {};
  for (const [from, to] of Object.entries(files)) {
    if (!tar[from]) throw new Error(`${pkg}@${ver}: нет файла ${from}`);
    res[to] = tar[from];
  }
  return res;
}

export async function fetchStt(dir, { runtimeOnly = false, printHashes = false, log = console.log } = {}) {
  const got = {};
  for (const p of NPM) Object.assign(got, await npmFiles(p));
  if (!runtimeOnly) {
    for (const f of MODEL_FILES) got[`models/whisper-base/${f}`] = await get(`https://huggingface.co/${MODEL}/resolve/${MODEL_REV}/${f}`);
  }
  for (const [rel, buf] of Object.entries(got)) {
    const h = sha256(buf);
    if (printHashes) log(`  '${rel}': '${h}',`);
    else if (SHA256[rel] && SHA256[rel] !== h) throw new Error(`sha256 mismatch: ${rel}`);
    else if (!SHA256[rel] && !rel.includes('LICENSE')) throw new Error(`нет sha256 для ${rel}`);
  }
  for (const [rel, buf] of Object.entries(got)) {
    const file = path.join(dir, STT_VERSION, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, buf);
  }
  log(`STT ${STT_VERSION}: ${Object.keys(got).length} файлов → ${path.join(dir, STT_VERSION)}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const dir = args.find((a) => !a.startsWith('--')) || 'stt';
  fetchStt(dir, { runtimeOnly: args.includes('--runtime-only'), printHashes: args.includes('--print-hashes') }).catch((e) => {
    console.error('Не удалось скачать распознавание речи:', e.message);
    process.exit(1);
  });
}
