// Однолинейные шрифты: разбор встроенного описания, свои почерки, импорт/экспорт.
import { chaikin, type Pt, type Stroke } from './geometry';
import { GLYPH_SRC } from './fontData';
// Рукописные шрифты (OFL), переведённые в однолинейные скриптом scripts/build-fonts.test.ts
import hwBadScript from '../fonts/hw-badscript.json';
import hwMarck from '../fonts/hw-marck.json';
import hwCaveat from '../fonts/hw-caveat.json';
import hwNeucha from '../fonts/hw-neucha.json';
import hwPangolin from '../fonts/hw-pangolin.json';

/** Единицы шрифта: высота заглавной буквы = 10, базовая линия y = 0, ось Y вверх. */
export const CAP = 10;

export interface GlyphVariant {
  advance: number;
  strokes: Stroke[];
}
export interface Glyph {
  variants: GlyphVariant[];
}
export interface Font {
  id: string;
  name: string;
  author?: string;
  license?: string;
  builtin?: boolean;
  createdAt?: number;
  glyphs: Record<string, Glyph>;
  kerning?: Record<string, number>;
}

const ARC_RE = /^a\(([^)]+)\)$/;

/** Разбор строки описания глифа в набор штрихов. */
export function parseGlyph(src: string): Stroke[] {
  const strokes: Stroke[] = [];
  for (const part of src.split(';')) {
    const tokens = part.trim().split(/\s+/).filter(Boolean);
    if (!tokens.length) continue;
    const s: Pt[] = [];
    for (const tok of tokens) {
      const m = ARC_RE.exec(tok);
      if (m) {
        const [cx, cy, rx, ry, a0, a1] = m[1].split(',').map(Number);
        const span = a1 - a0;
        const n = Math.max(6, Math.ceil((Math.abs(span) / 360) * 48));
        for (let i = 0; i <= n; i++) {
          const a = ((a0 + (span * i) / n) * Math.PI) / 180;
          s.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)]);
        }
      } else {
        const [x, y] = tok.split(',').map(Number);
        if (Number.isFinite(x) && Number.isFinite(y)) s.push([x, y]);
      }
    }
    if (s.length) strokes.push(s);
  }
  return strokes;
}

function buildBase(): Record<string, Glyph> {
  const glyphs: Record<string, Glyph> = {};
  for (const [ch, [adv, src]] of Object.entries(GLYPH_SRC)) {
    glyphs[ch] = { variants: [{ advance: adv, strokes: parseGlyph(src) }] };
  }
  return glyphs;
}

/** Наклон (курсив) и масштаб по ширине для производных шрифтов. */
function derive(base: Record<string, Glyph>, opts: { shearDeg: number; widthK: number; smooth: number }) {
  const k = Math.tan((opts.shearDeg * Math.PI) / 180);
  const out: Record<string, Glyph> = {};
  for (const [ch, g] of Object.entries(base)) {
    out[ch] = {
      variants: g.variants.map((v) => ({
        advance: v.advance * opts.widthK,
        strokes: v.strokes.map((s) => {
          const pts = s.map(([x, y]) => [x * opts.widthK + y * k, y] as Pt);
          return opts.smooth ? chaikin(pts, opts.smooth) : pts;
        }),
      })),
    };
  }
  return out;
}

let _builtins: Font[] | null = null;
export function builtinFonts(): Font[] {
  if (_builtins) return _builtins;
  const base = buildBase();
  _builtins = [
    { id: 'print', name: 'Печатный', author: 'Каллиграф', license: 'OFL-1.1', builtin: true, glyphs: base,
      kerning: { 'Та': -1, 'То': -0.8, 'Ту': -0.8, 'Го': -1, 'Га': -1, 'Ау': -0.5, 'Ty': -0.8, 'To': -0.8, 'AV': -0.8, 'LT': -0.8 } },
    ...[hwBadScript, hwMarck, hwCaveat, hwPangolin, hwNeucha].map((f) => ({ ...(f as unknown as Font), builtin: true })),
    { id: 'italic', name: 'Курсив', author: 'Каллиграф', license: 'OFL-1.1', builtin: true,
      glyphs: derive(base, { shearDeg: 14, widthK: 0.92, smooth: 1 }) },
    { id: 'drafting', name: 'Чертёжный (в стиле ГОСТ 2.304, наклон 75°)', author: 'Каллиграф', license: 'OFL-1.1', builtin: true,
      glyphs: derive(base, { shearDeg: 15, widthK: 0.82, smooth: 0 }) },
    { id: 'drafting-straight', name: 'Чертёжный прямой', author: 'Каллиграф', license: 'OFL-1.1', builtin: true,
      glyphs: derive(base, { shearDeg: 0, widthK: 0.82, smooth: 0 }) },
  ];
  return _builtins;
}

