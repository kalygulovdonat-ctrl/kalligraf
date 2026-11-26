// Оформление: размеры (ГОСТ 2.307), штриховка (ГОСТ 2.306), надписи чертёжным шрифтом (ГОСТ 2.304).
import { builtinFonts, CAP, type Font } from '../font';
import type { Pt } from '../geometry';
import { angleOf, arcPoints, normAngle, polar, type CadDoc, type Entity, type EntityOf } from './model';

const ARROW = 3;            // длина стрелки, мм
const ARROW_HALF = 0.55;    // полуширина стрелки, мм
const OVERSHOOT = 2;        // выход выносной линии за размерную, мм
const GAP = 1;              // зазор между числом и размерной линией, мм

let _font: Font | null = null;
const draftFont = () => (_font ??= builtinFonts().find((f) => f.id === 'drafting') ?? builtinFonts()[0]);

/** Строка чертёжным шрифтом: p — начало базовой линии, rot — угол строки (радианы, координаты листа). */
export function textLines(s: string, p: Pt, h: number, rot: number, anchor: 'start' | 'middle' = 'start'): Pt[][] {
  const f = draftFont();
  const k = h / CAP;
  const gap = h * 0.12;
  const chars = [...s];
  const width = chars.reduce((w, c) => w + (f.glyphs[c]?.variants[0].advance ?? 5) * k + gap, 0) - gap;
  let x = anchor === 'middle' ? -width / 2 : 0;
  const cs = Math.cos(rot), sn = Math.sin(rot);
  const out: Pt[][] = [];
  for (const c of chars) {
    const v = f.glyphs[c]?.variants[0];
    if (v) for (const st of v.strokes) out.push(st.map(([gx, gy]) => {
      const lx = x + gx * k, ly = -gy * k;
      return [p[0] + lx * cs - ly * sn, p[1] + lx * sn + ly * cs] as Pt;
    }));
    x += (v?.advance ?? 5) * k + gap;
  }
  return out;
}

export function textWidth(s: string, h: number): number {
  const f = draftFont(), k = h / CAP, gap = h * 0.12;
  return [...s].reduce((w, c) => w + (f.glyphs[c]?.variants[0].advance ?? 5) * k + gap, 0) - gap;
}

/** Стрелка с вершиной в tip, направленная по углу dir (заполнена штрихами). */
function arrow(tip: Pt, dir: number): Pt[][] {
  const back = polar(tip, ARROW, dir + Math.PI);
  const nx = -Math.sin(dir) * ARROW_HALF, ny = Math.cos(dir) * ARROW_HALF;
  const a: Pt = [back[0] + nx, back[1] + ny], b: Pt = [back[0] - nx, back[1] - ny];
  const mid1: Pt = [back[0] + nx * 0.45, back[1] + ny * 0.45], mid2: Pt = [back[0] - nx * 0.45, back[1] - ny * 0.45];
  return [[tip, a, b, tip], [mid1, tip, mid2]];
}

export function formatValue(v: number): string {
  const r = Math.round(v * 10) / 10;
  return (Number.isInteger(r) ? String(r) : r.toFixed(1)).replace('.', ',');
}

/** Читаемый угол надписи: текст не должен стоять «вверх ногами» (ГОСТ). */
function readable(a: number) {
  let r = normAngle(a);
  // вертикальные надписи читаются снизу вверх
  if (r >= Math.PI / 2 - 1e-9 && r < (3 * Math.PI) / 2 - 1e-9) r -= Math.PI;
  return r;
}

/** Размер между точками p1, p2 вдоль направления u (единичный вектор), размерная линия проходит через p3. */
function linearDim(p1: Pt, p2: Pt, p3: Pt, u: Pt, label: string, cad: CadDoc): Pt[][] {
  const n: Pt = [-u[1], u[0]];
  const off = (p: Pt) => (p3[0] - p[0]) * n[0] + (p3[1] - p[1]) * n[1];
  const d1 = off(p1), d2 = off(p2);
  const a: Pt = [p1[0] + n[0] * d1, p1[1] + n[1] * d1];
  const b: Pt = [p2[0] + n[0] * d2, p2[1] + n[1] * d2];
  const sgn = (v: number) => (v >= 0 ? 1 : -1);
  const out: Pt[][] = [];
  // выносные линии (с выходом за размерную)
  if (Math.abs(d1) > 0.3) out.push([p1, [a[0] + n[0] * OVERSHOOT * sgn(d1), a[1] + n[1] * OVERSHOOT * sgn(d1)]]);
  if (Math.abs(d2) > 0.3) out.push([p2, [b[0] + n[0] * OVERSHOOT * sgn(d2), b[1] + n[1] * OVERSHOOT * sgn(d2)]]);
  const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const dir = Math.atan2(b[1] - a[1], b[0] - a[0]);
  const h = cad.dimText;
  const tw = textWidth(label, h);
  const inside = L >= 2 * ARROW + 2;
  if (inside) {
    out.push([a, b], ...arrow(a, dir + Math.PI), ...arrow(b, dir));
  } else {
    // стрелки снаружи
    const ea = polar(a, ARROW + 3, dir + Math.PI), eb = polar(b, ARROW + 3, dir);
    out.push([ea, eb], ...arrow(a, dir), ...arrow(b, dir + Math.PI));
  }
  // число — над размерной линией, по центру
  const rot = readable(dir);
  const mid: Pt = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  // «над» — в сторону, противоположную низу текста
  const up: Pt = [Math.sin(rot), -Math.cos(rot)];
  let tp: Pt = [mid[0] + up[0] * GAP, mid[1] + up[1] * GAP];
  if (!inside && tw + 2 > L) tp = [tp[0] + Math.cos(rot) * (L / 2 + tw / 2 + ARROW + 2), tp[1] + Math.sin(rot) * (L / 2 + tw / 2 + ARROW + 2)];
  out.push(...textLines(label, tp, h, rot, 'middle'));
  return out;
}

