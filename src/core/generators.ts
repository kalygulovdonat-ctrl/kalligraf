// Генераторы рисунков: лабиринты, спирограф, графики функций, фракталы, орнаменты, разметка, рамки.
// Все функции возвращают пути в мм в собственной системе координат (0,0 — левый верх, Y вниз).
import { CAP, type Font } from './font';
import { type Path, type Pt } from './geometry';
import { makeNoise2D, mulberry32, type Rng } from './rng';
import { compileExpr } from './expr';
import { encodeQr, qrPaths, type Ecc } from './qr';
import { formulaPaths } from './math';

/** Однострочная надпись шрифтом: x — левый край, y — базовая линия. */
export function textPaths(str: string, font: Font, x: number, y: number, size: number, anchor: 'start' | 'middle' | 'end' = 'start'): Path[] {
  const s = size / CAP;
  const chars = [...str];
  const width = chars.reduce((w, c) => w + (font.glyphs[c]?.variants[0].advance ?? 4) * s + size * 0.06, 0);
  let pen = anchor === 'middle' ? x - width / 2 : anchor === 'end' ? x - width : x;
  const out: Path[] = [];
  for (const c of chars) {
    const v = font.glyphs[c]?.variants[0];
    if (v) for (const st of v.strokes) out.push({ points: st.map(([gx, gy]) => [pen + gx * s, y - gy * s] as Pt) });
    pen += (v?.advance ?? 4) * s + size * 0.06;
  }
  return out;
}

// ── Лабиринт ─────────────────────────────────────────────────────────

export type MazeAlgo = 'dfs' | 'prim' | 'kruskal' | 'wilson';
export interface MazeParams { cols: number; rows: number; cell: number; algo: MazeAlgo; seed: number; solution: boolean; shape: 'square' | 'circle' }

/** Возвращает для каждой клетки открытые стены: биты 1=верх, 2=право, 4=низ, 8=лево. */
export function carveMaze(cols: number, rows: number, algo: MazeAlgo, rnd: Rng, mask?: (c: number, r: number) => boolean): Uint8Array {
  const n = cols * rows;
  const open = new Uint8Array(n);
  const ok = (c: number, r: number) => c >= 0 && r >= 0 && c < cols && r < rows && (!mask || mask(c, r));
  const dirs: [number, number, number, number][] = [[0, -1, 1, 4], [1, 0, 2, 8], [0, 1, 4, 1], [-1, 0, 8, 2]];
  const link = (a: number, b: number, d: [number, number, number, number]) => { open[a] |= d[2]; open[b] |= d[3]; };
  const cells: number[] = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) if (ok(c, r)) cells.push(r * cols + c);
  if (!cells.length) return open;
  const inMaze = new Uint8Array(n);
  const shuffle = <T,>(a: T[]) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  const nbrs = (i: number) => {
    const c = i % cols, r = Math.floor(i / cols);
    return dirs.filter((d) => ok(c + d[0], r + d[1])).map((d) => ({ j: (r + d[1]) * cols + c + d[0], d }));
  };

  if (algo === 'dfs') {
    const start = cells[Math.floor(rnd() * cells.length)];
    const stack = [start];
    inMaze[start] = 1;
    while (stack.length) {
      const i = stack[stack.length - 1];
      const cand = shuffle(nbrs(i).filter((x) => !inMaze[x.j]));
      if (!cand.length) { stack.pop(); continue; }
      const { j, d } = cand[0];
      link(i, j, d); inMaze[j] = 1; stack.push(j);
    }
  } else if (algo === 'prim') {
    const start = cells[Math.floor(rnd() * cells.length)];
    inMaze[start] = 1;
    const frontier: { i: number; j: number; d: [number, number, number, number] }[] = nbrs(start).map((x) => ({ i: start, ...x }));
    while (frontier.length) {
      const k = Math.floor(rnd() * frontier.length);
      const f = frontier[k];
      frontier[k] = frontier[frontier.length - 1]; frontier.pop();
      if (inMaze[f.j]) continue;
      link(f.i, f.j, f.d); inMaze[f.j] = 1;
      for (const x of nbrs(f.j)) if (!inMaze[x.j]) frontier.push({ i: f.j, ...x });
    }
  } else if (algo === 'kruskal') {
    const parent = new Int32Array(n).map((_, i) => i);
    const find = (x: number): number => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
    const edges: { i: number; j: number; d: [number, number, number, number] }[] = [];
    for (const i of cells) for (const x of nbrs(i)) if (x.d[2] === 2 || x.d[2] === 4) edges.push({ i, ...x });
    for (const e of shuffle(edges)) {
      const a = find(e.i), b = find(e.j);
      if (a !== b) { parent[a] = b; link(e.i, e.j, e.d); }
    }
  } else {
    // Уилсон: случайные блуждания со стиранием петель — равномерный лабиринт
    inMaze[cells[Math.floor(rnd() * cells.length)]] = 1;
    let remaining = cells.length - 1;
    const next = new Int32Array(n).fill(-1);
    const nextDir: ([number, number, number, number] | null)[] = new Array(n).fill(null);
    while (remaining > 0) {
      let start = -1;
      for (const c of shuffle(cells.slice())) if (!inMaze[c]) { start = c; break; }
      let i = start;
      while (!inMaze[i]) {
        const ns = nbrs(i);
        const x = ns[Math.floor(rnd() * ns.length)];
        next[i] = x.j; nextDir[i] = x.d; i = x.j;
      }
      i = start;
      while (!inMaze[i]) {
        link(i, next[i], nextDir[i]!); inMaze[i] = 1; remaining--; i = next[i];
      }
    }
  }
  return open;
}

