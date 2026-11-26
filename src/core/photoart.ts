// Фото → рисунок для ручки: контуры (Кэнни), штриховка, пуантилизм (взвешенный Вороной),
// одна непрерывная линия (TSP-art), спираль, волны, скетч. Результат — пути в мм.
import { chaikin, simplify, type Path, type Pt } from './geometry';
import { downscale, thin, traceSkeleton, type Gray } from './vision';
import { lineArt } from './lineart';
import { mulberry32 } from './rng';

export type ArtStyle = 'portrait' | 'contours' | 'hatch' | 'stipple' | 'tsp' | 'spiral' | 'waves' | 'sketch' | 'lines';

export interface Prep {
  brightness: number;  // −100…100
  contrast: number;    // −100…100
  gamma: number;       // 0.3…3
  invert: boolean;
  whiteBg: number;     // 0…100: всё светлее этого порога становится белым (убрать фон)
}
export const defaultPrep: Prep = { brightness: 0, contrast: 10, gamma: 1, invert: false, whiteBg: 0 };

export interface StyleParams {
  detail: number;      // 1…10 — подробность
  spacing: number;     // мм — шаг линий/спирали/волн
  points: number;      // число точек (пуантилизм, TSP)
  amplitude: number;   // мм — размах волн/спирали
  layers: number;      // 1…4 — слоёв штриховки
  minLen: number;      // мм — короче не рисуем
  seed: number;
}
export const defaultParams: StyleParams = { detail: 5, spacing: 1.2, points: 2500, amplitude: 1.2, layers: 3, minLen: 1.5, seed: 1 };

export const STYLES: { id: ArtStyle; name: string; hint: string; uses: (keyof StyleParams)[] }[] = [
  { id: 'portrait', name: 'Портрет', hint: 'Для фото людей: черты лица контуром и тени тонкой штриховкой, как рисунок карандашом. Контраст и свет выравниваются сами.', uses: ['detail', 'spacing', 'layers', 'minLen'] },
  { id: 'contours', name: 'Контуры', hint: 'Обводка границ (детектор Кэнни). Лучше всего для чётких предметов и лиц.', uses: ['detail', 'minLen'] },
  { id: 'hatch', name: 'Штриховка', hint: 'Тёмные места — перекрёстная штриховка, как гравюра.', uses: ['spacing', 'layers', 'minLen'] },
  { id: 'stipple', name: 'Точки', hint: 'Пуантилизм: машина ставит точки, гуще в тёмных местах.', uses: ['points', 'seed'] },
  { id: 'tsp', name: 'Одна линия', hint: 'Весь рисунок — одной непрерывной линией, без подъёма ручки.', uses: ['points', 'seed'] },
  { id: 'spiral', name: 'Спираль', hint: 'Спираль из центра, в тёмных местах — волнистая.', uses: ['spacing', 'amplitude'] },
  { id: 'waves', name: 'Волны', hint: 'Горизонтальные линии с волнами по яркости.', uses: ['spacing', 'amplitude'] },
  { id: 'lines', name: 'Линии как есть', hint: 'Для чертежей, схем, страниц PDF и рисунков ручкой: каждая тёмная линия проходится один раз по центру.', uses: [] },
  { id: 'sketch', name: 'Скетч', hint: 'Как карандашом: контуры и лёгкая штриховка теней.', uses: ['detail', 'spacing', 'seed'] },
];

/** Растяжение яркости: 1% самых тёмных → чёрный, 1% самых светлых → белый. */
export function autoLevels(g: Gray): Gray {
  const hist = new Uint32Array(256);
  for (const v of g.d) hist[v]++;
  const n = g.d.length;
  let lo = 0, hi = 255, acc = 0;
  for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc >= n * 0.01) { lo = i; break; } }
  acc = 0;
  for (let i = 255; i >= 0; i--) { acc += hist[i]; if (acc >= n * 0.01) { hi = i; break; } }
  if (hi - lo < 10) return g;
  const d = new Uint8Array(n);
  for (let i = 0; i < n; i++) d[i] = Math.max(0, Math.min(255, ((g.d[i] - lo) * 255) / (hi - lo)));
  return { w: g.w, h: g.h, d };
}

/**
 * CLAHE — выравнивание гистограммы по участкам с ограничением контраста.
 * Тени на лице не проваливаются в черноту, пересвет не становится белым пятном.
 */
