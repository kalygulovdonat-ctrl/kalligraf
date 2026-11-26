// Базовая геометрия. Все координаты на листе — миллиметры, ось Y вниз.

export type Pt = [number, number];
export type Stroke = Pt[];

/** Путь, который ручка проходит, не поднимаясь. */
export interface Path {
  points: Pt[];
  color?: string;
  layer?: string;
}

export interface BBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export const dist = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1]);

export function pathLength(points: Pt[]): number {
  let s = 0;
  for (let i = 1; i < points.length; i++) s += dist(points[i - 1], points[i]);
  return s;
}

export function bboxOf(paths: { points: Pt[] }[]): BBox | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of paths)
    for (const [x, y] of p.points) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  return minX === Infinity ? null : { minX, minY, maxX, maxY };
}

/** Алгоритм Рамера–Дугласа–Пекера (итеративный, без рекурсии). */
export function simplify(points: Pt[], tol: number): Pt[] {
  if (points.length < 3 || tol <= 0) return points.slice();
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const [ax, ay] = points[a];
    const [bx, by] = points[b];
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let maxD = -1, idx = -1;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = points[i];
      let d: number;
      if (len2 === 0) d = Math.hypot(px - ax, py - ay);
      else {
        const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
        d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
      }
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > tol) {
      keep[idx] = 1;
      stack.push([a, idx], [idx, b]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

/** Сглаживание Чайкина (концы сохраняются). */
export function chaikin(points: Pt[], iterations = 1): Pt[] {
  let pts = points;
  for (let k = 0; k < iterations; k++) {
    if (pts.length < 3) return pts;
    const out: Pt[] = [pts[0]];
    for (let i = 0; i < pts.length - 1; i++) {
      const [x0, y0] = pts[i], [x1, y1] = pts[i + 1];
      out.push([0.75 * x0 + 0.25 * x1, 0.75 * y0 + 0.25 * y1]);
      out.push([0.25 * x0 + 0.75 * x1, 0.25 * y0 + 0.75 * y1]);
    }
    out.push(pts[pts.length - 1]);
    pts = out;
  }
  return pts;
}

/** Аффинное преобразование: x' = a*x + c*y + e, y' = b*x + d*y + f. */
export interface Mat { a: number; b: number; c: number; d: number; e: number; f: number }
export const applyMat = (m: Mat, [x, y]: Pt): Pt => [m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f];

export function transformPaths(paths: Path[], fn: (p: Pt) => Pt): Path[] {
  return paths.map((p) => ({ ...p, points: p.points.map(fn) }));
}

/** Делит длинные отрезки, чтобы деформации (дрожание, волна) выглядели плавно. */
export function densify(points: Pt[], maxSeg: number): Pt[] {
  if (points.length < 2) return points.slice();
  const out: Pt[] = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    const n = Math.max(1, Math.ceil(dist(a, b) / maxSeg));
    for (let k = 1; k <= n; k++) out.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
  }
  return out;
}

/** Обрезка ломаной прямоугольником (Коэн–Сазерленд по отрезкам). */
export function clipPath(points: Pt[], box: BBox): Pt[][] {
  const out: Pt[][] = [];
  let cur: Pt[] = [];
  const inside = (p: Pt) => p[0] >= box.minX && p[0] <= box.maxX && p[1] >= box.minY && p[1] <= box.maxY;
  for (let i = 0; i < points.length - 1; i++) {
    const seg = clipSegment(points[i], points[i + 1], box);
    if (!seg) {
      if (cur.length > 1) out.push(cur);
      cur = [];
      continue;
    }
    const [a, b] = seg;
    if (cur.length === 0 || dist(cur[cur.length - 1], a) > 1e-9) {
      if (cur.length > 1) out.push(cur);
      cur = [a];
    }
    cur.push(b);
    if (!inside(points[i + 1])) {
      if (cur.length > 1) out.push(cur);
      cur = [];
    }
  }
  if (cur.length > 1) out.push(cur);
  if (points.length === 1 && inside(points[0])) out.push([points[0]]);
  return out;
}

function clipSegment(p0: Pt, p1: Pt, b: BBox): [Pt, Pt] | null {
  // Лиан–Барски
  let t0 = 0, t1 = 1;
  const dx = p1[0] - p0[0], dy = p1[1] - p0[1];
  const checks: [number, number][] = [
    [-dx, p0[0] - b.minX], [dx, b.maxX - p0[0]],
    [-dy, p0[1] - b.minY], [dy, b.maxY - p0[1]],
  ];
  for (const [p, q] of checks) {
    if (p === 0) { if (q < 0) return null; continue; }
    const r = q / p;
    if (p < 0) { if (r > t1) return null; if (r > t0) t0 = r; }
    else { if (r < t0) return null; if (r < t1) t1 = r; }
  }
  return [[p0[0] + t0 * dx, p0[1] + t0 * dy], [p0[0] + t1 * dx, p0[1] + t1 * dy]];
}

/** Пунктир: делит путь на штрихи по образцу [штрих, пробел, ...] в мм. */
export function dashPath(points: Pt[], pattern: number[]): Pt[][] {
  if (!pattern.length) return [points];
  const out: Pt[][] = [];
  let pi = 0, left = pattern[0], on = true;
  let cur: Pt[] = on ? [points[0]] : [];
  for (let i = 1; i < points.length; i++) {
    let a = points[i - 1];
    const b = points[i];
    let segLen = dist(a, b);
    while (segLen > 1e-9) {
      const step = Math.min(left, segLen);
      const t = step / segLen;
      const m: Pt = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      if (on) cur.push(m);
      left -= step; segLen -= step; a = m;
      if (left <= 1e-9) {
        if (on && cur.length > 1) out.push(cur);
        on = !on; pi = (pi + 1) % pattern.length; left = pattern[pi];
        cur = on ? [a] : [];
      }
    }
  }
  if (on && cur.length > 1) out.push(cur);
  return out;
}
