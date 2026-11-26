// Операции чертежа: попадание, привязки, пересечения, преобразования, смещение, обрезка, удлинение, массивы.
import type { Pt } from '../geometry';
import { annotate } from './annotate';
import {
  angleOf, arcFrom3, bboxOfEntity, normAngle, offsetPolyline, polar, shapeOf, splinePoints, TAU, ellipsePoints,
  type CadDoc, type Entity, type EntityOf,
} from './model';

export const newId = () => 'e' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

const sub = (a: Pt, b: Pt): Pt => [a[0] - b[0], a[1] - b[1]];
const len = (a: Pt) => Math.hypot(a[0], a[1]);
export const dist = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1]);

export function distToSeg(p: Pt, a: Pt, b: Pt): { d: number; t: number; q: Pt } {
  const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy;
  const t = L2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2)) : 0;
  const q: Pt = [a[0] + t * dx, a[1] + t * dy];
  return { d: dist(p, q), t, q };
}

/** Ломаные объекта для попадания/пересечений (для размеров и текстов — их оформление). */
export function outline(e: Entity, cad: CadDoc): Pt[][] {
  if (e.t === 'dim' || e.t === 'text') return annotate(e, cad);
  if (e.t === 'hatch') return [[...e.pts, e.pts[0]]];
  return shapeOf(e);
}

export function distToEntity(p: Pt, e: Entity, cad: CadDoc): number {
  if (e.t === 'circle') return Math.abs(dist(p, e.c) - e.r);
  if (e.t === 'line') return distToSeg(p, e.a, e.b).d;
  let best = Infinity;
  for (const l of outline(e, cad)) {
    if (l.length === 1) best = Math.min(best, dist(p, l[0]));
    for (let i = 1; i < l.length; i++) best = Math.min(best, distToSeg(p, l[i - 1], l[i]).d);
  }
  return best;
}

export function hitTest(p: Pt, cad: CadDoc, tol: number, filter?: (e: Entity) => boolean): Entity | null {
  const vis = new Set(cad.layers.filter((l) => l.visible && !l.locked).map((l) => l.id));
  let best: Entity | null = null, bd = tol;
  for (let i = cad.entities.length - 1; i >= 0; i--) {
    const e = cad.entities[i];
    if (!vis.has(e.layer) || (filter && !filter(e))) continue;
    // штриховка совпадает с контуром — уступает ему при равном расстоянии
    const d = distToEntity(p, e, cad) + (e.t === 'hatch' ? tol * 0.5 : 0);
    if (d < bd) { bd = d; best = e; }
  }
  return best;
}

export function entitiesInBox(cad: CadDoc, a: Pt, b: Pt, crossing: boolean): Entity[] {
  const minX = Math.min(a[0], b[0]), maxX = Math.max(a[0], b[0]), minY = Math.min(a[1], b[1]), maxY = Math.max(a[1], b[1]);
  const vis = new Set(cad.layers.filter((l) => l.visible && !l.locked).map((l) => l.id));
  return cad.entities.filter((e) => {
    if (!vis.has(e.layer)) return false;
    const bb = bboxOfEntity(e, (x) => annotate(x, cad));
    if (!crossing) return bb.minX >= minX && bb.maxX <= maxX && bb.minY >= minY && bb.maxY <= maxY;
    return bb.maxX >= minX && bb.minX <= maxX && bb.maxY >= minY && bb.minY <= maxY;
  });
}

// ── Пересечения ──────────────────────────────────────────────────────

export function segSeg(a: Pt, b: Pt, c: Pt, d: Pt): { p: Pt; t: number; u: number } | null {
  const r = sub(b, a), s = sub(d, c);
  const den = r[0] * s[1] - r[1] * s[0];
  if (Math.abs(den) < 1e-12) return null;
  const ac = sub(c, a);
  const t = (ac[0] * s[1] - ac[1] * s[0]) / den;
  const u = (ac[0] * r[1] - ac[1] * r[0]) / den;
  if (t < -1e-9 || t > 1 + 1e-9 || u < -1e-9 || u > 1 + 1e-9) return null;
  return { p: [a[0] + t * r[0], a[1] + t * r[1]], t, u };
}