export function clahe(g: Gray, tiles = 8, clip = 2.5): Gray {
  const { w, h } = g;
  const tx = Math.max(1, Math.min(tiles, Math.floor(w / 16))), ty = Math.max(1, Math.min(tiles, Math.floor(h / 16)));
  const tw = w / tx, th = h / ty;
  const maps: Uint8Array[] = [];
  for (let j = 0; j < ty; j++) for (let i = 0; i < tx; i++) {
    const hist = new Float64Array(256);
    const x0 = Math.floor(i * tw), x1 = Math.floor((i + 1) * tw), y0 = Math.floor(j * th), y1 = Math.floor((j + 1) * th);
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) hist[g.d[y * w + x]]++;
    const cnt = Math.max(1, (x1 - x0) * (y1 - y0));
    const limit = (clip * cnt) / 256;
    let excess = 0;
    for (let k = 0; k < 256; k++) if (hist[k] > limit) { excess += hist[k] - limit; hist[k] = limit; }
    const add = excess / 256;
    const map = new Uint8Array(256);
    let acc = 0;
    for (let k = 0; k < 256; k++) { acc += hist[k] + add; map[k] = Math.min(255, Math.round((acc / cnt) * 255)); }
    maps.push(map);
  }
  const d = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const fy = Math.max(0, Math.min(ty - 1, y / th - 0.5));
    const j0 = Math.floor(fy), j1 = Math.min(ty - 1, j0 + 1), wy = fy - j0;
    for (let x = 0; x < w; x++) {
      const fx = Math.max(0, Math.min(tx - 1, x / tw - 0.5));
      const i0 = Math.floor(fx), i1 = Math.min(tx - 1, i0 + 1), wx = fx - i0;
      const v = g.d[y * w + x];
      const a = maps[j0 * tx + i0][v], b = maps[j0 * tx + i1][v], c = maps[j1 * tx + i0][v], e = maps[j1 * tx + i1][v];
      d[y * w + x] = (a * (1 - wx) + b * wx) * (1 - wy) + (c * (1 - wx) + e * wx) * wy;
    }
  }
  return { w, h, d };
}

/** Яркость, контраст, гамма, инверсия, удаление фона. */
export function prepare(g: Gray, p: Prep, maxSide: number): Gray {
  const { img } = downscale(g, maxSide);
  const d = new Uint8Array(img.d.length);
  const c = (p.contrast + 100) / 100;          // 0…2
  const cf = c <= 1 ? c : 1 + (c - 1) * 3;     // усиление сильнее при >0
  const wb = 255 * (1 - p.whiteBg / 100);
  for (let i = 0; i < d.length; i++) {
    let v = img.d[i] / 255;
    v = (v - 0.5) * cf + 0.5 + p.brightness / 200;
    v = Math.min(1, Math.max(0, v));
    v = Math.pow(v, 1 / p.gamma);
    let o = v * 255;
    if (p.invert) o = 255 - o;
    if (p.whiteBg > 0 && o >= wb) o = 255;
    d[i] = o;
  }
  return { w: img.w, h: img.h, d };
}

// ── Вспомогательное ──────────────────────────────────────────────────

function blur(g: Gray, sigma: number): Float32Array {
  const r = Math.max(1, Math.ceil(sigma * 2.5));
  const k: number[] = [];
  let s = 0;
  for (let i = -r; i <= r; i++) { const v = Math.exp(-(i * i) / (2 * sigma * sigma)); k.push(v); s += v; }
  for (let i = 0; i < k.length; i++) k[i] /= s;
  const { w, h } = g;
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let a = 0;
    for (let i = -r; i <= r; i++) a += g.d[y * w + Math.min(w - 1, Math.max(0, x + i))] * k[i + r];
    tmp[y * w + x] = a;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let a = 0;
    for (let i = -r; i <= r; i++) a += tmp[Math.min(h - 1, Math.max(0, y + i)) * w + x] * k[i + r];
    out[y * w + x] = a;
  }
  return out;
}

