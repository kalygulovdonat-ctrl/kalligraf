// Движок инструментов черчения: шаги (точка, число, текст, выбор), предпросмотр, командная строка.
import { create } from 'zustand';
import type { Pt } from '../../core/geometry';
import {
  arcFrom3, TAU, type CadDoc, type DimKind, type Entity, type LineType,
} from '../../core/cad/model';
import {
  arrayPolar, arrayRect, closedBoundary, dist, extendEntity, hitTest, mirror, move, newId, offsetEntity, rotate, scaleEnt,
  trimEntity, defaultSnaps, type Snap, type SnapOpts,
} from '../../core/cad/ops';
import { along, parseInput } from '../../core/cad/input';
import { useApp } from '../../store';

export type StepKind = 'point' | 'points' | 'number' | 'pointOrNumber' | 'text' | 'select' | 'pick' | 'picks';
export interface Step { kind: StepKind; prompt: string; def?: () => number | string; filter?: (e: Entity) => boolean; words?: string }
type Val = Pt | Pt[] | number | string | Entity | Entity[] | { e: Entity; p: Pt };

type DistOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type EntityInput = DistOmit<Entity, 'id' | 'layer' | 'lt'>;

export interface ToolCtx {
  cad: CadDoc;
  sheetH: number;
  sel: Entity[];
  mk: (x: EntityInput, kind?: 'dim') => Entity;
  add: (es: Entity[]) => void;
  replace: (remove: Entity[], add: Entity[]) => void;
  msg: (s: string) => void;
}

export interface ToolDef {
  id: string;
  name: string;
  alias: string[];
  group: 'draw' | 'dim' | 'edit';
  steps: Step[];
  /** После шага i: true — инструмент сам обработал значение (например, отрезок уже добавлен). */
  onStep?: (v: Val[], i: number, ctx: ToolCtx) => void;
  finish?: (v: Val[], ctx: ToolCtx) => void;
  preview?: (v: Val[], cur: Pt, ctx: ToolCtx) => Entity[];
  repeatFrom?: number;    // после завершения вернуться к шагу (offset, point, text)
  hint?: string;
}

const P = (v: Val) => v as Pt;
const PS = (v: Val) => (v as Pt[]) ?? [];
const N = (v: Val) => v as number;
const SEL = (v: Val) => v as Entity[];
const ghost = (x: EntityInput): Entity => ({ id: 'ghost', layer: '', lt: 'thin', ...x } as Entity);
const radOrDist = (v: Val, c: Pt) => (typeof v === 'number' ? v : dist(c, P(v)));

function polygonPts(n: number, c: Pt, v: Pt): Pt[] {
  const r = dist(c, v), a0 = Math.atan2(v[1] - c[1], v[0] - c[0]);
  return Array.from({ length: n }, (_, i) => [c[0] + r * Math.cos(a0 + (i * TAU) / n), c[1] + r * Math.sin(a0 + (i * TAU) / n)] as Pt);
}
function ellipseFrom(c: Pt, axis: Pt, other: Val): { c: Pt; rx: number; ry: number; rot: number } {
  const rx = dist(c, axis), rot = Math.atan2(axis[1] - c[1], axis[0] - c[0]);
  let ry: number;
  if (typeof other === 'number') ry = other;
  else {
    const o = P(other);
    const ux = Math.cos(rot), uy = Math.sin(rot);
    ry = Math.abs(-(o[0] - c[0]) * uy + (o[1] - c[1]) * ux);
  }
  return { c, rx, ry: Math.max(0.01, ry), rot };
}
const userAngle = (deg: number) => (-deg * Math.PI) / 180; // против часовой для пользователя = минус в листе

