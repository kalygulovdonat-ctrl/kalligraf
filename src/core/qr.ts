import type { Path, Pt } from './geometry';

// Кодировщик QR-кода по стандарту ISO/IEC 18004 (байтовый режим, UTF-8, версии 1–40,
// уровни коррекции L/M/Q/H, Рид–Соломон, выбор лучшей маски). Без внешних библиотек.

export type Ecc = 'L' | 'M' | 'Q' | 'H';
const ECC_ORDER: Ecc[] = ['L', 'M', 'Q', 'H'];
const ECC_FORMAT: Record<Ecc, number> = { L: 1, M: 0, Q: 3, H: 2 };

// Таблицы стандарта: кодовых слов коррекции на блок и число блоков (индекс — версия)
const ECC_PER_BLOCK: Record<Ecc, number[]> = {
  L: [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  M: [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  Q: [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  H: [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
};
const NUM_BLOCKS: Record<Ecc, number[]> = {
  L: [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  M: [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  Q: [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  H: [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
};

/** Число модулей для данных (без служебных узоров) в версии. */
function rawDataModules(ver: number): number {
  let r = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const n = Math.floor(ver / 7) + 2;
    r -= (25 * n - 10) * n - 55;
    if (ver >= 7) r -= 36;
  }
  return r;
}
const dataCodewords = (ver: number, ecc: Ecc) => Math.floor(rawDataModules(ver) / 8) - ECC_PER_BLOCK[ecc][ver] * NUM_BLOCKS[ecc][ver];

// ── Рид–Соломон в GF(256), многочлен 0x11D ─────────────────────────────
function gfMul(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) { z = (z << 1) ^ ((z >>> 7) * 0x11d); z ^= ((y >>> i) & 1) * x; }
  return z & 0xff;
}
function rsDivisor(deg: number): number[] {
  const r = new Array(deg).fill(0);
  r[deg - 1] = 1;
  let root = 1;
  for (let i = 0; i < deg; i++) {
    for (let j = 0; j < r.length; j++) { r[j] = gfMul(r[j], root); if (j + 1 < r.length) r[j] ^= r[j + 1]; }
    root = gfMul(root, 2);
  }
  return r;
}
export function rsRemainder(data: number[], div: number[]): number[] {
  const r = new Array(div.length).fill(0);
  for (const b of data) {
    const f = b ^ (r.shift() as number);
    r.push(0);
    div.forEach((c, i) => { r[i] ^= gfMul(c, f); });
  }
  return r;
}

export interface QrCode { version: number; size: number; ecc: Ecc; mask: number; modules: boolean[][] }

export function utf8Bytes(s: string): number[] {
  return Array.from(new TextEncoder().encode(s));
}

/**
 * Кодирует текст. minEcc — минимальный уровень коррекции; если влезает, уровень повышается
 * (как в хороших генераторах), чтобы код был надёжнее при той же версии.
 */
export function encodeQr(text: string, minEcc: Ecc = 'M', boostEcc = true): QrCode {
  const data = utf8Bytes(text);
  let ver = 1, ecc = minEcc;
  const bitsNeeded = (v: number) => 4 + (v <= 9 ? 8 : 16) + data.length * 8;
  for (; ; ver++) {
    if (ver > 40) throw new Error('Текст слишком длинный для QR-кода (максимум ~2900 байт).');
    if (bitsNeeded(ver) <= dataCodewords(ver, ecc) * 8) break;
  }
  if (boostEcc) for (const e of ECC_ORDER.slice(ECC_ORDER.indexOf(ecc) + 1)) if (bitsNeeded(ver) <= dataCodewords(ver, e) * 8) ecc = e;

  // Битовый поток: режим «байты» (0100), длина, данные, терминатор, выравнивание, заполнители
  const bits: number[] = [];
  const put = (val: number, len: number) => { for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
  put(4, 4);
  put(data.length, ver <= 9 ? 8 : 16);
  data.forEach((b) => put(b, 8));
  const cap = dataCodewords(ver, ecc) * 8;
  put(0, Math.min(4, cap - bits.length));
  put(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < cap; pad ^= 0xec ^ 0x11) put(pad, 8);
  const cw: number[] = [];
  for (let i = 0; i < bits.length; i += 8) cw.push(parseInt(bits.slice(i, i + 8).join(''), 2));

  // Блоки и коды коррекции, затем чередование
  const nb = NUM_BLOCKS[ecc][ver], eLen = ECC_PER_BLOCK[ecc][ver];
  const raw = Math.floor(rawDataModules(ver) / 8);
  const shortBlocks = nb - (raw % nb), shortLen = Math.floor(raw / nb);
  const div = rsDivisor(eLen);
  const blocks: number[][] = [];
  for (let i = 0, k = 0; i < nb; i++) {
    const dat = cw.slice(k, k + shortLen - eLen + (i < shortBlocks ? 0 : 1));
    k += dat.length;
    const e = rsRemainder(dat, div);
    if (i < shortBlocks) dat.push(0); // заглушка для выравнивания длины
    blocks.push(dat.concat(e));
  }
  const all: number[] = [];
  for (let i = 0; i < blocks[0].length; i++) blocks.forEach((b, j) => { if (i !== shortLen - eLen || j >= shortBlocks) all.push(b[i]); });

  const size = ver * 4 + 17;
  const mods: boolean[][] = Array.from({ length: size }, () => new Array(size).fill(false));
  const fn: boolean[][] = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (x: number, y: number, v: boolean) => { mods[y][x] = v; fn[y][x] = true; };

  // Служебные узоры
  for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  const finder = (cx: number, cy: number) => {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const d = Math.max(Math.abs(dx), Math.abs(dy)), x = cx + dx, y = cy + dy;
      if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, d !== 2 && d !== 4);
    }
  };
  finder(3, 3); finder(size - 4, 3); finder(3, size - 4);
  const align = alignmentPositions(ver);
  align.forEach((ay, i) => align.forEach((ax, j) => {
    if ((i === 0 && j === 0) || (i === 0 && j === align.length - 1) || (i === align.length - 1 && j === 0)) return;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }));
  drawFormat(mods, fn, size, ecc, 0, true);
  if (ver >= 7) {
    let rem = ver;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const b = (ver << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const bit = ((b >>> i) & 1) === 1, a = size - 11 + (i % 3), c = Math.floor(i / 3);
      set(a, c, bit); set(c, a, bit);
    }
  }

  // Данные зигзагом
  let bi = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) for (let j = 0; j < 2; j++) {
      const x = right - j, upward = ((right + 1) & 2) === 0, y = upward ? size - 1 - vert : vert;
      if (!fn[y][x] && bi < all.length * 8) { mods[y][x] = ((all[bi >>> 3] >>> (7 - (bi & 7))) & 1) === 1; bi++; }
    }
  }

  // Лучшая маска (минимальный штраф)
  let best = 0, bestPen = Infinity;
  for (let m = 0; m < 8; m++) {
    applyMask(mods, fn, size, m);
    drawFormat(mods, fn, size, ecc, m, false);
    const p = penalty(mods, size);
    if (p < bestPen) { bestPen = p; best = m; }
    applyMask(mods, fn, size, m); // снять (XOR)
  }
  applyMask(mods, fn, size, best);
  drawFormat(mods, fn, size, ecc, best, false);
  return { version: ver, size, ecc, mask: best, modules: mods };
}

export function alignmentPositions(ver: number): number[] {
  if (ver === 1) return [];
  const n = Math.floor(ver / 7) + 2;
  const step = ver === 32 ? 26 : Math.ceil((ver * 4 + 4) / (n * 2 - 2)) * 2;
  const r = [6];
  for (let pos = ver * 4 + 17 - 7; r.length < n; pos -= step) r.splice(1, 0, pos);
  return r;
}

export function formatBits(ecc: Ecc, mask: number): number {
  const data = (ECC_FORMAT[ecc] << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}

function drawFormat(m: boolean[][], fn: boolean[][], size: number, ecc: Ecc, mask: number, mark: boolean) {
  const bits = formatBits(ecc, mask);
  const set = (x: number, y: number, v: boolean) => { m[y][x] = v; if (mark) fn[y][x] = true; };
  const b = (i: number) => ((bits >>> i) & 1) === 1;
  for (let i = 0; i <= 5; i++) set(8, i, b(i));
  set(8, 7, b(6)); set(8, 8, b(7)); set(7, 8, b(8));
  for (let i = 9; i < 15; i++) set(14 - i, 8, b(i));
  for (let i = 0; i < 8; i++) set(size - 1 - i, 8, b(i));
  for (let i = 8; i < 15; i++) set(8, size - 15 + i, b(i));
  set(8, size - 8, true); // тёмный модуль
}

function maskFn(m: number, x: number, y: number): boolean {
  switch (m) {
    case 0: return (x + y) % 2 === 0;
    case 1: return y % 2 === 0;
    case 2: return x % 3 === 0;
    case 3: return (x + y) % 3 === 0;
    case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
    case 5: return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    default: return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
  }
}
function applyMask(m: boolean[][], fn: boolean[][], size: number, mask: number) {
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!fn[y][x] && maskFn(mask, x, y)) m[y][x] = !m[y][x];
}

function penalty(m: boolean[][], size: number): number {
  let p = 0;
  const line = (get: (i: number) => boolean) => {
    let run = 1;
    for (let i = 1; i <= size; i++) {
      if (i < size && get(i) === get(i - 1)) run++;
      else { if (run >= 5) p += 3 + (run - 5); run = 1; }
    }
    // узор 1:1:3:1:1 с белой полосой
    const s = Array.from({ length: size }, (_, i) => get(i));
    for (let i = 0; i + 10 < size + 1; i++) {
      const pat = [true, false, true, true, true, false, true];
      const ok = (o: number) => pat.every((v, k) => s[o + k] === v);
      if (i + 6 < size && ok(i)) {
        const before = i >= 4 && [0, 1, 2, 3].every((k) => !s[i - 1 - k]);
        const after = i + 10 < size && [0, 1, 2, 3].every((k) => !s[i + 7 + k]);
        if (before || after) p += 40;
      }
    }
  };
  for (let y = 0; y < size; y++) line((i) => m[y][i]);
  for (let x = 0; x < size; x++) line((i) => m[i][x]);
  for (let y = 0; y < size - 1; y++) for (let x = 0; x < size - 1; x++) {
    const c = m[y][x];
    if (c === m[y][x + 1] && c === m[y + 1][x] && c === m[y + 1][x + 1]) p += 3;
  }
  let dark = 0;
  for (const row of m) for (const v of row) if (v) dark++;
  const total = size * size;
  p += Math.floor(Math.abs(dark * 20 - total * 10) / total) * 10;
  return p;
}

// ── Рисование ручкой ─────────────────────────────────────────────────

export interface QrDrawOpts { module: number; pen: number; border: number; direction: 'h' | 'v' }

/**
 * Тёмные модули закрашиваются параллельными штрихами с шагом ≈ толщине линии ручки.
 * Соседние тёмные модули в ряду — один длинный штрих (меньше подъёмов ручки).
 */
export function qrPaths(qr: QrCode, o: QrDrawOpts): Path[] {
  const m = o.module, pen = Math.max(0.1, Math.min(o.pen, m));
  // штрихи с перекрытием ~10%, чтобы клетка была залита без просветов
  const passes = Math.max(1, Math.ceil(m / (pen * 0.9)));
  const out: Path[] = [];
  const off = o.border * m;
  const dark = (r: number, c: number) => (o.direction === 'h' ? qr.modules[r][c] : qr.modules[c][r]);
  let flip = false;
  for (let r = 0; r < qr.size; r++) {
    for (let k = 0; k < passes; k++) {
      const t = passes === 1 ? m / 2 : pen / 2 + ((m - pen) * k) / (passes - 1);
      const runs: [number, number][] = [];
      let start = -1;
      for (let c = 0; c <= qr.size; c++) {
        const d = c < qr.size && dark(r, c);
        if (d && start < 0) start = c;
        if (!d && start >= 0) { runs.push([start, c]); start = -1; }
      }
      if (flip) runs.reverse();
      for (const [a, b] of runs) {
        let p: Pt[] = [[off + a * m + pen / 2, off + r * m + t], [off + b * m - pen / 2, off + r * m + t]];
        if (flip) p = p.reverse();
        if (o.direction === 'v') p = p.map(([x, y]) => [y, x] as Pt);
        out.push({ points: p });
      }
      flip = !flip;
    }
  }
  return out;
}