/** Темнота 0…1 с билинейной интерполяцией. */
function darkSampler(g: Gray, smooth: Float32Array | null) {
  const src = smooth ?? Float32Array.from(g.d);
  return (x: number, y: number) => {
    if (x < 0 || y < 0 || x > g.w - 1 || y > g.h - 1) return -1;
    const x0 = Math.floor(x), y0 = Math.floor(y), x1 = Math.min(g.w - 1, x0 + 1), y1 = Math.min(g.h - 1, y0 + 1);
    const fx = x - x0, fy = y - y0;
    const v = (src[y0 * g.w + x0] * (1 - fx) + src[y0 * g.w + x1] * fx) * (1 - fy) + (src[y1 * g.w + x0] * (1 - fx) + src[y1 * g.w + x1] * fx) * fy;
    return 1 - v / 255;
  };
}

const scalePaths = (ps: Pt[][], k: number): Path[] =>
  ps.filter((p) => p.length).map((p) => ({ points: p.map(([x, y]) => [Math.round(x * k * 100) / 100, Math.round(y * k * 100) / 100] as Pt) }));

const plen = (p: Pt[]) => { let s = 0; for (let i = 1; i < p.length; i++) s += Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]); return s; };

// ── Контуры: детектор Кэнни ──────────────────────────────────────────

export function canny(g: Gray, detail: number, sigma = 1.4): Uint8Array {
  const { w, h } = g;
  const b = blur(g, sigma);
  const mag = new Float32Array(w * h), dir = new Uint8Array(w * h);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    const gx = -b[i - w - 1] - 2 * b[i - 1] - b[i + w - 1] + b[i - w + 1] + 2 * b[i + 1] + b[i + w + 1];
    const gy = -b[i - w - 1] - 2 * b[i - w] - b[i - w + 1] + b[i + w - 1] + 2 * b[i + w] + b[i + w + 1];
    mag[i] = Math.hypot(gx, gy);
    const a = ((Math.atan2(gy, gx) * 180) / Math.PI + 180) % 180;
    dir[i] = a < 22.5 || a >= 157.5 ? 0 : a < 67.5 ? 1 : a < 112.5 ? 2 : 3;
  }
  // подавление немаксимумов
  const nms = new Float32Array(w * h);
  const off = [[1, 0], [1, 1], [0, 1], [-1, 1]];
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x, m = mag[i];
    if (!m) continue;
    const [dx, dy] = off[dir[i]];
    if (m >= mag[i + dy * w + dx] && m >= mag[i - dy * w - dx]) nms[i] = m;
  }
  // Пороги — от «сильной» границы (99,5-й перцентиль градиента), а не от максимума (блики)
  const sorted = Float32Array.from(mag).sort();
  const ref = sorted[Math.floor(sorted.length * 0.995)];
  if (ref <= 1e-3) return new Uint8Array(w * h);
  const hi = ref * (0.5 - (detail - 1) * 0.045);   // detail 1 → 50%, 10 → 9.5%
  const lo = hi * 0.4;
  const out = new Uint8Array(w * h);
  const st: number[] = [];
  for (let i = 0; i < nms.length; i++) if (nms[i] >= hi && !out[i]) {
    out[i] = 1; st.push(i);
    while (st.length) {
      const p = st.pop()!;
      const px = p % w, py = (p - px) / w;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = px + dx, yy = py + dy;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        const q = yy * w + xx;
        if (!out[q] && nms[q] >= lo) { out[q] = 1; st.push(q); }
      }
    }
  }
  return out;
}

function contourLines(g: Gray, detail: number, minLenPx: number): Pt[][] {
  const e = canny(g, detail);
  thin(e, g.w, g.h); // границы бывают в 2 пикселя — утончаем, чтобы получались целые линии
  const strokes = traceSkeleton(e, g.w, g.h, 2);
  return strokes
    .filter((s) => s.length > 1 && plen(s) >= minLenPx)
    .map((s) => chaikin(simplify(s, 0.6), 1));
}

// ── Штриховка ────────────────────────────────────────────────────────

function hatchLayer(dark: (x: number, y: number) => number, w: number, h: number, angleDeg: number, step: number, thr: number, minLen: number): Pt[][] {
  const a = (angleDeg * Math.PI) / 180, ux = Math.cos(a), uy = Math.sin(a), nx = -uy, ny = ux;
  const cx = w / 2, cy = h / 2, R = Math.hypot(w, h) / 2;
  const out: Pt[][] = [];
  let flip = false;
  for (let o = -R; o <= R; o += step) {
    const seg: Pt[][] = [];
    let cur: Pt[] | null = null;
    for (let t = -R; t <= R; t += 0.5) {
      const x = cx + ux * t + nx * o, y = cy + uy * t + ny * o;
      const d = dark(x, y);
      if (d > thr) { if (!cur) cur = [[x, y]]; else if (cur.length === 1) cur.push([x, y]); else cur[1] = [x, y]; }
      else if (cur) { if (cur.length > 1 && plen(cur) >= minLen) seg.push(cur); cur = null; }
    }
    if (cur && cur.length > 1 && plen(cur) >= minLen) seg.push(cur);
    if (flip) seg.reverse().forEach((s) => s.reverse());
    out.push(...seg);
    flip = !flip;
  }
  return out;
}