export const TOOLS: ToolDef[] = [
  // ── Рисование ──
  { id: 'line', name: 'Отрезок', alias: ['L', 'LINE', 'О', 'ОТРЕЗОК'], group: 'draw',
    steps: [{ kind: 'points', prompt: 'Точки отрезков. Enter — закончить, C — замкнуть', words: 'C' }],
    onStep: (v, _i, ctx) => {
      const pts = PS(v[0]);
      if (pts.length >= 2) ctx.add([ctx.mk({ t: 'line', a: pts[pts.length - 2], b: pts[pts.length - 1] })]);
    },
    preview: (v, cur) => { const pts = PS(v[0]); return pts.length ? [ghost({ t: 'line', a: pts[pts.length - 1], b: cur })] : []; } },
  { id: 'pline', name: 'Полилиния', alias: ['PL', 'PLINE'], group: 'draw',
    steps: [{ kind: 'points', prompt: 'Вершины полилинии. Enter — закончить, C — замкнуть', words: 'C' }],
    finish: (v, ctx) => {
      const pts = PS(v[0]);
      const closed = (v as unknown as { closed?: boolean }).closed || (pts.length > 2 && dist(pts[0], pts[pts.length - 1]) < 1e-6);
      const clean = closed && dist(pts[0], pts[pts.length - 1]) < 1e-6 ? pts.slice(0, -1) : pts;
      if (clean.length >= 2) ctx.add([ctx.mk({ t: 'pline', pts: clean, closed })]);
    },
    preview: (v, cur) => { const pts = PS(v[0]); return pts.length ? [ghost({ t: 'pline', pts: [...pts, cur], closed: false })] : []; } },
  { id: 'rect', name: 'Прямоугольник', alias: ['REC', 'RECTANG', 'ПР'], group: 'draw',
    steps: [{ kind: 'point', prompt: 'Первый угол' }, { kind: 'point', prompt: 'Противоположный угол (или @ширина,высота)' }],
    finish: (v, ctx) => { const a = P(v[0]), b = P(v[1]); ctx.add([ctx.mk({ t: 'pline', pts: [a, [b[0], a[1]], b, [a[0], b[1]]], closed: true })]); },
    preview: (v, cur) => v.length ? [ghost({ t: 'pline', pts: [P(v[0]), [cur[0], P(v[0])[1]], cur, [P(v[0])[0], cur[1]]], closed: true })] : [],
    repeatFrom: 0 },
  { id: 'polygon', name: 'Многоугольник', alias: ['POL', 'POLYGON'], group: 'draw',
    steps: [{ kind: 'number', prompt: 'Число сторон', def: () => 6 }, { kind: 'point', prompt: 'Центр' }, { kind: 'pointOrNumber', prompt: 'Вершина (или радиус)' }],
    finish: (v, ctx) => {
      const n = Math.max(3, Math.round(N(v[0]))), c = P(v[1]);
      const vert: Pt = typeof v[2] === 'number' ? [c[0], c[1] - N(v[2])] : P(v[2]);
      ctx.add([ctx.mk({ t: 'pline', pts: polygonPts(n, c, vert), closed: true })]);
    },
    preview: (v, cur) => v.length >= 2 ? [ghost({ t: 'pline', pts: polygonPts(Math.max(3, Math.round(N(v[0]))), P(v[1]), cur), closed: true })] : [] },
  { id: 'circle', name: 'Окружность', alias: ['C', 'CIRCLE', 'ОКР'], group: 'draw',
    steps: [{ kind: 'point', prompt: 'Центр' }, { kind: 'pointOrNumber', prompt: 'Радиус (точка или число)' }],
    finish: (v, ctx) => { const c = P(v[0]); const r = radOrDist(v[1], c); if (r > 0) ctx.add([ctx.mk({ t: 'circle', c, r })]); },
    preview: (v, cur) => v.length ? [ghost({ t: 'circle', c: P(v[0]), r: dist(P(v[0]), cur) }), ghost({ t: 'line', a: P(v[0]), b: cur })] : [],
    repeatFrom: 0 },
  { id: 'arc', name: 'Дуга (3 точки)', alias: ['A', 'ARC', 'ДУГА'], group: 'draw',
    steps: [{ kind: 'point', prompt: 'Начало дуги' }, { kind: 'point', prompt: 'Точка на дуге' }, { kind: 'point', prompt: 'Конец дуги' }],
    finish: (v, ctx) => { const a = arcFrom3(P(v[0]), P(v[1]), P(v[2])); if (a) ctx.add([ctx.mk({ t: 'arc', ...a })]); else ctx.msg('Точки на одной прямой — дуги нет'); },
    preview: (v, cur) => {
      if (v.length === 1) return [ghost({ t: 'line', a: P(v[0]), b: cur })];
      if (v.length === 2) { const a = arcFrom3(P(v[0]), P(v[1]), cur); return a ? [ghost({ t: 'arc', ...a })] : []; }
      return [];
    } },
  { id: 'ellipse', name: 'Эллипс', alias: ['EL', 'ELLIPSE'], group: 'draw',
    steps: [{ kind: 'point', prompt: 'Центр' }, { kind: 'point', prompt: 'Конец первой полуоси' }, { kind: 'pointOrNumber', prompt: 'Вторая полуось (точка или длина)' }],
    finish: (v, ctx) => ctx.add([ctx.mk({ t: 'ellipse', ...ellipseFrom(P(v[0]), P(v[1]), v[2]) })]),
    preview: (v, cur) => v.length === 1 ? [ghost({ t: 'line', a: P(v[0]), b: cur })] : v.length === 2 ? [ghost({ t: 'ellipse', ...ellipseFrom(P(v[0]), P(v[1]), cur) })] : [] },
  { id: 'spline', name: 'Сплайн', alias: ['SPL', 'SPLINE'], group: 'draw',
    steps: [{ kind: 'points', prompt: 'Точки сплайна. Enter — закончить, C — замкнуть', words: 'C' }],
    finish: (v, ctx) => {
      const pts = PS(v[0]);
      const closed = !!(v as unknown as { closed?: boolean }).closed;
      if (pts.length >= 2) ctx.add([ctx.mk({ t: 'spline', pts, closed })]);
    },
    preview: (v, cur) => { const pts = PS(v[0]); return pts.length ? [ghost({ t: 'spline', pts: [...pts, cur], closed: false })] : []; } },
  { id: 'point', name: 'Точка', alias: ['PO', 'POINT'], group: 'draw',
    steps: [{ kind: 'point', prompt: 'Положение точки' }], finish: (v, ctx) => ctx.add([ctx.mk({ t: 'point', p: P(v[0]) })]), repeatFrom: 0 },
  { id: 'text', name: 'Текст', alias: ['T', 'TEXT', 'DT', 'ТЕКСТ'], group: 'draw',
    steps: [{ kind: 'point', prompt: 'Начало строки (левый нижний угол)' }, { kind: 'text', prompt: 'Введите текст и нажмите Enter' }],
    finish: (v, ctx) => { const s = String(v[1] ?? '').trim(); if (s) ctx.add([ctx.mk({ t: 'text', p: P(v[0]), text: s, h: cadUi().textH, rot: 0 })]); },
    repeatFrom: 0 },
  { id: 'hatch', name: 'Штриховка', alias: ['H', 'HATCH', 'ШТ'], group: 'draw',
    steps: [{ kind: 'picks', prompt: 'Укажите внешний контур, затем отверстия внутри. Enter — заштриховать', filter: (e) => !!closedBoundary(e) }],
    onStep: (v) => { const n = (v[0] as unknown as unknown[]).length; logMsg(n === 1 ? 'Контур выбран. Укажите отверстия (если есть) и нажмите Enter' : `Отверстий: ${n - 1}. Enter — заштриховать`); },
    finish: (v, ctx) => {
      const picks = ((v[0] as unknown as { e: Entity }[]) ?? []).map((x) => closedBoundary(x.e)).filter((x): x is Pt[] => !!x);
      if (!picks.length) return;
      // внешний контур — самый большой по площади, остальные — острова
      const area = (p: Pt[]) => Math.abs(p.reduce((s, a, i) => { const b = p[(i + 1) % p.length]; return s + a[0] * b[1] - b[0] * a[1]; }, 0) / 2);
      picks.sort((a, b) => area(b) - area(a));
      ctx.add([ctx.mk({ t: 'hatch', pts: picks[0], holes: picks.slice(1), angle: cadUi().hatchAngle, step: cadUi().hatchStep })]);
    },
    hint: 'Штриховка по ГОСТ 2.306: угол 45°, шаг 1–10 мм. Отверстия не штрихуются' },

  // ── Размеры ──
  ...(['linear', 'aligned'] as DimKind[]).map((kind): ToolDef => ({
    id: 'dim-' + kind, name: kind === 'linear' ? 'Линейный размер' : 'Параллельный размер', alias: kind === 'linear' ? ['DLI', 'DIMLINEAR', 'РАЗМ'] : ['DAL', 'DIMALIGNED'], group: 'dim',
    steps: [{ kind: 'point', prompt: 'Первая точка' }, { kind: 'point', prompt: 'Вторая точка' }, { kind: 'point', prompt: 'Положение размерной линии' }],
    finish: (v, ctx) => ctx.add([ctx.mk({ t: 'dim', kind, p1: P(v[0]), p2: P(v[1]), p3: P(v[2]) }, 'dim')]),
    preview: (v, cur) => v.length === 1 ? [ghost({ t: 'line', a: P(v[0]), b: cur })] : v.length === 2 ? [ghost({ t: 'dim', kind, p1: P(v[0]), p2: P(v[1]), p3: cur })] : [],
    repeatFrom: 0,
  })),
  ...(['radius', 'diameter'] as DimKind[]).map((kind): ToolDef => ({
    id: 'dim-' + kind, name: kind === 'radius' ? 'Радиус' : 'Диаметр', alias: kind === 'radius' ? ['DRA', 'DIMRADIUS'] : ['DDI', 'DIMDIAMETER'], group: 'dim',
    steps: [{ kind: 'pick', prompt: 'Укажите окружность или дугу', filter: (e) => e.t === 'circle' || e.t === 'arc' }, { kind: 'point', prompt: 'Положение размера' }],
    finish: (v, ctx) => {
      const e = (v[0] as { e: Entity }).e;
      if (e.t !== 'circle' && e.t !== 'arc') return;
      const p3 = P(v[1]);
      const a = Math.atan2(p3[1] - e.c[1], p3[0] - e.c[0]);
      ctx.add([ctx.mk({ t: 'dim', kind, p1: e.c, p2: [e.c[0] + e.r * Math.cos(a), e.c[1] + e.r * Math.sin(a)], p3 }, 'dim')]);
    },
    preview: (v, cur) => {
      const e = v[0] && (v[0] as { e: Entity }).e;
      if (!e || (e.t !== 'circle' && e.t !== 'arc')) return [];
      const a = Math.atan2(cur[1] - e.c[1], cur[0] - e.c[0]);
      return [ghost({ t: 'dim', kind, p1: e.c, p2: [e.c[0] + e.r * Math.cos(a), e.c[1] + e.r * Math.sin(a)], p3: cur })];
    },
    repeatFrom: 0,
  })),
  { id: 'dim-angular', name: 'Угловой размер', alias: ['DAN', 'DIMANGULAR'], group: 'dim',
    steps: [{ kind: 'point', prompt: 'Вершина угла' }, { kind: 'point', prompt: 'Точка на первой стороне' }, { kind: 'point', prompt: 'Точка на второй стороне' }, { kind: 'point', prompt: 'Положение дуги' }],
    finish: (v, ctx) => ctx.add([ctx.mk({ t: 'dim', kind: 'angular', p1: P(v[0]), p2: P(v[1]), p3: P(v[2]), p4: P(v[3]) }, 'dim')]),
    preview: (v, cur) => v.length === 3 ? [ghost({ t: 'dim', kind: 'angular', p1: P(v[0]), p2: P(v[1]), p3: P(v[2]), p4: cur })] : v.length ? [ghost({ t: 'line', a: P(v[0]), b: cur })] : [],
    repeatFrom: 0 },

  // ── Правка ──
  { id: 'move', name: 'Перенести', alias: ['M', 'MOVE', 'ПЕР'], group: 'edit',
    steps: [{ kind: 'select', prompt: 'Выберите объекты и нажмите Enter' }, { kind: 'point', prompt: 'Базовая точка' }, { kind: 'point', prompt: 'Куда перенести' }],
    finish: (v, ctx) => { const d: Pt = [P(v[2])[0] - P(v[1])[0], P(v[2])[1] - P(v[1])[1]]; ctx.replace(SEL(v[0]), SEL(v[0]).map((e) => move(e, d))); },
    preview: (v, cur) => v.length === 2 ? SEL(v[0]).map((e) => ({ ...move(e, [cur[0] - P(v[1])[0], cur[1] - P(v[1])[1]]), id: 'ghost' })) : [] },
  { id: 'copy', name: 'Копировать', alias: ['CO', 'CP', 'COPY', 'КОП'], group: 'edit',
    steps: [{ kind: 'select', prompt: 'Выберите объекты и нажмите Enter' }, { kind: 'point', prompt: 'Базовая точка' }, { kind: 'points', prompt: 'Куда копировать (можно несколько). Enter — закончить' }],
    onStep: (v, i, ctx) => {
      if (i !== 2) return;
      const pts = PS(v[2]), t = pts[pts.length - 1], b = P(v[1]);
      ctx.add(SEL(v[0]).map((e) => ({ ...move(e, [t[0] - b[0], t[1] - b[1]]), id: newId() })));
    },
    preview: (v, cur) => v.length >= 2 ? SEL(v[0]).map((e) => ({ ...move(e, [cur[0] - P(v[1])[0], cur[1] - P(v[1])[1]]), id: 'ghost' })) : [] },
  { id: 'rotate', name: 'Повернуть', alias: ['RO', 'ROTATE', 'ПОВ'], group: 'edit',
    steps: [{ kind: 'select', prompt: 'Выберите объекты и нажмите Enter' }, { kind: 'point', prompt: 'Центр поворота' }, { kind: 'pointOrNumber', prompt: 'Угол, ° (против часовой) или точка' }],
    finish: (v, ctx) => {
      const c = P(v[1]);
      const a = typeof v[2] === 'number' ? userAngle(N(v[2])) : Math.atan2(P(v[2])[1] - c[1], P(v[2])[0] - c[0]);
      ctx.replace(SEL(v[0]), SEL(v[0]).map((e) => rotate(e, c, a)));
    },
    preview: (v, cur) => v.length === 2 ? SEL(v[0]).map((e) => ({ ...rotate(e, P(v[1]), Math.atan2(cur[1] - P(v[1])[1], cur[0] - P(v[1])[0])), id: 'ghost' })) : [] },
  { id: 'mirror', name: 'Зеркало', alias: ['MI', 'MIRROR', 'ЗЕР'], group: 'edit',
    steps: [{ kind: 'select', prompt: 'Выберите объекты и нажмите Enter' }, { kind: 'point', prompt: 'Первая точка оси' }, { kind: 'point', prompt: 'Вторая точка оси' }],
    finish: (v, ctx) => ctx.add(SEL(v[0]).map((e) => ({ ...mirror(e, P(v[1]), P(v[2])), id: newId() }))),
    preview: (v, cur) => v.length === 2 ? [ghost({ t: 'line', a: P(v[1]), b: cur }), ...SEL(v[0]).map((e) => ({ ...mirror(e, P(v[1]), cur), id: 'ghost' }))] : [],
    hint: 'Исходные объекты остаются. Удалить их — клавишей Delete.' },
  { id: 'scale', name: 'Масштабировать', alias: ['SC', 'SCALE', 'МАСШ'], group: 'edit',
    steps: [{ kind: 'select', prompt: 'Выберите объекты и нажмите Enter' }, { kind: 'point', prompt: 'Базовая точка' }, { kind: 'number', prompt: 'Коэффициент масштаба', def: () => 2 }],
    finish: (v, ctx) => { const k = N(v[2]); if (k > 0) ctx.replace(SEL(v[0]), SEL(v[0]).map((e) => scaleEnt(e, P(v[1]), k))); } },
  { id: 'offset', name: 'Подобие (смещение)', alias: ['O', 'OFFSET', 'ПОД'], group: 'edit',
    steps: [{ kind: 'number', prompt: 'Расстояние смещения, мм', def: () => cadUi().lastOffset }, { kind: 'pick', prompt: 'Объект для смещения', filter: (e) => ['line', 'circle', 'arc', 'pline', 'spline', 'ellipse'].includes(e.t) }, { kind: 'point', prompt: 'С какой стороны' }],
    finish: (v, ctx) => {
      useCadUi.setState({ lastOffset: N(v[0]) });
      const o = offsetEntity((v[1] as { e: Entity }).e, N(v[0]), P(v[2]));
      if (o) ctx.add([o]); else ctx.msg('Этот объект нельзя сместить на такое расстояние');
    },
    preview: (v, cur) => { if (v.length < 2) return []; const o = offsetEntity((v[1] as { e: Entity }).e, N(v[0]), cur); return o ? [{ ...o, id: 'ghost' }] : []; },
    repeatFrom: 1 },
  { id: 'trim', name: 'Обрезать', alias: ['TR', 'TRIM', 'ОБР'], group: 'edit',
    steps: [{ kind: 'picks', prompt: 'Укажите участки, которые нужно удалить. Enter — закончить' }],
    onStep: (v, _i, ctx) => {
      const last = (v[0] as unknown as { e: Entity; p: Pt }[]).slice(-1)[0];
      if (!last) return;
      const r = trimEntity(last.e, last.p, ctx.cad);
      if (r) ctx.replace([last.e], r); else ctx.msg('Здесь нечем обрезать — объект ни с чем не пересекается');
    } },
  { id: 'extend', name: 'Удлинить', alias: ['EX', 'EXTEND', 'УДЛ'], group: 'edit',
    steps: [{ kind: 'picks', prompt: 'Укажите конец отрезка, который нужно удлинить. Enter — закончить', filter: (e) => e.t === 'line' || (e.t === 'pline' && !e.closed) }],
    onStep: (v, _i, ctx) => {
      const last = (v[0] as unknown as { e: Entity; p: Pt }[]).slice(-1)[0];
      if (!last) return;
      const r = extendEntity(last.e, last.p, ctx.cad);
      if (r) ctx.replace([last.e], [r]); else ctx.msg('Не до чего удлинять в этом направлении');
    } },
  { id: 'array', name: 'Массив прямоугольный', alias: ['AR', 'ARRAY', 'МАС'], group: 'edit',
    steps: [{ kind: 'select', prompt: 'Выберите объекты и нажмите Enter' }, { kind: 'number', prompt: 'Рядов', def: () => 2 }, { kind: 'number', prompt: 'Столбцов', def: () => 3 },
      { kind: 'number', prompt: 'Расстояние между столбцами, мм', def: () => 20 }, { kind: 'number', prompt: 'Расстояние между рядами, мм (вверх +)', def: () => 20 }],
    finish: (v, ctx) => ctx.add(arrayRect(SEL(v[0]), Math.max(1, Math.round(N(v[1]))), Math.max(1, Math.round(N(v[2]))), N(v[3]), -N(v[4]))) },
  { id: 'array-polar', name: 'Массив круговой', alias: ['ARP', 'ARRAYPOLAR'], group: 'edit',
    steps: [{ kind: 'select', prompt: 'Выберите объекты и нажмите Enter' }, { kind: 'point', prompt: 'Центр массива' }, { kind: 'number', prompt: 'Количество элементов', def: () => 6 }, { kind: 'number', prompt: 'Угол заполнения, °', def: () => 360 }],
    finish: (v, ctx) => ctx.add(arrayPolar(SEL(v[0]), P(v[1]), Math.max(2, Math.round(N(v[2]))), -N(v[3]))) },
  { id: 'erase', name: 'Удалить', alias: ['E', 'ERASE', 'DEL', 'УД'], group: 'edit',
    steps: [{ kind: 'select', prompt: 'Выберите объекты и нажмите Enter' }],
    finish: (v, ctx) => ctx.replace(SEL(v[0]), []) },
];

