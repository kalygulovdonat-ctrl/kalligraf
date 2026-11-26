// Сборка задания: текст + рисунки + разметка → листы с путями.
import { builtinFonts, type Font } from './core/font';
import { bboxOf, type Path, type Pt } from './core/geometry';
import { layoutText } from './core/layout';
import { markup, runGenerator } from './core/generators';
import type { ArtItem, Doc } from './store';
import { cadToPaths } from './core/cad/model';
import { annotate } from './core/cad/annotate';

const genCache = new Map<string, Path[]>();

export function itemLocalPaths(item: ArtItem, font: Font, sheet: { w: number; h: number }): Path[] {
  if (item.kind === 'svg' || item.kind === 'signature') return item.paths ?? [];
  const key = item.kind + JSON.stringify(item.params) + font.id + sheet.w + 'x' + sheet.h;
  let p = genCache.get(key);
  if (!p) {
    try {
      p = runGenerator(item.kind, item.params, font, sheet);
    } catch {
      p = [];
    }
    genCache.set(key, p);
    if (genCache.size > 60) genCache.delete(genCache.keys().next().value!);
  }
  return p;
}

// Кэш размещённых рисунков: элемент неизменяемый, поэтому пересчёт нужен только при его изменении
const placedCache = new WeakMap<ArtItem, { key: string; paths: Path[] }>();

export function placeItem(item: ArtItem, font: Font, sheet: { w: number; h: number }): Path[] {
  const key = font.id + '|' + sheet.w + 'x' + sheet.h;
  const hit = placedCache.get(item);
  if (hit && hit.key === key) return hit.paths;
  const paths = placeItemRaw(item, font, sheet);
  placedCache.set(item, { key, paths });
  return paths;
}

function placeItemRaw(item: ArtItem, font: Font, sheet: { w: number; h: number }): Path[] {
  const local = itemLocalPaths(item, font, sheet);
  if (item.kind === 'gost') return local.map((p) => ({ ...p, color: p.color ?? item.color }));
  const a = (item.rotation * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  const bb = bboxOf(local);
  const cx = bb ? (bb.minX + bb.maxX) / 2 : 0, cy = bb ? (bb.minY + bb.maxY) / 2 : 0;
  const ox = bb ? bb.minX : 0, oy = bb ? bb.minY : 0;
  return local.map((p) => ({
    ...p,
    color: p.color ?? item.color,
    points: p.points.map(([x, y]) => {
      // поворот вокруг центра, затем левый верхний угол рамки → (item.x, item.y)
      const dx = (x - cx) * item.scale, dy = (y - cy) * item.scale;
      const rx = dx * c - dy * s, ry = dx * s + dy * c;
      return [item.x + (cx - ox) * item.scale + rx, item.y + (cy - oy) * item.scale + ry] as Pt;
    }),
  }));
}

export interface BuiltPage {
  paths: Path[];
  groups: number[];
  ruling: Path[];      // разметка для показа (или печати)
}

export interface BuiltJob {
  pages: BuiltPage[];
  missing: string[];
  mathErrors: { src: string; message: string }[];
  lines: number;
  chars: number;
}

export function buildJob(doc: Doc, font: Font): BuiltJob {
  const fallback = builtinFonts()[0];
  const sheet = { w: doc.sheet.w, h: doc.sheet.h };
  const lay = layoutText(doc.text, font, doc.textOpts, sheet, font.id === fallback.id ? undefined : fallback);
  const cadPaths = doc.cad?.entities.length ? cadToPaths(doc.cad, annotate) : [];
  const maxItemPage = Math.max(doc.items.reduce((m, i) => Math.max(m, i.page), 0), cadPaths.length ? doc.cad.page : 0);
  const pageCount = Math.max(lay.pages.length, maxItemPage + 1);
  const ruling = doc.ruling === 'none' ? [] : markup({ kind: doc.ruling, step: doc.rulingStep, w: sheet.w, h: sheet.h, margin: false });
  const pages: BuiltPage[] = [];
  for (let i = 0; i < pageCount; i++) {
    const tp = lay.pages[i] ?? { paths: [], groups: [] };
    const paths = [...tp.paths];
    const groups = [...tp.groups];
    let g = 1e6;
    for (const it of doc.items.filter((x) => x.page === i)) {
      for (const p of placeItem(it, font, sheet)) { paths.push(p); groups.push(g); }
      g++;
    }
    if (cadPaths.length && doc.cad.page === i) for (const p of cadPaths) { paths.push(p); groups.push(2e6); }
    if (doc.printRuling && ruling.length) {
      const rp = ruling.map((p) => ({ ...p, color: undefined }));
      paths.unshift(...rp);
      groups.unshift(...rp.map(() => -1));
    }
    pages.push({ paths, groups, ruling });
  }
  return { pages, missing: lay.missing, lines: lay.lines, chars: lay.chars, mathErrors: lay.mathErrors };
}

/** Путь SVG «M…L…» из набора путей (для быстрой отрисовки). */
export function toSvgD(paths: Path[]): string {
  let d = '';
  for (const p of paths) {
    if (!p.points.length) continue;
    const [x0, y0] = p.points[0];
    d += `M${x0.toFixed(2)} ${y0.toFixed(2)}`;
    if (p.points.length === 1) d += `l0.05 0`;
    for (let i = 1; i < p.points.length; i++) d += `L${p.points[i][0].toFixed(2)} ${p.points[i][1].toFixed(2)}`;
  }
  return d;
}

export function groupByColor(paths: Path[]): Map<string, Path[]> {
  const m = new Map<string, Path[]>();
  for (const p of paths) {
    const k = p.color ?? '';
    if (!m.has(k)) m.set(k, []);
    m.get(k)!.push(p);
  }
  return m;
}

export const COLOR_NAMES: Record<string, string> = {
  '': 'основная', '#d9480f': 'оранжевая', '#e03131': 'красная', '#1971c2': 'синяя', '#2f9e44': 'зелёная',
  '#000000': 'чёрная', '#7048e8': 'фиолетовая', '#adb5bd': 'серая',
};
export const PEN_COLORS = ['', '#e03131', '#1971c2', '#2f9e44', '#d9480f', '#7048e8', '#000000'];