/** Точки пересечения двух объектов (по ломаным с высокой точностью). */
export function intersections(e1: Entity, e2: Entity, cad: CadDoc): Pt[] {
  if (e1 === e2) return [];
  const A = outline(e1, cad), B = outline(e2, cad);
  const out: Pt[] = [];
  for (const la of A) for (let i = 1; i < la.length; i++) {
    const a = la[i - 1], b = la[i];
    const ax0 = Math.min(a[0], b[0]), ax1 = Math.max(a[0], b[0]), ay0 = Math.min(a[1], b[1]), ay1 = Math.max(a[1], b[1]);
    for (const lb of B) for (let j = 1; j < lb.length; j++) {
      const c = lb[j - 1], d = lb[j];
      if (Math.max(c[0], d[0]) < ax0 - 1e-9 || Math.min(c[0], d[0]) > ax1 + 1e-9 || Math.max(c[1], d[1]) < ay0 - 1e-9 || Math.min(c[1], d[1]) > ay1 + 1e-9) continue;
      const x = segSeg(a, b, c, d);
      if (x && !out.some((q) => dist(q, x.p) < 1e-3)) out.push(x.p);
    }
  }
  return out;
}

// ── Привязки ─────────────────────────────────────────────────────────

export type SnapKind = 'end' | 'mid' | 'center' | 'quad' | 'int' | 'perp' | 'grid' | 'near';
export interface Snap { p: Pt; kind: SnapKind }
export interface SnapOpts { end: boolean; mid: boolean; center: boolean; quad: boolean; int: boolean; perp: boolean; near: boolean; grid: number }
export const defaultSnaps: SnapOpts = { end: true, mid: true, center: true, quad: true, int: true, perp: true, near: false, grid: 0 };

export function keyPoints(e: Entity, o: SnapOpts): Snap[] {
  const s: Snap[] = [];
  const add = (p: Pt, kind: SnapKind) => s.push({ p, kind });
  switch (e.t) {
    case 'line':
      if (o.end) { add(e.a, 'end'); add(e.b, 'end'); }
      if (o.mid) add([(e.a[0] + e.b[0]) / 2, (e.a[1] + e.b[1]) / 2], 'mid');
      break;
    case 'pline': {
      const pts = e.closed ? [...e.pts, e.pts[0]] : e.pts;
      if (o.end) e.pts.forEach((p) => add(p, 'end'));
      if (o.mid) for (let i = 1; i < pts.length; i++) add([(pts[i - 1][0] + pts[i][0]) / 2, (pts[i - 1][1] + pts[i][1]) / 2], 'mid');
      break;
    }
    case 'circle':
      if (o.center) add(e.c, 'center');
      if (o.quad) for (let k = 0; k < 4; k++) add(polar(e.c, e.r, (k * Math.PI) / 2), 'quad');
      break;
    case 'arc':
      if (o.center) add(e.c, 'center');
      if (o.end) { add(polar(e.c, e.r, e.a0), 'end'); add(polar(e.c, e.r, e.a1), 'end'); }
      if (o.mid) add(polar(e.c, e.r, (e.a0 + e.a1) / 2), 'mid');
      if (o.quad) for (let k = 0; k < 4; k++) { const a = (k * Math.PI) / 2; if (normAngle(a - e.a0) <= e.a1 - e.a0) add(polar(e.c, e.r, a), 'quad'); }
      break;
    case 'ellipse':
      if (o.center) add(e.c, 'center');
      if (o.quad) ellipsePoints(e.c, e.rx, e.ry, e.rot, 0, TAU).filter((_, i, arr) => i % Math.max(1, Math.floor((arr.length - 1) / 4)) === 0).forEach((p) => add(p, 'quad'));
      break;
    case 'spline':
      if (o.end) { add(e.pts[0], 'end'); add(e.pts[e.pts.length - 1], 'end'); }
      break;
    case 'point':
      if (o.end) add(e.p, 'end');
      break;
    case 'text':
      if (o.end) add(e.p, 'end');
      break;
    case 'hatch':
      if (o.end) e.pts.forEach((p) => add(p, 'end'));
      break;
    default:
      break;
  }
  return s;
}

