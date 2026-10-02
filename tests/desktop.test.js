import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { SecureStore, resolveAppPath } = require('../desktop/lib.cjs');

// Имитация safeStorage: XOR + маркер (в приложении — Keychain/DPAPI/libsecret)
const KEY = 0x5a;
const fakeEncrypt = (s) => Buffer.concat([Buffer.from('ENC1'), Buffer.from(Buffer.from(s, 'utf8').map((b) => b ^ KEY))]);
const fakeDecrypt = (b) => {
  if (b.subarray(0, 4).toString() !== 'ENC1') throw new Error('bad blob');
  return Buffer.from(b.subarray(4).map((x) => x ^ KEY)).toString('utf8');
};

test('десктоп: хранилище шифрует файл, переживает перезапуск и параллельные записи', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tainik-desk-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'store.bin');
  const s = new SecureStore({ file, encrypt: fakeEncrypt, decrypt: fakeDecrypt });

  await Promise.all(Array.from({ length: 50 }, (_, i) => s.set('k' + i, { n: i, text: 'секрет ' + i })));
  await s.set('session:bob', { RK: 'abc', skipped: { 'x|1': 'mk' } });
  const raw = fs.readFileSync(file);
  assert.ok(!raw.toString('utf8').includes('секрет'), 'на диске нет открытого текста');
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);

  const s2 = new SecureStore({ file, encrypt: fakeEncrypt, decrypt: fakeDecrypt });
  assert.equal(s2.get('k49').text, 'секрет 49');
  assert.deepEqual(s2.get('session:bob'), { RK: 'abc', skipped: { 'x|1': 'mk' } });

  const v = s2.get('k1');
  v.n = 999; // изменения копии не попадают в хранилище без set()
  assert.equal(s2.get('k1').n, 1);

  await s2.del('k1');
  await s2.clear();
  assert.equal(new SecureStore({ file, encrypt: fakeEncrypt, decrypt: fakeDecrypt }).get('k2'), undefined);
});

test('десктоп: протокол app:// не выпускает за пределы папки renderer', () => {
  const base = path.join(os.tmpdir(), 'renderer');
  assert.equal(resolveAppPath(base, 'app://app/'), path.join(base, 'index.html'));
  assert.equal(resolveAppPath(base, 'app://app/shared/client-core.js'), path.join(base, 'shared', 'client-core.js'));
  assert.equal(resolveAppPath(base, 'app://app/../../etc/passwd'), path.join(base, 'etc', 'passwd')); // URL нормализует ..
  assert.equal(resolveAppPath(base, 'app://app/%2e%2e%2f%2e%2e%2fetc/passwd'), null);
  assert.equal(resolveAppPath(base, 'app://evil/index.html'), null);
  assert.equal(resolveAppPath(base, 'file:///etc/passwd'), null);
});