// ── Состояние интерфейса черчения ────────────────────────────────────

export interface CadUi {
  tool: ToolDef | null;
  values: Val[];
  step: number;
  sel: string[];
  snaps: SnapOpts;
  snapOn: boolean;
  orthoOn: boolean;
  lt: LineType;
  textH: number;
  hatchAngle: number;
  hatchStep: number;
  lastOffset: number;
  log: string[];
  lastTool: string | null;
  cursor: Pt;
  snap: Snap | null;
  lastPt: Pt | null;
  pxPerMM: number;
}

export const useCadUi = create<CadUi>(() => ({
  tool: null, values: [], step: 0, sel: [], snaps: { ...defaultSnaps, grid: 5 }, snapOn: true, orthoOn: false,
  lt: 'main', textH: 5, hatchAngle: 45, hatchStep: 3, lastOffset: 10, log: ['Выберите инструмент слева или введите команду (L — отрезок, C — окружность…)'],
  lastTool: null, cursor: [0, 0], snap: null, lastPt: null, pxPerMM: 3,
}));
const cadUi = () => useCadUi.getState();

export function logMsg(s: string) {
  useCadUi.setState((u) => ({ log: [...u.log.slice(-40), s] }));
}

function makeCtx(): ToolCtx {
  const app = useApp.getState();
  const cad = app.doc.cad;
  const ui = cadUi();
  return {
    cad,
    sheetH: app.doc.sheet.h,
    sel: cad.entities.filter((e) => ui.sel.includes(e.id)),
    mk: (x, kind) => {
      // размеры — на слой «Размеры», если он есть, тонкой линией
      const dimLayer = kind === 'dim' ? cad.layers.find((l) => /размер/i.test(l.name))?.id : undefined;
      return { ...x, id: newId(), layer: dimLayer ?? cad.currentLayer, lt: kind === 'dim' ? 'thin' : ui.lt } as Entity;
    },
    add: (es) => { if (es.length) useApp.getState().setDoc((d) => ({ ...d, cad: { ...d.cad, entities: [...d.cad.entities, ...es] } })); },
    replace: (rm, add) => {
      const ids = new Set(rm.map((e) => e.id));
      useApp.getState().setDoc((d) => {
        const list: Entity[] = [];
        let inserted = false;
        for (const e of d.cad.entities) {
          if (ids.has(e.id)) { if (!inserted) { list.push(...add); inserted = true; } }
          else list.push(e);
        }
        if (!inserted) list.push(...add);
        return { ...d, cad: { ...d.cad, entities: list } };
      });
      useCadUi.setState({ sel: add.map((e) => e.id) });
    },
    msg: logMsg,
  };
}