/** Лучшая привязка к курсору в радиусе tol (мм). from — предыдущая точка (для перпендикуляра). */
export function findSnap(cur: Pt, cad: CadDoc, o: SnapOpts, tol: number, from?: Pt | null): Snap | null {
  const vis = new Set(cad.layers.filter((l) => l.visible).map((l) => l.id));
  const near = cad.entities.filter((e) => vis.has(e.layer) && e.t !== 'dim' && e.t !== 'hatch' &&
    (distToEntity(cur, e, cad) < tol * 3 || ((e.t === 'circle' || e.t === 'arc' || e.t === 'ellipse') && dist(cur, e.c) < tol * 3)));
  let best: Snap | null = null, bd = tol;
  const consider = (s: Snap, prio = 0) => { const d = dist(cur, s.p) - prio; if (d < bd) { bd = d; best = s; } };
  for (const e of near) for (const s of keyPoints(e, o)) consider(s, s.kind === 'end' || s.kind === 'center' ? tol * 0.15 : 0);
  if (o.int) for (let i = 0; i < near.length; i++) for (let j = i + 1; j < near.length; j++) for (const p of intersections(near[i], near[j], cad)) consider({ p, kind: 'int' }, tol * 0.1);
  if (o.perp && from) for (const e of near) {
    if (e.t === 'line') {
      const r = distToSeg(from, e.a, e.b);
      if (r.t > 0 && r.t < 1) consider({ p: r.q, kind: 'perp' });
    } else if (e.t === 'circle' || e.t === 'arc') {
      const a = angleOf(e.c, from);
      consider({ p: polar(e.c, e.r, a), kind: 'perp' });
    }
  }
  if (!best && o.near) {
    let bn = tol;
    for (const e of near) for (const l of outline(e, cad)) for (let i = 1; i < l.length; i++) {
      const r = distToSeg(cur, l[i - 1], l[i]);
      if (r.d < bn) { bn = r.d; best = { p: r.q, kind: 'near' }; }
    }
  }
  if (!best && o.grid > 0) {
    const g: Pt = [Math.round(cur[0] / o.grid) * o.grid, Math.round(cur[1] / o.grid) * o.grid];
    best = { p: g, kind: 'grid' };
  }
  return best;
}

// ── Преобразования ───────────────────────────────────────────────────

type Xf = (p: Pt) => Pt;

/** Применяет преобразование точек; angle — поворот (для текста/эллипса), mirror — отражение. */
export function transform(e: Entity, f: Xf, rot: number, mirror: boolean, scale = 1): Entity {
  const m = { ...e } as Entity;
  switch (m.t) {
    case 'line': m.a = f(m.a); m.b = f(m.b); break;
    case 'pline': case 'spline': m.pts = m.pts.map(f); break;
    case 'hatch': m.pts = m.pts.map(f); if (m.holes) m.holes = m.holes.map((h) => h.map(f)); break;
    case 'circle': m.c = f(m.c); m.r *= scale; break;
    case 'arc': {
      const s = f(polar(m.c, m.r, m.a0)), en = f(polar(m.c, m.r, m.a1)), mid = f(polar(m.c, m.r, (m.a0 + m.a1) / 2));
      const a = arcFrom3(s, mid, en);
      if (a) Object.assign(m, a);
      break;
    }
    case 'ellipse': m.c = f(m.c); m.rx *= scale; m.ry *= scale; m.rot = mirror ? -m.rot + rot : m.rot + rot; break;
    case 'point': m.p = f(m.p); break;
    case 'text': m.p = f(m.p); m.h *= scale; m.rot = mirror ? m.rot : m.rot + rot; break;
    case 'dim': m.p1 = f(m.p1); m.p2 = f(m.p2); m.p3 = f(m.p3); if (m.p4) m.p4 = f(m.p4); break;
  }
  if (m.t === 'hatch') m.angle = mirror ? -m.angle : m.angle + (rot * 180) / Math.PI;
  return m;
}

export const move = (e: Entity, d: Pt) => transform(e, (p) => [p[0] + d[0], p[1] + d[1]], 0, false);
export function rotate(e: Entity, c: Pt, a: number) {
  const cs = Math.cos(a), sn = Math.sin(a);
  return transform(e, (p) => [c[0] + (p[0] - c[0]) * cs - (p[1] - c[1]) * sn, c[1] + (p[0] - c[0]) * sn + (p[1] - c[1]) * cs], a, false);
}
export function scaleEnt(e: Entity, c: Pt, k: number) {
  return transform(e, (p) => [c[0] + (p[0] - c[0]) * k, c[1] + (p[1] - c[1]) * k], 0, false, k);
}
export function mirror(e: Entity, a: Pt, b: Pt) {
  const d = sub(b, a), L = len(d) || 1, u: Pt = [d[0] / L, d[1] / L];
  const f = (p: Pt): Pt => {
    const v = sub(p, a), t = v[0] * u[0] + v[1] * u[1];
    const q: Pt = [a[0] + u[0] * t, a[1] + u[1] * t];
    return [2 * q[0] - p[0], 2 * q[1] - p[1]];
  };
  const m = transform(e, f, 2 * Math.atan2(u[1], u[0]), true);
  // текст после зеркала остаётся читаемым (как в AutoCAD с MIRRTEXT=0): переносим начало строки
  return m;
}

