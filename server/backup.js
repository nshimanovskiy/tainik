// Резервная копия базы «на ходу»: node server/backup.js /data/backup.db
// Использует VACUUM INTO — согласованный снимок без остановки сервера.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const dataDir = process.env.DATA_DIR || path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'data');
const target = process.argv[2];
if (!target) {
  console.error('Использование: node server/backup.js <файл-копии.db>');
  process.exit(2);
}
if (fs.existsSync(target)) fs.rmSync(target);
const db = new DatabaseSync(path.join(dataDir, 'tainik.db'));
db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
db.close();
console.log('копия готова:', target, fs.statSync(target).size, 'байт');
