// Распознавание QR-кодов с камеры без зависимостей (ISO/IEC 18004), пара к shared/qr.js.
// Нужен там, где нет BarcodeDetector: приложение для Windows и Linux, Android (WebView), Firefox.
//
// Как работает: картинка → яркость → чёрно-белая (порог по окрестности) → поиск трёх
// «глазков» (1:1:3:1:1) → размер и версия → выравнивающий узор → перспективное
// преобразование → считывание модулей → формат (уровень коррекции и маска) → кодовые
// слова → исправление ошибок Рида–Соломона → текст. Версии 1–10, уровни L, M, Q, H.
//
//   scanQR({ data: RGBA, width, height }) → строка или null

const ALIGN = [[], [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];
// [кодовых слов коррекции в блоке, блоков группы 1, данных в блоке группы 1, блоков группы 2, данных в блоке группы 2]
// по биту уровня из формата: 0 — M, 1 — L, 2 — H, 3 — Q
const BLOCKS = {
  1: [null, [7, 1, 19], [10, 1, 34], [15, 1, 55], [20, 1, 80], [26, 1, 108], [18, 2, 68], [20, 2, 78], [24, 2, 97], [30, 2, 116], [18, 2, 68, 2, 69]],
  0: [null, [10, 1, 16], [16, 1, 28], [26, 1, 44], [18, 2, 32], [24, 2, 43], [16, 4, 27], [18, 4, 31], [22, 2, 38, 2, 39], [22, 3, 36, 2, 37], [26, 4, 43, 1, 44]],
  3: [null, [13, 1, 13], [22, 1, 22], [18, 2, 17], [26, 2, 24], [18, 2, 15, 2, 16], [24, 4, 19], [18, 2, 14, 4, 15], [22, 4, 18, 2, 19], [20, 4, 16, 4, 17], [24, 6, 19, 2, 20]],
  2: [null, [17, 1, 9], [28, 1, 16], [22, 2, 13], [16, 4, 9], [22, 2, 11, 2, 12], [28, 4, 15], [26, 4, 13, 1, 14], [26, 4, 14, 2, 15], [24, 4, 12, 4, 13], [28, 6, 15, 2, 16]],
};
export const TOTAL_CODEWORDS = [0, 26, 44, 70, 100, 134, 172, 196, 242, 292, 346];
export { BLOCKS as _BLOCKS };

// ---------- GF(256), x^8 + x^4 + x^3 + x^2 + 1 ----------
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
}
const mul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);
const div = (a, b) => (a ? EXP[(LOG[a] + 255 - LOG[b]) % 255] : 0);

/**
 * Исправить ошибки в блоке (данные + nsym слов коррекции, старший коэффициент первым).
 * Возвращает исправленный блок или null, если ошибок больше, чем можно исправить.
 */
function rsCorrect(block, nsym) {
  const n = block.length;
  // Синдромы S_i = r(α^i), i = 0..nsym-1 (корни порождающего многочлена — α^0…α^(nsym-1))
  const synd = new Array(nsym).fill(0);
  let bad = false;
  for (let i = 0; i < nsym; i++) {
    let s = 0;
    for (let j = 0; j < n; j++) s = mul(s, EXP[i]) ^ block[j];
    synd[i] = s;
    if (s) bad = true;
  }
  if (!bad) return block.slice();
  // Берлекэмп — Мэсси: многочлен локаторов ошибок (младший коэффициент первым)
  let C = [1];
  let B = [1];
  let L = 0;
  let m = 1;
  let b = 1;
  for (let k = 0; k < nsym; k++) {
    let d = synd[k];
    for (let i = 1; i <= L; i++) d ^= mul(C[i] || 0, synd[k - i]);
    if (d === 0) {
      m++;
      continue;
    }
    const coef = div(d, b);
    const T = C.slice();
    const need = B.length + m;
    while (C.length < need) C.push(0);
    for (let i = 0; i < B.length; i++) C[i + m] ^= mul(coef, B[i]);
    if (2 * L <= k) {
      L = k + 1 - L;
      B = T;
      b = d;
      m = 1;
    } else m++;
  }
  if (2 * L > nsym) return null;
  // Ченя: позиции ошибок. Позиция j (от начала) соответствует степени n-1-j, X = α^(n-1-j)
  const pos = [];
  for (let j = 0; j < n; j++) {
    const xinv = EXP[(255 - ((n - 1 - j) % 255)) % 255];
    let v = 0;
    for (let i = C.length - 1; i >= 0; i--) v = mul(v, xinv) ^ (C[i] || 0);
    if (v === 0) pos.push(j);
  }
  if (pos.length !== L) return null;
  // Форни: Ω(x) = S(x)·Λ(x) mod x^nsym
  const omega = new Array(nsym).fill(0);
  for (let i = 0; i < nsym; i++) for (let j = 0; j <= i && j < C.length; j++) omega[i] ^= mul(C[j] || 0, synd[i - j]);
  const out = block.slice();
  for (const j of pos) {
    const X = EXP[(n - 1 - j) % 255];
    const xinv = div(1, X);
    let num = 0;
    for (let i = omega.length - 1; i >= 0; i--) num = mul(num, xinv) ^ omega[i];
    // Λ'(x): только нечётные степени
    let den = 0;
    for (let i = 1; i < C.length; i += 2) den ^= mul(C[i] || 0, EXP[(LOG[xinv] * (i - 1)) % 255]);
    if (!den) return null;
    // Корни с α^0: e = X · Ω(X⁻¹) / Λ'(X⁻¹)
    out[j] ^= mul(X, div(num, den));
  }
  return out;
}

