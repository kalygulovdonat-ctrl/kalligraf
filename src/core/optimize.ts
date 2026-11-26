// Оптимизация порядка путей: меньше холостых переездов с поднятой ручкой.
import { dist, simplify, type Path, type Pt } from './geometry';

export interface OptimizeOptions {
  merge: boolean;          // склеивать пути, у которых конец = начало
  mergeTol: number;        // допуск склейки, мм
  reorder: boolean;        // менять порядок путей
  twoOpt: boolean;         // улучшение 2-opt
  timeBudgetMs: number;
  simplifyTol: number;     // упрощение точек, мм (0 — выкл.)
}

export const defaultOptimize: OptimizeOptions = {
  merge: true, mergeTol: 0.3, reorder: true, twoOpt: true, timeBudgetMs: 250, simplifyTol: 0.02,
};

const first = (p: Path) => p.points[0];
const last = (p: Path) => p.points[p.points.length - 1];
const reversed = (p: Path): Path => ({ ...p, points: p.points.slice().reverse() });

/** Длина холостого хода при заданном порядке, начиная из точки start. */
export function travelLength(paths: Path[], start: Pt = [0, 0]): number {
  let pos = start, s = 0;
  for (const p of paths) {
    if (!p.points.length) continue;
    s += dist(pos, first(p));
    pos = last(p);
  }
  return s + dist(pos, start);
}

/** Склеивает соседние (по порядку) пути, если конец совпадает с началом. */
export function mergeAdjacent(paths: Path[], tol: number): Path[] {
  const out: Path[] = [];
  for (const p of paths) {
    if (!p.points.length) continue;
    const prev = out[out.length - 1];
    if (prev && prev.color === p.color && dist(last(prev), first(p)) <= tol) {
      prev.points = prev.points.concat(p.points.slice(1));
    } else out.push({ ...p, points: p.points.slice() });
  }
  return out;
}

/** Жадный «ближайший сосед» с возможностью пройти путь в обратную сторону. Сетка ускоряет поиск. */
export function nearestNeighbor(paths: Path[], start: Pt): Path[] {
  const n = paths.length;
  if (n < 2) return paths.slice();
  const cell = 10;
  const grid = new Map<string, number[]>();
  const key = (x: number, y: number) => `${Math.floor(x / cell)},${Math.floor(y / cell)}`;
  const add = (i: number, p: Pt) => {
    const k = key(p[0], p[1]);
    let arr = grid.get(k);
    if (!arr) grid.set(k, (arr = []));
    arr.push(i);
  };
  paths.forEach((p, i) => { add(i, first(p)); add(i, last(p)); });
  const used = new Uint8Array(n);
  const out: Path[] = [];
  let pos = start;
  for (let step = 0; step < n; step++) {
    let best = -1, bestD = Infinity, bestRev = false;
    const cx = Math.floor(pos[0] / cell), cy = Math.floor(pos[1] / cell);
    for (let r = 0; r < 1000; r++) {
      for (let gx = cx - r; gx <= cx + r; gx++)
        for (let gy = cy - r; gy <= cy + r; gy++) {
          if (Math.max(Math.abs(gx - cx), Math.abs(gy - cy)) !== r) continue;
          const arr = grid.get(`${gx},${gy}`);
          if (!arr) continue;
          for (const i of arr) {
            if (used[i]) continue;
            const d1 = dist(pos, first(paths[i]));
            const d2 = dist(pos, last(paths[i]));
            if (d1 < bestD) { bestD = d1; best = i; bestRev = false; }
            if (d2 < bestD) { bestD = d2; best = i; bestRev = true; }
          }
        }
      // Любая точка в кольце r+1 дальше, чем r*cell — можно остановиться
      if (best >= 0 && bestD <= r * cell) break;
      if (r > 0 && grid.size > 0 && r * cell > 5000) break;
    }
    if (best < 0) {
      for (let i = 0; i < n; i++) if (!used[i]) { best = i; break; }
    }
    used[best] = 1;
    const p = bestRev ? reversed(paths[best]) : paths[best];
    out.push(p);
    pos = last(p);
  }
  return out;
}