export const currentStep = (): Step | null => { const u = cadUi(); return u.tool ? u.tool.steps[u.step] ?? null : null; };

export function startTool(id: string) {
  const tool = TOOLS.find((t) => t.id === id);
  if (!tool) return;
  useCadUi.setState({ tool, values: [], step: 0, lastPt: null, lastTool: id });
  logMsg(`${tool.name}${tool.hint ? ' — ' + tool.hint : ''}`);
  enterStep();
}

export function cancelTool() {
  if (cadUi().tool) logMsg('Отменено');
  useCadUi.setState({ tool: null, values: [], step: 0, lastPt: null });
}

/** Вход в шаг: автоматическое заполнение выбора, если объекты уже выделены. */
function enterStep() {
  const u = cadUi();
  const st = currentStep();
  if (!u.tool || !st) return;
  if (st.kind === 'select' && u.sel.length) {
    const ctx = makeCtx();
    pushValue(ctx.sel);
    return;
  }
  if (st.kind === 'select') useCadUi.setState({ sel: [] });
}

function advance() {
  const u = cadUi();
  if (!u.tool) return;
  const next = u.step + 1;
  if (next >= u.tool.steps.length) {
    u.tool.finish?.(u.values, makeCtx());
    if (u.tool.repeatFrom !== undefined) {
      useCadUi.setState({ values: u.values.slice(0, u.tool.repeatFrom), step: u.tool.repeatFrom, sel: u.tool.group === 'edit' ? cadUi().sel : [] });
      enterStep();
    } else {
      useCadUi.setState({ tool: null, values: [], step: 0, lastPt: null, sel: u.tool.group === 'edit' ? cadUi().sel : [] });
    }
    return;
  }
  useCadUi.setState({ step: next });
  enterStep();
}