// ---------- Чёрно-белое изображение ----------
function binarize({ data, width: w, height: h }) {
  const gray = new Uint8Array(w * h);
  for (let i = 0, p = 0; i < gray.length; i++, p += 4) gray[i] = (data[p] * 77 + data[p + 1] * 150 + data[p + 2] * 29) >> 8;
  // Порог по среднему в окрестности (Брэдли): тени и блики на экране телефона не мешают
  const integral = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += gray[y * w + x];
      integral[(y + 1) * (w + 1) + x + 1] = integral[y * (w + 1) + x + 1] + row;
    }
  }
  const r = Math.max(4, Math.floor(Math.min(w, h) / 16));
  const bits = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r);
    const y1 = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r);
      const x1 = Math.min(w, x + r + 1);
      const sum = integral[y1 * (w + 1) + x1] - integral[y0 * (w + 1) + x1] - integral[y1 * (w + 1) + x0] + integral[y0 * (w + 1) + x0];
      const mean = sum / ((x1 - x0) * (y1 - y0));
      bits[y * w + x] = gray[y * w + x] < mean * 0.88 ? 1 : 0; // 1 — тёмный
    }
  }
  return { bits, w, h };
}

// ---------- Поиск «глазков» ----------
function ratioOk(c) {
  const total = c[0] + c[1] + c[2] + c[3] + c[4];
  if (total < 7) return false;
  const m = total / 7;
  const v = m * 0.6;
  return Math.abs(m - c[0]) < v && Math.abs(m - c[1]) < v && Math.abs(3 * m - c[2]) < 3 * v && Math.abs(m - c[3]) < v && Math.abs(m - c[4]) < v;
}

// Пересечь узор по вертикали (dx=0, dy=1) или горизонтали через (x, y). Возвращает {c, total} или null
function crossCheck(img, x, y, dx, dy, maxRun) {
  const at = (px, py) => (px < 0 || py < 0 || px >= img.w || py >= img.h ? -1 : img.bits[py * img.w + px]);
  const c = [0, 0, 0, 0, 0];
  let px = x;
  let py = y;
  if (at(px, py) !== 1) return null;
  // назад от центра
  while (at(px, py) === 1) (c[2]++, (px -= dx), (py -= dy));
  while (at(px, py) === 0 && c[1] <= maxRun) (c[1]++, (px -= dx), (py -= dy));
  if (at(px, py) !== 1) return null;
  while (at(px, py) === 1 && c[0] <= maxRun) (c[0]++, (px -= dx), (py -= dy));
  if (c[0] > maxRun) return null;
  // вперёд
  px = x + dx;
  py = y + dy;
  while (at(px, py) === 1) (c[2]++, (px += dx), (py += dy));
  const endCenter = dx ? px : py;
  while (at(px, py) === 0 && c[3] <= maxRun) (c[3]++, (px += dx), (py += dy));
  if (at(px, py) !== 1) return null;
  while (at(px, py) === 1 && c[4] <= maxRun) (c[4]++, (px += dx), (py += dy));
  if (c[4] > maxRun || !ratioOk(c)) return null;
  const center = endCenter - c[2] / 2;
  return { center, total: c.reduce((a, b) => a + b, 0) };
}