function solveMaze(open: Uint8Array, cols: number, rows: number, from: number, to: number): number[] {
  const prev = new Int32Array(cols * rows).fill(-2);
  const q = [from];
  prev[from] = -1;
  const step: [number, number, number][] = [[1, 0, -1], [2, 1, 0], [4, 0, 1], [8, -1, 0]];
  while (q.length) {
    const i = q.shift()!;
    if (i === to) break;
    const c = i % cols, r = Math.floor(i / cols);
    for (const [bit, dc, dr] of step) {
      if (!(open[i] & bit)) continue;
      const j = (r + dr) * cols + c + dc;
      if (j < 0 || j >= cols * rows || prev[j] !== -2) continue;
      prev[j] = i; q.push(j);
    }
  }
  const path: number[] = [];
  for (let i = to; i >= 0; i = prev[i]) { path.push(i); if (prev[i] === -2) return []; }
  return path.reverse();
}

export function maze(p: MazeParams): Path[] {
  const rnd = mulberry32(p.seed);
  const { cols, rows, cell } = p;
  const cx = cols / 2, cy = rows / 2;
  const mask = p.shape === 'circle' ? (c: number, r: number) => Math.hypot(c + 0.5 - cx, (r + 0.5 - cy) * (cols / rows)) <= cols / 2 : undefined;
  const open = carveMaze(cols, rows, p.algo, rnd, mask);
  const inside = (c: number, r: number) => c >= 0 && r >= 0 && c < cols && r < rows && (!mask || mask(c, r));
  // Вход и выход
  let entry = -1, exit = -1;
  for (let i = 0; i < cols * rows && entry < 0; i++) if (inside(i % cols, Math.floor(i / cols))) entry = i;
  for (let i = cols * rows - 1; i >= 0 && exit < 0; i--) if (inside(i % cols, Math.floor(i / cols))) exit = i;
  open[entry] |= 1; open[exit] |= 4;
  // Горизонтальные стены — длинными линиями
  const out: Path[] = [];
  for (let r = 0; r <= rows; r++) {
    let runStart = -1;
    for (let c = 0; c <= cols; c++) {
      let wall = false;
      if (c < cols) {
        const above = r > 0 && inside(c, r - 1), below = r < rows && inside(c, r);
        if (above || below) {
          if (below) wall = !(open[r * cols + c] & 1);
          else wall = !(open[(r - 1) * cols + c] & 4);
          if (above && below) wall = !(open[r * cols + c] & 1);
        }
      }
      if (wall && runStart < 0) runStart = c;
      if (!wall && runStart >= 0) { out.push({ points: [[runStart * cell, r * cell], [c * cell, r * cell]] }); runStart = -1; }
    }
  }
  for (let c = 0; c <= cols; c++) {
    let runStart = -1;
    for (let r = 0; r <= rows; r++) {
      let wall = false;
      if (r < rows) {
        const left = c > 0 && inside(c - 1, r), right = c < cols && inside(c, r);
        if (left || right) wall = right ? !(open[r * cols + c] & 8) : !(open[r * cols + c - 1] & 2);
      }
      if (wall && runStart < 0) runStart = r;
      if (!wall && runStart >= 0) { out.push({ points: [[c * cell, runStart * cell], [c * cell, r * cell]] }); runStart = -1; }
    }
  }
  if (p.solution) {
    const sol = solveMaze(open, cols, rows, entry, exit);
    if (sol.length) {
      const pts: Pt[] = sol.map((i) => [((i % cols) + 0.5) * cell, (Math.floor(i / cols) + 0.5) * cell]);
      pts.unshift([pts[0][0], 0]);
      pts.push([pts[pts.length - 1][0], rows * cell]);
      out.push({ points: pts, color: '#d9480f', layer: 'Решение' });
    }
  }
  return out;
}

// ── Кривые ───────────────────────────────────────────────────────────

export interface SpiroParams { R: number; r: number; d: number; scale: number }
export function spirograph(p: SpiroParams): Path[] {
  const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
  const R = Math.round(p.R), r = Math.round(p.r);
  const turns = r / gcd(R, r);
  const n = Math.min(20000, Math.ceil(turns * 400));
  const pts: Pt[] = [];
  const k = p.scale;
  const off = (R - r + p.d) * k;
  for (let i = 0; i <= n; i++) {
    const t = (i / n) * turns * 2 * Math.PI;
    pts.push([off + ((R - r) * Math.cos(t) + p.d * Math.cos(((R - r) / r) * t)) * k, off + ((R - r) * Math.sin(t) - p.d * Math.sin(((R - r) / r) * t)) * k]);
  }
  return [{ points: pts }];
}

export interface RoseParams { n: number; d: number; radius: number }
export function rose(p: RoseParams): Path[] {
  const k = p.n / p.d;
  const period = (p.n * p.d) % 2 === 0 ? 2 * Math.PI * p.d : Math.PI * p.d;
  const N = 3000;
  const pts: Pt[] = [];
  for (let i = 0; i <= N; i++) {
    const t = (i / N) * period;
    const r = p.radius * Math.cos(k * t);
    pts.push([p.radius + r * Math.cos(t), p.radius + r * Math.sin(t)]);
  }
  return [{ points: pts }];
}

export interface LissajousParams { a: number; b: number; delta: number; w: number; h: number }
export function lissajous(p: LissajousParams): Path[] {
  const N = 3000, pts: Pt[] = [];
  for (let i = 0; i <= N; i++) {
    const t = (i / N) * 2 * Math.PI;
    pts.push([p.w / 2 + (p.w / 2) * Math.sin(p.a * t + (p.delta * Math.PI) / 180), p.h / 2 + (p.h / 2) * Math.sin(p.b * t)]);
  }
  return [{ points: pts }];
}