function pushValue(v: Val) {
  const u = cadUi();
  if (!u.tool) return;
  const values = u.values.slice();
  values[u.step] = v;
  const lastPt = Array.isArray(v) && typeof v[0] === 'number' ? (v as Pt) : u.lastPt;
  useCadUi.setState({ values, lastPt });
  u.tool.onStep?.(values, u.step, makeCtx());
  advance();
}

/** Щелчок/ввод точки. */
export function inputPoint(p: Pt) {
  const u = cadUi();
  const st = currentStep();
  if (!u.tool || !st) return;
  if (st.kind === 'point' || st.kind === 'pointOrNumber') return pushValue(p);
  if (st.kind === 'points') {
    const values = u.values.slice();
    const pts = [...PS(values[u.step]), p];
    // щелчок в первую точку замыкает полилинию/сплайн
    if (pts.length > 3 && dist(pts[0], p) < 1e-6 && (u.tool.id === 'pline' || u.tool.id === 'spline')) {
      (values as unknown as { closed?: boolean }).closed = true;
      values[u.step] = pts.slice(0, -1);
      useCadUi.setState({ values });
      return advance();
    }
    values[u.step] = pts;
    useCadUi.setState({ values, lastPt: p });
    u.tool.onStep?.(values, u.step, makeCtx());
    return;
  }
  if (st.kind === 'select' || st.kind === 'pick' || st.kind === 'picks') return pickAt(p);
}