function findFinders(img) {
  const found = [];
  const step = img.h > 600 ? 2 : 1;
  for (let y = 0; y < img.h; y += step) {
    // серии одного цвета в строке
    const runs = [];
    let color = img.bits[y * img.w];
    let start = 0;
    for (let x = 1; x <= img.w; x++) {
      const v = x < img.w ? img.bits[y * img.w + x] : -1;
      if (v !== color) {
        runs.push([color, start, x - start]);
        color = v;
        start = x;
      }
    }
    for (let i = 0; i + 4 < runs.length; i++) {
      if (runs[i][0] !== 1) continue;
      const c = [runs[i][2], runs[i + 1][2], runs[i + 2][2], runs[i + 3][2], runs[i + 4][2]];
      if (!ratioOk(c)) continue;
      const total = c.reduce((a, b) => a + b, 0);
      const cx = Math.round(runs[i + 2][1] + runs[i + 2][2] / 2);
      const v = crossCheck(img, cx, y, 0, 1, c[2] * 2);
      if (!v || Math.abs(v.total - total) > total * 0.5) continue;
      const cy = Math.round(v.center);
      const hz = crossCheck(img, cx, cy, 1, 0, c[2] * 2);
      if (!hz || Math.abs(hz.total - total) > total * 0.5) continue;
      const fx = hz.center;
      const ms = (hz.total + v.total) / 14;
      const near = found.find((f) => Math.hypot(f.x - fx, f.y - cy) < f.ms * 2.5 && Math.abs(f.ms - ms) < Math.max(f.ms, ms) * 0.5);
      if (near) {
        near.x = (near.x * near.n + fx) / (near.n + 1);
        near.y = (near.y * near.n + cy) / (near.n + 1);
        near.ms = (near.ms * near.n + ms) / (near.n + 1);
        near.n++;
      } else found.push({ x: fx, y: cy, ms, n: 1 });
    }
  }
  return found;
}

/** Тройки «глазков», похожие на углы квадрата, лучшие первыми: [tl, tr, bl] */
function finderTriples(found) {
  let list = found.slice().sort((a, b) => b.n - a.n);
  if (list.filter((f) => f.n >= 2).length >= 3) list = list.filter((f) => f.n >= 2);
  list = list.slice(0, 12);
  const out = [];
  const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  for (let i = 0; i < list.length; i++)
    for (let j = i + 1; j < list.length; j++)
      for (let k = j + 1; k < list.length; k++) {
        const p = [list[i], list[j], list[k]];
        const ms = p.map((f) => f.ms);
        if (Math.max(...ms) / Math.min(...ms) > 1.8) continue;
        // вершина прямого угла — напротив самой длинной стороны
        const sides = [
          [d(p[1], p[2]), 0],
          [d(p[0], p[2]), 1],
          [d(p[0], p[1]), 2],
        ].sort((a, b) => a[0] - b[0]);
        const [a, b, c] = sides.map((s) => s[0]);
        if (a < Math.min(...ms) * 8) continue; // слишком близко для двух углов кода
        const score = Math.abs(c * c - a * a - b * b) / (c * c) + Math.abs(a - b) / b;
        if (score > 0.6) continue;
        const tl = p[sides[2][1]];
        let [tr, bl] = p.filter((f) => f !== tl);
        // ось y вниз: от «верх-право» к «низ-лево» поворот по часовой стрелке
        if ((tr.x - tl.x) * (bl.y - tl.y) - (tr.y - tl.y) * (bl.x - tl.x) < 0) [tr, bl] = [bl, tr];
        out.push({ score, tl, tr, bl });
      }
  return out.sort((a, b) => a.score - b.score).slice(0, 4);
}

