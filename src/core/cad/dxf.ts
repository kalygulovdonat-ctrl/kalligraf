// DXF: импорт (LINE, LWPOLYLINE, POLYLINE, CIRCLE, ARC, ELLIPSE, SPLINE, POINT, TEXT, MTEXT, блоки INSERT)
// и экспорт в DXF R12 (открывается в AutoCAD, КОМПАС-3D, LibreCAD, Inkscape).
// В DXF ось Y направлена вверх; на листе — вниз. Переводим: y_лист = H − y_dxf.
import type { Pt } from '../geometry';
import { annotate } from './annotate';
import { newId } from './ops';
import { TAU, normAngle, shapeOf, type CadDoc, type Entity, type LineType } from './model';

type Pair = [number, string];

function pairs(text: string): Pair[] {
  const lines = text.replace(/\r/g, '').split('\n');
  const out: Pair[] = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = parseInt(lines[i].trim(), 10);
    if (Number.isNaN(code)) { i--; continue; }
    out.push([code, lines[i + 1].trim()]);
  }
  return out;
}

interface Raw { type: string; g: Pair[] }

const num = (r: Raw, code: number, def = 0) => { const p = r.g.find((x) => x[0] === code); return p ? parseFloat(p[1]) : def; };
const str = (r: Raw, code: number) => r.g.find((x) => x[0] === code)?.[1] ?? '';
const all = (r: Raw, code: number) => r.g.filter((x) => x[0] === code).map((x) => parseFloat(x[1]));

function ltypeOf(name: string): LineType {
  const n = name.toUpperCase();
  if (/DASHDOT|CENTER|ОСЕВ|ШТРИХПУНКТ/.test(n)) return 'center';
  if (/PHANTOM|DIVIDE/.test(n)) return 'phantom';
  if (/DASH|HIDDEN|ШТРИХ/.test(n)) return 'dashed';
  return 'main';
}

/** Сплайн NURBS (без весов) по контрольным точкам и узлам — алгоритм де Бура. */
function bspline(ctrl: Pt[], knots: number[], deg: number, n = 200): Pt[] {
  if (ctrl.length <= deg || knots.length !== ctrl.length + deg + 1) return ctrl;
  const lo = knots[deg], hi = knots[knots.length - deg - 1];
  const out: Pt[] = [];
  for (let s = 0; s <= n; s++) {
    const t = lo + ((hi - lo) * s) / n;
    let k = deg;
    while (k < ctrl.length - 1 && t >= knots[k + 1]) k++;
    const d = ctrl.slice(k - deg, k + 1).map((p) => [p[0], p[1]] as Pt);
    for (let r = 1; r <= deg; r++)
      for (let j = deg; j >= r; j--) {
        const i = k - deg + j;
        const den = knots[i + deg - r + 1] - knots[i];
        const a = den ? (t - knots[i]) / den : 0;
        d[j] = [(1 - a) * d[j - 1][0] + a * d[j][0], (1 - a) * d[j - 1][1] + a * d[j][1]];
      }
    out.push(d[deg]);
  }
  return out;
}

export interface DxfImport { entities: Entity[]; skipped: Record<string, number>; bbox: { minX: number; minY: number; maxX: number; maxY: number } | null }