const HATCH_LAYERS: [number, number][] = [[45, 0.18], [-45, 0.38], [0, 0.58], [90, 0.76]];

// ── Пуантилизм: взвешенная диаграмма Вороного (Лойд) ─────────────────

export function stipplePoints(g: Gray, n: number, seed: number, iters = 14): Pt[] {
  const { w, h } = g;
  const W = new Float32Array(w * h);
  let total = 0;
  // почти белое — это бумага: там точек не ставим (иначе одинокие точки и длинные «перелёты»)
  for (let i = 0; i < W.length; i++) { const v = Math.pow(1 - g.d[i] / 255, 1.6); W[i] = v < 0.025 ? 0 : v; total += W[i]; }
  if (total < 1e-6) return [];
  const rnd = mulberry32(seed);
  // начальные точки — выборка с отбраковкой по темноте
  const pts: Pt[] = [];
  let guard = 0;
  while (pts.length < n && guard++ < n * 400) {
    const x = rnd() * (w - 1), y = rnd() * (h - 1);
    if (rnd() < W[Math.floor(y) * w + Math.floor(x)]) pts.push([x, y]);
  }
  const cell = Math.max(2, Math.sqrt((w * h) / Math.max(1, pts.length)) * 1.2);
  const gw = Math.ceil(w / cell), gh = Math.ceil(h / cell);
  for (let it = 0; it < iters; it++) {
    const grid: number[][] = Array.from({ length: gw * gh }, () => []);
    pts.forEach((p, i) => grid[Math.min(gh - 1, Math.floor(p[1] / cell)) * gw + Math.min(gw - 1, Math.floor(p[0] / cell))].push(i));
    const sx = new Float64Array(pts.length), sy = new Float64Array(pts.length), sm = new Float64Array(pts.length);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const wt = W[y * w + x];
      if (wt < 0.01) continue;
      const gx = Math.floor(x / cell), gy = Math.floor(y / cell);
      let best = -1, bd = Infinity;
      for (let r = 0; r < Math.max(gw, gh); r++) {
        for (let yy = gy - r; yy <= gy + r; yy++) for (let xx = gx - r; xx <= gx + r; xx++) {
          if (Math.max(Math.abs(xx - gx), Math.abs(yy - gy)) !== r || xx < 0 || yy < 0 || xx >= gw || yy >= gh) continue;
          for (const i of grid[yy * gw + xx]) { const d = (pts[i][0] - x) ** 2 + (pts[i][1] - y) ** 2; if (d < bd) { bd = d; best = i; } }
        }
        if (best >= 0 && Math.sqrt(bd) <= r * cell) break;
      }
      if (best < 0) continue;
      sx[best] += x * wt; sy[best] += y * wt; sm[best] += wt;
    }
    for (let i = 0; i < pts.length; i++) if (sm[i] > 0) pts[i] = [sx[i] / sm[i], sy[i] / sm[i]];
  }
  return pts;
}

