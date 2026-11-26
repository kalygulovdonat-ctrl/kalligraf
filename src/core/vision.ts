// Распознавание почерка по фото листа-шаблона. Чистый TypeScript, без OpenCV:
// метки → гомография → выравнивание листа → выравнивание яркости → порог →
// по клеткам: очистка → скелетизация (Чжан–Суэнь) → граф скелета → штрихи.
import { chaikin, simplify, type Pt } from './geometry';
import { TPL, cellRect } from './template';

export interface Gray { w: number; h: number; d: Uint8Array }

export function toGray(rgba: Uint8ClampedArray | Uint8Array, w: number, h: number): Gray {
  const d = new Uint8Array(w * h);
  for (let i = 0, j = 0; i < d.length; i++, j += 4) d[i] = (rgba[j] * 77 + rgba[j + 1] * 150 + rgba[j + 2] * 29) >> 8;
  return { w, h, d };
}

/** Уменьшение (усреднением по блокам) до maxSide по большей стороне. */
export function downscale(g: Gray, maxSide: number): { img: Gray; k: number } {
  const k = Math.max(1, Math.ceil(Math.max(g.w, g.h) / maxSide));
  if (k === 1) return { img: g, k: 1 };
  const w = Math.floor(g.w / k), h = Math.floor(g.h / k);
  const d = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let dy = 0; dy < k; dy++) for (let dx = 0; dx < k; dx++) s += g.d[(y * k + dy) * g.w + x * k + dx];
      d[y * w + x] = s / (k * k);
    }
  return { img: { w, h, d }, k };
}

export function otsu(d: Uint8Array, from = 0, to = d.length): number {
  const hist = new Float64Array(256);
  for (let i = from; i < to; i++) hist[d[i]]++;
  const total = to - from;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = 0, t = 127;
  for (let i = 0; i < 256; i++) {
    wB += hist[i];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += i * hist[i];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const v = wB * wF * (mB - mF) ** 2;
    if (v > best) { best = v; t = i; }
  }
  return t;
}

export interface Comp { area: number; minX: number; minY: number; maxX: number; maxY: number; cx: number; cy: number; pixels?: number[] }

/** Связные компоненты (8-связность) на бинарном изображении. */
export function components(bin: Uint8Array, w: number, h: number, keepPixels = false): Comp[] {
  const label = new Int32Array(w * h);
  const out: Comp[] = [];
  const stack: number[] = [];
  for (let start = 0; start < bin.length; start++) {
    if (!bin[start] || label[start]) continue;
    const id = out.length + 1;
    const c: Comp = { area: 0, minX: w, minY: h, maxX: 0, maxY: 0, cx: 0, cy: 0, pixels: keepPixels ? [] : undefined };
    label[start] = id;
    stack.push(start);
    while (stack.length) {
      const i = stack.pop()!;
      const x = i % w, y = (i - x) / w;
      c.area++; c.cx += x; c.cy += y;
      if (x < c.minX) c.minX = x; if (x > c.maxX) c.maxX = x;
      if (y < c.minY) c.minY = y; if (y > c.maxY) c.maxY = y;
      c.pixels?.push(i);
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          const j = yy * w + xx;
          if (bin[j] && !label[j]) { label[j] = id; stack.push(j); }
        }
      }
    }
    c.cx /= c.area; c.cy /= c.area;
    out.push(c);
  }
  return out;
}

/**
 * Поиск 4 угловых меток. Возвращает центры в порядке ЛВ, ПВ, ПН, ЛН (координаты изображения)
 * или null, если не нашлось.
 */