export interface SpiralParams { turns: number; radius: number }
export function spiral(p: SpiralParams): Path[] {
  const N = Math.ceil(p.turns * 120), pts: Pt[] = [];
  for (let i = 0; i <= N; i++) {
    const t = (i / N) * p.turns * 2 * Math.PI;
    const r = (p.radius * i) / N;
    pts.push([p.radius + r * Math.cos(t), p.radius + r * Math.sin(t)]);
  }
  return [{ points: pts }];
}

// ── График функции ───────────────────────────────────────────────────

export interface GraphParams {
  exprs: string;       // несколько функций через «;»
  xmin: number; xmax: number; ymin: number; ymax: number;
  w: number; h: number;
  grid: boolean;
  labels: boolean;
}
const GRAPH_COLORS = ['', '#d9480f', '#1971c2', '#2f9e44'];

export function graph(p: GraphParams, font: Font): Path[] {
  const out: Path[] = [];
  const X = (x: number) => ((x - p.xmin) / (p.xmax - p.xmin)) * p.w;
  const Y = (y: number) => p.h - ((y - p.ymin) / (p.ymax - p.ymin)) * p.h;
  const niceStep = (range: number) => {
    const raw = range / 8;
    const pow = Math.pow(10, Math.floor(Math.log10(raw)));
    return [1, 2, 5, 10].map((m) => m * pow).find((s) => s >= raw) ?? raw;
  };
  const sx = niceStep(p.xmax - p.xmin), sy = niceStep(p.ymax - p.ymin);
  if (p.grid) {
    for (let x = Math.ceil(p.xmin / sx) * sx; x <= p.xmax + 1e-9; x += sx) out.push({ points: [[X(x), 0], [X(x), p.h]], color: '#adb5bd', layer: 'Сетка' });
    for (let y = Math.ceil(p.ymin / sy) * sy; y <= p.ymax + 1e-9; y += sy) out.push({ points: [[0, Y(y)], [p.w, Y(y)]], color: '#adb5bd', layer: 'Сетка' });
  }
  const ax = p.ymin <= 0 && p.ymax >= 0 ? Y(0) : p.h;
  const ay = p.xmin <= 0 && p.xmax >= 0 ? X(0) : 0;
  out.push({ points: [[0, ax], [p.w, ax]] }, { points: [[p.w - 3, ax - 1.2], [p.w, ax], [p.w - 3, ax + 1.2]] });
  out.push({ points: [[ay, p.h], [ay, 0]] }, { points: [[ay - 1.2, 3], [ay, 0], [ay + 1.2, 3]] });
  const ls = 2.5;
  if (p.labels) {
    out.push(...textPaths('x', font, p.w - 2, ax + 4.5, ls));
    out.push(...textPaths('y', font, ay + 2, 3, ls));
    for (let x = Math.ceil(p.xmin / sx) * sx; x <= p.xmax + 1e-9; x += sx) {
      if (Math.abs(x) < 1e-9 || X(x) > p.w - 5) continue;
      out.push({ points: [[X(x), ax - 0.8], [X(x), ax + 0.8]] });
      out.push(...textPaths(fmtNum(x), font, X(x), ax + 4, ls * 0.8, 'middle'));
    }
    for (let y = Math.ceil(p.ymin / sy) * sy; y <= p.ymax + 1e-9; y += sy) {
      if (Math.abs(y) < 1e-9 || Y(y) < 5) continue;
      out.push({ points: [[ay - 0.8, Y(y)], [ay + 0.8, Y(y)]] });
      out.push(...textPaths(fmtNum(y), font, ay - 1.5, Y(y) + 1, ls * 0.8, 'end'));
    }
    if (p.xmin <= 0 && p.xmax >= 0 && p.ymin <= 0 && p.ymax >= 0) out.push(...textPaths('0', font, ay - 1.5, ax + 3.5, ls * 0.8, 'end'));
  }
  p.exprs.split(';').map((e) => e.trim()).filter(Boolean).forEach((src, k) => {
    const f = compileExpr(src.replace(/^y\s*=\s*/i, ''));
    const N = 1500;
    let cur: Pt[] = [];
    const flush = () => { if (cur.length > 1) out.push({ points: cur, color: GRAPH_COLORS[k % GRAPH_COLORS.length] || undefined }); cur = []; };
    let prevY: number | null = null;
    for (let i = 0; i <= N; i++) {
      const x = p.xmin + ((p.xmax - p.xmin) * i) / N;
      const y = f({ x });
      if (!Number.isFinite(y) || y < p.ymin - (p.ymax - p.ymin) || y > p.ymax + (p.ymax - p.ymin) || (prevY !== null && Math.abs(y - prevY) > (p.ymax - p.ymin) * 0.8)) {
        flush(); prevY = Number.isFinite(y) ? y : null; continue;
      }
      prevY = y;
      const py = Y(y);
      if (py < 0 || py > p.h) { flush(); continue; }
      cur.push([X(x), py]);
    }
    flush();
  });
  return out;
}
const fmtNum = (n: number) => String(Math.round(n * 1000) / 1000).replace('.', ',');

// ── Фракталы и генеративное ──────────────────────────────────────────

export interface KochParams { depth: number; size: number }
export function koch(p: KochParams): Path[] {
  const h = (p.size * Math.sqrt(3)) / 2;
  let pts: Pt[] = [[0, h / 3], [p.size, h / 3], [p.size / 2, h / 3 + h], [0, h / 3]];
  for (let d = 0; d < Math.min(6, p.depth); d++) {
    const next: Pt[] = [pts[0]];
    for (let i = 0; i < pts.length - 1; i++) {
      const [ax, ay] = pts[i], [bx, by] = pts[i + 1];
      const dx = (bx - ax) / 3, dy = (by - ay) / 3;
      const p1: Pt = [ax + dx, ay + dy], p3: Pt = [ax + 2 * dx, ay + 2 * dy];
      const p2: Pt = [p1[0] + dx * 0.5 + dy * Math.sqrt(3) / 2, p1[1] + dy * 0.5 - dx * Math.sqrt(3) / 2];
      next.push(p1, p2, p3, [bx, by]);
    }
    pts = next;
  }
  return [{ points: pts }];
}