// ---------- Перспектива: модули (u, v) → пиксели (x, y) ----------
function homography(src, dst) {
  // 8 уравнений, 8 неизвестных
  const A = [];
  for (let i = 0; i < 4; i++) {
    const [u, v] = src[i];
    const [x, y] = dst[i];
    A.push([u, v, 1, 0, 0, 0, -u * x, -v * x, x]);
    A.push([0, 0, 0, u, v, 1, -u * y, -v * y, y]);
  }
  for (let c = 0; c < 8; c++) {
    let p = c;
    for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    if (Math.abs(A[p][c]) < 1e-12) return null;
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

function dark(img, x, y) {
  const px = Math.round(x);
  const py = Math.round(y);
  if (px < 0 || py < 0 || px >= img.w || py >= img.h) return false;
  return img.bits[py * img.w + px] === 1;
}

// Выравнивающий узор (5×5: тёмная рамка, светлое кольцо, тёмный центр) около оценки (ex, ey)
function findAlignment(img, ex, ey, ms) {
  let best = null;
  const r = ms * 5;
  const step = Math.max(1, ms / 3);
  const ring = (cx, cy, rad, want) => {
    let ok = 0;
    for (let k = 0; k < 8; k++) {
      const a = (k * Math.PI) / 4;
      const rr = k % 2 ? rad * Math.SQRT2 : rad;
      if (dark(img, cx + Math.cos(a) * rr, cy + Math.sin(a) * rr) === want) ok++;
    }
    return ok;
  };
  for (let dy = -r; dy <= r; dy += step)
    for (let dx = -r; dx <= r; dx += step) {
      const x = ex + dx;
      const y = ey + dy;
      if (!dark(img, x, y)) continue;
      const score = ring(x, y, ms, false) + ring(x, y, ms * 2, true) - Math.hypot(dx, dy) / (r * 4);
      if (!best || score > best.score) best = { x, y, score };
    }
  return best && best.score >= 13 ? best : null;
}

// ---------- Матрица модулей → текст ----------
const MASKS = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

function formatWord(ec, mask) {
  const fdata = (ec << 3) | mask;
  let rem = fdata;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((fdata << 10) | rem) ^ 0x5412;
}
const FORMATS = [];
for (let ec = 0; ec < 4; ec++) for (let mask = 0; mask < 8; mask++) FORMATS.push({ ec, mask, word: formatWord(ec, mask) });
const popcount = (v) => {
  let n = 0;
  for (; v; v &= v - 1) n++;
  return n;
};

/** Функциональные модули (не данные) — так же, как их расставляет shared/qr.js */
function functionMap(version) {
  const size = version * 4 + 17;
  const fn = Array.from({ length: size }, () => new Array(size).fill(false));
  for (let i = 0; i < size; i++) fn[6][i] = fn[i][6] = true;
  for (const [cx, cy] of [
    [3, 3],
    [size - 4, 3],
    [3, size - 4],
  ])
    for (let dy = -4; dy <= 4; dy++)
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (x >= 0 && y >= 0 && x < size && y < size) fn[y][x] = true;
      }
  const pos = ALIGN[version];
  for (let i = 0; i < pos.length; i++)
    for (let j = 0; j < pos.length; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === pos.length - 1) || (i === pos.length - 1 && j === 0)) continue;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) fn[pos[j] + dy][pos[i] + dx] = true;
    }
  for (let i = 0; i <= 8; i++) fn[i][8] = fn[8][i] = true;
  for (let i = 0; i < 8; i++) fn[8][size - 1 - i] = fn[size - 1 - i][8] = true;
  if (version >= 7)
    for (let i = 0; i < 18; i++) {
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      fn[b][a] = fn[a][b] = true;
    }
  return fn;
}

