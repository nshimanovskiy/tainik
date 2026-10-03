import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server/server.js';
import { buildWebclip } from '../server/webclip.js';

test('iPhone: профиль с веб-клипом', () => {
  const icon = Buffer.from('PNG-данные');
  const xml = buildWebclip({ host: 'chat.example.com', icon });
  assert.match(xml, /^<\?xml version="1.0" encoding="UTF-8"\?>/);
  assert.match(xml, /<string>https:\/\/chat\.example\.com\/app<\/string>/);
  assert.match(xml, /<string>com\.apple\.webClip\.managed<\/string>/);
  assert.match(xml, /<key>FullScreen<\/key>\s*<true\/>/, 'открывается как приложение, без панелей Safari');
  assert.match(xml, /<string>com\.example\.chat\.tainik<\/string>/);
  assert.ok(xml.includes(icon.toString('base64')));
  // UUID постоянные: повторная установка заменяет профиль, а не добавляет второй
  assert.equal(xml, buildWebclip({ host: 'chat.example.com', icon }));
  assert.notEqual(xml, buildWebclip({ host: 'other.example.com', icon }));
  const uuids = xml.match(/[0-9A-F]{8}-[0-9A-F]{4}-4[0-9A-F]{3}-A[0-9A-F]{3}-[0-9A-F]{12}/g);
  assert.equal(new Set(uuids).size, 2);
  assert.match(buildWebclip({ host: "localhost:8080", icon }), /http:\/\/localhost:8080\/app/);
});

test('iPhone: сервер отдаёт профиль и страницу установки', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tainik-ios-'));
  const srv = await startServer({ port: 0, host: '127.0.0.1', dataDir, log: false, domain: 'chat.example.com' });
  t.after(async () => {
    await srv.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${srv.port}`;
  let r = await fetch(`${base}/tainik.mobileconfig`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'application/x-apple-aspen-config');
  assert.match(r.headers.get('content-disposition'), /Tainik\.mobileconfig/);
  const body = await r.text();
  assert.match(body, /https:\/\/chat\.example\.com\//, 'адрес — из DOMAIN, а не из заголовка Host');
  assert.ok(body.includes(fs.readFileSync('client/apple-touch-icon.png').toString('base64').slice(0, 64)));

  r = await fetch(`${base}/ios`);
  assert.equal(r.status, 200);
  assert.match(await r.text(), /tainik\.mobileconfig/);
  assert.equal((await fetch(`${base}/apple-touch-icon.png`)).status, 200);
  assert.equal((await fetch(`${base}/install.js`)).status, 200);
});

test('главная на /, мессенджер на /app', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tainik-home-'));
  const srv = await startServer({ port: 0, host: '127.0.0.1', dataDir, log: false });
  t.after(async () => {
    await srv.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${srv.port}`;
  assert.match(await (await fetch(`${base}/`)).text(), /landing\.js/);
  assert.match(await (await fetch(`${base}/app`)).text(), /app\.js/);
  const r = await fetch(`${base}/app/`, { redirect: 'manual' });
  assert.equal(r.status, 301);
  assert.equal(r.headers.get('location'), '/app');
  const m = await (await fetch(`${base}/manifest.webmanifest`)).json();
  assert.equal(m.start_url, '/app');
});