export function arrayRect(es: Entity[], rows: number, cols: number, dx: number, dy: number): Entity[] {
  const out: Entity[] = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    if (!r && !c) continue;
    for (const e of es) out.push({ ...move(e, [c * dx, r * dy]), id: newId() });
  }
  return out;
}

export function arrayPolar(es: Entity[], center: Pt, count: number, totalDeg: number): Entity[] {
  const out: Entity[] = [];
  const full = Math.abs(totalDeg) >= 360 - 1e-9;
  const step = ((totalDeg * Math.PI) / 180) / (full ? count : Math.max(1, count - 1));
  for (let k = 1; k < count; k++) for (const e of es) out.push({ ...rotate(e, center, step * k), id: newId() });
  return out;
}

// ── Подобие (смещение) ───────────────────────────────────────────────

/** Смещение объекта на d в сторону точки side. */
export function offsetEntity(e: Entity, d: number, side: Pt): Entity | null {
  switch (e.t) {
    case 'line': {
      const v = sub(e.b, e.a), L = len(v) || 1;
      const n: Pt = [v[1] / L, -v[0] / L];
      const s = (side[0] - e.a[0]) * n[0] + (side[1] - e.a[1]) * n[1] >= 0 ? 1 : -1;
      return { ...e, id: newId(), a: [e.a[0] + n[0] * d * s, e.a[1] + n[1] * d * s], b: [e.b[0] + n[0] * d * s, e.b[1] + n[1] * d * s] };
    }
    case 'circle': {
      const r = dist(side, e.c) > e.r ? e.r + d : e.r - d;
      return r > 0 ? { ...e, id: newId(), r } : null;
    }
    case 'arc': {
      const r = dist(side, e.c) > e.r ? e.r + d : e.r - d;
      return r > 0 ? { ...e, id: newId(), r } : null;
    }
    case 'pline': case 'spline': {
      const pts = e.t === 'spline' ? splinePoints(e.pts, e.closed) : e.pts;
      // сторона — по ближайшему отрезку
      let bi = 0, bd = Infinity;
      const P = e.closed ? [...pts, pts[0]] : pts;
      for (let i = 1; i < P.length; i++) { const r = distToSeg(side, P[i - 1], P[i]); if (r.d < bd) { bd = r.d; bi = i; } }
      const a = P[bi - 1], b = P[bi];
      const cross = (b[0] - a[0]) * (side[1] - a[1]) - (b[1] - a[1]) * (side[0] - a[0]);
      // offsetPolyline: положительное d — нормаль (dy, -dx), это «левая» сторона в координатах листа
      const sgn = cross < 0 ? 1 : -1;
      const off = offsetPolyline(P, d * sgn, e.closed);
      const res = e.closed ? off.slice(0, -1) : off;
      return { id: newId(), layer: e.layer, lt: e.lt, t: 'pline', pts: res, closed: e.closed };
    }
    case 'ellipse': {
      const pts = ellipsePoints(e.c, e.rx, e.ry, e.rot);
      const inside = dist(side, e.c) < (e.rx + e.ry) / 2;
      const off = offsetPolyline(pts, inside ? d : -d, true);
      return { id: newId(), layer: e.layer, lt: e.lt, t: 'pline', pts: off.slice(0, -1), closed: true };
    }
    default: return null;
  }
}

// ── Обрезка и удлинение ──────────────────────────────────────────────

/** Точки разреза на объекте e от всех остальных (кроме размеров/текстов/штриховок). */
function cutters(e: Entity, cad: CadDoc): Pt[] {
  const pts: Pt[] = [];
  for (const o of cad.entities) {
    if (o === e || o.t === 'dim' || o.t === 'text' || o.t === 'hatch' || o.t === 'point') continue;
    pts.push(...intersections(e, o, cad));
  }
  if (e.t === 'pline' || e.t === 'spline') pts.push(...selfIntersections(outline(e, cad)[0]));
  return pts;
}

function selfIntersections(l: Pt[]): Pt[] {
  const out: Pt[] = [];
  for (let i = 1; i < l.length; i++) for (let j = i + 2; j < l.length; j++) {
    if (i === 1 && j === l.length - 1 && dist(l[0], l[l.length - 1]) < 1e-9) continue;
    const x = segSeg(l[i - 1], l[i], l[j - 1], l[j]);
    if (x) out.push(x.p);
  }
  return out;
}

