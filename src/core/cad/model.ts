// Модель чертежа: объекты, слои, типы линий (ГОСТ 2.303), превращение в пути для ручки.
// Координаты хранятся в мм листа (ось Y вниз, начало — левый верхний угол листа).
// Углы — в радианах в координатах листа: рост угла = по часовой стрелке на экране.
import { dashPath, type Path, type Pt } from '../geometry';

export type LineType = 'main' | 'thin' | 'dashed' | 'center' | 'phantom';

export const LINE_TYPES: Record<LineType, { name: string; dash: number[] }> = {
  main: { name: 'Сплошная основная', dash: [] },
  thin: { name: 'Сплошная тонкая', dash: [] },
  dashed: { name: 'Штриховая', dash: [5, 1.8] },
  center: { name: 'Штрихпунктирная тонкая', dash: [14, 2.5, 0.4, 2.5] },
  phantom: { name: 'Штрихпунктирная с двумя точками', dash: [16, 2.5, 0.4, 2.5, 0.4, 2.5] },
};

export interface Layer { id: string; name: string; color: string; visible: boolean; locked: boolean }

interface Base { id: string; layer: string; lt: LineType }
export type DimKind = 'linear' | 'aligned' | 'radius' | 'diameter' | 'angular';

export type Entity = Base & (
  | { t: 'line'; a: Pt; b: Pt }
  | { t: 'pline'; pts: Pt[]; closed: boolean }
  | { t: 'circle'; c: Pt; r: number }
  | { t: 'arc'; c: Pt; r: number; a0: number; a1: number } // от a0 до a1 (a1 > a0)
  | { t: 'ellipse'; c: Pt; rx: number; ry: number; rot: number }
  | { t: 'spline'; pts: Pt[]; closed: boolean }
  | { t: 'point'; p: Pt }
  | { t: 'text'; p: Pt; text: string; h: number; rot: number } // p — левый край базовой линии
  | { t: 'dim'; kind: DimKind; p1: Pt; p2: Pt; p3: Pt; p4?: Pt; text?: string }
  | { t: 'hatch'; pts: Pt[]; holes?: Pt[][]; angle: number; step: number } // holes — «острова» (отверстия)
);

export type EntityOf<T extends Entity['t']> = Extract<Entity, { t: T }>;

export interface CadDoc {
  entities: Entity[];
  layers: Layer[];
  currentLayer: string;
  page: number;
  scale: number;        // масштаб чертежа: 1 — 1:1, 0.5 — 1:2, 2 — 2:1 (размер на листе = натура × scale)
  dimText: number;      // высота размерных чисел, мм (ГОСТ: 3.5)
  boldMain: boolean;    // основная линия — двойным проходом (толще)
}

export const defaultCad = (): CadDoc => ({
  entities: [],
  layers: [
    { id: 'L0', name: 'Основной', color: '', visible: true, locked: false },
    { id: 'L1', name: 'Осевые', color: '#e03131', visible: true, locked: false },
    { id: 'L2', name: 'Размеры', color: '#1971c2', visible: true, locked: false },
  ],
  currentLayer: 'L0',
  page: 0,
  scale: 1,
  dimText: 3.5,
  boldMain: false,
});

export const TAU = Math.PI * 2;
export const normAngle = (a: number) => ((a % TAU) + TAU) % TAU;
export const polar = (c: Pt, r: number, a: number): Pt => [c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)];
export const angleOf = (c: Pt, p: Pt) => Math.atan2(p[1] - c[1], p[0] - c[0]);

/** Окружность через 3 точки. */
export function circleFrom3(p1: Pt, p2: Pt, p3: Pt): { c: Pt; r: number } | null {
  const ax = p1[0], ay = p1[1], bx = p2[0], by = p2[1], cx = p3[0], cy = p3[1];
  const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
  if (Math.abs(d) < 1e-9) return null;
  const ux = ((ax * ax + ay * ay) * (by - cy) + (bx * bx + by * by) * (cy - ay) + (cx * cx + cy * cy) * (ay - by)) / d;
  const uy = ((ax * ax + ay * ay) * (cx - bx) + (bx * bx + by * by) * (ax - cx) + (cx * cx + cy * cy) * (bx - ax)) / d;
  return { c: [ux, uy], r: Math.hypot(ax - ux, ay - uy) };
}