/** m[y][x] — true для тёмного модуля. Возвращает текст или null. */
export function decodeMatrix(m) {
  const size = m.length;
  const version = (size - 17) / 4;
  if (!Number.isInteger(version) || version < 1 || version > 10) return null;
  // Формат: обе копии, ближайшее допустимое слово (до 3 ошибок)
  let f1 = 0;
  let f2 = 0;
  const bit = (x, y) => (m[y][x] ? 1 : 0);
  for (let i = 0; i <= 5; i++) f1 |= bit(8, i) << i;
  f1 |= bit(8, 7) << 6;
  f1 |= bit(8, 8) << 7;
  f1 |= bit(7, 8) << 8;
  for (let i = 9; i < 15; i++) f1 |= bit(14 - i, 8) << i;
  for (let i = 0; i < 8; i++) f2 |= bit(size - 1 - i, 8) << i;
  for (let i = 8; i < 15; i++) f2 |= bit(8, size - 15 + i) << i;
  let fmt = null;
  let bestD = 99;
  for (const f of FORMATS) {
    const dd = Math.min(popcount(f.word ^ f1), popcount(f.word ^ f2));
    if (dd < bestD) (bestD = dd), (fmt = f);
  }
  if (bestD > 3) return null;
  const table = BLOCKS[fmt.ec][version];
  const fn = functionMap(version);
  const maskFn = MASKS[fmt.mask];
  // Биты данных зигзагом снизу справа
  const total = TOTAL_CODEWORDS[version];
  const codewords = new Array(total).fill(0);
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++)
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (fn[y][x]) continue;
        if (i < total * 8) {
          const b = m[y][x] !== maskFn(x, y);
          if (b) codewords[i >>> 3] |= 1 << (7 - (i & 7));
        }
        i++;
      }
  }
  // Блоки: данные и коррекция перемежаются
  const [ecLen, n1, k1, n2 = 0, k2 = 0] = table;
  const blocks = [];
  for (let b = 0; b < n1; b++) blocks.push({ k: k1, d: [] });
  for (let b = 0; b < n2; b++) blocks.push({ k: k2, d: [] });
  let p = 0;
  const maxK = Math.max(k1, k2);
  for (let r = 0; r < maxK; r++) for (const b of blocks) if (r < b.k) b.d.push(codewords[p++]);
  for (let r = 0; r < ecLen; r++) for (const b of blocks) b.d.push(codewords[p++]);
  const data = [];
  for (const b of blocks) {
    const fixed = rsCorrect(b.d, ecLen);
    if (!fixed) return null;
    data.push(...fixed.slice(0, b.k));
  }
  return parseData(data, version);
}

function parseData(bytes, version) {
  let pos = 0;
  const read = (n) => {
    let v = 0;
    for (let k = 0; k < n; k++, pos++) {
      if (pos >= bytes.length * 8) throw new Error('eof');
      v = (v << 1) | ((bytes[pos >>> 3] >>> (7 - (pos & 7))) & 1);
    }
    return v;
  };
  const ALNUM = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';
  const out = [];
  let text = '';
  const flush = () => {
    if (out.length) text += new TextDecoder().decode(new Uint8Array(out.splice(0)));
  };
  try {
    while (pos + 4 <= bytes.length * 8) {
      const mode = read(4);
      if (mode === 0) break;
      if (mode === 4) {
        for (let n = read(version <= 9 ? 8 : 16); n > 0; n--) out.push(read(8));
      } else if (mode === 2) {
        flush();
        let n = read(version <= 9 ? 9 : 11);
        for (; n >= 2; n -= 2) {
          const v = read(11);
          text += ALNUM[Math.floor(v / 45)] + ALNUM[v % 45];
        }
        if (n) text += ALNUM[read(6)];
      } else if (mode === 1) {
        flush();
        let n = read(version <= 9 ? 10 : 12);
        for (; n >= 3; n -= 3) text += String(read(10)).padStart(3, '0');
        if (n === 2) text += String(read(7)).padStart(2, '0');
        else if (n === 1) text += String(read(4));
      } else if (mode === 7) {
        // ECI: номер кодировки игнорируем — читаем как UTF-8
        const first = read(8);
        if ((first & 0xc0) === 0x80) read(8);
        else if ((first & 0xe0) === 0xc0) read(16);
      } else return null; // кандзи, структурированное добавление — не нужны
    }
  } catch {
    return null;
  }
  flush();
  return text;
}

// ---------- Целиком ----------
function sampleGrid(img, tri, version, fourth) {
  const size = version * 4 + 17;
  const { tl, tr, bl } = tri;
  const map = homography(
    [[3.5, 3.5], [size - 3.5, 3.5], [3.5, size - 3.5], fourth.uv],
    [[tl.x, tl.y], [tr.x, tr.y], [bl.x, bl.y], fourth.xy]
  );
  if (!map) return null;
  const m = [];
  for (let y = 0; y < size; y++) {
    const row = [];
    for (let x = 0; x < size; x++) {
      const [px, py] = map(x + 0.5, y + 0.5);
      row.push(dark(img, px, py));
    }
    m.push(row);
  }
  return m;
}

function tryDecode(m) {
  if (!m) return null;
  const text = decodeMatrix(m);
  if (text != null) return text;
  // Код снят в зеркальном отражении (фронтальная камера) — транспонированная матрица
  return decodeMatrix(m.map((row, y) => row.map((_, x) => m[x][y])));
}