/** Обход точек одной линией: ближайший сосед + 2-opt с ограничением по времени. */
export function tspTour(pts: Pt[], budgetMs = 1500): Pt[] {
  const n = pts.length;
  if (n < 3) return pts.slice();
  const cell = Math.max(1, Math.sqrt(1 / n) * 300);
  const key = (p: Pt) => `${Math.floor(p[0] / cell)},${Math.floor(p[1] / cell)}`;
  const grid = new Map<string, number[]>();
  pts.forEach((p, i) => { const k = key(p); if (!grid.has(k)) grid.set(k, []); grid.get(k)!.push(i); });
  const used = new Uint8Array(n);
  const order: number[] = [0];
  used[0] = 1;
  for (let s = 1; s < n; s++) {
    const p = pts[order[order.length - 1]];
    const cx = Math.floor(p[0] / cell), cy = Math.floor(p[1] / cell);
    let best = -1, bd = Infinity;
    for (let r = 0; r < 10000; r++) {
      for (let y = cy - r; y <= cy + r; y++) for (let x = cx - r; x <= cx + r; x++) {
        if (Math.max(Math.abs(x - cx), Math.abs(y - cy)) !== r) continue;
        const arr = grid.get(`${x},${y}`);
        if (!arr) continue;
        for (const i of arr) if (!used[i]) { const d = (pts[i][0] - p[0]) ** 2 + (pts[i][1] - p[1]) ** 2; if (d < bd) { bd = d; best = i; } }
      }
      if (best >= 0 && Math.sqrt(bd) <= r * cell) break;
    }
    if (best < 0) for (let i = 0; i < n; i++) if (!used[i]) { best = i; break; }
    used[best] = 1;
    order.push(best);
  }
  return twoOptNeighbors(order.map((i) => pts[i]), budgetMs);
}

/**
 * 2-opt со списками ближайших соседей: для каждого ребра (a,b) пробуем соединить a с одним из
 * k ближайших к нему точек c. Так исчезают длинные «перелёты», которые оставляет жадный обход.
 */
export function twoOptNeighbors(P: Pt[], budgetMs: number, K = 10): Pt[] {
  const n = P.length;
  if (n < 5) return P;
  const tour = P.map((_, i) => i);            // tour[позиция] = точка
  const pos = Int32Array.from(tour);          // pos[точка] = позиция
  // k ближайших соседей через сетку
  const minX = Math.min(...P.map((p) => p[0])), minY = Math.min(...P.map((p) => p[1]));
  const maxX = Math.max(...P.map((p) => p[0])), maxY = Math.max(...P.map((p) => p[1]));
  const cell = Math.max(1e-6, Math.sqrt(((maxX - minX) * (maxY - minY) + 1e-9) / n) * 1.5);
  const gw = Math.max(1, Math.ceil((maxX - minX) / cell) + 1), gh = Math.max(1, Math.ceil((maxY - minY) / cell) + 1);
  const grid: number[][] = Array.from({ length: gw * gh }, () => []);
  const cx = (p: Pt) => Math.min(gw - 1, Math.floor((p[0] - minX) / cell)), cy = (p: Pt) => Math.min(gh - 1, Math.floor((p[1] - minY) / cell));
  P.forEach((p, i) => grid[cy(p) * gw + cx(p)].push(i));
  const d = (i: number, j: number) => Math.hypot(P[i][0] - P[j][0], P[i][1] - P[j][1]);
  const nbr: number[][] = P.map((p, i) => {
    const x0 = cx(p), y0 = cy(p);
    const cand: number[] = [];
    for (let r = 1; cand.length < K + 1 && r < Math.max(gw, gh) + 1; r++) {
      cand.length = 0;
      for (let y = y0 - r; y <= y0 + r; y++) for (let x = x0 - r; x <= x0 + r; x++) if (x >= 0 && y >= 0 && x < gw && y < gh) cand.push(...grid[y * gw + x]);
    }
    return cand.filter((j) => j !== i).sort((a, b) => d(i, a) - d(i, b)).slice(0, K);
  });
  const reverse = (i: number, j: number) => { // развернуть tour[i..j]
    while (i < j) { const a = tour[i], b = tour[j]; tour[i] = b; tour[j] = a; pos[b] = i; pos[a] = j; i++; j--; }
  };
  const t0 = performance.now();
  let improved = true;
  while (improved && performance.now() - t0 < budgetMs) {
    improved = false;
    for (let i = 0; i < n - 1; i++) {
      const a = tour[i], b = tour[i + 1];
      const dab = d(a, b);
      for (const c of nbr[a]) {
        const dac = d(a, c);
        if (dac >= dab) break;               // дальше соседи только длиннее
        const j = pos[c];
        if (j === n - 1 || Math.abs(j - i) < 2) continue;
        const e = tour[j + 1];
        const delta = dac + d(b, e) - dab - d(c, e);
        if (delta < -1e-9) {
          if (i < j) reverse(i + 1, j); else reverse(j + 1, i);
          improved = true;
          break;
        }
      }
      if ((i & 255) === 0 && performance.now() - t0 > budgetMs) break;
    }
  }
  return tour.map((i) => P[i]);
}

