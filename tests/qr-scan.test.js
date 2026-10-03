// Распознавание QR-кодов (shared/qr-scan.js): матрица, исправление ошибок, «снимок» кода
// под углом и в перспективе — то, что видит камера.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { qrEncode } from '../shared/qr.js';
import { scanQR, decodeMatrix, _BLOCKS, TOTAL_CODEWORDS } from '../shared/qr-scan.js';

// Детерминированный «случай», чтобы тест не мигал
let seed = 42;
const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

function homography(src, dst) {
  const A = [];
  for (let i = 0; i < 4; i++) {
    const [u, v] = src[i];
    const [x, y] = dst[i];
    A.push([u, v, 1, 0, 0, 0, -u * x, -v * x, x], [0, 0, 0, u, v, 1, -u * y, -v * y, y]);
  }
  for (let c = 0; c < 8; c++) {
    let p = c;
    for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]];
    for (let r = 0; r < 8; r++) {
      if (r === c) continue;
      const f = A[r][c] / A[c][c];
      for (let k = c; k < 9; k++) A[r][k] -= f * A[c][k];
    }
  }
  const h = A.map((row, i) => row[8] / row[i]);
  return (u, v) => {
    const z = h[6] * u + h[7] * v + 1;
    return [(h[0] * u + h[1] * v + h[2]) / z, (h[3] * u + h[4] * v + h[5]) / z];
  };
}

/** Кадр W×H, на котором код занимает четырёхугольник quad (с тихой зоной). */
function photo(m, quad, { W = 640, H = 480, noise = 20 } = {}) {
  const n = m.length + 8;
  const inv = homography(quad, [[0, 0], [n, 0], [n, n], [0, n]]);
  const data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      let acc = 0;
      for (const [a, b] of [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]) {
        const [u, v] = inv(x + a, y + b);
        if (u >= 0 && v >= 0 && u < n && v < n) {
          const mx = Math.floor(u) - 4;
          const my = Math.floor(v) - 4;
          acc += mx >= 0 && my >= 0 && mx < m.length && my < m.length && m[my][mx] ? 35 : 225;
        } else acc += 110 + 50 * Math.sin(x / 17) * Math.cos(y / 23);
      }
      const val = acc / 4 + (rand() - 0.5) * noise + 40 * (x / W) - 20; // неровное освещение
      const p = (y * W + x) * 4;
      data[p] = data[p + 1] = data[p + 2] = val;
      data[p + 3] = 255;
    }
  return { data, width: W, height: H };
}

test('qr: таблица блоков сходится с числом кодовых слов', () => {
  for (const ec of [0, 1, 2, 3])
    for (let v = 1; v <= 10; v++) {
      const [e, n1, k1, n2 = 0, k2 = 0] = _BLOCKS[ec][v];
      assert.equal(n1 * (k1 + e) + n2 * (k2 + e), TOTAL_CODEWORDS[v], `уровень ${ec}, версия ${v}`);
    }
});

test('qr: матрица читается обратно, ошибки исправляются', () => {
  for (const s of ['a', 'TAINIK1:' + 'ABCDEFGHJKMNPQRSTVWXYZ0123456789'.repeat(2), 'Привет, мир 👋', 'x'.repeat(200)]) {
    const m = qrEncode(s);
    assert.equal(decodeMatrix(m), s);
    // Испортить несколько модулей в области данных
    const broken = m.map((row) => row.slice());
    for (let k = 0; k < 6; k++) {
      const x = m.length - 1 - k;
      broken[m.length - 1 - (k % 3)][x] = !broken[m.length - 1 - (k % 3)][x];
    }
    assert.equal(decodeMatrix(broken), s, 'испорченные модули исправлены');
  }
  // Слишком много ошибок — честный отказ, а не мусор
  const m = qrEncode('TAINIK1:XYZ');
  const ruined = m.map((row, y) => row.map((v, x) => (x > 12 && y > 12 ? !v : v)));
  assert.equal(decodeMatrix(ruined), null);
});

test('qr: снимок под углом и в перспективе, светлый на тёмном, зеркальный', () => {
  const code = 'TAINIK1:' + 'ABCDEFGHJKMNPQRSTVWXYZ0123456789'.repeat(2); // как код привязки: версия 5
  const m = qrEncode(code);
  let ok = 0;
  const N = 12;
  for (let k = 0; k < N; k++) {
    const size = 240 + rand() * 160;
    const ang = (rand() * 2 - 1) * Math.PI;
    const j = size * 0.1 * rand();
    const quad = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => {
      const x = (a * size) / 2 + (rand() * 2 - 1) * j;
      const y = (b * size) / 2 + (rand() * 2 - 1) * j;
      return [320 + x * Math.cos(ang) - y * Math.sin(ang), 240 + x * Math.sin(ang) + y * Math.cos(ang)];
    });
    if (scanQR(photo(m, quad), { budgetMs: 3000 }) === code) ok++;
  }
  assert.ok(ok >= N - 1, `распознано ${ok} из ${N}`);
  const straight = [[170, 90], [470, 90], [470, 390], [170, 390]];
  // Светлый код на тёмном фоне
  const inv = photo(m, straight);
  for (let i = 0; i < inv.data.length; i += 4) inv.data[i] = inv.data[i + 1] = inv.data[i + 2] = 255 - inv.data[i];
  assert.equal(scanQR(inv), code);
  // Зеркало
  assert.equal(scanQR(photo(m.map((row) => row.slice().reverse()), straight)), code);
  // Нет кода — нет ответа
  assert.equal(scanQR(photo([[false]], [[0, 0], [1, 0], [1, 1], [0, 1]])), null);
});