function decodeTriple(img, tri, version, deadline) {
  const size = version * 4 + 17;
  const { tl, tr, bl } = tri;
  const ms = (tl.ms + tr.ms + bl.ms) / 3;
  // Четвёртая точка: выравнивающий узор (v ≥ 2) или угол, достроенный до параллелограмма.
  // При сильной перспективе оценка неточна — тогда перебираем точки вокруг неё.
  const a = version >= 2 ? size - 6.5 : size - 3.5;
  const k = (a - 3.5) / (size - 7);
  const ex = tl.x + (tr.x - tl.x) * k + (bl.x - tl.x) * k;
  const ey = tl.y + (tr.y - tl.y) * k + (bl.y - tl.y) * k;
  if (version >= 2) {
    const al = findAlignment(img, ex, ey, ms);
    if (al) {
      const text = tryDecode(sampleGrid(img, tri, version, { uv: [a, a], xy: [al.x, al.y] }));
      if (text != null) return text;
    }
  }
  // Направления «вправо» и «вниз» по коду в пикселях на модуль
  const ux = (tr.x - tl.x) / (size - 7);
  const uy = (tr.y - tl.y) / (size - 7);
  const vx = (bl.x - tl.x) / (size - 7);
  const vy = (bl.y - tl.y) / (size - 7);
  const R = version >= 2 ? 3 : 4;
  const pts = [];
  for (let i = -R; i <= R; i += 0.5) for (let j = -R; j <= R; j += 0.5) pts.push([i, j]);
  pts.sort((p, q) => p[0] * p[0] + p[1] * p[1] - q[0] * q[0] - q[1] * q[1]);
  for (const [i, j] of pts) {
    if (Date.now() > deadline) return null;
    const text = tryDecode(sampleGrid(img, tri, version, { uv: [a, a], xy: [ex + i * ux + j * vx, ey + i * uy + j * vy] }));
    if (text != null) return text;
  }
  return null;
}

/**
 * Размер модуля вдоль направления from → to: ширина «глазка» (1:1:3:1:1) по этой линии / 7.
 * По горизонтали и вертикали повёрнутый код кажется шире — поэтому меряем вдоль линии к соседу.
 */
function moduleAlong(img, from, to) {
  const len = Math.hypot(to.x - from.x, to.y - from.y);
  const dx = (to.x - from.x) / len;
  const dy = (to.y - from.y) / len;
  const run = (sign) => {
    // от центра: тёмное, светлое, тёмное — до выхода на светлое
    let state = 0;
    let t = 0;
    const lim = from.ms * 8;
    for (; t < lim; t += 0.5) {
      const d = dark(img, from.x + dx * t * sign, from.y + dy * t * sign);
      if (state === 0 && !d) state = 1;
      else if (state === 1 && d) state = 2;
      else if (state === 2 && !d) return t;
    }
    return null;
  };
  const a = run(1);
  const b = run(-1);
  return a && b ? (a + b) / 7 : from.ms;
}

function decodeImage(img, deadline) {
  const finders = findFinders(img);
  for (const tri of finderTriples(finders)) {
    if (Date.now() > deadline) return null;
    const msTR = (moduleAlong(img, tri.tl, tri.tr) + moduleAlong(img, tri.tr, tri.tl)) / 2;
    const msBL = (moduleAlong(img, tri.tl, tri.bl) + moduleAlong(img, tri.bl, tri.tl)) / 2;
    const d1 = Math.hypot(tri.tr.x - tri.tl.x, tri.tr.y - tri.tl.y) / msTR;
    const d2 = Math.hypot(tri.bl.x - tri.tl.x, tri.bl.y - tri.tl.y) / msBL;
    const v0 = Math.round(((d1 + d2) / 2 + 7 - 17) / 4);
    for (const v of [v0, v0 - 1, v0 + 1, v0 - 2, v0 + 2]) {
      if (v < 1 || v > 10) continue;
      const text = decodeTriple(img, tri, v, deadline);
      if (text != null) return text;
    }
  }
  return null;
}

/**
 * Найти и прочитать QR-код на картинке. imageData: { data (RGBA), width, height }.
 * budgetMs — сколько времени тратить на один кадр (с камеры придёт следующий).
 */
export function scanQR(imageData, { budgetMs = 400 } = {}) {
  const deadline = Date.now() + budgetMs;
  const img = binarize(imageData);
  const text = decodeImage(img, deadline);
  if (text != null) return text;
  // Светлый код на тёмном фоне
  for (let i = 0; i < img.bits.length; i++) img.bits[i] ^= 1;
  return decodeImage(img, deadline);
}

