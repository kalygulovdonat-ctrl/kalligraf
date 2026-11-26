// Быстрый разбор SVG без браузерных вызовов на каждую точку.
// Поддержка: path (M L H V C S Q T A Z, в т.ч. относительные), line, polyline, polygon, rect, circle, ellipse,
// вложенные g с transform (matrix, translate, scale, rotate, skewX, skewY), viewBox и единицы (mm, cm, in, pt, px).
import { simplify, type Path, type Pt } from './geometry';

type M6 = [number, number, number, number, number, number]; // a b c d e f
const I: M6 = [1, 0, 0, 1, 0, 0];
const mul = (m: M6, n: M6): M6 => [
  m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
];
const apply = (m: M6, [x, y]: Pt): Pt => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
const scaleOf = (m: M6) => Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1;

const NUM = /-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi;
const nums = (s: string) => (s.match(NUM) ?? []).map(Number);

export function parseTransform(t: string | undefined): M6 {
  let m = I;
  if (!t) return m;
  const re = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g;
  let r: RegExpExecArray | null;
  while ((r = re.exec(t))) {
    const v = nums(r[2]);
    let n: M6 = I;
    switch (r[1]) {
      case 'matrix': if (v.length === 6) n = v as M6; break;
      case 'translate': n = [1, 0, 0, 1, v[0] ?? 0, v[1] ?? 0]; break;
      case 'scale': n = [v[0] ?? 1, 0, 0, v[1] ?? v[0] ?? 1, 0, 0]; break;
      case 'rotate': {
        const a = ((v[0] ?? 0) * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
        n = [c, s, -s, c, 0, 0];
        if (v.length >= 3) n = mul(mul([1, 0, 0, 1, v[1], v[2]], n), [1, 0, 0, 1, -v[1], -v[2]]);
        break;
      }
      case 'skewX': n = [1, 0, Math.tan(((v[0] ?? 0) * Math.PI) / 180), 1, 0, 0]; break;
      case 'skewY': n = [1, Math.tan(((v[0] ?? 0) * Math.PI) / 180), 0, 1, 0, 0]; break;
    }
    m = mul(m, n);
  }
  return m;
}

/** Путь d → ломаные (в единицах SVG). segLen — желаемая длина отрезка при разбиении кривых. */
export function parsePathD(d: string, segLen: number): Pt[][] {
  const toks = d.match(/[MmLlHhVvCcSsQqTtAaZz]|-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi) ?? [];
  const out: Pt[][] = [];
  let cur: Pt[] = [];
  let x = 0, y = 0, sx = 0, sy = 0, cmd = '';
  let lcx = 0, lcy = 0, lqx = 0, lqy = 0, prev = '';
  let i = 0;
  const n = () => Number(toks[i++]);
  const isNum = () => i < toks.length && !/^[a-z]$/i.test(toks[i]);
  const push = (p: Pt) => cur.push(p);
  const flush = () => { if (cur.length > 1) out.push(cur); cur = []; };
  const steps = (len: number) => Math.max(2, Math.min(200, Math.ceil(len / segLen)));
  const cubic = (x1: number, y1: number, x2: number, y2: number, ex: number, ey: number) => {
    const len = Math.hypot(x1 - x, y1 - y) + Math.hypot(x2 - x1, y2 - y1) + Math.hypot(ex - x2, ey - y2);
    const k = steps(len);
    for (let j = 1; j <= k; j++) {
      const t = j / k, u = 1 - t;
      push([u * u * u * x + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * ex, u * u * u * y + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * ey]);
    }
  };
  const quad = (x1: number, y1: number, ex: number, ey: number) => {
    const k = steps(Math.hypot(x1 - x, y1 - y) + Math.hypot(ex - x1, ey - y1));
    for (let j = 1; j <= k; j++) {
      const t = j / k, u = 1 - t;
      push([u * u * x + 2 * u * t * x1 + t * t * ex, u * u * y + 2 * u * t * y1 + t * t * ey]);
    }
  };
  const arc = (rx: number, ry: number, phi: number, fa: number, fs: number, ex: number, ey: number) => {
    // перевод в параметры центра (SVG 1.1, приложение F.6)
    if (!rx || !ry) { push([ex, ey]); return; }
    rx = Math.abs(rx); ry = Math.abs(ry);
    const p = (phi * Math.PI) / 180, cp = Math.cos(p), sp = Math.sin(p);
    const dx = (x - ex) / 2, dy = (y - ey) / 2;
    const x1 = cp * dx + sp * dy, y1 = -sp * dx + cp * dy;
    const lam = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
    if (lam > 1) { rx *= Math.sqrt(lam); ry *= Math.sqrt(lam); }
    const sign = fa === fs ? -1 : 1;
    const num = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1;
    const co = sign * Math.sqrt(Math.max(0, num / (rx * rx * y1 * y1 + ry * ry * x1 * x1)));
    const cxp = (co * rx * y1) / ry, cyp = (-co * ry * x1) / rx;
    const cx = cp * cxp - sp * cyp + (x + ex) / 2, cy = sp * cxp + cp * cyp + (y + ey) / 2;
    const ang = (ux: number, uy: number, vx: number, vy: number) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
    const t1 = ang(1, 0, (x1 - cxp) / rx, (y1 - cyp) / ry);
    let dt = ang((x1 - cxp) / rx, (y1 - cyp) / ry, (-x1 - cxp) / rx, (-y1 - cyp) / ry);
    if (!fs && dt > 0) dt -= 2 * Math.PI;
    if (fs && dt < 0) dt += 2 * Math.PI;
    const k = steps(Math.abs(dt) * Math.max(rx, ry));
    for (let j = 1; j <= k; j++) {
      const t = t1 + (dt * j) / k;
      push([cx + rx * Math.cos(t) * cp - ry * Math.sin(t) * sp, cy + rx * Math.cos(t) * sp + ry * Math.sin(t) * cp]);
    }
  };
  while (i < toks.length) {
    if (/^[a-z]$/i.test(toks[i])) cmd = toks[i++];
    else if (!cmd) { i++; continue; }
    const rel = cmd === cmd.toLowerCase(), C = cmd.toUpperCase();
    const ox = rel ? x : 0, oy = rel ? y : 0;
    switch (C) {
      case 'M': {
        flush();
        x = ox + n(); y = oy + n(); sx = x; sy = y; push([x, y]);
        cmd = rel ? 'l' : 'L'; // дальнейшие пары — это L
        break;
      }
      case 'L': x = ox + n(); y = oy + n(); push([x, y]); break;
      case 'H': x = ox + n(); push([x, y]); break;
      case 'V': y = oy + n(); push([x, y]); break;
      case 'C': { const a = ox + n(), b = oy + n(), c = ox + n(), dd = oy + n(), e = ox + n(), f = oy + n(); cubic(a, b, c, dd, e, f); lcx = c; lcy = dd; x = e; y = f; break; }
      case 'S': {
        const rx = /[CS]/i.test(prev) ? 2 * x - lcx : x, ry = /[CS]/i.test(prev) ? 2 * y - lcy : y;
        const c = ox + n(), dd = oy + n(), e = ox + n(), f = oy + n();
        cubic(rx, ry, c, dd, e, f); lcx = c; lcy = dd; x = e; y = f; break;
      }
      case 'Q': { const a = ox + n(), b = oy + n(), e = ox + n(), f = oy + n(); quad(a, b, e, f); lqx = a; lqy = b; x = e; y = f; break; }
      case 'T': {
        const a = /[QT]/i.test(prev) ? 2 * x - lqx : x, b = /[QT]/i.test(prev) ? 2 * y - lqy : y;
        const e = ox + n(), f = oy + n(); quad(a, b, e, f); lqx = a; lqy = b; x = e; y = f; break;
      }
      case 'A': { const rx = n(), ry = n(), ph = n(), fa = n(), fs = n(), e = ox + n(), f = oy + n(); arc(rx, ry, ph, fa, fs, e, f); x = e; y = f; break; }
      case 'Z': if (cur.length) push([sx, sy]); x = sx; y = sy; flush(); cur = [[x, y]]; break;
    }
    prev = C;
    if (C !== 'Z' && !isNum() && i < toks.length && !/^[a-z]$/i.test(toks[i])) i++; // защита от мусора
    if (C === 'Z' && isNum()) { cmd = ''; }
  }
  flush();
  return out;
}

const UNIT: Record<string, number> = { mm: 1, cm: 10, in: 25.4, pt: 25.4 / 72, pc: 25.4 / 6, px: 25.4 / 96, '': 25.4 / 96 };
function lengthMM(v: string | undefined): number | null {
  if (!v) return null;
  const m = /^\s*(-?\d*\.?\d+(?:e[-+]?\d+)?)\s*(mm|cm|in|pt|pc|px)?\s*$/i.exec(v);
  if (!m) return null;
  return Number(m[1]) * UNIT[(m[2] ?? '').toLowerCase()];
}

const attrsOf = (s: string) => {
  const a: Record<string, string> = {};
  const re = /([\w:-]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let r: RegExpExecArray | null;
  while ((r = re.exec(s))) a[r[1]] = r[3] ?? r[4] ?? '';
  // style="display:none" / visibility
  if (a.style) for (const part of a.style.split(';')) { const [k, v] = part.split(':').map((x) => x?.trim()); if (k && v && !(k in a)) a[k] = v; }
  return a;
};

export interface SvgResult { paths: Path[]; elements: number; skipped: number }

/** SVG-текст → пути в мм (ось Y вниз, как на листе). Только текстовая обработка — быстро и в фоне. */
export function parseSvg(text: string, opts: { tolMM?: number } = {}): SvgResult {
  const tol = opts.tolMM ?? 0.05;
  // корень: размеры и viewBox
  const rootTag = /<svg\b([^>]*)>/i.exec(text);
  if (!rootTag) throw new Error('В файле нет тега <svg>');
  const ra = attrsOf(rootTag[1]);
  const vb = ra.viewBox ? nums(ra.viewBox) : null;
  const wMM = lengthMM(ra.width), hMM = lengthMM(ra.height);
  let base: M6 = [UNIT.px, 0, 0, UNIT.px, 0, 0];
  if (vb && vb.length === 4 && vb[2] > 0 && vb[3] > 0) {
    const sx = wMM ? wMM / vb[2] : hMM ? hMM / vb[3] : UNIT.px;
    const sy = hMM ? hMM / vb[3] : sx;
    const s = Math.min(sx, sy); // preserveAspectRatio по умолчанию — meet
    base = [s, 0, 0, s, -vb[0] * s, -vb[1] * s];
  }
  const out: Path[] = [];
  let elements = 0, skipped = 0;
  const stack: { m: M6; hidden: boolean; tag: string }[] = [{ m: base, hidden: false, tag: 'svg' }];
  const SKIP = /^(defs|clipPath|mask|symbol|marker|pattern|style|script|title|desc|metadata|linearGradient|radialGradient|filter|text)$/i;
  const re = /<(\/?)([\w:-]+)([^>]*?)(\/?)>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>/g;
  let r: RegExpExecArray | null;
  let first = true;
  while ((r = re.exec(text))) {
    if (!r[2]) continue;
    const closing = r[1] === '/', tag = r[2].replace(/^.*:/, ''), selfClose = r[4] === '/';
    if (closing) { if (stack.length > 1) stack.pop(); continue; }
    if (first && tag.toLowerCase() === 'svg') { first = false; if (selfClose) break; continue; }
    const parent = stack[stack.length - 1];
    const a = attrsOf(r[3]);
    const hidden = parent.hidden || SKIP.test(tag) || a.display === 'none' || a.visibility === 'hidden';
    let m = mul(parent.m, parseTransform(a.transform));
    if (tag === 'svg' || tag === 'use') m = mul(m, [1, 0, 0, 1, Number(a.x) || 0, Number(a.y) || 0]);
    if (!selfClose) stack.push({ m, hidden, tag });
    if (hidden) continue;
    // длина отрезка в единицах элемента для нужной точности в мм
    const k = scaleOf(m);
    const segLen = Math.max(1e-6, (0.6 / k));
    let polys: Pt[][] = [];
    const num = (v?: string) => Number(v) || 0;
    switch (tag) {
      case 'path': polys = parsePathD(a.d ?? '', segLen); break;
      case 'line': polys = [[[num(a.x1), num(a.y1)], [num(a.x2), num(a.y2)]]]; break;
      case 'polyline': case 'polygon': {
        const v = nums(a.points ?? '');
        const p: Pt[] = [];
        for (let j = 0; j + 1 < v.length; j += 2) p.push([v[j], v[j + 1]]);
        if (tag === 'polygon' && p.length > 2) p.push(p[0]);
        polys = [p];
        break;
      }
      case 'rect': {
        const x = num(a.x), y = num(a.y), w = num(a.width), h = num(a.height);
        if (w > 0 && h > 0) polys = [[[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y]]];
        break;
      }
      case 'circle': case 'ellipse': {
        const cx = num(a.cx), cy = num(a.cy), rx = tag === 'circle' ? num(a.r) : num(a.rx), ry = tag === 'circle' ? num(a.r) : num(a.ry);
        if (rx > 0 && ry > 0) {
          const nSeg = Math.max(12, Math.min(360, Math.ceil((2 * Math.PI * Math.max(rx, ry)) / segLen)));
          polys = [Array.from({ length: nSeg + 1 }, (_, j) => [cx + rx * Math.cos((j / nSeg) * 2 * Math.PI), cy + ry * Math.sin((j / nSeg) * 2 * Math.PI)] as Pt)];
        }
        break;
      }
      default: continue;
    }
    elements++;
    for (const p of polys) {
      if (p.length < 2) continue;
      const pts = simplify(p.map((q) => apply(m, q)), tol);
      if (pts.every(([x, y]) => Number.isFinite(x) && Number.isFinite(y))) out.push({ points: pts.map(([x, y]) => [Math.round(x * 100) / 100, Math.round(y * 100) / 100] as Pt) });
      else skipped++;
    }
  }
  return { paths: out, elements, skipped };
}