// ── Спираль и волны ──────────────────────────────────────────────────

function spiralLines(dark: (x: number, y: number) => number, w: number, h: number, stepPx: number, ampPx: number): Pt[][] {
  const cx = w / 2, cy = h / 2, Rmax = Math.hypot(w, h) / 2;
  const out: Pt[][] = [];
  let cur: Pt[] = [];
  let th = 0, phase = 0;
  while (true) {
    const r = (stepPx * th) / (2 * Math.PI);
    if (r > Rmax) break;
    const bx = cx + r * Math.cos(th), by = cy + r * Math.sin(th);
    const dk = dark(bx, by);
    if (dk < 0) { if (cur.length > 1) out.push(cur); cur = []; }
    else {
      phase += 0.9 + dk * 1.2;
      const rr = r + Math.sin(phase) * ampPx * dk;
      cur.push([cx + rr * Math.cos(th), cy + rr * Math.sin(th)]);
    }
    th += Math.min(0.2, 0.35 / Math.max(1, r)); // шаг ~0,35 px по дуге
  }
  if (cur.length > 1) out.push(cur);
  return out.map((p) => simplify(p, 0.15));
}

function waveLines(dark: (x: number, y: number) => number, w: number, h: number, stepPx: number, ampPx: number): Pt[][] {
  const out: Pt[][] = [];
  let row = 0;
  for (let y = stepPx / 2; y < h; y += stepPx, row++) {
    const pts: Pt[] = [];
    let phase = 0;
    for (let x = 0; x <= w - 1; x += 0.35) {
      const dk = Math.max(0, dark(x, y));
      phase += 0.25 + dk * 0.9;
      pts.push([x, y + Math.sin(phase) * ampPx * dk]);
    }
    const s = simplify(pts, 0.12);
    out.push(row % 2 ? s.reverse() : s);
  }
  return out;
}

// ── Главная функция ──────────────────────────────────────────────────

/**
 * img — подготовленное изображение (prepare). widthMM — ширина рисунка на листе.
 * Возвращает пути в мм, начало — левый верхний угол рисунка.
 */
export function photoToPaths(src: Gray, style: ArtStyle, p: StyleParams, widthMM: number, onProgress?: (s: string) => void): Path[] {
  // Рабочее разрешение под стиль
  const res: Record<ArtStyle, number> = { portrait: 650, contours: 700, hatch: 360, stipple: 300, tsp: 300, spiral: 360, waves: 360, sketch: 600, lines: 1600 };
  const { img } = downscale(src, res[style]);
  const k = widthMM / img.w;            // мм на пиксель
  const mm = (v: number) => v / k;       // мм → пиксели
  onProgress?.('Обработка');
  switch (style) {
    case 'lines':
      onProgress?.('Обводим линии');
      return lineArt(img, widthMM);
    case 'contours':
      return scalePaths(contourLines(img, p.detail, mm(p.minLen)), k);
    case 'hatch': {
      const dark = darkSampler(img, blur(img, Math.max(0.8, mm(p.spacing) / 3)));
      const out: Pt[][] = [];
      HATCH_LAYERS.slice(0, Math.max(1, Math.min(4, p.layers))).forEach(([a, t]) => out.push(...hatchLayer(dark, img.w, img.h, a, mm(p.spacing), t, mm(p.minLen))));
      return scalePaths(out, k);
    }
    case 'stipple': {
      onProgress?.('Расставляем точки');
      return scalePaths(stipplePoints(img, p.points, p.seed).map((q) => [q]), k);
    }
    case 'tsp': {
      onProgress?.('Расставляем точки');
      const pts = stipplePoints(img, p.points, p.seed, 10);
      // для одной линии больше точек выглядит лучше; обход — с улучшением по соседям
      onProgress?.('Прокладываем одну линию');
      return scalePaths([tspTour(pts)], k);
    }
    case 'spiral':
      return scalePaths(spiralLines(darkSampler(img, blur(img, 1)), img.w, img.h, mm(p.spacing), mm(p.amplitude)), k);
    case 'waves':
      return scalePaths(waveLines(darkSampler(img, blur(img, 1)), img.w, img.h, mm(p.spacing), mm(p.amplitude)), k);
    case 'portrait': {
      // 1) свет и контраст: автоуровни + CLAHE (смешиваем с исходником, чтобы не было «пластика»)
      const lev = autoLevels(img);
      const eq = clahe(lev, 6, 2.2);
      const tone: Gray = { w: img.w, h: img.h, d: lev.d.map((v, i) => Math.round(v * 0.45 + eq.d[i] * 0.55)) };
      // 2) черты лица: контуры по сглаженной картинке (без шума кожи и волос)
      onProgress?.('Черты лица');
      const lines = contourLines(tone, Math.max(1, Math.min(10, p.detail - 1)), mm(Math.max(1, p.minLen)));
      // 3) тени: 2–4 слоя штриховки с разными углами, тоньше и чаще, чем в «Штриховке»
      onProgress?.('Тени');
      const dark = darkSampler(tone, blur(tone, Math.max(1, mm(p.spacing) / 2.5)));
      const LAYERS: [number, number][] = [[45, 0.32], [-45, 0.5], [0, 0.66], [90, 0.8]];
      const out: Pt[][] = [...lines];
      // самый светлый слой — редкий, для мягких полутонов на коже (без него лицо выходит «плакатным»)
      out.push(...hatchLayer(dark, img.w, img.h, 30, mm(p.spacing * 2), 0.2, mm(1.5)));
      LAYERS.slice(0, Math.max(1, Math.min(4, p.layers))).forEach(([a, t]) => out.push(...hatchLayer(dark, img.w, img.h, a, mm(p.spacing), t, mm(1.2))));
      return scalePaths(out, k);
    }
    case 'sketch': {
      const rnd = mulberry32(p.seed);
      const c = contourLines(img, Math.min(10, p.detail + 1), mm(1));
      // повтор контура с лёгким дрожанием — как штрихи карандаша
      const jit = (s: Pt[]) => s.map(([x, y]) => [x + (rnd() - 0.5) * mm(0.35), y + (rnd() - 0.5) * mm(0.35)] as Pt);
      const strokes = [...c, ...c.filter((s) => plen(s) > mm(4)).map(jit)];
      const dark = darkSampler(img, blur(img, 2));
      strokes.push(...hatchLayer(dark, img.w, img.h, 35, mm(p.spacing * 1.6), 0.45, mm(2)));
      strokes.push(...hatchLayer(dark, img.w, img.h, -55, mm(p.spacing * 1.6), 0.7, mm(2)));
      return scalePaths(strokes, k);
    }
  }
}