export interface TreeParams { depth: number; angle: number; length: number; ratio: number; seed: number; randomness: number }
export function tree(p: TreeParams): Path[] {
  const rnd = mulberry32(p.seed);
  const out: Path[] = [];
  const W = p.length * 4;
  const grow = (x: number, y: number, ang: number, len: number, d: number) => {
    const j = 1 + (rnd() * 2 - 1) * p.randomness;
    const x2 = x + Math.cos(ang) * len * j, y2 = y - Math.sin(ang) * len * j;
    out.push({ points: [[x, y], [x2, y2]] });
    if (d <= 1) return;
    const a = (p.angle * Math.PI) / 180;
    grow(x2, y2, ang + a * (1 + (rnd() * 2 - 1) * p.randomness), len * p.ratio, d - 1);
    grow(x2, y2, ang - a * (1 + (rnd() * 2 - 1) * p.randomness), len * p.ratio, d - 1);
  };
  grow(W / 2, p.length * 3.2, Math.PI / 2, p.length, Math.min(12, p.depth));
  return out;
}

export interface FlowParams { w: number; h: number; lines: number; length: number; scale: number; seed: number }
export function flowField(p: FlowParams): Path[] {
  const noise = makeNoise2D(p.seed);
  const rnd = mulberry32(p.seed + 1);
  const out: Path[] = [];
  for (let k = 0; k < p.lines; k++) {
    let x = rnd() * p.w, y = rnd() * p.h;
    const pts: Pt[] = [[x, y]];
    for (let i = 0; i < p.length; i++) {
      const a = noise(x / p.scale, y / p.scale) * Math.PI * 2;
      x += Math.cos(a) * 0.8; y += Math.sin(a) * 0.8;
      if (x < 0 || y < 0 || x > p.w || y > p.h) break;
      pts.push([x, y]);
    }
    if (pts.length > 2) out.push({ points: pts });
  }
  return out;
}

export interface WavesParams { w: number; h: number; lines: number; amp: number; seed: number }
export function waves(p: WavesParams): Path[] {
  const noise = makeNoise2D(p.seed);
  const out: Path[] = [];
  for (let k = 0; k < p.lines; k++) {
    const y0 = (p.h * (k + 1)) / (p.lines + 1);
    const pts: Pt[] = [];
    for (let x = 0; x <= p.w; x += 0.8) {
      const c = 1 - Math.abs(x - p.w / 2) / (p.w / 2);
      const bump = Math.pow(Math.max(0, c), 2) * Math.abs(noise(x / 12, k * 0.7)) * p.amp * 2.2;
      pts.push([x, y0 - bump]);
    }
    out.push({ points: pts });
  }
  return out;
}

export interface MandalaParams { radius: number; petals: number; rings: number; seed: number }
export function mandala(p: MandalaParams): Path[] {
  const rnd = mulberry32(p.seed);
  const out: Path[] = [];
  const C = p.radius;
  const circle = (r: number) => {
    const pts: Pt[] = [];
    for (let i = 0; i <= 120; i++) { const t = (i / 120) * 2 * Math.PI; pts.push([C + r * Math.cos(t), C + r * Math.sin(t)]); }
    out.push({ points: pts });
  };
  for (let ring = 0; ring < p.rings; ring++) {
    const r0 = (p.radius * (ring + 0.6)) / (p.rings + 0.6), r1 = (p.radius * (ring + 1.6)) / (p.rings + 0.6);
    const n = p.petals * (ring % 2 ? 2 : 1);
    const style = Math.floor(rnd() * 3);
    circle(r0);
    for (let i = 0; i < n; i++) {
      const a0 = (i / n) * 2 * Math.PI, a1 = ((i + 1) / n) * 2 * Math.PI, am = (a0 + a1) / 2;
      const pts: Pt[] = [];
      for (let k = 0; k <= 24; k++) {
        const t = k / 24;
        const a = a0 + (a1 - a0) * t;
        const bulge = style === 0 ? Math.sin(t * Math.PI) : style === 1 ? 1 - Math.abs(2 * t - 1) : Math.sin(t * Math.PI) ** 0.5;
        const r = r0 + (r1 - r0) * 0.95 * bulge;
        pts.push([C + r * Math.cos(a), C + r * Math.sin(a)]);
      }
      out.push({ points: pts });
      if (style !== 1) {
        const rr = r0 + (r1 - r0) * 0.45;
        out.push({ points: [[C + r0 * Math.cos(am), C + r0 * Math.sin(am)], [C + rr * Math.cos(am), C + rr * Math.sin(am)]] });
      }
    }
  }
  circle(p.radius * 0.6 / (p.rings + 0.6) * 0.5);
  return out;
}