export function dimValue(e: EntityOf<'dim'>, cad: CadDoc): number {
  const s = cad.scale || 1;
  const { p1, p2, p3 } = e;
  switch (e.kind) {
    case 'linear': {
      const horiz = isHorizontal(e);
      return (horiz ? Math.abs(p2[0] - p1[0]) : Math.abs(p2[1] - p1[1])) / s;
    }
    case 'aligned': return Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) / s;
    case 'radius': return Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) / s;
    case 'diameter': return (2 * Math.hypot(p2[0] - p1[0], p2[1] - p1[1])) / s;
    case 'angular': {
      const a = Math.abs(normAngle(angleOf(p1, p3) - angleOf(p1, p2)));
      return ((a > Math.PI ? 2 * Math.PI - a : a) * 180) / Math.PI;
    }
  }
}

/** Линейный размер: горизонтальный, если размерная линия ушла выше/ниже точек, иначе вертикальный. */
function isHorizontal(e: EntityOf<'dim'>) {
  const { p1, p2, p3 } = e;
  const minX = Math.min(p1[0], p2[0]), maxX = Math.max(p1[0], p2[0]);
  const minY = Math.min(p1[1], p2[1]), maxY = Math.max(p1[1], p2[1]);
  const dy = p3[1] < minY ? minY - p3[1] : p3[1] > maxY ? p3[1] - maxY : 0;
  const dx = p3[0] < minX ? minX - p3[0] : p3[0] > maxX ? p3[0] - maxX : 0;
  if (dx === 0 && dy === 0) return Math.abs(p2[0] - p1[0]) >= Math.abs(p2[1] - p1[1]);
  return dy >= dx;
}