/** Разбор DXF. Возвращает объекты в «DXF-координатах» с Y вниз (до размещения на листе). */
export function parseDxf(text: string, layerId: string): DxfImport {
  const P = pairs(text);
  // Секции
  const blocks = new Map<string, Raw[]>();
  const entities: Raw[] = [];
  let section = '';
  let curBlock: { name: string; list: Raw[] } | null = null;
  let cur: Raw | null = null;
  const flush = () => { if (cur) { (curBlock ? curBlock.list : section === 'ENTITIES' ? entities : []).push(cur); cur = null; } };
  for (let i = 0; i < P.length; i++) {
    const [c, v] = P[i];
    if (c === 0) {
      flush();
      if (v === 'SECTION') { section = P[i + 1]?.[1] ?? ''; continue; }
      if (v === 'ENDSEC') { section = ''; continue; }
      if (section === 'BLOCKS' && v === 'BLOCK') { curBlock = { name: '', list: [] }; cur = null; continue; }
      if (section === 'BLOCKS' && v === 'ENDBLK') { if (curBlock) blocks.set(curBlock.name, curBlock.list); curBlock = null; continue; }
      if (section === 'ENTITIES' || (section === 'BLOCKS' && curBlock)) cur = { type: v, g: [] };
      continue;
    }
    if (curBlock && !cur && c === 2) curBlock.name = v;
    if (cur) cur.g.push([c, v]);
  }
  flush();

  const out: Entity[] = [];
  const skipped: Record<string, number> = {};
  const base = (r: Raw) => ({ id: newId(), layer: layerId, lt: ltypeOf(str(r, 6)) });
  const Y = (y: number) => -y; // Y вверх → вниз; сдвиг сделаем при размещении

  const convert = (list: Raw[], xf: (p: Pt) => Pt, rotDeg: number, sc: number, depth: number) => {
    for (let idx = 0; idx < list.length; idx++) {
      const r = list[idx];
      const pt = (cx: number, cy: number): Pt => { const p = xf([num(r, cx), num(r, cy)]); return [p[0], Y(p[1])]; };
      switch (r.type) {
        case 'LINE': out.push({ ...base(r), t: 'line', a: pt(10, 20), b: pt(11, 21) }); break;
        case 'POINT': out.push({ ...base(r), t: 'point', p: pt(10, 20) }); break;
        case 'CIRCLE': out.push({ ...base(r), t: 'circle', c: pt(10, 20), r: num(r, 40) * sc }); break;
        case 'ARC': {
          // DXF: углы против часовой при Y вверх; на листе (Y вниз) — это по часовой, т.е. a = −угол
          const s = (num(r, 50) + rotDeg) * Math.PI / 180, e = (num(r, 51) + rotDeg) * Math.PI / 180;
          const a0 = -e, sweep = normAngle(e - s) || TAU;
          out.push({ ...base(r), t: 'arc', c: pt(10, 20), r: num(r, 40) * sc, a0, a1: a0 + sweep });
          break;
        }
        case 'ELLIPSE': {
          const c = pt(10, 20);
          const mx = num(r, 11), my = num(r, 21);
          const ratio = num(r, 40, 1);
          const rx = Math.hypot(mx, my) * sc;
          const rot = -(Math.atan2(my, mx) + (rotDeg * Math.PI) / 180);
          const t0 = num(r, 41, 0), t1 = num(r, 42, TAU);
          if (Math.abs(normAngle(t1 - t0)) < 1e-6 || Math.abs(t1 - t0 - TAU) < 1e-6) out.push({ ...base(r), t: 'ellipse', c, rx, ry: rx * ratio, rot });
          else {
            const n = 96, pts: Pt[] = [];
            const sweep = normAngle(t1 - t0) || TAU;
            for (let k = 0; k <= n; k++) {
              const t = t0 + (sweep * k) / n;
              const x = rx * Math.cos(t), y = rx * ratio * Math.sin(t);
              const cs = Math.cos(-rot), sn = Math.sin(-rot);
              pts.push([c[0] + x * cs - y * sn, c[1] - (x * sn + y * cs)]);
            }
            out.push({ ...base(r), t: 'pline', pts, closed: false });
          }
          break;
        }
        case 'LWPOLYLINE': {
          const xs = all(r, 10), ys = all(r, 20);
          const closed = (num(r, 70) & 1) === 1;
          // выпуклость (42) для каждой вершины — по порядку появления после 10/20
          const bulges: number[] = [];
          let vi = -1;
          for (const [c, v] of r.g) { if (c === 10) { vi++; bulges[vi] = 0; } else if (c === 42 && vi >= 0) bulges[vi] = parseFloat(v); }
          const raw = xs.map((x, k) => xf([x, ys[k]]));
          out.push({ ...base(r), t: 'pline', pts: bulgePoly(raw, bulges, closed).map(([x, y]) => [x, Y(y)] as Pt), closed });
          break;
        }
        case 'POLYLINE': {
          const closed = (num(r, 70) & 1) === 1;
          const raw: Pt[] = [], bulges: number[] = [];
          let j = idx + 1;
          for (; j < list.length && list[j].type === 'VERTEX'; j++) { raw.push(xf([num(list[j], 10), num(list[j], 20)])); bulges.push(num(list[j], 42)); }
          idx = j; // SEQEND
          out.push({ ...base(r), t: 'pline', pts: bulgePoly(raw, bulges, closed).map(([x, y]) => [x, Y(y)] as Pt), closed });
          break;
        }
        case 'SPLINE': {
          const fx = all(r, 11), fy = all(r, 21);
          if (fx.length >= 2) { out.push({ ...base(r), t: 'spline', pts: fx.map((x, k) => { const p = xf([x, fy[k]]); return [p[0], Y(p[1])] as Pt; }), closed: (num(r, 70) & 1) === 1 }); break; }
          const cx = all(r, 10), cy = all(r, 20), knots = all(r, 40), deg = num(r, 71, 3);
          const pts = bspline(cx.map((x, k) => xf([x, cy[k]])), knots, deg).map(([x, y]) => [x, Y(y)] as Pt);
          out.push({ ...base(r), t: 'pline', pts, closed: false });
          break;
        }
        case 'TEXT': case 'MTEXT': {
          let s = str(r, 1);
          if (r.type === 'MTEXT') s = s.replace(/\\P/g, ' ').replace(/\\[A-Za-z][^;]*;/g, '').replace(/[{}]/g, '');
          s = s.replace(/%%[cC]/g, '⌀').replace(/%%[dD]/g, '°').replace(/%%[pP]/g, '±');
          if (!s.trim()) break;
          out.push({ ...base(r), t: 'text', p: pt(10, 20), text: s, h: Math.max(1, num(r, 40, 3.5) * sc), rot: -((num(r, 50) + rotDeg) * Math.PI) / 180 });
          break;
        }
        case 'INSERT': {
          const blk = blocks.get(str(r, 2));
          if (!blk || depth > 4) { skipped.INSERT = (skipped.INSERT ?? 0) + 1; break; }
          const ip: Pt = [num(r, 10), num(r, 20)];
          const sx = num(r, 41, 1), sy = num(r, 42, sx), ang = num(r, 50) * Math.PI / 180;
          const cs = Math.cos(ang), sn = Math.sin(ang);
          const inner = (p: Pt): Pt => xf([ip[0] + (p[0] * sx) * cs - (p[1] * sy) * sn, ip[1] + (p[0] * sx) * sn + (p[1] * sy) * cs]);
          convert(blk, inner, rotDeg + num(r, 50), sc * Math.abs(sx), depth + 1);
          break;
        }
        case 'VERTEX': case 'SEQEND': case 'ATTRIB': case 'ATTDEF': break;
        default: skipped[r.type] = (skipped[r.type] ?? 0) + 1;
      }
    }
  };
  convert(entities, (p) => p, 0, 1, 0);

  let bbox: DxfImport['bbox'] = null;
  for (const e of out) {
    const lines = e.t === 'text' ? [[e.p]] : shapeOf(e);
    for (const l of lines) for (const [x, y] of l) {
      if (!bbox) bbox = { minX: x, minY: y, maxX: x, maxY: y };
      else { bbox.minX = Math.min(bbox.minX, x); bbox.minY = Math.min(bbox.minY, y); bbox.maxX = Math.max(bbox.maxX, x); bbox.maxY = Math.max(bbox.maxY, y); }
    }
  }
  return { entities: out, skipped, bbox };
}