/** Кыргызский орнамент «кочкор мүйүз» (бараньи рога) — бордюр из парных завитков. */
export interface OrnamentParams { count: number; size: number; rows: number }
export function kochkorMuyuz(p: OrnamentParams): Path[] {
  const out: Path[] = [];
  const s = p.size;
  // Рог: спираль вокруг центра (±0.3s, 0.55s), начинается в вершине стебля (0, 0.55s),
  // идёт вверх-наружу и закручивается внутрь на 1.5 оборота. Ось Y здесь вверх.
  const horn = (side: 1 | -1, mx: number, base: number): Pt[] => {
    const pts: Pt[] = [];
    const N = 90;
    const cx = side * 0.3 * s, cy = 0.55 * s;
    for (let i = 0; i <= N; i++) {
      const t = i / N;
      const ang = Math.PI - t * 3 * Math.PI; // по часовой стрелке для правого рога
      const r = 0.3 * s * (1 - 0.78 * t);
      const x = cx + side * r * Math.cos(ang);
      const y = cy + r * Math.sin(ang);
      pts.push([mx + x, base - y]);
    }
    return pts;
  };
  const step = s * 1.35;
  for (let row = 0; row < p.rows; row++) {
    const base = row * s * 1.25 + s * 0.95;
    for (let i = 0; i < p.count; i++) {
      const mx = s * 0.65 + i * step;
      out.push({ points: [...horn(-1, mx, base).reverse(), ...horn(1, mx, base).slice(1)] });
      out.push({ points: [[mx, base - 0.55 * s], [mx, base + s * 0.12]] });
    }
    out.push({ points: [[0, base + s * 0.12], [s * 1.3 + (p.count - 1) * step, base + s * 0.12]] });
  }
  return out;
}

// ── Разметка и рамки ─────────────────────────────────────────────────

export type MarkupKind = 'grid' | 'lines' | 'oblique' | 'mm' | 'staff' | 'propisi';
export interface MarkupParams { kind: MarkupKind; step: number; w: number; h: number; margin: boolean }
export function markup(p: MarkupParams): Path[] {
  const out: Path[] = [];
  const H = (y: number, color?: string) => out.push({ points: [[0, y], [p.w, y]], color });
  const V = (x: number, color?: string) => out.push({ points: [[x, 0], [x, p.h]], color });
  if (p.kind === 'grid' || p.kind === 'mm') {
    const step = p.kind === 'mm' ? 1 : p.step;
    for (let y = 0; y <= p.h + 1e-9; y += step) H(y);
    for (let x = 0; x <= p.w + 1e-9; x += step) V(x);
  } else if (p.kind === 'lines') {
    for (let y = p.step; y <= p.h + 1e-9; y += p.step) H(y);
  } else if (p.kind === 'oblique' || p.kind === 'propisi') {
    // косая линейка: рабочая строка, вспомогательные линии, наклонные 65°
    const lineH = p.step;
    for (let y = lineH; y + lineH <= p.h + 1e-9; y += lineH * 2.5) {
      H(y); H(y + lineH / 3); H(y + (2 * lineH) / 3); H(y + lineH);
    }
    const k = 1 / Math.tan((65 * Math.PI) / 180);
    for (let x = -p.h * k; x < p.w; x += p.step * 1.5) {
      const a: Pt = [x, p.h], b: Pt = [x + p.h * k, 0];
      const clip = (pt: Pt, q: Pt): Pt[] | null => {
        const t0 = Math.max(0, (0 - pt[0]) / (q[0] - pt[0])), t1 = Math.min(1, (p.w - pt[0]) / (q[0] - pt[0]));
        if (t0 >= t1) return null;
        return [[pt[0] + (q[0] - pt[0]) * t0, pt[1] + (q[1] - pt[1]) * t0], [pt[0] + (q[0] - pt[0]) * t1, pt[1] + (q[1] - pt[1]) * t1]];
      };
      const seg = clip(a, b);
      if (seg) out.push({ points: seg, color: '#adb5bd' });
    }
  } else if (p.kind === 'staff') {
    const gap = p.step / 4;
    for (let y = p.step; y + p.step <= p.h; y += p.step * 2.2) for (let k = 0; k < 5; k++) H(y + k * gap);
  }
  if (p.margin) V(p.w - 25, '#e03131');
  return out;
}

/** Рамка чертежа по ГОСТ 2.104 (форма 1, упрощённая сетка штампа 185×55). */
export function gostFrame(sheetW: number, sheetH: number, font: Font, fields: Record<string, string>): Path[] {
  const out: Path[] = [];
  const L = 20, M = 5;
  const x0 = L, y0 = M, x1 = sheetW - M, y1 = sheetH - M;
  const rect = (ax: number, ay: number, bx: number, by: number) => out.push({ points: [[ax, ay], [bx, ay], [bx, by], [ax, by], [ax, ay]] });
  const line = (ax: number, ay: number, bx: number, by: number) => out.push({ points: [[ax, ay], [bx, by]] });
  rect(x0, y0, x1, y1);
  const sx = x1 - 185, sy = y1 - 55;
  rect(sx, sy, x1, y1);
  // Левая часть штампа: 7 колонок, строки по 5 мм
  const cols = [7, 10, 23, 15, 10];
  let cx = sx;
  for (const c of cols) { cx += c; line(cx, sy, cx, y1); }
  for (let k = 1; k < 11; k++) line(sx, sy + k * 5, sx + 65, sy + k * 5);
  // Правая часть
  line(sx + 65, sy + 15, x1, sy + 15);
  line(sx + 65, sy + 40, x1, sy + 40);
  line(sx + 135, sy + 15, sx + 135, y1);
  line(sx + 135, sy + 20, x1, sy + 20);
  line(sx + 135, sy + 35, x1, sy + 35);
  line(sx + 150, sy + 15, sx + 150, sy + 35);
  line(sx + 167, sy + 15, sx + 167, sy + 35);
  const t = (s: string, x: number, y: number, size = 2.5, anchor: 'start' | 'middle' = 'start') => out.push(...textPaths(s, font, x, y, size, anchor));
  const rowsL = ['Изм.', 'Разраб.', 'Пров.', 'Т.контр.', '', 'Н.контр.', 'Утв.'];
  rowsL.forEach((r, k) => r && t(r, sx + 0.8, sy + 29 + k * 5 - 0.0 + (k ? 0 : -5), 2.2));
  t('Лит.', sx + 137, sy + 19, 2.2); t('Масса', sx + 152, sy + 19, 2.2); t('Масштаб', sx + 168, sy + 19, 2.2);
  if (fields.title) t(fields.title, sx + 100, sy + 30, 5, 'middle');
  if (fields.code) t(fields.code, sx + 125, sy + 10, 5, 'middle');
  if (fields.org) t(fields.org, sx + 160, sy + 49, 3.5, 'middle');
  if (fields.author) t(fields.author, sx + 18, sy + 34, 2.5);
  if (fields.checker) t(fields.checker, sx + 18, sy + 39, 2.5);
  if (fields.scale) t(fields.scale, sx + 176, sy + 29, 3.5, 'middle');
  return out;
}