/** Параметр точки вдоль ломаной (длина от начала). */
function paramOn(l: Pt[], p: Pt): number {
  let acc = 0, best = Infinity, bestS = 0;
  for (let i = 1; i < l.length; i++) {
    const r = distToSeg(p, l[i - 1], l[i]);
    const L = dist(l[i - 1], l[i]);
    if (r.d < best) { best = r.d; bestS = acc + r.t * L; }
    acc += L;
  }
  return bestS;
}

function subPolyline(l: Pt[], s0: number, s1: number): Pt[] {
  const out: Pt[] = [];
  let acc = 0;
  for (let i = 1; i < l.length; i++) {
    const a = l[i - 1], b = l[i], L = dist(a, b);
    const lo = acc, hi = acc + L;
    if (hi >= s0 && lo <= s1 && L > 0) {
      const t0 = Math.max(0, (s0 - lo) / L), t1 = Math.min(1, (s1 - lo) / L);
      const pa: Pt = [a[0] + (b[0] - a[0]) * t0, a[1] + (b[1] - a[1]) * t0];
      const pb: Pt = [a[0] + (b[0] - a[0]) * t1, a[1] + (b[1] - a[1]) * t1];
      if (!out.length) out.push(pa);
      out.push(pb);
    }
    acc = hi;
  }
  return out;
}

const totalLen = (l: Pt[]) => { let s = 0; for (let i = 1; i < l.length; i++) s += dist(l[i - 1], l[i]); return s; };

/**
 * Обрезка: удаляет участок объекта между соседними пересечениями, на который указали.
 * Возвращает объекты-замену (0, 1 или 2) или null, если резать нечем.
 */
export function trimEntity(e: Entity, pick: Pt, cad: CadDoc): Entity[] | null {
  const cuts = cutters(e, cad);
  if (!cuts.length) return null;
  const keep = (x: Partial<Entity> & { t: Entity['t'] }) => ({ ...x, id: newId(), layer: e.layer, lt: e.lt } as Entity);
  if (e.t === 'line') {
    const L = dist(e.a, e.b);
    const ts = cuts.map((p) => distToSeg(p, e.a, e.b).t * L).filter((s) => s > 1e-6 && s < L - 1e-6).sort((a, b) => a - b);
    if (!ts.length) return null;
    const sp = distToSeg(pick, e.a, e.b).t * L;
    const lo = Math.max(0, ...ts.filter((s) => s <= sp)), hi = Math.min(L, ...ts.filter((s) => s > sp));
    const at = (s: number): Pt => [e.a[0] + ((e.b[0] - e.a[0]) * s) / L, e.a[1] + ((e.b[1] - e.a[1]) * s) / L];
    const out: Entity[] = [];
    if (lo > 1e-6) out.push(keep({ t: 'line', a: e.a, b: at(lo) }));
    if (hi < L - 1e-6) out.push(keep({ t: 'line', a: at(hi), b: e.b }));
    return out;
  }
  if (e.t === 'circle' || e.t === 'arc') {
    const base = e.t === 'arc' ? e.a0 : 0;
    const span = e.t === 'arc' ? e.a1 - e.a0 : TAU;
    const rel = (p: Pt) => normAngle(angleOf(e.c, p) - base);
    const raw = cuts.map(rel).map((a) => (a > TAU - 1e-6 ? 0 : a));
    const as = (e.t === 'circle' ? raw : raw.filter((a) => a > 1e-6 && a < span - 1e-6))
      .sort((a, b) => a - b).filter((a, i, arr) => i === 0 || a - arr[i - 1] > 1e-6);
    if (!as.length) return null;
    const ap = rel(pick);
    if (e.t === 'circle') {
      if (as.length < 2) return null;
      // удаляем участок между соседними разрезами вокруг ap (по кругу)
      let lo = as[as.length - 1] - TAU, hi = as[0];
      for (let i = 0; i < as.length; i++) {
        const a = as[i], b = i + 1 < as.length ? as[i + 1] : as[0] + TAU;
        if ((ap >= a && ap < b) || (ap + TAU >= a && ap + TAU < b)) { lo = a; hi = b; }
      }
      return [keep({ t: 'arc', c: e.c, r: e.r, a0: hi, a1: lo + TAU })];
    }
    const lo = Math.max(0, ...as.filter((a) => a <= ap)), hi = Math.min(span, ...as.filter((a) => a > ap));
    const out: Entity[] = [];
    if (lo > 1e-6) out.push(keep({ t: 'arc', c: e.c, r: e.r, a0: base, a1: base + lo }));
    if (hi < span - 1e-6) out.push(keep({ t: 'arc', c: e.c, r: e.r, a0: base + hi, a1: base + span }));
    return out;
  }
  if (e.t === 'pline' || e.t === 'spline' || e.t === 'ellipse') {
    const l = outline(e, cad)[0];
    const L = totalLen(l);
    const closed = e.t === 'ellipse' ? true : e.closed;
    const ss = [...new Set(cuts.map((p) => paramOn(l, p)))].filter((s) => s > 1e-6 && s < L - 1e-6).sort((a, b) => a - b);
    if (!ss.length) return null;
    const sp = paramOn(l, pick);
    const out: Entity[] = [];
    if (!closed) {
      const lo = Math.max(0, ...ss.filter((s) => s <= sp)), hi = Math.min(L, ...ss.filter((s) => s > sp));
      if (lo > 1e-6) out.push(keep({ t: 'pline', pts: subPolyline(l, 0, lo), closed: false }));
      if (hi < L - 1e-6) out.push(keep({ t: 'pline', pts: subPolyline(l, hi, L), closed: false }));
      return out;
    }
    if (ss.length < 2) return null;
    let lo = ss[ss.length - 1] - L, hi = ss[0];
    for (let i = 0; i < ss.length - 1; i++) if (sp >= ss[i] && sp < ss[i + 1]) { lo = ss[i]; hi = ss[i + 1]; }
    // остаётся участок от hi до lo (через конец)
    const rest = lo < 0 ? subPolyline(l, hi, L + lo) : [...subPolyline(l, hi, L), ...subPolyline(l, 0, lo).slice(1)];
    out.push(keep({ t: 'pline', pts: rest, closed: false }));
    return out;
  }
  return null;
}