/** Дуга через начало, точку на дуге и конец. */
export function arcFrom3(s: Pt, m: Pt, e: Pt): { c: Pt; r: number; a0: number; a1: number } | null {
  const cr = circleFrom3(s, m, e);
  if (!cr) return null;
  const as = angleOf(cr.c, s), am = angleOf(cr.c, m), ae = angleOf(cr.c, e);
  // по возрастанию угла от s: попадает ли m до e?
  const dm = normAngle(am - as), de = normAngle(ae - as);
  if (dm < de) return { ...cr, a0: as, a1: as + de };
  return { ...cr, a0: ae, a1: ae + normAngle(as - ae) };
}

/** Количество отрезков для дуги, чтобы погрешность хорды была ≤ tol мм. */
const arcSegs = (r: number, sweep: number, tol = 0.02) => {
  const step = 2 * Math.acos(Math.max(-1, Math.min(1, 1 - tol / Math.max(r, tol))));
  return Math.max(4, Math.min(720, Math.ceil(Math.abs(sweep) / Math.max(step, 0.01))));
};

export function arcPoints(c: Pt, r: number, a0: number, a1: number): Pt[] {
  const n = arcSegs(r, a1 - a0);
  return Array.from({ length: n + 1 }, (_, i) => polar(c, r, a0 + ((a1 - a0) * i) / n));
}

/** Сплайн Катмулла–Рома через точки. */
export function splinePoints(pts: Pt[], closed: boolean): Pt[] {
  if (pts.length < 3) return pts.slice();
  const P = closed ? [pts[pts.length - 1], ...pts, pts[0], pts[1]] : [pts[0], ...pts, pts[pts.length - 1]];
  const out: Pt[] = [];
  const segs = closed ? pts.length : pts.length - 1;
  for (let i = 0; i < segs; i++) {
    const p0 = P[i], p1 = P[i + 1], p2 = P[i + 2], p3 = P[i + 3];
    const n = Math.max(6, Math.ceil(Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) / 0.6));
    for (let k = 0; k < n; k++) {
      const t = k / n, t2 = t * t, t3 = t2 * t;
      out.push([
        0.5 * (2 * p1[0] + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3),
        0.5 * (2 * p1[1] + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3),
      ]);
    }
  }
  out.push(closed ? out[0] : pts[pts.length - 1]);
  return out;
}

export function ellipsePoints(c: Pt, rx: number, ry: number, rot: number, a0 = 0, a1 = TAU): Pt[] {
  const n = arcSegs(Math.max(rx, ry), a1 - a0);
  const cs = Math.cos(rot), sn = Math.sin(rot);
  return Array.from({ length: n + 1 }, (_, i) => {
    const t = a0 + ((a1 - a0) * i) / n;
    const x = rx * Math.cos(t), y = ry * Math.sin(t);
    return [c[0] + x * cs - y * sn, c[1] + x * sn + y * cs] as Pt;
  });
}

/**
 * Геометрия объекта как набор ломаных (без учёта типа линии). Для размеров, текста и штриховки
 * используется отдельная отрисовка (annotate.ts), здесь — только «контур» для привязок и пересечений.
 */
export function shapeOf(e: Entity): Pt[][] {
  switch (e.t) {
    case 'line': return [[e.a, e.b]];
    case 'pline': return [e.closed && e.pts.length > 2 ? [...e.pts, e.pts[0]] : e.pts];
    case 'circle': return [arcPoints(e.c, e.r, 0, TAU)];
    case 'arc': return [arcPoints(e.c, e.r, e.a0, e.a1)];
    case 'ellipse': return [ellipsePoints(e.c, e.rx, e.ry, e.rot)];
    case 'spline': return [splinePoints(e.pts, e.closed)];
    case 'point': return [[e.p]];
    default: return [];
  }
}