// ── Судоку ───────────────────────────────────────────────────────────

export interface SudokuParams { cell: number; clues: number; seed: number; solution: boolean }
export function sudokuGrid(seed: number, clues: number): { puzzle: number[]; solution: number[] } {
  const rnd = mulberry32(seed);
  const g = new Array(81).fill(0);
  const can = (b: number[], i: number, v: number) => {
    const r = Math.floor(i / 9), c = i % 9;
    for (let k = 0; k < 9; k++) if (b[r * 9 + k] === v || b[k * 9 + c] === v) return false;
    const br = r - (r % 3), bc = c - (c % 3);
    for (let a = 0; a < 3; a++) for (let d = 0; d < 3; d++) if (b[(br + a) * 9 + bc + d] === v) return false;
    return true;
  };
  const fill = (i: number): boolean => {
    if (i === 81) return true;
    const vals = [1, 2, 3, 4, 5, 6, 7, 8, 9].sort(() => rnd() - 0.5);
    for (const v of vals) if (can(g, i, v)) { g[i] = v; if (fill(i + 1)) return true; g[i] = 0; }
    return false;
  };
  fill(0);
  const solution = g.slice();
  const count = (b: number[], limit: number): number => {
    const i = b.indexOf(0);
    if (i < 0) return 1;
    let n = 0;
    for (let v = 1; v <= 9 && n < limit; v++) if (can(b, i, v)) { b[i] = v; n += count(b, limit - n); b[i] = 0; }
    return n;
  };
  const puzzle = solution.slice();
  const order = Array.from({ length: 81 }, (_, i) => i).sort(() => rnd() - 0.5);
  let filled = 81;
  for (const i of order) {
    if (filled <= clues) break;
    const keep = puzzle[i];
    puzzle[i] = 0;
    if (count(puzzle.slice(), 2) !== 1) puzzle[i] = keep;
    else filled--;
  }
  return { puzzle, solution };
}

export function sudoku(p: SudokuParams, font: Font): Path[] {
  const { puzzle, solution } = sudokuGrid(p.seed, p.clues);
  const out: Path[] = [];
  const S = p.cell * 9;
  for (let k = 0; k <= 9; k++) {
    out.push({ points: [[0, k * p.cell], [S, k * p.cell]] });
    out.push({ points: [[k * p.cell, 0], [k * p.cell, S]] });
    if (k % 3 === 0) {
      out.push({ points: [[0, k * p.cell + 0.3], [S, k * p.cell + 0.3]] });
      out.push({ points: [[k * p.cell + 0.3, 0], [k * p.cell + 0.3, S]] });
    }
  }
  const grid = p.solution ? solution : puzzle;
  grid.forEach((v, i) => {
    if (!v) return;
    const r = Math.floor(i / 9), c = i % 9;
    const paths = textPaths(String(v), font, (c + 0.5) * p.cell, (r + 0.5) * p.cell + p.cell * 0.3, p.cell * 0.55, 'middle');
    if (p.solution && !puzzle[i]) paths.forEach((x) => (x.color = '#1971c2'));
    out.push(...paths);
  });
  return out;
}

// ── Реестр генераторов для интерфейса ────────────────────────────────

export type GenKind = 'qr' | 'formula' | 'maze' | 'spiro' | 'rose' | 'lissajous' | 'spiral' | 'graph' | 'koch' | 'tree' | 'flow' | 'waves' | 'mandala' | 'ornament' | 'markup' | 'sudoku' | 'gost';

export interface ParamDef { key: string; label: string; type: 'number' | 'text' | 'bool' | 'select'; min?: number; max?: number; step?: number; options?: [string, string][] }

export interface GenDef { kind: GenKind; title: string; icon: string; defaults: Record<string, unknown>; params: ParamDef[] }

