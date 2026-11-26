// Формулы в синтаксисе LaTeX → однолинейные пути для ручки.
// Поддержка: ^ _ {} \frac \dfrac \sqrt[n] \left( \right) \sum \prod \int \oint \lim, функции (\sin, \log…),
// греческие буквы, знаки (\pm \times \cdot \le \ge \ne \approx \infty \to \partial \in), \text{}, \overline,
// \vec, \hat, \bar, \dot, пробелы (\, \; \quad), перенос строки \\.
import { builtinFonts, CAP, type Font } from './font';
import type { Path, Pt } from './geometry';

// ── Разбор ───────────────────────────────────────────────────────────

type Node =
  | { t: 'row'; items: Node[] }
  | { t: 'sym'; c: string; kind: 'ord' | 'op' | 'rel' | 'punct' | 'open' | 'close'; upright?: boolean }
  | { t: 'text'; s: string }
  | { t: 'func'; name: string; limits: boolean }
  | { t: 'frac'; num: Node; den: Node }
  | { t: 'sqrt'; body: Node; index?: Node }
  | { t: 'scripts'; base: Node; sup?: Node; sub?: Node }
  | { t: 'big'; op: 'sum' | 'prod' | 'int' | 'oint' | 'iint' }
  | { t: 'delim'; left: string; right: string; body: Node }
  | { t: 'accent'; kind: 'bar' | 'vec' | 'hat' | 'dot' | 'overline'; body: Node }
  | { t: 'space'; em: number }
  | { t: 'lines'; rows: Node[] };

const GREEK: Record<string, string> = {
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', varepsilon: 'ε', theta: 'θ', vartheta: 'θ', lambda: 'λ', mu: 'μ',
  pi: 'π', rho: 'ρ', sigma: 'σ', tau: 'τ', phi: 'φ', varphi: 'φ', omega: 'ω',
  Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π', Sigma: 'Σ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
};
const SYMS: Record<string, [string, 'op' | 'rel' | 'ord']> = {
  pm: ['±', 'op'], mp: ['∓', 'op'], times: ['×', 'op'], div: ['÷', 'op'], cdot: ['·', 'op'], ast: ['*', 'op'],
  le: ['≤', 'rel'], leq: ['≤', 'rel'], ge: ['≥', 'rel'], geq: ['≥', 'rel'], ne: ['≠', 'rel'], neq: ['≠', 'rel'],
  approx: ['≈', 'rel'], to: ['→', 'rel'], rightarrow: ['→', 'rel'], leftarrow: ['←', 'rel'], in: ['∈', 'rel'],
  infty: ['∞', 'ord'], partial: ['∂', 'ord'], circ: ['°', 'ord'], deg: ['°', 'ord'], prime: ['′', 'ord'],
  angle: ['∠', 'ord'], percent: ['%', 'ord'], degree: ['°', 'ord'],
};
const FUNCS = ['sin', 'cos', 'tg', 'tan', 'ctg', 'cot', 'sec', 'csc', 'arcsin', 'arccos', 'arctg', 'arctan', 'arcctg', 'sh', 'ch', 'th', 'sinh', 'cosh', 'tanh',
  'log', 'lg', 'ln', 'exp', 'det', 'max', 'min', 'lim', 'sup', 'inf', 'gcd', 'deg', 'dim', 'mod'];
const LIMIT_FUNCS = new Set(['lim', 'max', 'min', 'sup', 'inf']);
const SPACES: Record<string, number> = { ',': 0.17, ':': 0.22, ';': 0.28, '!': -0.17, ' ': 0.33, quad: 1, qquad: 2 };

export class MathError extends Error {}