/** Ломаная с выпуклостями (bulge) → точки с дугами. */
function bulgePoly(pts: Pt[], bulges: number[], closed: boolean): Pt[] {
  if (!bulges.some((b) => b)) return pts;
  const out: Pt[] = [pts[0]];
  const n = closed ? pts.length : pts.length - 1;
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length], bu = bulges[i] ?? 0;
    if (!bu) { out.push(b); continue; }
    const theta = 4 * Math.atan(bu);
    const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const r = d / (2 * Math.sin(theta / 2));
    const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
    const h = r * Math.cos(theta / 2);
    const ux = (b[0] - a[0]) / d, uy = (b[1] - a[1]) / d;
    const c: Pt = [mx - uy * h, my + ux * h];
    const a0 = Math.atan2(a[1] - c[1], a[0] - c[0]);
    const segs = Math.max(4, Math.ceil(Math.abs(theta) / (Math.PI / 36)));
    for (let k = 1; k <= segs; k++) {
      const t = a0 + (theta * k) / segs;
      out.push([c[0] + Math.abs(r) * Math.cos(t), c[1] + Math.abs(r) * Math.sin(t)]);
    }
  }
  if (closed) out.pop();
  return out;
}

// ── Экспорт DXF R12 ──────────────────────────────────────────────────

const f = (n: number) => (Math.round(n * 10000) / 10000).toString();