export function findMarkers(g: Gray): Pt[] | null {
  const t = otsu(g.d);
  const bin = new Uint8Array(g.d.length);
  for (let i = 0; i < bin.length; i++) bin[i] = g.d[i] < Math.min(t, 150) ? 1 : 0;
  const comps = components(bin, g.w, g.h);
  const minSide = Math.min(g.w, g.h);
  const cands = comps.filter((c) => {
    const bw = c.maxX - c.minX + 1, bh = c.maxY - c.minY + 1;
    if (bw < 5 || bh < 5) return false;
    if (c.minX <= 1 || c.minY <= 1 || c.maxX >= g.w - 2 || c.maxY >= g.h - 2) return false;
    if (Math.max(bw, bh) > minSide * 0.12 || Math.max(bw, bh) < minSide * 0.008) return false;
    if (Math.max(bw, bh) / Math.min(bw, bh) > 2.2) return false;
    return c.area / (bw * bh) >= 0.45;
  });
  if (cands.length < 4) return null;
  // Группа похожих по площади кандидатов (метки одного размера), самая крупная из возможных
  const sorted = cands.slice().sort((a, b) => b.area - a.area);
  let group: Comp[] | null = null;
  for (const ref of sorted) {
    const gr = sorted.filter((c) => c.area >= ref.area * 0.45 && c.area <= ref.area * 1.6);
    if (gr.length >= 4) { group = gr; break; }
  }
  if (!group) return null;
  // Крайние по диагоналям
  const pick = (f: (c: Comp) => number) => group!.reduce((a, b) => (f(b) > f(a) ? b : a));
  const tl = pick((c) => -(c.cx + c.cy)), br = pick((c) => c.cx + c.cy);
  const tr = pick((c) => c.cx - c.cy), bl = pick((c) => c.cy - c.cx);
  const four = [tl, tr, br, bl];
  if (new Set(four).size < 4) return null;
  // Площадь четырёхугольника должна быть заметной
  const pts = four.map((c) => [c.cx, c.cy] as Pt);
  if (Math.abs(polyArea(pts)) < g.w * g.h * 0.08) return null;
  // Ориентация: метка с окошком — левая верхняя
  const hasHole = (c: Comp) => {
    const x = Math.round(c.cx), y = Math.round(c.cy);
    let white = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (!bin[(y + dy) * g.w + x + dx]) white++;
    return white >= 5;
  };
  const holeIdx = four.findIndex(hasHole);
  // по часовой стрелке на экране (Y вниз): сортировка по углу вокруг центра
  const cx = pts.reduce((s, p) => s + p[0], 0) / 4, cy = pts.reduce((s, p) => s + p[1], 0) / 4;
  const order = [0, 1, 2, 3].sort((a, b) => Math.atan2(pts[a][1] - cy, pts[a][0] - cx) - Math.atan2(pts[b][1] - cy, pts[b][0] - cx));
  const start = holeIdx >= 0 ? order.indexOf(holeIdx) : order.indexOf(0);
  return [0, 1, 2, 3].map((k) => pts[order[(start + k) % 4]]);
}

function polyArea(p: Pt[]) {
  let s = 0;
  for (let i = 0; i < p.length; i++) { const a = p[i], b = p[(i + 1) % p.length]; s += a[0] * b[1] - b[0] * a[1]; }
  return s / 2;
}

/** Гомография по 4 парам точек: src → dst. */
export function homography(src: Pt[], dst: Pt[]): number[] {
  const A: number[][] = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i], [u, v] = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
  }
  // Гаусс с выбором ведущего элемента
  for (let c = 0; c < 8; c++) {
    let p = c;
    for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]];
    if (Math.abs(A[c][c]) < 1e-12) throw new Error('Метки стоят на одной линии');
    for (let r = 0; r < 8; r++) {
      if (r === c) continue;
      const f = A[r][c] / A[c][c];
      for (let k = c; k < 9; k++) A[r][k] -= f * A[c][k];
    }
  }
  const h = A.map((row, i) => row[8] / row[i]);
  return [...h, 1];
}

export const applyH = (H: number[], [x, y]: Pt): Pt => {
  const w = H[6] * x + H[7] * y + H[8];
  return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w];
};