export function parseMath(src: string): Node {
  let i = 0;
  const s = src;
  const err = (m: string): never => { throw new MathError(`${m} (символ ${i + 1})`); };
  const skipWs = () => { while (i < s.length && /\s/.test(s[i])) i++; };

  function readCommand(): string {
    i++; // '\'
    if (i >= s.length) err('После «\\» нужна команда');
    if (!/[a-zA-Z]/.test(s[i])) return s[i++];
    let n = '';
    while (i < s.length && /[a-zA-Z]/.test(s[i])) n += s[i++];
    return n;
  }
  function readGroup(): Node {
    skipWs();
    if (s[i] === '{') {
      i++;
      const r = parseRow('}');
      if (s[i] !== '}') err('Не хватает «}»');
      i++;
      return r;
    }
    return parseAtom() ?? err('Ожидалось выражение');
  }
  function readOptional(): Node | undefined {
    skipWs();
    if (s[i] !== '[') return undefined;
    i++;
    const r = parseRow(']');
    if (s[i] !== ']') err('Не хватает «]»');
    i++;
    return r;
  }
  function readDelim(): string {
    skipWs();
    if (s[i] === '\\') { const c = readCommand(); return c === '{' ? '{' : c === '}' ? '}' : c === '|' ? '‖' : c === 'langle' ? '⟨' : c === 'rangle' ? '⟩' : c; }
    return s[i++] ?? err('Нужна скобка');
  }
  function textArg(): string {
    skipWs();
    if (s[i] !== '{') err('После \\text нужны фигурные скобки');
    let depth = 0, out = '';
    for (; i < s.length; i++) {
      if (s[i] === '{') { if (depth++ === 0) continue; }
      if (s[i] === '}') { if (--depth === 0) { i++; return out; } }
      out += s[i];
    }
    return err('Не хватает «}»');
  }

  function parseAtom(): Node | null {
    skipWs();
    const c = s[i];
    if (c === undefined) return null;
    if (c === '{') { i++; const r = parseRow('}'); if (s[i] !== '}') err('Не хватает «}»'); i++; return r; }
    if (c === '\\') {
      const cmd = readCommand();
      // заглавные греческие в формулах пишутся прямо, строчные — курсивом
      if (cmd in GREEK) return { t: 'sym', c: GREEK[cmd], kind: 'ord', upright: /^[A-Z]/.test(cmd) };
      if (cmd in SYMS) return { t: 'sym', c: SYMS[cmd][0], kind: SYMS[cmd][1] };
      if (cmd in SPACES) return { t: 'space', em: SPACES[cmd] };
      if (FUNCS.includes(cmd)) return { t: 'func', name: cmd, limits: LIMIT_FUNCS.has(cmd) };
      switch (cmd) {
        case 'frac': case 'dfrac': case 'tfrac': { const num = readGroup(); const den = readGroup(); return { t: 'frac', num, den }; }
        case 'sqrt': { const index = readOptional(); return { t: 'sqrt', body: readGroup(), index }; }
        case 'sum': return { t: 'big', op: 'sum' };
        case 'prod': return { t: 'big', op: 'prod' };
        case 'int': return { t: 'big', op: 'int' };
        case 'iint': return { t: 'big', op: 'iint' };
        case 'oint': return { t: 'big', op: 'oint' };
        case 'text': case 'mathrm': case 'textrm': case 'operatorname': return { t: 'text', s: textArg() };
        case 'overline': return { t: 'accent', kind: 'overline', body: readGroup() };
        case 'bar': return { t: 'accent', kind: 'bar', body: readGroup() };
        case 'vec': return { t: 'accent', kind: 'vec', body: readGroup() };
        case 'hat': return { t: 'accent', kind: 'hat', body: readGroup() };
        case 'dot': return { t: 'accent', kind: 'dot', body: readGroup() };
        case 'left': {
          const l = readDelim();
          const body = parseRow('\\right');
          if (!s.startsWith('\\right', i)) err('Нет парной \\right');
          i += 6;
          const r = readDelim();
          return { t: 'delim', left: l, right: r, body };
        }
        case '{': return { t: 'sym', c: '{', kind: 'open' };
        case '}': return { t: 'sym', c: '}', kind: 'close' };
        case '%': return { t: 'sym', c: '%', kind: 'ord' };
        case 'ldots': case 'dots': case 'cdots': return { t: 'text', s: '...' };
        case 'displaystyle': case 'limits': return { t: 'space', em: 0 };
        default: return err(`Неизвестная команда \\${cmd}`);
      }
    }
    if (c === '}' || c === ']') return null;
    if (c === '^' || c === '_') err(`«${c}» без основания`);
    i++;
    if ('+-*/'.includes(c)) return { t: 'sym', c: c === '-' ? '−' : c === '*' ? '·' : c, kind: c === '/' ? 'ord' : 'op' };
    if ('=<>'.includes(c)) return { t: 'sym', c, kind: 'rel' };
    if (',;:!?'.includes(c)) return { t: 'sym', c, kind: 'punct' };
    if ('([|'.includes(c)) return { t: 'sym', c, kind: c === '|' ? 'ord' : 'open' };
    if (')]'.includes(c)) return { t: 'sym', c, kind: 'close' };
    if (c === "'") return { t: 'sym', c: '′', kind: 'ord' };
    return { t: 'sym', c, kind: 'ord' };
  }

  function parseRow(end: string): Node {
    const items: Node[] = [];
    const rows: Node[] = [];
    for (;;) {
      skipWs();
      if (i >= s.length) { if (end) err(end === '\\right' ? 'Нет парной \\right' : `Не хватает «${end}»`); break; }
      if (end && s.startsWith(end, i)) break;
      if (s.startsWith('\\\\', i)) { i += 2; rows.push({ t: 'row', items: items.splice(0) }); continue; }
      let a = parseAtom();
      if (!a) { if (s[i] === '}' && !end) err('Лишняя «}»'); if (s[i] === ']' && end !== ']') { i++; items.push({ t: 'sym', c: ']', kind: 'close' }); continue; } break; }
      // индексы
      for (;;) {
        skipWs();
        const c = s[i];
        if (c !== '^' && c !== '_') break;
        i++;
        const arg = readGroup();
        const sc: Node & { t: 'scripts' } = a.t === 'scripts' ? a : { t: 'scripts', base: a };
        if (c === '^') { if (sc.sup) err('Два верхних индекса подряд — используйте {}'); sc.sup = arg; }
        else { if (sc.sub) err('Два нижних индекса подряд — используйте {}'); sc.sub = arg; }
        a = sc;
      }
      items.push(a);
    }
    if (rows.length) { rows.push({ t: 'row', items }); return { t: 'lines', rows }; }
    return { t: 'row', items };
  }

  const r = parseRow('');
  if (i < s.length) err(`Лишний символ «${s[i]}»`);
  return r;
}

