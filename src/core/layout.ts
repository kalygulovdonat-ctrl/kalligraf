// Раскладка текста по листам + «живой» почерк.
import { CAP, type Font, type GlyphVariant } from './font';
import { densify, type Path, type Pt } from './geometry';
import { makeNoise1D, mulberry32, signed } from './rng';
import { splitForWidth } from './hyphen';
import { formulaCached, MathError } from './math';

export type Align = 'left' | 'center' | 'right' | 'justify';

export interface Margins { top: number; right: number; bottom: number; left: number }
export interface Sheet { w: number; h: number }

export interface HumanizeParams {
  rotationDeg: number;   // случайный поворот буквы, ±
  scaleJitter: number;   // доля, ±
  baselineJitter: number; // доля высоты буквы, ±
  spacingJitter: number; // доля высоты буквы, ±
  tremor: number;        // дрожание точек, доля высоты
  wave: number;          // волна строки, доля высоты
  marginDrift: number;   // «гуляющее» левое поле, мм
  fatigue: number;       // 0..1 — к концу страницы крупнее и небрежнее
}

export interface TextOptions {
  size: number;          // высота заглавной буквы, мм
  letterSpacing: number; // мм
  wordSpacing: number;   // множитель ширины пробела
  lineHeight: number;    // расстояние между базовыми линиями, мм
  align: Align;
  margins: Margins;
  indent: number;        // красная строка, мм
  hyphenate: boolean;
  accuracy: number;      // 1..10, 10 — идеально ровно
  slopeDeg: number;      // наклон строки
  seed: number;
  pageNumbers: boolean;
  color?: string;
  humanize?: Partial<HumanizeParams>;
}

export const defaultTextOptions: TextOptions = {
  size: 6, letterSpacing: 0.4, wordSpacing: 1, lineHeight: 10, align: 'left',
  margins: { top: 15, right: 32, bottom: 15, left: 15 }, indent: 10, hyphenate: true,
  accuracy: 8, slopeDeg: 0, seed: 1, pageNumbers: false,
};

export function humanizeFromAccuracy(accuracy: number): HumanizeParams {
  const m = Math.max(0, Math.min(1, (10 - accuracy) / 9));
  return {
    rotationDeg: 3 * m, scaleJitter: 0.05 * m, baselineJitter: 0.07 * m, spacingJitter: 0.12 * m,
    tremor: 0.025 * m, wave: 0.18 * m, marginDrift: 1.6 * m, fatigue: m,
  };
}

export interface LaidOutPage {
  paths: Path[];
  /** Номер «группы» (слова) для каждого пути — оптимизация не перемешивает слова. */
  groups: number[];
}

export interface LayoutResult {
  pages: LaidOutPage[];
  missing: string[];
  lines: number;
  chars: number;
  /** Ошибки в формулах $…$ (формула с ошибкой пишется как обычный текст). */
  mathErrors: { src: string; message: string }[];
}

/** Кусок слова: текст или формула. */
export type Part = { k: 't'; s: string } | { k: 'm'; src: string };
interface Item { text: string; parts?: Part[]; display?: string; scale?: number }
interface Word extends Item { paraStart: boolean; paraEnd: boolean }
interface Line { words: Item[]; indent: number; justify: boolean; display?: boolean }

/**
 * Разбор абзаца на слова. $…$ — формула внутри строки (пробелы внутри не разбивают слово),
 * \$ — обычный знак доллара. Незакрытый $ остаётся текстом.
 */
export function tokenizeParagraph(para: string): { words: Item[]; unclosed: boolean } {
  const words: Item[] = [];
  let parts: Part[] = [];
  let buf = '';
  let unclosed = false;
  const flushBuf = () => { if (buf) { parts.push({ k: 't', s: buf }); buf = ''; } };
  const flushWord = () => {
    flushBuf();
    if (!parts.length) return;
    words.push(parts.every((x) => x.k === 't')
      ? { text: parts.map((x) => (x as { s: string }).s).join('') }
      : { text: parts.map((x) => (x.k === 't' ? x.s : '$' + x.src + '$')).join(''), parts });
    parts = [];
  };
  for (let i = 0; i < para.length; i++) {
    const c = para[i];
    if (c === '\\' && para[i + 1] === '$') { buf += '$'; i++; continue; }
    if (c === '$') {
      let j = i + 1;
      while (j < para.length && !(para[j] === '$' && para[j - 1] !== '\\')) j++;
      if (j >= para.length) { unclosed = true; buf += para.slice(i); break; }
      flushBuf();
      const src = para.slice(i + 1, j).trim();
      if (src) parts.push({ k: 'm', src });
      i = j;
      continue;
    }
    if (c === ' ' || c === '\t') { flushWord(); continue; }
    buf += c;
  }
  flushWord();
  return { words, unclosed };
}

