// Подпись профиля iPhone: deploy/sign-profile.sh с тестовой цепочкой сертификатов
// (корень → промежуточный → сертификат домена, ECDSA — как у Let's Encrypt).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync, spawn } from 'node:child_process';
import { startServer } from '../server/server.js';

const hasOpenssl = spawnSync('openssl', ['version']).status === 0;
const ssl = (cwd, ...args) => execFileSync('openssl', args, { cwd, stdio: 'pipe' });

function makeChain(dir) {
  const ext = (name, text) => fs.writeFileSync(path.join(dir, name), text);
  ext('ca.ext', 'basicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n');
  ext('leaf.ext', 'basicConstraints=CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:chat.example.com\n');
  for (const k of ['root', 'int', 'leaf']) ssl(dir, 'ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', `${k}.key`);
  ssl(dir, 'req', '-x509', '-new', '-key', 'root.key', '-subj', '/CN=Test Root', '-days', '30', '-out', 'root.pem', '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign');
  ssl(dir, 'req', '-new', '-key', 'int.key', '-subj', '/CN=Test Intermediate', '-out', 'int.csr');
  ssl(dir, 'x509', '-req', '-in', 'int.csr', '-CA', 'root.pem', '-CAkey', 'root.key', '-CAcreateserial', '-days', '30', '-extfile', 'ca.ext', '-out', 'chain.pem');
  ssl(dir, 'req', '-new', '-key', 'leaf.key', '-subj', '/CN=chat.example.com', '-out', 'leaf.csr');
  ssl(dir, 'x509', '-req', '-in', 'leaf.csr', '-CA', 'chain.pem', '-CAkey', 'int.key', '-CAcreateserial', '-days', '30', '-extfile', 'leaf.ext', '-out', 'cert.pem');
  fs.copyFileSync(path.join(dir, 'leaf.key'), path.join(dir, 'privkey.pem'));
}

test('iPhone: профиль подписывается сертификатом домена и отдаётся подписанным', { skip: !hasOpenssl && 'нет openssl' }, async (t) => {
  const certDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tainik-cert-'));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tainik-sign-'));
  const srv = await startServer({ port: 0, host: '127.0.0.1', dataDir, log: false, domain: 'chat.example.com' });
  t.after(async () => {
    await srv.close();
    fs.rmSync(certDir, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  makeChain(certDir);
  const base = `http://127.0.0.1:${srv.port}`;

  // До подписи — обычный XML
  assert.match(await (await fetch(`${base}/tainik.mobileconfig`)).text(), /^<\?xml/);

  // Асинхронно: сервер работает в этом же процессе и должен отвечать скрипту
  const run = (env) =>
    new Promise((resolve) => {
      const p = spawn('deploy/sign-profile.sh', ['--no-hook', '--quiet'], {
        env: { ...process.env, DOMAIN: 'chat.example.com', TAINIK_PORT: String(srv.port), CERT_DIR: certDir, CA_FILE: path.join(certDir, 'root.pem'), OUT: path.join(dataDir, 'tainik-signed.mobileconfig'), ...env },
      });
      let stderr = '';
      p.stderr.on('data', (d) => (stderr += d));
      p.on('close', (status) => resolve({ status, stderr }));
    });
  const r = await run({});
  assert.equal(r.status, 0, r.stderr);

  // Теперь сервер отдаёт подписанный профиль (DER, PKCS#7)
  const res = await fetch(`${base}/tainik.mobileconfig`);
  assert.equal(res.headers.get('content-type'), 'application/x-apple-aspen-config');
  const der = Buffer.from(await res.arrayBuffer());
  assert.equal(der[0], 0x30);
  const signed = path.join(certDir, 'got.mobileconfig');
  fs.writeFileSync(signed, der);
  // Проверка подписи и цепочки до корня — так профиль проверяет iPhone
  const inner = ssl(certDir, 'smime', '-verify', '-inform', 'der', '-in', signed, '-CAfile', 'root.pem', '-purpose', 'any').toString();
  assert.match(inner, /https:\/\/chat\.example\.com\//);
  assert.match(inner, /com\.apple\.webClip\.managed/);
  const signers = ssl(certDir, 'pkcs7', '-inform', 'der', '-in', signed, '-print_certs', '-noout').toString();
  assert.match(signers, /CN\s*=\s*chat\.example\.com/);
  assert.match(signers, /Test Intermediate/, 'промежуточный сертификат вложен — iPhone соберёт цепочку');

  // Неподписанный — по-прежнему доступен скрипту
  assert.match(await (await fetch(`${base}/tainik.mobileconfig?unsigned=1`)).text(), /^<\?xml/);

  // Чужой корень — подпись не проходит проверку, скрипт останавливается
  fs.rmSync(path.join(dataDir, 'tainik-signed.mobileconfig'));
  ssl(certDir, 'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', 'other.key', '-subj', '/CN=Other', '-days', '1', '-out', 'other.pem');
  const bad = await run({ CA_FILE: path.join(certDir, 'other.pem') });
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /Подпись не проверяется/);
  assert.ok(!fs.existsSync(path.join(dataDir, 'tainik-signed.mobileconfig')));

  // Нет сертификата — понятная ошибка
  const none = await run({ CERT_DIR: path.join(certDir, 'нет') });
  assert.notEqual(none.status, 0);
  assert.match(none.stderr, /Не найден/);
});