// ── Вёрстка ──────────────────────────────────────────────────────────
// Координаты внутри формулы: x вправо, y вверх, 0 — базовая линия. Единица — мм.

interface Box { w: number; h: number; d: number; lines: Pt[][] }

const empty = (): Box => ({ w: 0, h: 0, d: 0, lines: [] });
const shift = (b: Box, dx: number, dy: number): Pt[][] => b.lines.map((l) => l.map(([x, y]) => [x + dx, y + dy] as Pt));

let fonts: { it: Font; up: Font } | null = null;
const F = () => (fonts ??= { it: builtinFonts().find((f) => f.id === 'italic')!, up: builtinFonts()[0] });

function glyphBox(c: string, size: number, italic: boolean): Box {
  const font = italic ? F().it : F().up;
  const g = font.glyphs[c] ?? F().up.glyphs[c] ?? F().up.glyphs['?'];
  const v = g.variants[0];
  const k = size / CAP;
  let maxY = 0, minY = 0;
  for (const s of v.strokes) for (const [, y] of s) { if (y > maxY) maxY = y; if (y < minY) minY = y; }
  return {
    w: v.advance * k + size * 0.06,
    h: Math.max(maxY, 7) * k,
    d: Math.max(0, -minY) * k,
    lines: v.strokes.map((s) => s.map(([x, y]) => [x * k, y * k] as Pt)),
  };
}

function textBox(str: string, size: number, italic = false): Box {
  const out = empty();
  for (const c of str) {
    if (c === ' ') { out.w += size * 0.4; continue; }
    const g = glyphBox(c, size, italic);
    out.lines.push(...shift(g, out.w, 0));
    out.w += g.w; out.h = Math.max(out.h, g.h); out.d = Math.max(out.d, g.d);
  }
  return out;
}

function hbox(items: Box[], gaps?: number[]): Box {
  const out = empty();
  items.forEach((b, i) => {
    out.w += gaps?.[i] ?? 0;
    out.lines.push(...shift(b, out.w, 0));
    out.w += b.w; out.h = Math.max(out.h, b.h); out.d = Math.max(out.d, b.d);
  });
  if (gaps && gaps.length > items.length) out.w += gaps[items.length];
  return out;
}

