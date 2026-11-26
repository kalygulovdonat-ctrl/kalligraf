import { describe, expect, it } from 'vitest';
import { arcFrom3, cadToPaths, defaultCad, offsetPolyline, styleLines, type CadDoc, type Entity } from '../core/cad/model';
import { annotate, dimValue, formatValue, hatchLines } from '../core/cad/annotate';
import { arrayPolar, arrayRect, extendEntity, findSnap, intersections, mirror, offsetEntity, rotate, trimEntity, defaultSnaps, hitTest } from '../core/cad/ops';
import { exportDxf, parseDxf } from '../core/cad/dxf';
import { parseInput, toUser } from '../core/cad/input';
import type { Pt } from '../core/geometry';

const base = { layer: 'L0', lt: 'main' as const };
let n = 0;
const id = () => 't' + n++;
const line = (a: Pt, b: Pt): Entity => ({ ...base, id: id(), t: 'line', a, b });
const circle = (c: Pt, r: number): Entity => ({ ...base, id: id(), t: 'circle', c, r });
const doc = (...e: Entity[]): CadDoc => ({ ...defaultCad(), entities: e });
const near = (a: Pt, b: Pt, tol = 1e-3) => Math.hypot(a[0] - b[0], a[1] - b[1]) < tol;

describe('чертёж: геометрия', () => {
  it('дуга через 3 точки', () => {
    const a = arcFrom3([10, 0], [0, 10], [-10, 0])!;
    expect(a.r).toBeCloseTo(10);
    expect(near(a.c, [0, 0])).toBe(true);
    expect(a.a1 - a.a0).toBeCloseTo(Math.PI);
  });
  it('пересечение отрезков и окружности', () => {
    const l = line([-20, 0], [20, 0]), c = circle([0, 0], 10);
    const pts = intersections(l, c, doc(l, c));
    expect(pts.length).toBe(2);
    expect(pts.some((p) => near(p, [10, 0], 0.02))).toBe(true);
    expect(pts.some((p) => near(p, [-10, 0], 0.02))).toBe(true);
  });
  it('привязка: конец, середина, центр, пересечение', () => {
    const a = line([0, 0], [100, 0]), b = line([50, -50], [50, 50]), c = circle([200, 0], 20);
    const d = doc(a, b, c);
    expect(findSnap([1, 1], d, defaultSnaps, 3)?.kind).toBe('end');
    expect(findSnap([25.5, 0.5], d, { ...defaultSnaps, end: false }, 3)).toBeNull();
    expect(findSnap([50.8, 0.6], d, defaultSnaps, 3)?.kind).toBe('int');
    expect(findSnap([201, 1], d, defaultSnaps, 3)?.kind).toBe('center');
    expect(findSnap([30, 30], d, { ...defaultSnaps, grid: 5 }, 1)?.p).toEqual([30, 30]);
  });
  it('попадание по объекту', () => {
    const a = line([0, 0], [100, 0]);
    expect(hitTest([50, 0.5], doc(a), 1)?.id).toBe(a.id);
    expect(hitTest([50, 5], doc(a), 1)).toBeNull();
  });
});

describe('чертёж: правка', () => {
  it('обрезка отрезка по двум секущим', () => {
    const a = line([0, 0], [100, 0]), b = line([30, -10], [30, 10]), c = line([70, -10], [70, 10]);
    const res = trimEntity(a, [50, 0], doc(a, b, c))!;
    expect(res.length).toBe(2);
    const ls = res.map((e) => (e.t === 'line' ? [e.a, e.b] : null));
    expect(ls.some((l) => l && near(l[0], [0, 0]) && near(l[1], [30, 0]))).toBe(true);
    expect(ls.some((l) => l && near(l[0], [70, 0]) && near(l[1], [100, 0]))).toBe(true);
  });
  it('обрезка окружности → дуга', () => {
    const c = circle([0, 0], 10), l = line([-20, 0], [20, 0]);
    const res = trimEntity(c, [0, 10], doc(c, l))!; // режем нижнюю половину (Y вниз)
    expect(res.length).toBe(1);
    const arc = res[0];
    expect(arc.t).toBe('arc');
    if (arc.t === 'arc') expect(arc.a1 - arc.a0).toBeCloseTo(Math.PI, 2);
  });
  it('удлинение до границы', () => {
    const a = line([0, 0], [10, 0]), b = line([50, -10], [50, 10]);
    const r = extendEntity(a, [9, 0], doc(a, b))!;
    expect(r.t === 'line' && near(r.b, [50, 0], 1e-6)).toBe(true);
  });
  it('подобие: отрезок и окружность в сторону курсора', () => {
    const a = line([0, 0], [10, 0]);
    const o = offsetEntity(a, 5, [5, 3])!;
    expect(o.t === 'line' && near(o.a, [0, 5])).toBe(true);
    const o2 = offsetEntity(a, 5, [5, -3])!;
    expect(o2.t === 'line' && near(o2.a, [0, -5])).toBe(true);
    const c = offsetEntity(circle([0, 0], 10), 2, [0, 20])!;
    expect(c.t === 'circle' && c.r).toBe(12);
  });
  it('смещение замкнутого квадрата — квадрат больше на 2×d', () => {
    const sq: Pt[] = [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]];
    // обход по часовой стрелке на экране: «влево по ходу» (+d) — наружу
    const o = offsetPolyline(sq, 1, true);
    const xs = o.map((p) => p[0]);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(12, 5);
  });
  it('поворот, зеркало, массивы', () => {
    const a = line([10, 0], [20, 0]);
    const r = rotate(a, [0, 0], Math.PI / 2);
    expect(r.t === 'line' && near(r.a, [0, 10])).toBe(true);
    const m = mirror(a, [0, -5], [0, 5]);
    expect(m.t === 'line' && near(m.a, [-10, 0])).toBe(true);
    expect(arrayRect([a], 2, 3, 10, 10).length).toBe(5);
    const pol = arrayPolar([a], [0, 0], 4, 360);
    expect(pol.length).toBe(3);
    expect(pol.some((e) => e.t === 'line' && near(e.a, [-10, 0], 1e-6))).toBe(true);
  });
});