export const heightFor = (img: Gray, widthMM: number) => (img.h / img.w) * widthMM;

// ── Кадр: поворот и обрезка ──────────────────────────────────────────

export interface Crop { x0: number; y0: number; x1: number; y1: number } // доли 0…1 от повёрнутого фото
export const fullCrop: Crop = { x0: 0, y0: 0, x1: 1, y1: 1 };

/** Поворот на rot × 90° по часовой стрелке. */
export function rotateGray(g: Gray, rot: number): Gray {
  const r = ((rot % 4) + 4) % 4;
  if (!r) return g;
  const w = r % 2 ? g.h : g.w, h = r % 2 ? g.w : g.h;
  const d = new Uint8Array(w * h);
  for (let y = 0; y < g.h; y++) for (let x = 0; x < g.w; x++) {
    const v = g.d[y * g.w + x];
    let nx: number, ny: number;
    if (r === 1) { nx = g.h - 1 - y; ny = x; }
    else if (r === 2) { nx = g.w - 1 - x; ny = g.h - 1 - y; }
    else { nx = y; ny = g.w - 1 - x; }
    d[ny * w + nx] = v;
  }
  return { w, h, d };
}

/** Повернуть, затем вырезать кадр. */
export function frameGray(g: Gray, rot: number, c: Crop): Gray {
  const r = rotateGray(g, rot);
  const x0 = Math.max(0, Math.floor(Math.min(c.x0, c.x1) * r.w)), x1 = Math.min(r.w, Math.ceil(Math.max(c.x0, c.x1) * r.w));
  const y0 = Math.max(0, Math.floor(Math.min(c.y0, c.y1) * r.h)), y1 = Math.min(r.h, Math.ceil(Math.max(c.y0, c.y1) * r.h));
  const w = Math.max(1, x1 - x0), h = Math.max(1, y1 - y0);
  if (w === r.w && h === r.h) return r;
  const d = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) d.set(r.d.subarray((y0 + y) * r.w + x0, (y0 + y) * r.w + x0 + w), y * w);
  return { w, h, d };
}