/** Скобка нужной высоты, рисуется линией. */
function delimBox(ch: string, h: number, d: number, size: number): Box {
  const H = h + d, w = Math.max(size * 0.35, Math.min(size * 0.7, H * 0.18));
  const y0 = -d, y1 = h, ym = (y0 + y1) / 2;
  const lines: Pt[][] = [];
  const N = 16;
  const arc = (dir: 1 | -1) => {
    const pts: Pt[] = [];
    for (let i = 0; i <= N; i++) {
      const t = i / N, y = y0 + (y1 - y0) * t;
      const x = w * 0.15 + w * 0.6 * (1 - Math.sin(Math.PI * t));
      pts.push([dir === 1 ? x : w - x, y]);
    }
    return pts;
  };
  switch (ch) {
    case '(': lines.push(arc(1)); break;
    case ')': lines.push(arc(-1)); break;
    case '[': lines.push([[w * 0.8, y1], [w * 0.25, y1], [w * 0.25, y0], [w * 0.8, y0]]); break;
    case ']': lines.push([[w * 0.2, y1], [w * 0.75, y1], [w * 0.75, y0], [w * 0.2, y0]]); break;
    case '|': lines.push([[w / 2, y1], [w / 2, y0]]); break;
    case '‖': lines.push([[w * 0.35, y1], [w * 0.35, y0]], [[w * 0.65, y1], [w * 0.65, y0]]); break;
    case '{': lines.push([[w * 0.85, y1], [w * 0.5, y1 - H * 0.04], [w * 0.45, ym + H * 0.08], [w * 0.1, ym], [w * 0.45, ym - H * 0.08], [w * 0.5, y0 + H * 0.04], [w * 0.85, y0]]); break;
    case '}': lines.push([[w * 0.15, y1], [w * 0.5, y1 - H * 0.04], [w * 0.55, ym + H * 0.08], [w * 0.9, ym], [w * 0.55, ym - H * 0.08], [w * 0.5, y0 + H * 0.04], [w * 0.15, y0]]); break;
    case '⟨': lines.push([[w * 0.8, y1], [w * 0.2, ym], [w * 0.8, y0]]); break;
    case '⟩': lines.push([[w * 0.2, y1], [w * 0.8, ym], [w * 0.2, y0]]); break;
    case '.': return { w: 0, h, d, lines: [] };
    default: return textBox(ch, size);
  }
  return { w, h, d, lines };
}

function bigOpBox(op: string, size: number): Box {
  const axis = size * 0.35;
  if (op === 'sum' || op === 'prod') {
    const H = size * 1.5, w = size * 1.1;
    const y0 = axis - H / 2, y1 = axis + H / 2;
    const lines: Pt[][] = op === 'sum'
      ? [[[w, y1], [0, y1], [w * 0.5, axis], [0, y0], [w, y0]]]
      : [[[0, y1], [w, y1]], [[w * 0.18, y1], [w * 0.18, y0]], [[w * 0.82, y1], [w * 0.82, y0]]];
    return { w: w + size * 0.15, h: y1, d: -y0, lines };
  }
  // интеграл
  const H = size * 2.2, w = size * 0.8;
  const y0 = axis - H / 2, y1 = axis + H / 2;
  const pts: Pt[] = [];
  for (let i = 0; i <= 30; i++) {
    const t = i / 30, y = y0 + (y1 - y0) * t;
    // S-образная кривая: внизу хвост влево, вверху — вправо, наклон как у курсива
    const x = w * 0.5 + (t - 0.5) * w * 0.45 + (t < 0.12 ? -Math.cos((t / 0.12) * Math.PI / 2) * w * 0.3 : 0) + (t > 0.88 ? Math.cos(((1 - t) / 0.12) * Math.PI / 2) * w * 0.3 : 0);
    pts.push([x, y]);
  }
  const lines: Pt[][] = [pts];
  let width = w;
  if (op === 'iint') { lines.push(pts.map(([x, y]) => [x + w * 0.45, y] as Pt)); width += w * 0.45; }
  if (op === 'oint') {
    const c: Pt = [w * 0.5, axis], r = size * 0.35;
    lines.push(Array.from({ length: 25 }, (_, i) => [c[0] + r * Math.cos((i / 24) * 2 * Math.PI), c[1] + r * 0.8 * Math.sin((i / 24) * 2 * Math.PI)] as Pt));
  }
  return { w: width + size * 0.1, h: y1, d: -y0, lines };
}

/** Индексы: справа (обычные) или сверху/снизу по центру (у сумм, пределов). */
const isItalic = (n: Node): boolean => n.t === 'sym' && /\p{L}/u.test(n.c) && !n.upright;