export const GENERATORS: GenDef[] = [
  { kind: 'formula', title: 'Формула', icon: 'sigma', defaults: { latex: 'x_{1,2} = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}', size: 6 }, params: [
    { key: 'latex', label: 'Формула (LaTeX)', type: 'text' }, { key: 'size', label: 'Высота букв, мм', type: 'number', min: 2, max: 40, step: 0.5 } ] },
  { kind: 'qr', title: 'QR-код', icon: 'qr', defaults: { text: 'https://example.com', ecc: 'M', module: 1.6, pen: 0.5, border: 2, direction: 'h', caption: false }, params: [
    { key: 'text', label: 'Текст или ссылка', type: 'text' },
    { key: 'ecc', label: 'Надёжность', type: 'select', options: [['L', 'L — 7% (меньше)'], ['M', 'M — 15%'], ['Q', 'Q — 25%'], ['H', 'H — 30% (надёжнее)']] },
    { key: 'module', label: 'Размер клетки, мм', type: 'number', min: 0.8, max: 10, step: 0.1 },
    { key: 'pen', label: 'Толщина линии ручки, мм', type: 'number', min: 0.2, max: 2, step: 0.05 },
    { key: 'border', label: 'Белая рамка, клеток', type: 'number', min: 0, max: 8 },
    { key: 'direction', label: 'Штрихи', type: 'select', options: [['h', 'Горизонтальные'], ['v', 'Вертикальные']] },
    { key: 'caption', label: 'Подпись под кодом', type: 'bool' } ] },
  { kind: 'maze', title: 'Лабиринт', icon: 'grid', defaults: { cols: 20, rows: 26, cell: 6, algo: 'dfs', seed: 1, solution: false, shape: 'square' }, params: [
    { key: 'cols', label: 'Столбцов', type: 'number', min: 2, max: 80 }, { key: 'rows', label: 'Строк', type: 'number', min: 2, max: 120 },
    { key: 'cell', label: 'Клетка, мм', type: 'number', min: 2, max: 30, step: 0.5 },
    { key: 'algo', label: 'Алгоритм', type: 'select', options: [['dfs', 'Поиск в глубину'], ['prim', 'Прима'], ['kruskal', 'Краскала'], ['wilson', 'Уилсона']] },
    { key: 'shape', label: 'Форма', type: 'select', options: [['square', 'Прямоугольник'], ['circle', 'Круг']] },
    { key: 'solution', label: 'Показать решение', type: 'bool' }, { key: 'seed', label: 'Вариант', type: 'number', min: 1, max: 99999 } ] },
  { kind: 'sudoku', title: 'Судоку', icon: 'hash', defaults: { cell: 12, clues: 30, seed: 1, solution: false }, params: [
    { key: 'cell', label: 'Клетка, мм', type: 'number', min: 6, max: 20 }, { key: 'clues', label: 'Подсказок', type: 'number', min: 22, max: 60 },
    { key: 'solution', label: 'Напечатать ответ', type: 'bool' }, { key: 'seed', label: 'Вариант', type: 'number', min: 1, max: 99999 } ] },
  { kind: 'graph', title: 'График функции', icon: 'chart', defaults: { exprs: 'sin(x); x^2/4 - 2', xmin: -6, xmax: 6, ymin: -4, ymax: 4, w: 150, h: 100, grid: true, labels: true }, params: [
    { key: 'exprs', label: 'y = (через «;»)', type: 'text' },
    { key: 'xmin', label: 'x от', type: 'number', step: 0.5 }, { key: 'xmax', label: 'x до', type: 'number', step: 0.5 },
    { key: 'ymin', label: 'y от', type: 'number', step: 0.5 }, { key: 'ymax', label: 'y до', type: 'number', step: 0.5 },
    { key: 'w', label: 'Ширина, мм', type: 'number', min: 20, max: 300 }, { key: 'h', label: 'Высота, мм', type: 'number', min: 20, max: 300 },
    { key: 'grid', label: 'Сетка', type: 'bool' }, { key: 'labels', label: 'Подписи осей', type: 'bool' } ] },
  { kind: 'spiro', title: 'Спирограф', icon: 'spiro', defaults: { R: 96, r: 35, d: 50, scale: 0.5 }, params: [
    { key: 'R', label: 'Большое колесо R', type: 'number', min: 10, max: 200 }, { key: 'r', label: 'Малое колесо r', type: 'number', min: 2, max: 199 },
    { key: 'd', label: 'Отверстие d', type: 'number', min: 1, max: 200 }, { key: 'scale', label: 'Масштаб', type: 'number', min: 0.05, max: 3, step: 0.05 } ] },
  { kind: 'mandala', title: 'Мандала', icon: 'flower', defaults: { radius: 70, petals: 12, rings: 5, seed: 3 }, params: [
    { key: 'radius', label: 'Радиус, мм', type: 'number', min: 10, max: 140 }, { key: 'petals', label: 'Лепестков', type: 'number', min: 3, max: 48 },
    { key: 'rings', label: 'Колец', type: 'number', min: 1, max: 12 }, { key: 'seed', label: 'Вариант', type: 'number', min: 1, max: 99999 } ] },
  { kind: 'ornament', title: 'Кочкор мүйүз', icon: 'ornament', defaults: { count: 8, size: 18, rows: 1 }, params: [
    { key: 'count', label: 'Повторов', type: 'number', min: 1, max: 30 }, { key: 'size', label: 'Размер, мм', type: 'number', min: 5, max: 80 },
    { key: 'rows', label: 'Рядов', type: 'number', min: 1, max: 12 } ] },
  { kind: 'rose', title: 'Роза', icon: 'flower', defaults: { n: 5, d: 4, radius: 60 }, params: [
    { key: 'n', label: 'n', type: 'number', min: 1, max: 20 }, { key: 'd', label: 'd', type: 'number', min: 1, max: 20 }, { key: 'radius', label: 'Радиус, мм', type: 'number', min: 5, max: 140 } ] },
  { kind: 'lissajous', title: 'Фигура Лиссажу', icon: 'wave', defaults: { a: 3, b: 4, delta: 90, w: 120, h: 120 }, params: [
    { key: 'a', label: 'a', type: 'number', min: 1, max: 20 }, { key: 'b', label: 'b', type: 'number', min: 1, max: 20 }, { key: 'delta', label: 'Сдвиг, °', type: 'number', min: 0, max: 360 },
    { key: 'w', label: 'Ширина, мм', type: 'number', min: 10, max: 300 }, { key: 'h', label: 'Высота, мм', type: 'number', min: 10, max: 300 } ] },
  { kind: 'spiral', title: 'Спираль', icon: 'spiral', defaults: { turns: 20, radius: 60 }, params: [
    { key: 'turns', label: 'Витков', type: 'number', min: 1, max: 200 }, { key: 'radius', label: 'Радиус, мм', type: 'number', min: 5, max: 140 } ] },
  { kind: 'koch', title: 'Снежинка Коха', icon: 'snow', defaults: { depth: 4, size: 120 }, params: [
    { key: 'depth', label: 'Глубина', type: 'number', min: 0, max: 6 }, { key: 'size', label: 'Размер, мм', type: 'number', min: 10, max: 250 } ] },
  { kind: 'tree', title: 'Фрактальное дерево', icon: 'tree', defaults: { depth: 10, angle: 24, length: 30, ratio: 0.72, seed: 1, randomness: 0.15 }, params: [
    { key: 'depth', label: 'Глубина', type: 'number', min: 1, max: 12 }, { key: 'angle', label: 'Угол, °', type: 'number', min: 1, max: 90 },
    { key: 'length', label: 'Ствол, мм', type: 'number', min: 5, max: 80 }, { key: 'ratio', label: 'Уменьшение', type: 'number', min: 0.3, max: 0.9, step: 0.01 },
    { key: 'randomness', label: 'Случайность', type: 'number', min: 0, max: 0.6, step: 0.01 }, { key: 'seed', label: 'Вариант', type: 'number', min: 1, max: 99999 } ] },
  { kind: 'flow', title: 'Поле потоков', icon: 'wind', defaults: { w: 170, h: 240, lines: 400, length: 80, scale: 40, seed: 7 }, params: [
    { key: 'w', label: 'Ширина, мм', type: 'number', min: 10, max: 300 }, { key: 'h', label: 'Высота, мм', type: 'number', min: 10, max: 400 },
    { key: 'lines', label: 'Линий', type: 'number', min: 10, max: 3000 }, { key: 'length', label: 'Длина', type: 'number', min: 5, max: 500 },
    { key: 'scale', label: 'Масштаб шума', type: 'number', min: 5, max: 300 }, { key: 'seed', label: 'Вариант', type: 'number', min: 1, max: 99999 } ] },
  { kind: 'waves', title: 'Волны', icon: 'wave', defaults: { w: 160, h: 200, lines: 50, amp: 18, seed: 2 }, params: [
    { key: 'w', label: 'Ширина, мм', type: 'number', min: 10, max: 300 }, { key: 'h', label: 'Высота, мм', type: 'number', min: 10, max: 400 },
    { key: 'lines', label: 'Линий', type: 'number', min: 2, max: 200 }, { key: 'amp', label: 'Амплитуда, мм', type: 'number', min: 1, max: 60 },
    { key: 'seed', label: 'Вариант', type: 'number', min: 1, max: 99999 } ] },
  { kind: 'markup', title: 'Разметка тетради', icon: 'lines', defaults: { kind: 'grid', step: 5, w: 165, h: 205, margin: true }, params: [
    { key: 'kind', label: 'Вид', type: 'select', options: [['grid', 'Клетка'], ['lines', 'Линейка'], ['oblique', 'Косая линейка'], ['mm', 'Миллиметровка'], ['staff', 'Нотный стан']] },
    { key: 'step', label: 'Шаг, мм', type: 'number', min: 2, max: 30, step: 0.5 },
    { key: 'w', label: 'Ширина, мм', type: 'number', min: 10, max: 300 }, { key: 'h', label: 'Высота, мм', type: 'number', min: 10, max: 400 },
    { key: 'margin', label: 'Поле (красная линия)', type: 'bool' } ] },
  { kind: 'gost', title: 'Рамка ГОСТ 2.104', icon: 'frame', defaults: { title: 'Деталь', code: 'КП.01.00.000', org: 'Группа', author: '', checker: '', scale: '1:1' }, params: [
    { key: 'title', label: 'Наименование', type: 'text' }, { key: 'code', label: 'Обозначение', type: 'text' }, { key: 'org', label: 'Организация / группа', type: 'text' },
    { key: 'author', label: 'Разраб.', type: 'text' }, { key: 'checker', label: 'Пров.', type: 'text' }, { key: 'scale', label: 'Масштаб', type: 'text' } ] },
];