// ── Формат файла .kfont (раздел 8.4 ТЗ) ──────────────────────────────
// В файле: unitsPerEm = 1000, capHeight = 700. Внутри программы — capHeight = 10.

const FILE_CAP = 700;

export interface KFontFile {
  name: string;
  author?: string;
  license?: string;
  version: number;
  unitsPerEm: number;
  capHeight: number;
  xHeight?: number;
  ascent?: number;
  descent?: number;
  glyphs: Record<string, { variants: { advance: number; strokes: number[][][] }[] }>;
  kerning?: Record<string, number>;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

export function exportFont(font: Font): KFontFile {
  const k = FILE_CAP / CAP;
  const glyphs: KFontFile['glyphs'] = {};
  for (const [ch, g] of Object.entries(font.glyphs)) {
    glyphs[ch] = {
      variants: g.variants.map((v) => ({
        advance: r2(v.advance * k),
        strokes: v.strokes.map((s) => s.map(([x, y]) => [r2(x * k), r2(y * k)])),
      })),
    };
  }
  const kerning: Record<string, number> = {};
  for (const [p, v] of Object.entries(font.kerning ?? {})) kerning[p] = r2(v * k);
  return {
    name: font.name, author: font.author, license: font.license, version: 1,
    unitsPerEm: 1000, capHeight: FILE_CAP, xHeight: 500, ascent: 800, descent: -250,
    glyphs, kerning,
  };
}

export function importFont(data: unknown): Font {
  const f = data as Partial<KFontFile>;
  if (!f || typeof f !== 'object' || !f.glyphs || typeof f.glyphs !== 'object')
    throw new Error('Файл не похож на шрифт .kfont: нет раздела "glyphs".');
  const cap = Number(f.capHeight) > 0 ? Number(f.capHeight) : FILE_CAP;
  const k = CAP / cap;
  const glyphs: Record<string, Glyph> = {};
  for (const [ch, g] of Object.entries(f.glyphs)) {
    if (!g || !Array.isArray(g.variants)) continue;
    const variants: GlyphVariant[] = [];
    for (const v of g.variants) {
      if (!v || !Array.isArray(v.strokes)) continue;
      const strokes: Stroke[] = v.strokes
        .filter((s) => Array.isArray(s))
        .map((s) => s.filter((p) => Array.isArray(p) && p.length >= 2).map((p) => [Number(p[0]) * k, Number(p[1]) * k] as Pt))
        .filter((s) => s.length > 0 && s.every(([x, y]) => Number.isFinite(x) && Number.isFinite(y)));
      variants.push({ advance: Number.isFinite(Number(v.advance)) ? Number(v.advance) * k : 6, strokes });
    }
    if (variants.length) glyphs[ch] = { variants };
  }
  if (!Object.keys(glyphs).length) throw new Error('В шрифте нет ни одной буквы.');
  const kerning: Record<string, number> = {};
  for (const [p, v] of Object.entries(f.kerning ?? {})) if (Number.isFinite(Number(v))) kerning[p] = Number(v) * k;
  return {
    id: 'u-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    name: String(f.name || 'Импортированный шрифт'),
    author: f.author, license: f.license, createdAt: Date.now(), glyphs, kerning,
  };
}

/** Какие символы текста отсутствуют в шрифте (пробелы и переводы строк не считаются). */
export function missingChars(text: string, font: Font, fallback?: Font): string[] {
  const set = new Set<string>();
  for (const ch of text) {
    if (ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t') continue;
    if (!font.glyphs[ch] && !(fallback && fallback.glyphs[ch])) set.add(ch);
  }
  return [...set];
}

/** Набор символов, для которых строится свой почерк. */
export const HANDWRITING_SET =
  'АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯабвгдеёжзийклмнопрстуфхцчшщъыьэюяҢңӨөҮү0123456789.,!?:;-()«»№';