/** Удлинение отрезка (или конца ломаной) до ближайшего объекта. */
export function extendEntity(e: Entity, pick: Pt, cad: CadDoc): Entity | null {
  let a: Pt, b: Pt, atEnd: boolean;
  if (e.t === 'line') { atEnd = dist(pick, e.b) < dist(pick, e.a); [a, b] = atEnd ? [e.a, e.b] : [e.b, e.a]; }
  else if (e.t === 'pline' && !e.closed && e.pts.length >= 2) {
    atEnd = dist(pick, e.pts[e.pts.length - 1]) < dist(pick, e.pts[0]);
    [a, b] = atEnd ? [e.pts[e.pts.length - 2], e.pts[e.pts.length - 1]] : [e.pts[1], e.pts[0]];
  } else return null;
  const d = sub(b, a), L = len(d);
  if (!L) return null;
  const far: Pt = [b[0] + (d[0] / L) * 10000, b[1] + (d[1] / L) * 10000];
  let best: Pt | null = null, bd = Infinity;
  for (const o of cad.entities) {
    if (o === e || o.t === 'dim' || o.t === 'text' || o.t === 'hatch' || o.t === 'point') continue;
    for (const l of outline(o, cad)) for (let i = 1; i < l.length; i++) {
      const x = segSeg(b, far, l[i - 1], l[i]);
      if (x && x.t * 10000 > 1e-4 && x.t < bd) { bd = x.t; best = x.p; }
    }
  }
  if (!best) return null;
  if (e.t === 'line') return atEnd! ? { ...e, b: best } : { ...e, a: best };
  const pts = e.pts.slice();
  if (atEnd!) pts[pts.length - 1] = best; else pts[0] = best;
  return { ...e, pts };
}

/** Замкнутый контур объекта (для штриховки). */
export function closedBoundary(e: Entity): Pt[] | null {
  if (e.t === 'pline' && (e.closed || dist(e.pts[0], e.pts[e.pts.length - 1]) < 0.01) && e.pts.length >= 3) return e.pts;
  if (e.t === 'circle') return shapeOf(e)[0].slice(0, -1);
  if (e.t === 'ellipse') return shapeOf(e)[0].slice(0, -1);
  if (e.t === 'spline' && e.closed) return splinePoints(e.pts, true).slice(0, -1);
  return null;
}

export function measureEntity(e: EntityOf<'line'> | EntityOf<'circle'> | EntityOf<'arc'>) {
  if (e.t === 'line') return dist(e.a, e.b);
  return e.r;
}