/** Выпрямление: H переводит мм шаблона → пиксели фото. Результат — s пикселей на мм. */
export function warp(g: Gray, H: number[], s: number): Gray {
  const w = Math.round(TPL.pageW * s), h = Math.round(TPL.pageH * s);
  const d = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const [u, v] = applyH(H, [(x + 0.5) / s, (y + 0.5) / s]);
      const x0 = Math.floor(u - 0.5), y0 = Math.floor(v - 0.5);
      if (x0 < 0 || y0 < 0 || x0 >= g.w - 1 || y0 >= g.h - 1) { d[y * w + x] = 255; continue; }
      const fx = u - 0.5 - x0, fy = v - 0.5 - y0;
      const i = y0 * g.w + x0;
      const a = g.d[i] * (1 - fx) + g.d[i + 1] * fx;
      const b = g.d[i + g.w] * (1 - fx) + g.d[i + g.w + 1] * fx;
      d[y * w + x] = a * (1 - fy) + b * fy;
    }
  return { w, h, d };
}

/** Выравнивание освещения: делим на размытую копию (убирает тени и градиенты). */
export function flatten(g: Gray, r: number): Gray {
  const { w, h } = g;
  // Фон оцениваем по «светлой» версии: сначала локальный максимум 3×3 дважды, чтобы чернила меньше темнили фон
  let src = g.d;
  for (let k = 0; k < 2; k++) {
    const m = new Uint8Array(w * h);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        let mx = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = Math.min(h - 1, Math.max(0, y + dy * 2));
          for (let dx = -1; dx <= 1; dx++) {
            const v = src[yy * w + Math.min(w - 1, Math.max(0, x + dx * 2))];
            if (v > mx) mx = v;
          }
        }
        m[y * w + x] = mx;
      }
    src = m;
  }
  const I = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) { row += src[y * w + x]; I[(y + 1) * (w + 1) + x + 1] = I[y * (w + 1) + x + 1] + row; }
  }
  const d = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1);
      const s = I[y1 * (w + 1) + x1] - I[y0 * (w + 1) + x1] - I[y1 * (w + 1) + x0] + I[y0 * (w + 1) + x0];
      const bg = s / ((x1 - x0) * (y1 - y0));
      d[y * w + x] = Math.min(255, (g.d[y * w + x] * 255) / Math.max(1, bg));
    }
  }
  return { w, h, d };
}

/** Утончение Чжана–Суэня (на месте). */
export function thin(b: Uint8Array, w: number, h: number) {
  const del: number[] = [];
  let changed = true;
  while (changed) {
    changed = false;
    for (let pass = 0; pass < 2; pass++) {
      del.length = 0;
      for (let y = 1; y < h - 1; y++)
        for (let x = 1; x < w - 1; x++) {
          const i = y * w + x;
          if (!b[i]) continue;
          const p2 = b[i - w], p3 = b[i - w + 1], p4 = b[i + 1], p5 = b[i + w + 1];
          const p6 = b[i + w], p7 = b[i + w - 1], p8 = b[i - 1], p9 = b[i - w - 1];
          const B = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9;
          if (B < 2 || B > 6) continue;
          const seq = [p2, p3, p4, p5, p6, p7, p8, p9, p2];
          let A = 0;
          for (let k = 0; k < 8; k++) if (!seq[k] && seq[k + 1]) A++;
          if (A !== 1) continue;
          if (pass === 0 ? p2 * p4 * p6 === 0 && p4 * p6 * p8 === 0 : p2 * p4 * p8 === 0 && p2 * p6 * p8 === 0) del.push(i);
        }
      for (const i of del) b[i] = 0;
      if (del.length) changed = true;
    }
  }
}

const N8 = (w: number) => [-w, -w + 1, 1, w + 1, w, w - 1, -1, -w - 1]; // по кругу, начиная с севера

