// Обычный (контурный) шрифт → однолинейный шрифт для ручки.
// Буква растеризуется крупно, затем скелетизируется (Чжан–Суэнь) и трассируется в штрихи —
// ручка проходит по середине линии один раз, без «двойной» обводки контура.
import { CAP, type Font, type Glyph } from './font';
import { chaikin, simplify, type Pt } from './geometry';
import { thin, traceSkeleton, components } from './vision';
import type { Contour, TtfFont } from './ttf';
import { HANDWRITING_SET } from './font';
import { EN_LOWER, EN_UPPER } from './fontData';

/** Набор символов по умолчанию: русский, кыргызский, английский, цифры, знаки. */
export const CONVERT_SET = [...new Set([...HANDWRITING_SET, ...EN_UPPER, ...EN_LOWER, ...'"\'%+=/*<>#&@°–—«»№'])].join('');

/** Заливка контуров по правилу ненулевой обмотки. */
export function rasterize(contours: Contour[], k: number, pad: number): { bin: Uint8Array; w: number; h: number; ox: number; oy: number } | null {
  const pts = contours.flat();
  if (!pts.length) return null;
  const minX = Math.min(...pts.map((p) => p[0])), maxX = Math.max(...pts.map((p) => p[0]));
  const minY = Math.min(...pts.map((p) => p[1])), maxY = Math.max(...pts.map((p) => p[1]));
  const w = Math.ceil((maxX - minX) * k) + 2 * pad, h = Math.ceil((maxY - minY) * k) + 2 * pad;
  if (w > 4000 || h > 4000) return null;
  const bin = new Uint8Array(w * h);
  // координаты пикселей: x вправо, y вниз
  const edges: [number, number, number, number][] = [];
  for (const c of contours) for (let i = 0; i < c.length; i++) {
    const a = c[i], b = c[(i + 1) % c.length];
    edges.push([(a[0] - minX) * k + pad, (maxY - a[1]) * k + pad, (b[0] - minX) * k + pad, (maxY - b[1]) * k + pad]);
  }
  const xs: { x: number; d: number }[] = [];
  for (let y = 0; y < h; y++) {
    const yc = y + 0.5;
    xs.length = 0;
    for (const [x0, y0, x1, y1] of edges) {
      if ((y0 <= yc && y1 > yc) || (y1 <= yc && y0 > yc)) xs.push({ x: x0 + ((yc - y0) / (y1 - y0)) * (x1 - x0), d: y1 > y0 ? 1 : -1 });
    }
    xs.sort((a, b) => a.x - b.x);
    let wind = 0;
    for (let i = 0; i < xs.length - 1; i++) {
      wind += xs[i].d;
      if (wind !== 0) {
        const a = Math.max(0, Math.ceil(xs[i].x - 0.5)), b = Math.min(w - 1, Math.floor(xs[i + 1].x - 0.5));
        for (let x = a; x <= b; x++) bin[y * w + x] = 1;
      }
    }
  }
  return { bin, w, h, ox: minX - pad / k, oy: maxY + pad / k };
}

export interface ConvertOptions {
  pxPerCap?: number;      // разрешение: пикселей на высоту заглавной буквы
  /** Плотный набор для слитных (курсивных) шрифтов: промежуток между буквами, ед. (заглавная = 10). */
  tight?: number;
  chars?: string;
  onProgress?: (done: number, total: number) => void;
}