describe('чертёж: оформление по ГОСТ', () => {
  it('размеры с учётом масштаба чертежа', () => {
    const cad = { ...defaultCad(), scale: 0.5 };
    const d: Entity = { ...base, id: id(), t: 'dim', kind: 'linear', p1: [0, 0], p2: [40, 10], p3: [20, -15] };
    if (d.t === 'dim') expect(dimValue(d, cad)).toBe(80); // горизонтальный, 1:2
    const v: Entity = { ...base, id: id(), t: 'dim', kind: 'linear', p1: [0, 0], p2: [40, 10], p3: [60, 5] };
    if (v.t === 'dim') expect(dimValue(v, cad)).toBe(20); // вертикальный
    const r: Entity = { ...base, id: id(), t: 'dim', kind: 'diameter', p1: [0, 0], p2: [12.5, 0], p3: [5, 0] };
    if (r.t === 'dim') expect(dimValue(r, defaultCad())).toBe(25);
    const a: Entity = { ...base, id: id(), t: 'dim', kind: 'angular', p1: [0, 0], p2: [10, 0], p3: [0, 10] };
    if (a.t === 'dim') expect(dimValue(a, defaultCad())).toBeCloseTo(90);
    expect(formatValue(12.25)).toBe('12,3');
    expect(formatValue(40)).toBe('40');
  });
  it('размер рисуется: линии, стрелки, число', () => {
    const d: Entity = { ...base, id: id(), t: 'dim', kind: 'aligned', p1: [0, 0], p2: [50, 0], p3: [25, -10] };
    const lines = annotate(d, defaultCad());
    expect(lines.length).toBeGreaterThan(8);
    for (const l of lines) for (const [x, y] of l) { expect(Number.isFinite(x) && Number.isFinite(y)).toBe(true); }
  });
  it('штриховка 45° внутри квадрата', () => {
    const h = hatchLines([[0, 0], [20, 0], [20, 20], [0, 20]], 45, 2);
    expect(h.length).toBeGreaterThanOrEqual(13); // диагональ 28,3 мм / шаг 2 мм
    for (const s of h) for (const [x, y] of s) { expect(x).toBeGreaterThanOrEqual(-1e-6); expect(x).toBeLessThanOrEqual(20 + 1e-6); expect(y).toBeGreaterThanOrEqual(-1e-6); expect(y).toBeLessThanOrEqual(20 + 1e-6); }
  });
  it('штриховка с отверстием не заходит внутрь отверстия', () => {
    const sq: Pt[] = [[0, 0], [40, 0], [40, 40], [0, 40]];
    const hole: Pt[] = Array.from({ length: 48 }, (_, i) => [20 + 8 * Math.cos((i / 48) * 2 * Math.PI), 20 + 8 * Math.sin((i / 48) * 2 * Math.PI)] as Pt);
    const h = hatchLines(sq, 45, 2, [hole]);
    for (const s of h) {
      // середина каждого штриха — вне отверстия
      const m: Pt = [(s[0][0] + s[1][0]) / 2, (s[0][1] + s[1][1]) / 2];
      expect(Math.hypot(m[0] - 20, m[1] - 20)).toBeGreaterThan(7.5);
    }
  });
  it('штриховая линия — настоящие разрывы', () => {
    const d = styleLines([[[0, 0], [100, 0]]], 'dashed', false);
    expect(d.length).toBeGreaterThan(10);
    const c = styleLines([[[0, 0], [100, 0]]], 'main', true);
    expect(c.length).toBe(2); // двойной проход
  });
  it('чертёж превращается в пути с цветом слоя', () => {
    const cad = doc(line([0, 0], [10, 0]), { ...base, layer: 'L1', id: id(), t: 'circle', c: [5, 5], r: 3 });
    const p = cadToPaths(cad, annotate);
    expect(p.length).toBe(2);
    expect(p[1].color).toBe('#e03131');
    cad.layers[1].visible = false;
    expect(cadToPaths(cad, annotate).length).toBe(1);
  });
});