export function layoutText(text: string, font: Font, opts: TextOptions, sheet: Sheet, fallback?: Font): LayoutResult {
  const s = opts.size / CAP;
  const hp: HumanizeParams = { ...humanizeFromAccuracy(opts.accuracy), ...opts.humanize };
  const missing = new Set<string>();

  const glyphOf = (ch: string) => font.glyphs[ch] ?? fallback?.glyphs[ch];
  const advanceOf = (ch: string) => {
    const g = glyphOf(ch);
    if (!g) return 5;
    return g.variants[0].advance;
  };
  const spaceW = (glyphOf(' ')?.variants[0].advance ?? 4) * s * opts.wordSpacing;
  const kern = (a: string, b: string) => (font.kerning?.[a + b] ?? 0) * s;
  const measure = (w: string) => {
    const cs = [...w];
    let x = 0;
    cs.forEach((c, i) => {
      x += advanceOf(c) * s;
      if (i < cs.length - 1) x += opts.letterSpacing + kern(c, cs[i + 1]);
    });
    return x;
  };

  const mathErrors: LayoutResult['mathErrors'] = [];
  const errSeen = new Set<string>();
  const formula = (src: string, size: number) => {
    const f = formulaCached(src, size);
    if (f instanceof MathError) { if (!errSeen.has(src)) { errSeen.add(src); mathErrors.push({ src, message: f.message }); } return null; }
    return f;
  };
  const DISPLAY_K = 1.1;           // формулы $$…$$ чуть крупнее текста
  const MATH_PAD = opts.size * 0.12;
  const partsWidth = (parts: Part[], scale = 1) => parts.reduce((w, part, i) => {
    const gap = i ? opts.letterSpacing * 0.5 + (part.k === 'm' || parts[i - 1].k === 'm' ? MATH_PAD : 0) : 0;
    if (part.k === 't') return w + gap + measure(part.s);
    const f = formula(part.src, opts.size * scale);
    return w + gap + (f ? f.w : measure('$' + part.src + '$'));
  }, 0);
  const measureItem = (it: Item) => {
    if (it.display !== undefined) { const f = formula(it.display, opts.size * DISPLAY_K * (it.scale ?? 1)); return f ? f.w : measure(it.display); }
    return it.parts ? partsWidth(it.parts, it.scale) : measure(it.text);
  };

  // 1. Слова по абзацам
  const words: Word[] = [];
  for (const para of text.replace(/\r/g, '').split('\n')) {
    const disp = /^\s*\$\$([\s\S]+)\$\$\s*$/.exec(para);
    if (disp) { words.push({ text: para, display: disp[1].trim(), paraStart: true, paraEnd: true }); continue; }
    const { words: ws, unclosed } = tokenizeParagraph(para);
    if (unclosed && !errSeen.has(para)) { errSeen.add(para); mathErrors.push({ src: para.slice(para.lastIndexOf('$')), message: 'Нет закрывающего знака $' }); }
    if (!ws.length) { words.push({ text: '', paraStart: true, paraEnd: true }); continue; }
    ws.forEach((w, i) => words.push({ ...w, paraStart: i === 0, paraEnd: i === ws.length - 1 }));
  }

  // 2. Разбиение на строки
  const fullW = sheet.w - opts.margins.left - opts.margins.right;
  const lines: Line[] = [];
  let cur: Line | null = null;
  let curW = 0;
  const queue = [...words];
  while (queue.length) {
    const w = queue.shift()!;
    if (w.paraStart || !cur) {
      if (cur) lines.push(cur);
      cur = { words: [], indent: w.paraStart && w.text ? opts.indent : 0, justify: true };
      curW = 0;
    }
    if (!w.text) { cur.justify = false; lines.push(cur); cur = null; continue; }
    if (w.display !== undefined) {
      // формула отдельной строкой; если шире строки — уменьшаем
      if (cur.words.length) lines.push(cur);
      const fw = measureItem(w);
      lines.push({ words: [{ text: w.text, display: w.display, scale: fw > fullW ? fullW / fw : 1 }], indent: 0, justify: false, display: true });
      cur = null;
      continue;
    }
    const avail = fullW - cur.indent;
    const ww = measureItem(w);
    const need = (cur.words.length ? curW + spaceW : 0) + ww;
    if (need <= avail) {
      cur.words.push(w);
      curW = need;
    } else if (w.parts) {
      // слово с формулой не переносим: на новую строку, а если и там не влезает — уменьшаем формулы
      if (cur.words.length) { lines.push(cur); cur = { words: [], indent: 0, justify: true }; curW = 0; queue.unshift({ ...w, paraStart: false }); continue; }
      cur.words.push({ ...w, scale: Math.max(0.4, avail / ww) });
      curW = avail;
    } else {
      const room = avail - (cur.words.length ? curW + spaceW : 0);
      const split = opts.hyphenate ? splitForWidth(w.text, measure, room) : null;
      if (split) {
        cur.words.push({ text: split[0] });
        lines.push(cur);
        cur = { words: [], indent: 0, justify: true }; curW = 0;
        queue.unshift({ text: split[1], paraStart: false, paraEnd: w.paraEnd });
        continue;
      }
      if (cur.words.length) {
        lines.push(cur);
        cur = { words: [], indent: 0, justify: true }; curW = 0;
        queue.unshift({ ...w, paraStart: false });
        continue;
      }
      // Слово длиннее строки — режем по буквам
      const cs = [...w.text];
      let k = 1;
      while (k < cs.length && measure(cs.slice(0, k + 1).join('')) <= avail) k++;
      cur.words.push({ text: cs.slice(0, k).join('') });
      lines.push(cur);
      cur = { words: [], indent: 0, justify: true }; curW = 0;
      if (k < cs.length) queue.unshift({ text: cs.slice(k).join(''), paraStart: false, paraEnd: w.paraEnd });
      continue;
    }
    if (w.paraEnd) { cur.justify = false; lines.push(cur); cur = null; }
  }
  if (cur) { cur.justify = false; lines.push(cur); }

  // 3. Размещение на листах с очеловечиванием
  const rnd = mulberry32(opts.seed * 7919 + 17);
  const noise = makeNoise1D(opts.seed + 101);
  const tremorNoise = makeNoise1D(opts.seed + 202);
  const pages: LaidOutPage[] = [];
  let page: LaidOutPage = { paths: [], groups: [] };
  let group = 0;
  const bottomLimit = sheet.h - opts.margins.bottom - (opts.pageNumbers ? opts.size * 2 : 0);
  let baseline = opts.margins.top + opts.size;
  const linesPerPage = Math.max(1, Math.floor((bottomLimit - opts.margins.top - opts.size) / opts.lineHeight) + 1);
  let lineOnPage = 0;
  const lastVariant = new Map<string, number>();
  let tremorT = 0;
  let chars = 0;

  const finishPage = () => {
    if (opts.pageNumbers) {
      const label = String(pages.length + 1);
      const w = measure(label);
      placeWord(label, (sheet.w - w) / 2, sheet.h - opts.margins.bottom, 0, true);
    }
    pages.push(page);
    page = { paths: [], groups: [] };
    baseline = opts.margins.top + opts.size;
    lineOnPage = 0;
  };

  function placeWord(word: string, x: number, y: number, lineSlope: number, plain = false) {
    placeText(word, x, y, lineSlope, plain);
    group++;
  }

  /** Формула: базовая линия формулы совпадает с базовой линией строки, наклон и волна строки — те же. */
  function placeMath(src: string, x: number, y: number, lineSlope: number, size: number): number {
    const f = formula(src, size);
    if (!f) return placeText('$' + src + '$', x, y, lineSlope, false);
    for (const p of f.paths) {
      const pts: Pt[] = p.points.map(([px, py]) => {
        const X = x + px;
        let Y = y - f.asc + py;
        Y += (X - opts.margins.left) * Math.tan(lineSlope);
        Y += noise(X / 40 + baseline) * hp.wave * opts.size;
        return [X, Y];
      });
      page.paths.push({ points: pts, color: opts.color });
      page.groups.push(group);
    }
    chars++;
    return x + f.w;
  }

  function placeItem(it: Item, x: number, y: number, lineSlope: number) {
    if (it.display !== undefined) { placeMath(it.display, x, y, lineSlope, opts.size * DISPLAY_K * (it.scale ?? 1)); group++; return; }
    if (!it.parts) return placeWord(it.text, x, y, lineSlope);
    let px = x;
    it.parts.forEach((part, i) => {
      if (i) px += opts.letterSpacing * 0.5 + (part.k === 'm' || it.parts![i - 1].k === 'm' ? MATH_PAD : 0);
      px = part.k === 't' ? placeText(part.s, px, y, lineSlope, false) : placeMath(part.src, px, y, lineSlope, opts.size * (it.scale ?? 1));
    });
    group++;
  }

  /** Высота формул строки над/под базовой линией (для увеличения межстрочного). */
  function lineMath(line: Line): { asc: number; desc: number } {
    let asc = 0, desc = 0;
    for (const it of line.words) {
      const srcs: [string, number][] = it.display !== undefined
        ? [[it.display, DISPLAY_K * (it.scale ?? 1)]]
        : (it.parts ?? []).filter((x): x is { k: 'm'; src: string } => x.k === 'm').map((x) => [x.src, it.scale ?? 1]);
      for (const [src, k] of srcs) { const f = formula(src, opts.size * k); if (f) { asc = Math.max(asc, f.asc); desc = Math.max(desc, f.desc); } }
    }
    return { asc, desc };
  }

  function placeText(word: string, x: number, y: number, lineSlope: number, plain = false): number {
    const cs = [...word];
    let penX = x;
    const fatigue = plain ? 0 : hp.fatigue * (lineOnPage / linesPerPage);
    const j = plain ? 0 : 1 + 0.6 * fatigue;
    cs.forEach((ch, i) => {
      chars++;
      const g = glyphOf(ch);
      if (!g) { missing.add(ch); penX += 5 * s + opts.letterSpacing; return; }
      let vi = 0;
      if (g.variants.length > 1) {
        vi = Math.floor(rnd() * g.variants.length);
        if (vi === lastVariant.get(ch)) vi = (vi + 1) % g.variants.length;
        lastVariant.set(ch, vi);
      }
      const v: GlyphVariant = g.variants[vi];
      const sizeK = (1 + (plain ? 0 : 0.03 * fatigue)) * (1 + signed(rnd) * hp.scaleJitter * j);
      const gs = s * sizeK;
      const rot = ((signed(rnd) * hp.rotationDeg * j) * Math.PI) / 180;
      const dy = signed(rnd) * hp.baselineJitter * opts.size * j;
      const cos = Math.cos(rot), sin = Math.sin(rot);
      const cx = v.advance / 2, cy = 3.5;
      for (const st of v.strokes) {
        const src = hp.tremor > 0 && !plain ? densify(st, 0.6) : st;
        const pts: Pt[] = src.map(([gx, gy]) => {
          const rx = cx + (gx - cx) * cos - (gy - cy) * sin;
          const ry = cy + (gx - cx) * sin + (gy - cy) * cos;
          let X = penX + rx * gs;
          let Y = y - ry * gs + dy;
          if (!plain) {
            Y += (X - opts.margins.left) * Math.tan(lineSlope);
            Y += noise(X / 40 + baseline) * hp.wave * opts.size;
            if (hp.tremor > 0) {
              tremorT += 0.35;
              X += tremorNoise(tremorT) * hp.tremor * opts.size * j;
              Y += tremorNoise(tremorT + 50) * hp.tremor * opts.size * j;
            }
          }
          return [X, Y];
        });
        page.paths.push({ points: pts, color: opts.color });
        page.groups.push(group);
      }
      penX += v.advance * gs;
      if (i < cs.length - 1) {
        penX += opts.letterSpacing + kern(ch, cs[i + 1]);
        if (!plain) penX += signed(rnd) * hp.spacingJitter * opts.size * 0.3 * j;
      }
    });
    return penX;
  }

  for (const line of lines) {
    // высокие формулы (дроби, суммы) раздвигают строки, чтобы не задевать соседние
    const lm = lineMath(line);
    const pad = line.display ? opts.size * 0.35 : 0;
    const extraAbove = Math.max(0, lm.asc - opts.size * 1.15) + pad;
    const extraBelow = Math.max(0, lm.desc - opts.size * 0.4) + pad;
    if (baseline > bottomLimit + 1e-6 || (baseline + extraAbove > bottomLimit + 1e-6 && lineOnPage > 0)) finishPage();
    baseline += extraAbove;
    const lineSlope = ((opts.slopeDeg + signed(rnd) * hp.rotationDeg * 0.3) * Math.PI) / 180;
    const drift = signed(rnd) * hp.marginDrift;
    const avail = fullW - line.indent;
    if (line.display) {
      const w = measureItem(line.words[0]);
      placeItem(line.words[0], opts.margins.left + (fullW - w) / 2, baseline, lineSlope);
      baseline += opts.lineHeight + extraBelow;
      lineOnPage++;
      continue;
    }
    const widths = line.words.map(measureItem);
    const textW = widths.reduce((a, b) => a + b, 0);
    let gap = spaceW;
    let x = opts.margins.left + line.indent + drift;
    const natural = textW + spaceW * Math.max(0, line.words.length - 1);
    if (opts.align === 'center') x += (avail - natural) / 2;
    else if (opts.align === 'right') x += avail - natural;
    else if (opts.align === 'justify' && line.justify && line.words.length > 1)
      gap = (avail - textW) / (line.words.length - 1);
    line.words.forEach((w, i) => {
      placeItem(w, x, baseline, lineSlope);
      x += widths[i] + gap + signed(rnd) * hp.spacingJitter * opts.size;
    });
    baseline += opts.lineHeight + extraBelow;
    lineOnPage++;
  }
  if (page.paths.length || !pages.length) finishPage();

  return { pages, missing: [...missing], lines: lines.length, chars, mathErrors };
}