/** Применение типа линии (пунктир настоящими разрывами) и «жирной» основной линии. */
export function styleLines(lines: Pt[][], lt: LineType, bold: boolean): Pt[][] {
  const dash = LINE_TYPES[lt].dash;
  let out = dash.length ? lines.flatMap((l) => (l.length > 1 ? dashPath(l, dash) : [l])) : lines;
  if (lt === 'main' && bold) out = out.flatMap((l) => (l.length > 1 ? [l, offsetPolyline(l, 0.25, false)] : [l]));
  return out;
}

/** Смещение ломаной на d (положительное — влево по ходу в координатах листа). Стыки — со срезом острых углов. */
export function offsetPolyline(pts: Pt[], d: number, closed: boolean): Pt[] {
  const n = pts.length;
  if (n < 2) return pts.slice();
  const P = closed && dist2(pts[0], pts[n - 1]) < 1e-12 ? pts.slice(0, -1) : pts;
  const m = P.length;
  const normal = (a: Pt, b: Pt): Pt => {
    const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1;
    return [dy / l, -dx / l];
  };
  const out: Pt[] = [];
  for (let i = 0; i < m; i++) {
    const prev = i > 0 ? P[i - 1] : closed ? P[m - 1] : null;
    const next = i < m - 1 ? P[i + 1] : closed ? P[0] : null;
    const n1 = prev ? normal(prev, P[i]) : null, n2 = next ? normal(P[i], next) : null;
    if (n1 && n2) {
      const bx = n1[0] + n2[0], by = n1[1] + n2[1];
      const bl = Math.hypot(bx, by);
      const cos = (n1[0] * n2[0] + n1[1] * n2[1]);
      if (bl < 1e-9) { out.push([P[i][0] + n1[0] * d, P[i][1] + n1[1] * d]); continue; }
      const k = d / Math.max(0.25, (1 + cos) / 2) ** 0.5; // ограничение «усов» на острых углах
      out.push([P[i][0] + (bx / bl) * k, P[i][1] + (by / bl) * k]);
    } else {
      const nn = (n1 ?? n2)!;
      out.push([P[i][0] + nn[0] * d, P[i][1] + nn[1] * d]);
    }
  }
  if (closed) out.push(out[0]);
  return out;
}
const dist2 = (a: Pt, b: Pt) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;

/** Все видимые объекты → пути для ручки (с цветом слоя). */
export function cadToPaths(cad: CadDoc, annotate: (e: Entity, cad: CadDoc) => Pt[][]): Path[] {
  const layers = new Map(cad.layers.map((l) => [l.id, l]));
  const out: Path[] = [];
  for (const e of cad.entities) {
    const L = layers.get(e.layer);
    if (L && !L.visible) continue;
    const color = L?.color || undefined;
    let lines: Pt[][];
    if (e.t === 'dim' || e.t === 'text' || e.t === 'hatch') lines = annotate(e, cad);
    else lines = styleLines(shapeOf(e), e.lt, cad.boldMain);
    for (const l of lines) if (l.length) out.push({ points: l, color, layer: L?.name });
  }
  return out;
}

export function bboxOfEntity(e: Entity, annotate?: (e: Entity) => Pt[][]): { minX: number; minY: number; maxX: number; maxY: number } {
  const lines = e.t === 'dim' || e.t === 'text' || e.t === 'hatch' ? (annotate ? annotate(e) : []) : shapeOf(e);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const l of lines) for (const [x, y] of l) { if (x < minX) minX = x; if (y < minY) minY = y; if (x > maxX) maxX = x; if (y > maxY) maxY = y; }
  if (e.t === 'hatch') for (const [x, y] of e.pts) { if (x < minX) minX = x; if (y < minY) minY = y; if (x > maxX) maxX = x; if (y > maxY) maxY = y; }
  return { minX, minY, maxX, maxY };
}