describe('DXF', () => {
  it('экспорт → импорт сохраняет геометрию', () => {
    const cad = doc(line([10, 20], [60, 20]), circle([100, 100], 15),
      { ...base, id: id(), t: 'arc', c: [50, 50], r: 10, a0: 0, a1: Math.PI / 2 },
      { ...base, id: id(), t: 'text', p: [20, 200], text: '⌀20 текст', h: 5, rot: 0 });
    const H = 297;
    const dxf = exportDxf(cad, H);
    expect(dxf).toContain('AC1009');
    expect(dxf).toContain('%%c20');
    const imp = parseDxf(dxf, 'L0');
    // при импорте Y = −y_dxf; вернём на лист: y = H − y_dxf → y_imp + H
    const back = (p: Pt): Pt => [p[0], p[1] + H];
    const l = imp.entities.find((e) => e.t === 'line');
    expect(l && l.t === 'line' && near(back(l.a), [10, 20]) && near(back(l.b), [60, 20])).toBe(true);
    const c = imp.entities.find((e) => e.t === 'circle');
    expect(c && c.t === 'circle' && near(back(c.c), [100, 100]) && Math.abs(c.r - 15) < 1e-6).toBe(true);
    const a = imp.entities.find((e) => e.t === 'arc');
    expect(a && a.t === 'arc' && Math.abs(a.a1 - a.a0 - Math.PI / 2) < 1e-6 && Math.abs(((a.a0 % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) < 1e-6).toBe(true);
    const t = imp.entities.find((e) => e.t === 'text');
    expect(t && t.t === 'text' && t.text).toBe('⌀20 текст');
  });
  it('LWPOLYLINE с выпуклостью (полукруг) и блоки', () => {
    const dxf = ['0', 'SECTION', '2', 'BLOCKS', '0', 'BLOCK', '2', 'B1', '10', '0', '20', '0', '0', 'LINE', '8', '0', '10', '0', '20', '0', '11', '5', '21', '0', '0', 'ENDBLK', '0', 'ENDSEC',
      '0', 'SECTION', '2', 'ENTITIES',
      '0', 'LWPOLYLINE', '8', '0', '90', '2', '70', '0', '10', '0', '20', '0', '42', '1', '10', '20', '20', '0',
      '0', 'INSERT', '8', '0', '2', 'B1', '10', '100', '20', '0', '41', '2',
      '0', 'ENDSEC', '0', 'EOF'].join('\n');
    const imp = parseDxf(dxf, 'L0');
    const pl = imp.entities.find((e) => e.t === 'pline');
    expect(pl && pl.t === 'pline').toBe(true);
    if (pl && pl.t === 'pline') {
      const ys = pl.pts.map((p) => -p[1]); // обратно в Y вверх
      expect(Math.max(...ys.map(Math.abs))).toBeCloseTo(10, 1); // радиус полукруга 10
      expect(near(pl.pts[pl.pts.length - 1], [20, 0], 1e-6)).toBe(true);
    }
    const ln = imp.entities.find((e) => e.t === 'line');
    expect(ln && ln.t === 'line' && near(ln.b, [110, 0])).toBe(true); // блок вставлен с масштабом 2
  });
});

describe('ввод координат', () => {
  const H = 297;
  it('абсолютные, относительные, полярные', () => {
    expect(parseInput('10,20', null, H)).toEqual({ kind: 'point', p: [10, 277] });
    const last: Pt = [10, 277];
    const r = parseInput('@5,0', last, H);
    expect(r.kind === 'point' && near(r.p, [15, 277])).toBe(true);
    const p = parseInput('@10<90', last, H);
    expect(p.kind === 'point' && near(p.p, [10, 267])).toBe(true); // вверх по листу
    expect(parseInput('10,5;20', null, H)).toEqual({ kind: 'point', p: [10.5, 277] });
    expect(parseInput('25', null, H)).toEqual({ kind: 'number', v: 25 });
    expect(parseInput('l', null, H)).toEqual({ kind: 'word', s: 'L' });
    expect(parseInput('@1,2', null, H).kind).toBe('error');
    expect(toUser([10, 277], H)).toEqual([10, 20]);
  });
});