/** italicCorr — сдвиг верхнего индекса вправо у наклонных букв (иначе «b²» слипается). */
function scriptsBox(base: Box, sup: Box | null, sub: Box | null, size: number, limits: boolean, italicCorr = 0): Box {
  const out: Box = { w: base.w, h: base.h, d: base.d, lines: [...base.lines] };
  if (limits) {
    const W = Math.max(base.w, sup?.w ?? 0, sub?.w ?? 0);
    const bx = (W - base.w) / 2;
    out.lines = shift(base, bx, 0);
    if (sup) { const y = base.h + size * 0.15 + sup.d; out.lines.push(...shift(sup, (W - sup.w) / 2, y)); out.h = y + sup.h; }
    if (sub) { const y = -base.d - size * 0.15 - sub.h; out.lines.push(...shift(sub, (W - sub.w) / 2, y)); out.d = -y + sub.d; }
    out.w = W + size * 0.1;
    return out;
  }
  let supY = Math.max(size * 0.45, base.h - size * 0.35), subY = -Math.max(size * 0.22, base.d * 0.7 + size * 0.1);
  if (sup && sub) {
    const gap = (supY - sup.d) - (subY + sub.h);
    if (gap < size * 0.15) { const fix = (size * 0.15 - gap) / 2; supY += fix; subY -= fix; }
  }
  const x = base.w;
  let w = 0;
  if (sup) { out.lines.push(...shift(sup, x + italicCorr, supY)); out.h = Math.max(out.h, supY + sup.h); w = Math.max(w, sup.w + italicCorr); }
  if (sub) { out.lines.push(...shift(sub, x, subY)); out.d = Math.max(out.d, -subY + sub.d); w = Math.max(w, sub.w); }
  out.w = x + w + size * 0.05;
  return out;
}