export function exportDxf(cad: CadDoc, sheetH: number): string {
  const L: string[] = [];
  const g = (code: number, v: string | number) => L.push(String(code), typeof v === 'number' ? f(v) : v);
  const Y = (y: number) => sheetH - y;
  const layerName = new Map(cad.layers.map((l) => [l.id, l.name.replace(/[<>/\\":;?*|=,]/g, '_') || '0']));
  const LT: Record<LineType, string> = { main: 'CONTINUOUS', thin: 'CONTINUOUS', dashed: 'DASHED', center: 'CENTER', phantom: 'PHANTOM' };
  const aci: Record<string, number> = { '': 7, '#e03131': 1, '#1971c2': 5, '#2f9e44': 3, '#d9480f': 30, '#7048e8': 6, '#000000': 7 };

  g(0, 'SECTION'); g(2, 'HEADER'); g(9, '$ACADVER'); g(1, 'AC1009'); g(9, '$INSUNITS'); g(70, '4'); g(0, 'ENDSEC');
  g(0, 'SECTION'); g(2, 'TABLES');
  g(0, 'TABLE'); g(2, 'LTYPE'); g(70, '4');
  const ltypes: [string, string, number[]][] = [['CONTINUOUS', 'Solid line', []], ['DASHED', '__ __ __', [5, -1.8]], ['CENTER', '____ . ____', [14, -2.5, 0.4, -2.5]], ['PHANTOM', '____ . . ____', [16, -2.5, 0.4, -2.5, 0.4, -2.5]]];
  for (const [name, desc, pat] of ltypes) {
    g(0, 'LTYPE'); g(2, name); g(70, '0'); g(3, desc); g(72, '65'); g(73, String(pat.length)); g(40, pat.reduce((s, x) => s + Math.abs(x), 0));
    for (const p of pat) g(49, p);
  }
  g(0, 'ENDTAB');
  g(0, 'TABLE'); g(2, 'LAYER'); g(70, String(cad.layers.length));
  for (const l of cad.layers) { g(0, 'LAYER'); g(2, layerName.get(l.id)!); g(70, '0'); g(62, String((aci[l.color] ?? 7) * (l.visible ? 1 : -1))); g(6, 'CONTINUOUS'); }
  g(0, 'ENDTAB'); g(0, 'ENDSEC');

  g(0, 'SECTION'); g(2, 'ENTITIES');
  const head = (type: string, e: Entity) => { g(0, type); g(8, layerName.get(e.layer) ?? '0'); g(6, LT[e.lt]); };
  const poly = (e: Entity, pts: Pt[], closed: boolean) => {
    head('POLYLINE', e); g(66, '1'); g(10, 0); g(20, 0); g(30, 0); g(70, closed ? '1' : '0');
    for (const [x, y] of pts) { g(0, 'VERTEX'); g(8, layerName.get(e.layer) ?? '0'); g(10, x); g(20, Y(y)); g(30, 0); }
    g(0, 'SEQEND');
  };
  for (const e of cad.entities) {
    switch (e.t) {
      case 'line': head('LINE', e); g(10, e.a[0]); g(20, Y(e.a[1])); g(30, 0); g(11, e.b[0]); g(21, Y(e.b[1])); g(31, 0); break;
      case 'circle': head('CIRCLE', e); g(10, e.c[0]); g(20, Y(e.c[1])); g(30, 0); g(40, e.r); break;
      case 'arc': {
        head('ARC', e); g(10, e.c[0]); g(20, Y(e.c[1])); g(30, 0); g(40, e.r);
        // на листе a0→a1 по часовой; в DXF против часовой от −a1 до −a0
        g(50, (normAngle(-e.a1) * 180) / Math.PI); g(51, (normAngle(-e.a0) * 180) / Math.PI);
        break;
      }
      case 'point': head('POINT', e); g(10, e.p[0]); g(20, Y(e.p[1])); g(30, 0); break;
      case 'text': {
        const s = e.text.replace(/⌀/g, '%%c').replace(/°/g, '%%d').replace(/±/g, '%%p');
        head('TEXT', e); g(10, e.p[0]); g(20, Y(e.p[1])); g(30, 0); g(40, e.h); g(1, s); g(50, (normAngle(-e.rot) * 180) / Math.PI);
        break;
      }
      case 'pline': poly(e, e.pts, e.closed); break;
      case 'ellipse': case 'spline': poly(e, shapeOf(e)[0], false); break;
      case 'dim': case 'hatch':
        // размеры и штриховки — «разбитыми» на линии (как в AutoCAD после EXPLODE)
        for (const l of annotate(e, cad)) if (l.length > 1) poly(e, l, false);
        break;
    }
  }
  g(0, 'ENDSEC'); g(0, 'EOF');
  return L.join('\n') + '\n';
}