/** Граф скелета → штрихи (в пикселях). spur — длина «шпор», которые удаляются. */
export function traceSkeleton(sk: Uint8Array, w: number, h: number, spur: number): Pt[][] {
  const nb = N8(w);
  const at = (i: number) => {
    const x = i % w, y = (i - x) / w;
    return x > 0 && y > 0 && x < w - 1 && y < h - 1;
  };
  // Число переходов 0→1 вокруг пикселя: 1 — конец, 2 — линия, ≥3 — развилка
  const cn = new Uint8Array(w * h);
  const cnt = new Uint8Array(w * h);
  for (let i = 0; i < sk.length; i++) {
    if (!sk[i] || !at(i)) { if (sk[i]) cn[i] = 1; continue; }
    let t = 0, c = 0;
    for (let k = 0; k < 8; k++) {
      const a = sk[i + nb[k]], b = sk[i + nb[(k + 1) % 8]];
      if (!a && b) t++;
      if (a) c++;
    }
    cn[i] = t; cnt[i] = c;
  }
  const isNode = (i: number) => sk[i] && (cn[i] !== 2);
  // Кластеры узлов
  const cluster = new Int32Array(w * h).fill(-1);
  const clusters: { pts: number[]; x: number; y: number }[] = [];
  for (let i = 0; i < sk.length; i++) {
    if (!isNode(i) || cluster[i] >= 0) continue;
    const id = clusters.length;
    const c = { pts: [] as number[], x: 0, y: 0 };
    const st = [i];
    cluster[i] = id;
    while (st.length) {
      const p = st.pop()!;
      c.pts.push(p);
      if (!at(p)) continue;
      for (const o of nb) { const q = p + o; if (isNode(q) && cluster[q] < 0) { cluster[q] = id; st.push(q); } }
    }
    for (const p of c.pts) { c.x += p % w; c.y += Math.floor(p / w); }
    c.x /= c.pts.length; c.y /= c.pts.length;
    clusters.push(c);
  }
  const P = (i: number): Pt => [i % w, Math.floor(i / w)];
  type Edge = { a: number; b: number; pts: Pt[]; alive: boolean };
  const edges: Edge[] = [];
  const visited = new Uint8Array(w * h);
  const order4first = [0, 2, 4, 6, 1, 3, 5, 7];

  const walk = (startNode: number, first: number): Edge => {
    const pts: Pt[] = [[clusters[startNode].x, clusters[startNode].y], P(first)];
    visited[first] = 1;
    let prev = -1, cur = first, end = -1;
    for (let guard = 0; guard < w * h; guard++) {
      let next = -1;
      if (at(cur)) {
        // сначала — узел (не стартовый в первые шаги)
        for (const k of order4first) {
          const q = cur + nb[k];
          if (q === prev || !sk[q]) continue;
          if (isNode(q) && (cluster[q] !== startNode || pts.length > 3)) { end = cluster[q]; break; }
        }
        if (end >= 0) break;
        for (const k of order4first) {
          const q = cur + nb[k];
          if (q === prev || !sk[q] || visited[q] || isNode(q)) continue;
          next = q; break;
        }
      }
      if (next < 0) break;
      visited[next] = 1;
      pts.push(P(next));
      prev = cur; cur = next;
    }
    if (end >= 0) pts.push([clusters[end].x, clusters[end].y]);
    return { a: startNode, b: end, pts, alive: true };
  };

  clusters.forEach((c, id) => {
    for (const p of c.pts) {
      if (!at(p)) continue;
      for (const k of order4first) {
        const q = p + nb[k];
        if (sk[q] && !isNode(q) && !visited[q]) edges.push(walk(id, q));
      }
    }
  });
  // Петли без узлов (буква «о»)
  const loops: Pt[][] = [];
  for (let i = 0; i < sk.length; i++) {
    if (!sk[i] || visited[i] || isNode(i)) continue;
    const pts: Pt[] = [P(i)];
    visited[i] = 1;
    let cur = i, prev = -1;
    for (;;) {
      let next = -1;
      if (at(cur)) for (const k of order4first) { const q = cur + nb[k]; if (q !== prev && sk[q] && !visited[q] && !isNode(q)) { next = q; break; } }
      if (next < 0) break;
      visited[next] = 1; pts.push(P(next)); prev = cur; cur = next;
    }
    if (pts.length > 4) { pts.push(pts[0]); loops.push(pts); }
  }

  const len = (pts: Pt[]) => { let s = 0; for (let i = 1; i < pts.length; i++) s += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); return s; };
  const degree = () => {
    const d = new Int32Array(clusters.length);
    for (const e of edges) if (e.alive) { d[e.a]++; if (e.b >= 0) d[e.b]++; else d[e.a] += 0; }
    return d;
  };
  // Удаление шпор: короткая ветка от развилки к концу
  for (let it = 0; it < 3; it++) {
    const d = degree();
    let removed = false;
    for (const e of edges) {
      if (!e.alive || len(e.pts) >= spur) continue;
      const da = d[e.a], db = e.b >= 0 ? d[e.b] : 1;
      if ((da === 1 && db >= 3) || (db === 1 && da >= 3)) { e.alive = false; removed = true; }
    }
    if (!removed) break;
  }
  // Короткие обрывки-«ступеньки» (рёбра в пределах одного кластера)
  for (const e of edges) if (e.alive && e.a === e.b && len(e.pts) < 3) e.alive = false;

  // Сборка штрихов: идём по рёбрам, на развилке выбираем самое прямое продолжение
  const alive = edges.filter((e) => e.alive);
  const used = new Set<Edge>();
  const byNode = new Map<number, Edge[]>();
  for (const e of alive) {
    for (const n of [e.a, e.b]) {
      if (n < 0) continue;
      if (!byNode.has(n)) byNode.set(n, []);
      byNode.get(n)!.push(e);
    }
  }
  const strokes: Pt[][] = [];
  const dirOut = (pts: Pt[]): Pt => {
    const a = pts[0], b = pts[Math.min(pts.length - 1, 6)];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    return [(b[0] - a[0]) / l, (b[1] - a[1]) / l];
  };
  const oriented = (e: Edge, from: number): Pt[] => (e.a === from ? e.pts : e.pts.slice().reverse());
  const deg = degree();
  const starts = clusters.map((_, i) => i).filter((i) => (byNode.get(i)?.length ?? 0) > 0)
    .sort((x, y) => {
      const ox = deg[x] % 2, oy = deg[y] % 2;
      if (ox !== oy) return oy - ox; // сначала концы (нечётная степень)
      return (clusters[x].y + clusters[x].x * 0.3) - (clusters[y].y + clusters[y].x * 0.3);
    });
  for (const s of starts) {
    for (;;) {
      const free = (byNode.get(s) ?? []).filter((e) => !used.has(e));
      if (!free.length) break;
      let node = s;
      let stroke: Pt[] = [];
      let e: Edge | undefined = free[0];
      while (e) {
        used.add(e);
        const pts = oriented(e, node);
        stroke = stroke.length ? stroke.concat(pts.slice(1)) : pts.slice();
        node = e.a === node ? e.b : e.a;
        if (node < 0) break;
        const tail = stroke.slice(-7);
        const din = dirOut(tail.slice().reverse()).map((v) => -v) as Pt;
        const cand = (byNode.get(node) ?? []).filter((x) => !used.has(x));
        let best: Edge | undefined, bestDot = -2;
        for (const c of cand) {
          const d = dirOut(oriented(c, node));
          const dot = d[0] * din[0] + d[1] * din[1];
          if (dot > bestDot) { bestDot = dot; best = c; }
        }
        // на развилке с острым поворотом лучше поднять ручку
        e = best && (bestDot > -0.3 || cand.length === 1) ? best : undefined;
      }
      strokes.push(stroke);
    }
  }
  // Узлы без рёбер — точки (ё, й, i, !)
  clusters.forEach((c, i) => { if (!(byNode.get(i)?.length)) strokes.push([[c.x, c.y]]); });
  return [...strokes, ...loops];
}