function layout(n: Node, size: number, depth = 0): Box {
  const sub = (x: Node, k: number) => layout(x, Math.max(size * k, 1.2), depth + 1);
  switch (n.t) {
    case 'sym': {
      const letter = /\p{L}/u.test(n.c) && !n.upright;
      const b = glyphBox(n.c, size, letter);
      if (n.kind === 'op' || n.kind === 'rel') return hbox([b], [size * (n.kind === 'rel' ? 0.32 : 0.24), size * (n.kind === 'rel' ? 0.32 : 0.24)]);
      if (n.kind === 'punct') return hbox([b], [0, size * 0.18]);
      return b;
    }
    case 'text': return textBox(n.s, size, false);
    case 'func': return hbox([textBox(n.name, size, false)], [size * 0.08, size * 0.12]);
    case 'space': return { w: n.em * size * 1.0, h: 0, d: 0, lines: [] };
    case 'row': {
      const items = n.items.map((x, i) => {
        // «−b», «(−1)», «= +2»: знак без пробелов, если стоит в начале или после оператора/скобки
        const prev = n.items[i - 1];
        const afterOp = !prev || (prev.t === 'sym' && (prev.kind === 'op' || prev.kind === 'rel' || prev.kind === 'open' || prev.kind === 'punct'));
        return x.t === 'sym' && x.kind === 'op' && afterOp ? { ...x, kind: 'ord' as const } : x;
      });
      const boxes = items.map((x) => layout(x, size, depth));
      // курсивная поправка: наклонная буква перед прямым символом не должна его касаться
      const gaps = items.map((x, i) => {
        const prev = items[i - 1];
        const prevItalic = prev && isItalic(prev);
        return prevItalic && !isItalic(x) ? size * 0.07 : 0;
      });
      return boxes.length ? hbox(boxes, gaps) : { w: size * 0.5, h: size * 0.7, d: 0, lines: [] };
    }
    case 'lines': {
      const rows = n.rows.map((r) => layout(r, size, depth));
      const out = empty();
      let y = 0;
      rows.forEach((r, i) => {
        if (i > 0) y -= rows[i - 1].d + r.h + size * 0.6;
        out.lines.push(...shift(r, 0, y));
        out.w = Math.max(out.w, r.w);
      });
      out.h = rows[0].h;
      out.d = -y + rows[rows.length - 1].d;
      return out;
    }
    case 'frac': {
      const k = depth === 0 ? 0.9 : 0.75;
      const num = sub(n.num, k), den = sub(n.den, k);
      const axis = size * 0.35, gap = size * 0.18, pad = size * 0.12;
      const W = Math.max(num.w, den.w) + 2 * pad;
      const numY = axis + gap + num.d, denY = axis - gap - den.h;
      const lines = [...shift(num, (W - num.w) / 2, numY), ...shift(den, (W - den.w) / 2, denY), [[0, axis], [W, axis]] as Pt[]];
      return hbox([{ w: W, h: numY + num.h, d: -(denY - den.d), lines }], [size * 0.1, size * 0.1]);
    }
    case 'sqrt': {
      const body = layout(n.body, size, depth + 1);
      const H = Math.max(body.h, size * 0.75) + size * 0.2, D = body.d + size * 0.1;
      const r1: Pt = [0, size * 0.32], r2: Pt = [size * 0.22, size * 0.42], r3: Pt = [size * 0.5, -D], r4: Pt = [size * 0.9, H];
      let ox = 0;
      const extra: Pt[][] = [];
      if (n.index) {
        const ix = sub(n.index, 0.55);
        ox = Math.max(0, ix.w - size * 0.3);
        extra.push(...shift(ix, ox + size * 0.3 - ix.w, size * 0.5 + ix.d));
      }
      const bx = r4[0] + size * 0.1;
      const radical: Pt[] = [r1, r2, r3, r4, [bx + body.w + size * 0.1, H]].map(([x, y]) => [x + ox, y] as Pt);
      return { w: ox + bx + body.w + size * 0.2, h: Math.max(H, n.index ? size * 0.5 + 1 : 0) + size * 0.05, d: D, lines: [radical, ...extra, ...shift(body, ox + bx, 0)] };
    }
    case 'big': return bigOpBox(n.op, size);
    case 'scripts': {
      const base = layout(n.base, size, depth);
      const limits = (n.base.t === 'big' && n.base.op !== 'int' && n.base.op !== 'iint' && n.base.op !== 'oint') || (n.base.t === 'func' && n.base.limits);
      return scriptsBox(base, n.sup ? sub(n.sup, 0.68) : null, n.sub ? sub(n.sub, 0.68) : null, size, limits, isItalic(n.base) ? size * 0.13 : 0);
    }
    case 'delim': {
      const body = layout(n.body, size, depth);
      const h = Math.max(body.h, size * 0.8) + size * 0.08, d = Math.max(body.d, size * 0.15) + size * 0.08;
      return hbox([delimBox(n.left, h, d, size), body, delimBox(n.right, h, d, size)], [0, size * 0.05, size * 0.05]);
    }
    case 'accent': {
      const body = layout(n.body, size, depth);
      const y = body.h + size * 0.15;
      const out: Box = { ...body, lines: [...body.lines], h: y + size * 0.25 };
      const x0 = body.w * 0.08, x1 = body.w * 0.92, xm = body.w / 2;
      if (n.kind === 'overline' || n.kind === 'bar') out.lines.push([[x0, y], [x1, y]]);
      if (n.kind === 'vec') out.lines.push([[x0, y], [x1, y]], [[x1 - size * 0.18, y + size * 0.12], [x1, y], [x1 - size * 0.18, y - size * 0.12]]);
      if (n.kind === 'hat') out.lines.push([[xm - size * 0.2, y - size * 0.05], [xm, y + size * 0.15], [xm + size * 0.2, y - size * 0.05]]);
      if (n.kind === 'dot') out.lines.push([[xm, y], [xm, y + size * 0.04]]);
      return out;
    }
  }
}

/** asc — высота над базовой линией, desc — глубина под ней (мм). */
export interface Formula { paths: Path[]; w: number; h: number; asc: number; desc: number }

/**
 * Формула → пути в мм (ось Y вниз, начало — левый верхний угол рамки формулы;
 * базовая линия проходит на высоте asc от верха). size — высота заглавной буквы, мм.
 */
export function formulaPaths(src: string, size: number): Formula {
  const box = layout(parseMath(src), size);
  return {
    w: box.w,
    h: box.h + box.d,
    asc: box.h,
    desc: box.d,
    paths: box.lines.filter((l) => l.length).map((l) => ({ points: l.map(([x, y]) => [Math.round(x * 1000) / 1000, Math.round((box.h - y) * 1000) / 1000] as Pt) })),
  };
}

// Кэш: при наборе текста одна и та же формула верстается много раз
const cache = new Map<string, Formula | MathError>();
/** Формула из кэша; при ошибке возвращает MathError (не бросает). */
export function formulaCached(src: string, size: number): Formula | MathError {
  const key = size.toFixed(3) + '|' + src;
  let r = cache.get(key);
  if (!r) {
    try { r = formulaPaths(src, size); } catch (e) { r = e instanceof MathError ? e : new MathError(String((e as Error).message)); }
    cache.set(key, r);
    if (cache.size > 400) cache.delete(cache.keys().next().value!);
  }
  return r;
}