export function dimLines(e: EntityOf<'dim'>, cad: CadDoc): Pt[][] {
  const v = dimValue(e, cad);
  switch (e.kind) {
    case 'linear': {
      const u: Pt = isHorizontal(e) ? [1, 0] : [0, 1];
      return linearDim(e.p1, e.p2, e.p3, u, e.text || formatValue(v), cad);
    }
    case 'aligned': {
      const L = Math.hypot(e.p2[0] - e.p1[0], e.p2[1] - e.p1[1]) || 1;
      return linearDim(e.p1, e.p2, e.p3, [(e.p2[0] - e.p1[0]) / L, (e.p2[1] - e.p1[1]) / L], e.text || formatValue(v), cad);
    }
    case 'radius':
    case 'diameter': {
      const c = e.p1, r = Math.hypot(e.p2[0] - c[0], e.p2[1] - c[1]);
      const dir = angleOf(c, e.p3 ?? e.p2);
      const onArc = polar(c, r, dir);
      const label = e.text || (e.kind === 'radius' ? 'R' : '⌀') + formatValue(v);
      const h = cad.dimText;
      const out: Pt[][] = [];
      const outside = Math.hypot(e.p3[0] - c[0], e.p3[1] - c[1]) > r;
      const start: Pt = e.kind === 'diameter' ? polar(c, r, dir + Math.PI) : c;
      const tw = textWidth(label, h);
      if (outside) {
        // полка снаружи окружности
        const end = e.p3;
        out.push([start, onArc, end]);
        const shelfDir = Math.cos(angleOf(onArc, end)) >= 0 ? 0 : Math.PI;
        const shelfEnd = polar(end, tw + 2, shelfDir);
        out.push([end, shelfEnd]);
        out.push(...arrow(onArc, dir));
        if (e.kind === 'diameter') out.push(...arrow(start, dir + Math.PI));
        const tp: Pt = [shelfDir === 0 ? end[0] + 1 : shelfEnd[0] + 1, end[1] - GAP];
        out.push(...textLines(label, tp, h, 0));
      } else {
        out.push([start, onArc], ...arrow(onArc, dir));
        if (e.kind === 'diameter') out.push(...arrow(start, dir + Math.PI));
        const rot = readable(dir);
        const mid: Pt = e.kind === 'diameter' ? c : polar(c, r / 2, dir);
        const up: Pt = [Math.sin(rot), -Math.cos(rot)];
        out.push(...textLines(label, [mid[0] + up[0] * GAP, mid[1] + up[1] * GAP], h, rot, 'middle'));
      }
      return out;
    }
    case 'angular': {
      const c = e.p1;
      const pos = e.p4 ?? e.p3;
      const R = Math.max(5, Math.hypot(pos[0] - c[0], pos[1] - c[1]));
      let a0 = angleOf(c, e.p2), a1 = angleOf(c, e.p3);
      let sweep = normAngle(a1 - a0);
      if (sweep > Math.PI) { [a0, a1] = [a1, a0]; sweep = normAngle(a1 - a0); }
      const out: Pt[][] = [];
      out.push(arcPoints(c, R, a0, a0 + sweep));
      // выносные линии, если точки ближе дуги
      for (const [p, a] of [[e.p2, a0], [e.p3, a0 + sweep]] as [Pt, number][]) {
        const rp = Math.hypot(p[0] - c[0], p[1] - c[1]);
        if (rp < R) out.push([polar(c, rp, a), polar(c, R + OVERSHOOT, a)]);
      }
      out.push(...arrow(polar(c, R, a0), a0 - Math.PI / 2), ...arrow(polar(c, R, a0 + sweep), a0 + sweep + Math.PI / 2));
      const am = a0 + sweep / 2;
      const label = e.text || formatValue(dimValue(e, cad)) + '°';
      const rot = readable(am + Math.PI / 2);
      const tp = polar(c, R + GAP, am);
      // текст снаружи дуги
      const up: Pt = [Math.sin(rot), -Math.cos(rot)];
      const flip = up[0] * Math.cos(am) + up[1] * Math.sin(am) < 0 ? cad.dimText : 0;
      out.push(...textLines(label, polar(tp, flip, am), cad.dimText, rot, 'middle'));
      return out;
    }
  }
}

/** Штриховка многоугольника параллельными линиями (правило «чёт-нечет», с дырами). */
export function hatchLines(poly: Pt[], angleDeg: number, step: number, holes: Pt[][] = []): Pt[][] {
  if (poly.length < 3 || step <= 0) return [];
  const rings = [poly, ...holes.filter((h) => h.length >= 3)];
  const a = (angleDeg * Math.PI) / 180;
  // поворачиваем так, чтобы штрихи стали горизонтальными
  const cs = Math.cos(-a), sn = Math.sin(-a);
  const R = (p: Pt): Pt => [p[0] * cs - p[1] * sn, p[0] * sn + p[1] * cs];
  const ci = Math.cos(a), si = Math.sin(a);
  const Ri = (p: Pt): Pt => [p[0] * ci - p[1] * si, p[0] * si + p[1] * ci];
  const RINGS = rings.map((r) => r.map(R));
  const P = RINGS[0];
  const ys = P.map((p) => p[1]);
  const y0 = Math.ceil(Math.min(...ys) / step) * step, y1 = Math.max(...ys);
  const out: Pt[][] = [];
  let flip = false;
  for (let y = y0; y <= y1; y += step) {
    const xs: number[] = [];
    for (const ring of RINGS) for (let i = 0; i < ring.length; i++) {
      const p = ring[i], q = ring[(i + 1) % ring.length];
      if ((p[1] <= y && q[1] > y) || (q[1] <= y && p[1] > y)) xs.push(p[0] + ((y - p[1]) / (q[1] - p[1])) * (q[0] - p[0]));
    }
    xs.sort((x, z) => x - z);
    const segs: Pt[][] = [];
    for (let k = 0; k + 1 < xs.length; k += 2) if (xs[k + 1] - xs[k] > 0.05) segs.push([Ri([xs[k], y]), Ri([xs[k + 1], y])]);
    if (flip) segs.reverse().forEach((s) => s.reverse());
    out.push(...segs);
    flip = !flip;
  }
  return out;
}

/** Оформление (размеры, тексты, штриховки) — для cadToPaths. */
export function annotate(e: Entity, cad: CadDoc): Pt[][] {
  if (e.t === 'text') return textLines(e.text, e.p, e.h, e.rot);
  // угол штриховки задаётся как у пользователя (против часовой), на листе ось Y вниз
  if (e.t === 'hatch') return hatchLines(e.pts, -e.angle, e.step, e.holes);
  if (e.t === 'dim') return dimLines(e, cad);
  return [];
}