export function pickTolerance() {
  return 5 / Math.max(0.1, cadUi().pxPerMM);
}

/** Выбор объекта щелчком на шагах select/pick/picks. */
export function pickAt(p: Pt, tol = pickTolerance()) {
  const u = cadUi();
  const st = currentStep();
  const ctx = makeCtx();
  if (!st || !u.tool) return;
  const e = hitTest(p, ctx.cad, tol, st.kind === 'select' ? undefined : st.filter) ?? (st.filter ? hitTest(p, ctx.cad, tol) : null);
  if (st.kind === 'select') {
    if (!e) return;
    useCadUi.setState({ sel: u.sel.includes(e.id) ? u.sel.filter((x) => x !== e.id) : [...u.sel, e.id] });
    return;
  }
  if (!e) return logMsg('Здесь нет объекта');
  if (st.filter && !st.filter(e)) return logMsg('Этот объект не подходит для команды');
  if (st.kind === 'pick') return pushValue({ e, p });
  // picks — копим и обрабатываем каждый
  const values = u.values.slice();
  const list = [...((values[u.step] as unknown as { e: Entity; p: Pt }[]) ?? []), { e, p }];
  values[u.step] = list as unknown as Val;
  useCadUi.setState({ values });
  u.tool.onStep?.(values, u.step, makeCtx());
}