// ── Обработка листа ──────────────────────────────────────────────────

export interface CellResult {
  index: number;
  char: string;
  strokes: Pt[][];   // в единицах шрифта (Y вверх, базовая линия 0, заглавная 10)
  advance: number;
  flags: ('empty' | 'many' | 'small' | 'big')[];
  crop: Uint8Array;  // выровненная клетка (оттенки серого) для просмотра
  cropSize: number;
  shift: number;     // на сколько единиц сдвинута буква по X (для наложения на снимок)
}

export interface SheetResult {
  corners: Pt[];           // в координатах исходного фото
  preview: Gray;           // выпрямленный лист, 3 px/мм
  cells: CellResult[];
  threshold: number;
  pxPerMM: number;
}

export interface ProcessOptions {
  pxPerMM?: number;
  corners?: Pt[] | null;   // ручные углы (центры меток), ЛВ, ПВ, ПН, ЛН
  onProgress?: (stage: string, pct: number) => void;
}

export function processSheet(photo: Gray, chars: string[], opts: ProcessOptions = {}): SheetResult {
  const S = opts.pxPerMM ?? 7;
  const prog = opts.onProgress ?? (() => {});
  prog('Ищем метки по углам', 5);
  let corners = opts.corners ?? null;
  if (!corners) {
    const { img, k } = downscale(photo, 1100);
    const m = findMarkers(img);
    if (!m) throw new MarkersNotFound();
    corners = m.map(([x, y]) => [(x + 0.5) * k - 0.5, (y + 0.5) * k - 0.5] as Pt);
  }
  prog('Выпрямляем лист', 20);
  const H = homography(TPL.markers, corners);
  const warped = warp(photo, H, S);
  prog('Убираем тени', 40);
  const flat = flatten(warped, Math.round(4 * S));
  // Порог по области сетки
  const gx0 = Math.round(TPL.gridX * S), gy0 = Math.round(TPL.gridY * S);
  const gx1 = Math.round((TPL.gridX + TPL.cols * TPL.cell) * S), gy1 = Math.round((TPL.gridY + TPL.rows * TPL.cell) * S);
  const sample: number[] = [];
  for (let y = gy0; y < gy1; y += 2) for (let x = gx0; x < gx1; x += 2) sample.push(flat.d[y * flat.w + x]);
  const t = Math.max(70, Math.min(150, otsu(Uint8Array.from(sample))));
  prog('Распознаём буквы', 55);
  const cells: CellResult[] = [];
  chars.forEach((ch, i) => {
    cells.push(processCell(flat, i, ch, S, t));
    if (i % 10 === 0) prog('Распознаём буквы', 55 + (40 * i) / chars.length);
  });
  // превью 3 px/мм
  const pk = Math.max(1, Math.round(S / 3));
  const preview = downscale(flat, Math.ceil(Math.max(flat.w, flat.h) / pk)).img;
  prog('Готово', 100);
  return { corners, preview, cells, threshold: t, pxPerMM: S };
}