export function runGenerator(kind: GenKind, params: Record<string, unknown>, font: Font, sheet: { w: number; h: number }): Path[] {
  const P = params as never;
  switch (kind) {
    case 'qr': {
      const q = params as { text: string; ecc: Ecc; module: number; pen: number; border: number; direction: 'h' | 'v'; caption: boolean };
      const code = encodeQr(String(q.text || ' '), q.ecc);
      const out = qrPaths(code, { module: q.module, pen: q.pen, border: q.border, direction: q.direction });
      if (q.caption && q.text) {
        const side = (code.size + 2 * q.border) * q.module;
        out.push(...textPaths(String(q.text).slice(0, 60), font, side / 2, side + Math.max(3, q.module * 2.5), Math.max(2.5, Math.min(5, side / 14)), 'middle'));
      }
      return out;
    }
    case 'formula': {
      const f = params as { latex: string; size: number };
      return formulaPaths(String(f.latex || 'x'), Number(f.size) || 6).paths;
    }
    case 'maze': return maze(P);
    case 'spiro': return spirograph(P);
    case 'rose': return rose(P);
    case 'lissajous': return lissajous(P);
    case 'spiral': return spiral(P);
    case 'graph': return graph(P, font);
    case 'koch': return koch(P);
    case 'tree': return tree(P);
    case 'flow': return flowField(P);
    case 'waves': return waves(P);
    case 'mandala': return mandala(P);
    case 'ornament': return kochkorMuyuz(P);
    case 'markup': return markup(P);
    case 'sudoku': return sudoku(P, font);
    case 'gost': return gostFrame(sheet.w, sheet.h, font, params as Record<string, string>);
  }
}