/** 2-opt: разворот отрезка последовательности (с разворотом каждого пути) пока есть выигрыш. */
export function twoOpt(paths: Path[], start: Pt, budgetMs: number): Path[] {
  const n = paths.length;
  if (n < 3 || n > 3000) return paths;
  const arr = paths.slice();
  const t0 = performance.now();
  const endOf = (i: number): Pt => (i < 0 ? start : last(arr[i]));
  const startOf = (i: number): Pt => (i >= n ? start : first(arr[i]));
  let improved = true;
  while (improved) {
    improved = false;
    for (let i = -1; i < n - 2; i++) {
      if (performance.now() - t0 > budgetMs) return arr;
      const a = endOf(i), b = startOf(i + 1);
      const dab = dist(a, b);
      for (let j = i + 2; j < n; j++) {
        const c = endOf(j), d = startOf(j + 1);
        const delta = dist(a, c) + dist(b, d) - dab - dist(c, d);
        if (delta < -1e-6) {
          // развернуть arr[i+1..j]
          let lo = i + 1, hi = j;
          while (lo < hi) {
            const t = arr[lo]; arr[lo] = reversed(arr[hi]); arr[hi] = reversed(t);
            lo++; hi--;
          }
          if (lo === hi) arr[lo] = reversed(arr[lo]);
          improved = true;
          break;
        }
      }
    }
  }
  return arr;
}

export interface OptimizeReport {
  travelBefore: number;
  travelAfter: number;
  pathsBefore: number;
  pathsAfter: number;
}

/**
 * Оптимизирует пути. Если переданы группы (слова текста), порядок групп сохраняется,
 * а оптимизируется только порядок внутри группы — так текст пишется «по-человечески».
 */
export function optimizePaths(
  paths: Path[], opts: OptimizeOptions, start: Pt = [0, 0], groups?: number[],
): { paths: Path[]; report: OptimizeReport } {
  const clean = paths.filter((p) => p.points.length > 0);
  const travelBefore = travelLength(clean, start);
  let result: Path[];
  const prep = (ps: Path[]) => (opts.simplifyTol > 0 ? ps.map((p) => ({ ...p, points: simplify(p.points, opts.simplifyTol) })) : ps);

  // Цвета (слои) не смешиваем: каждый цвет — отдельный проход со сменой ручки
  const byColor = new Map<string, { p: Path; g: number }[]>();
  clean.forEach((p, i) => {
    const k = p.color ?? '';
    if (!byColor.has(k)) byColor.set(k, []);
    byColor.get(k)!.push({ p, g: groups ? groups[i] ?? 0 : 0 });
  });

  result = [];
  let pos = start;
  for (const items of byColor.values()) {
    let chunks: Path[][];
    if (groups) {
      chunks = [];
      let curG = NaN;
      for (const it of items) {
        if (it.g !== curG) { chunks.push([]); curG = it.g; }
        chunks[chunks.length - 1].push(it.p);
      }
    } else chunks = [items.map((i) => i.p)];
    for (let chunk of chunks) {
      chunk = prep(chunk);
      if (opts.merge) chunk = mergeAdjacent(chunk, opts.mergeTol);
      if (opts.reorder) {
        chunk = nearestNeighbor(chunk, pos);
        if (opts.twoOpt) chunk = twoOpt(chunk, pos, groups ? 20 : opts.timeBudgetMs);
        if (opts.merge) chunk = mergeAdjacent(chunk, opts.mergeTol);
      }
      result.push(...chunk);
      if (chunk.length) pos = last(chunk[chunk.length - 1]);
    }
  }
  return {
    paths: result,
    report: { travelBefore, travelAfter: travelLength(result, start), pathsBefore: clean.length, pathsAfter: result.length },
  };
}