export class MarkersNotFound extends Error {
  constructor() { super('Не нашлись 4 чёрные метки по углам листа. Снимите лист целиком, ровно сверху, при хорошем свете — или отметьте углы вручную.'); }
}

export const CELL_INSET = 0.6;

export function processCell(flat: Gray, index: number, char: string, S: number, t: number): CellResult {
  const r = cellRect(index);
  const inset = CELL_INSET;
  const x0 = Math.round((r.x + inset) * S), y0 = Math.round((r.y + inset) * S);
  const cw = Math.round((r.w - 2 * inset) * S), ch = Math.round((r.h - 2 * inset) * S);
  const crop = new Uint8Array(cw * ch);
  const bin = new Uint8Array(cw * ch);
  for (let y = 0; y < ch; y++)
    for (let x = 0; x < cw; x++) {
      const v = flat.d[(y0 + y) * flat.w + x0 + x];
      crop[y * cw + x] = v;
      bin[y * cw + x] = v < t ? 1 : 0;
    }
  // Подпись буквы в левом верхнем углу (если вдруг прошла порог) — убираем зону 3×3 мм, если она не связана с буквой
  // Шум и остатки линий
  const comps = components(bin, cw, ch, true);
  const minArea = Math.max(5, (0.45 * S) ** 2 * 0.6);
  for (const c of comps) {
    const bw = c.maxX - c.minX + 1, bh = c.maxY - c.minY + 1;
    const lineLike = (bh <= Math.max(2, 0.35 * S) && bw > cw * 0.5) || (bw <= Math.max(2, 0.35 * S) && bh > ch * 0.85);
    const label = c.maxX < 3.2 * S && c.maxY < 3.0 * S && c.area < (1.6 * S) ** 2 * 0.5;
    if (c.area < minArea || lineLike || label) for (const p of c.pixels!) bin[p] = 0;
  }
  // Закрытие (заполнить мелкие дырки от шарика ручки)
  const sk = closing(bin, cw, ch);
  const blobs = components(sk, cw, ch, true);
  thin(sk, cw, ch);
  // Утончение может целиком стереть маленькую точку (ё, й, :, !) — возвращаем её центр
  for (const c of blobs) {
    if (c.pixels!.some((p) => sk[p])) continue;
    sk[Math.round(c.cy) * cw + Math.round(c.cx)] = 1;
  }
  const raw = traceSkeleton(sk, cw, ch, Math.round(1.0 * S));
  // В единицы шрифта
  const toU = ([px, py]: Pt): Pt => {
    const mmX = (x0 + px + 0.5) / S - r.x;
    const mmY = (y0 + py + 0.5) / S - r.y;
    return [mmX / TPL.unitMM, (TPL.base - mmY) / TPL.unitMM];
  };
  let strokes = raw
    // совсем короткие штрихи — это точки: заменяем их центром
    .map((s) => (s.length > 1 && pathLen(s) < 0.5 * S ? [[s.reduce((q, p) => q + p[0], 0) / s.length, s.reduce((q, p) => q + p[1], 0) / s.length] as Pt] : s))
    .map((s) => (s.length > 2 ? chaikin(simplify(s, 0.9), 2) : s).map(toU))
    .map((s) => (s.length > 2 ? simplify(s, 0.06) : s));
  // Направление: сверху вниз, слева направо (как пишут люди)
  strokes = strokes.map((s) => {
    if (s.length < 2) return s;
    const a = s[0], b = s[s.length - 1];
    if (Math.hypot(a[0] - b[0], a[1] - b[1]) < 0.3) return s; // петля
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const flip = Math.abs(dy) > Math.abs(dx) ? dy > 0 : dx < 0;
    return flip ? s.slice().reverse() : s;
  });
  // Порядок: слева направо, мелкие точки — в конце
  const big = (s: Pt[]) => s.length > 1 && pathLen(s) > 1.2;
  strokes.sort((a, b) => (big(a) === big(b) ? Math.min(...a.map((p) => p[0])) - Math.min(...b.map((p) => p[0])) : big(a) ? -1 : 1));
  // Нормализация по ширине: левый край → 0.3
  const flags: CellResult['flags'] = [];
  let advance = 6, shift = 0;
  if (!strokes.length) flags.push('empty');
  else {
    const xs = strokes.flat().map((p) => p[0]), ys = strokes.flat().map((p) => p[1]);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    shift = 0.3 - minX;
    strokes = strokes.map((s) => s.map(([x, y]) => [x + shift, y] as Pt));
    advance = maxX - minX + 0.9;
    const hgt = Math.max(...ys) - Math.min(...ys);
    if (strokes.length > 8) flags.push('many');
    if (hgt < 1.5 && maxX - minX < 1.5 && !'.,:;\'"-'.includes(char)) flags.push('small');
    if (Math.max(...ys) > 14 || Math.min(...ys) < -5.5) flags.push('big');
  }
  return { index, char, strokes, advance, flags, crop, cropSize: cw, shift };
}

const pathLen = (s: Pt[]) => { let l = 0; for (let i = 1; i < s.length; i++) l += Math.hypot(s[i][0] - s[i - 1][0], s[i][1] - s[i - 1][1]); return l; };

function dilate(b: Uint8Array, w: number, h: number): Uint8Array {
  const o = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let v = 0;
      for (let dy = -1; dy <= 1 && !v; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx >= 0 && yy >= 0 && xx < w && yy < h && b[yy * w + xx]) { v = 1; break; }
      }
      o[y * w + x] = v;
    }
  return o;
}
const invert = (b: Uint8Array) => b.map((v) => (v ? 0 : 1));
/** Морфологическое закрытие 3×3: заполняет мелкие дырки и разрывы в линии. */
export function closing(b: Uint8Array, w: number, h: number): Uint8Array {
  return invert(dilate(invert(dilate(b, w, h)), w, h));
}
