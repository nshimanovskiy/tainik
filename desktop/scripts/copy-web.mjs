// Копирует веб-клиент и общий код в desktop/renderer перед запуском и сборкой.
// Так у веба и десктопа один и тот же интерфейс и одно крипто-ядро.
//
// TAINIK_SERVER=chat.example.com npm run dist   → адрес сервера по умолчанию в приложении
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const out = path.resolve(here, '..', 'renderer');

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
fs.cpSync(path.join(root, 'client'), out, { recursive: true });
fs.cpSync(path.join(root, 'shared'), path.join(out, 'shared'), { recursive: true });

const raw = (process.env.TAINIK_SERVER || '').trim();
if (raw) {
  let s = raw;
  if (!/^(wss?|https?):\/\//i.test(s)) s = 'wss://' + s;
  const u = new URL(s.replace(/^https:/i, 'wss:').replace(/^http:/i, 'ws:'));
  if (u.pathname === '/' || u.pathname === '') u.pathname = '/ws';
  if (u.protocol === 'ws:' && !/^(localhost|127\.)/.test(u.hostname)) {
    console.warn('[!] ws:// без TLS для удалённого сервера — используйте wss://');
  }
  fs.writeFileSync(
    path.join(out, 'config.js'),
    `// Сгенерировано scripts/copy-web.mjs\nexport default ${JSON.stringify({ defaultServer: u.toString() })};\n`
  );
  console.log('сервер по умолчанию:', u.toString());
}
console.log('renderer готов:', path.relative(process.cwd(), out));