/** Одна буква → штрихи в единицах «Каллиграфа» (заглавная = 10, ось Y вверх). */
export function convertGlyph(ttf: TtfFont, ch: string, pxPerCap = 120): Glyph | null {
  const gid = ttf.glyphIndex(ch.codePointAt(0)!);
  if (!gid) return null;
  const units = CAP / ttf.capHeight;           // единицы шрифта → единицы «Каллиграфа»
  const adv = ttf.advance(gid) * units;
  const contours = ttf.contours(gid);
  if (!contours.length) return ch === ' ' ? { variants: [{ advance: adv, strokes: [] }] } : null;
  const k = pxPerCap / ttf.capHeight;          // единицы шрифта → пиксели
  const r = rasterize(contours, k, 3);
  if (!r) return null;
  const { bin, w, h, ox, oy } = r;
  const blobs = components(bin, w, h, true);
  thin(bin, w, h);
  // утончение может стереть маленькую точку — возвращаем её центр
  for (const c of blobs) if (!c.pixels!.some((p) => bin[p])) bin[Math.round(c.cy) * w + Math.round(c.cx)] = 1;
  const spur = Math.round(pxPerCap * 0.05);
  const raw = traceSkeleton(bin, w, h, spur);
  const toU = ([px, py]: Pt): Pt => [((px + 0.5) / k + ox) * units, (oy - (py + 0.5) / k) * units];
  const minLen = pxPerCap * 0.04;
  const plen = (s: Pt[]) => s.slice(1).reduce((a, p, i) => a + Math.hypot(p[0] - s[i][0], p[1] - s[i][1]), 0);
  let strokes: Pt[][] = raw
    .map((s) => (s.length > 1 && plen(s) < minLen ? [[s.reduce((q, p) => q + p[0], 0) / s.length, s.reduce((q, p) => q + p[1], 0) / s.length] as Pt] : s))
    .map((s) => (s.length > 2 ? chaikin(simplify(s, 0.7), 2) : s).map(toU))
    .map((s) => (s.length > 2 ? simplify(s, 0.04) : s).map(([x, y]) => [Math.round(x * 100) / 100, Math.round(y * 100) / 100] as Pt));
  // порядок и направление как у человека: штрихи слева направо, каждый — сверху вниз / слева направо
  strokes = strokes.map((s) => {
    if (s.length < 2) return s;
    const a = s[0], b = s[s.length - 1];
    if (Math.hypot(a[0] - b[0], a[1] - b[1]) < 0.3) return s;
    const flip = Math.abs(b[1] - a[1]) > Math.abs(b[0] - a[0]) ? b[1] > a[1] : b[0] < a[0];
    return flip ? s.slice().reverse() : s;
  });
  const big = (s: Pt[]) => s.length > 1 && plen(s) > 1.2;
  strokes.sort((a, b) => (big(a) === big(b) ? Math.min(...a.map((p) => p[0])) - Math.min(...b.map((p) => p[0])) : big(a) ? -1 : 1));
  return { variants: [{ advance: Math.round(adv * 100) / 100, strokes }] };
}

/** Весь шрифт → однолинейный шрифт «Каллиграфа». */
export function convertFont(ttf: TtfFont, meta: { id: string; name: string; author?: string; license?: string }, o: ConvertOptions = {}): Font {
  const chars = [...(o.chars ?? CONVERT_SET)];
  const glyphs: Record<string, Glyph> = {};
  const spaceGid = ttf.glyphIndex(32);
  glyphs[' '] = { variants: [{ advance: Math.round((spaceGid ? ttf.advance(spaceGid) : ttf.unitsPerEm * 0.3) * (CAP / ttf.capHeight) * 100) / 100, strokes: [] }] };
  chars.forEach((ch, i) => {
    const g = convertGlyph(ttf, ch, o.pxPerCap);
    if (g && g.variants[0].strokes.length) {
      if (o.tight !== undefined && /\p{L}/u.test(ch)) {
        // ширина буквы = чернила + небольшой промежуток: буквы слитного шрифта почти касаются
        const v = g.variants[0];
        const xs = v.strokes.flat().map((p) => p[0]);
        const minX = Math.min(...xs), maxX = Math.max(...xs);
        const shift = minX > 0.35 ? 0.35 - minX : 0;
        v.strokes = v.strokes.map((s) => s.map(([x, y]) => [Math.round((x + shift) * 100) / 100, y] as [number, number]));
        v.advance = Math.round(Math.min(v.advance + shift, maxX + shift + o.tight) * 100) / 100;
      }
      glyphs[ch] = g;
    }
    o.onProgress?.(i + 1, chars.length);
  });
  return { id: meta.id, name: meta.name, author: meta.author, license: meta.license, createdAt: Date.now(), glyphs };
}