/** Enter: закончить шаг с несколькими значениями / подтвердить выбор / повторить команду. */
export function pressEnter() {
  const u = cadUi();
  const st = currentStep();
  if (!u.tool) { if (u.lastTool) startTool(u.lastTool); return; }
  if (!st) return;
  if (st.kind === 'points' || st.kind === 'picks') {
    if (st.kind === 'points' && u.tool.id === 'copy') return cancelTool();
    return advance();
  }
  if (st.kind === 'select') {
    if (!u.sel.length) return logMsg('Ничего не выбрано');
    return pushValue(makeCtx().sel);
  }
  if ((st.kind === 'number' || st.kind === 'pointOrNumber') && st.def) return pushValue(Number(st.def()));
}

/** Текст из командной строки. */
export function submitCommand(raw: string) {
  const u = cadUi();
  const st = currentStep();
  const text = raw.trim();
  if (!text) return pressEnter();
  if (!u.tool) {
    const w = text.toUpperCase();
    const tool = TOOLS.find((t) => t.alias.includes(w) || t.id.toUpperCase() === w);
    if (tool) return startTool(tool.id);
    if (w === 'U' || w === 'UNDO' || w === 'ОТМ') { useApp.getState().undo(); return logMsg('Отменено последнее действие'); }
    return logMsg(`Неизвестная команда «${text}». Примеры: L, PL, C, A, REC, T, DLI, M, CO, RO, TR, O`);
  }
  if (!st) return;
  if (st.kind === 'text') return pushValue(raw);
  const H = useApp.getState().doc.sheet.h;
  const r = parseInput(text, u.lastPt, H);
  if (r.kind === 'error') return logMsg(r.msg);
  if (r.kind === 'word') {
    if (st.words?.includes(r.s) && r.s === 'C') {
      const values = u.values.slice();
      const pts = PS(values[u.step]);
      if (u.tool.id === 'line' && pts.length >= 3) {
        makeCtx().add([makeCtx().mk({ t: 'line', a: pts[pts.length - 1], b: pts[0] })]);
        return cancelTool();
      }
      if (pts.length >= 3) { (values as unknown as { closed?: boolean }).closed = true; useCadUi.setState({ values }); return advance(); }
    }
    const tool = TOOLS.find((t) => t.alias.includes(r.s));
    if (tool) return startTool(tool.id);
    return logMsg('Ожидается ' + (st.kind === 'number' ? 'число' : 'точка: x,y или @dx,dy или @длина<угол'));
  }
  if (r.kind === 'number') {
    if (st.kind === 'number' || st.kind === 'pointOrNumber') return pushValue(r.v);
    if ((st.kind === 'point' || st.kind === 'points') && u.lastPt) return inputPoint(along(u.lastPt, u.cursor, r.v)); // прямой ввод расстояния
    return logMsg('Нужна точка: x,y (например 20,30), @dx,dy или @длина<угол');
  }
  if (r.kind === 'point') {
    if (st.kind === 'point' || st.kind === 'points' || st.kind === 'pointOrNumber') return inputPoint(r.p);
    return logMsg(st.kind === 'number' ? 'Нужно число' : 'Укажите объект мышью');
  }
}

/** Масштаб вида (пикселей на мм) — для допуска попадания мышью. */
export const setViewScale = (k: number) => { if (cadUi().pxPerMM !== k) useCadUi.setState({ pxPerMM: k }); };
