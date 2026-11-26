// Рисунок из линий «по центру»: для чертежей, схем, страниц PDF и рисунков ручкой.
import { simplify, type Path, type Pt } from './geometry';
import { thin, traceSkeleton, type Gray } from './vision';

/**
 * Линии рисунка «по центру»: тёмное → тонкий скелет → штрихи. Ручка проходит каждую линию один раз.
 * widthMM — ширина картинки на листе.
 */
export function lineArt(g: Gray, widthMM: number, threshold = 150): Path[] {
  const { w, h, d } = g;
  const b = new Uint8Array(w * h);
  for (let i = 0; i < b.length; i++) b[i] = d[i] < threshold ? 1 : 0;
  // рамка в 1 пиксель — пустая (нужно для утончения)
  for (let x = 0; x < w; x++) { b[x] = 0; b[(h - 1) * w + x] = 0; }
  for (let y = 0; y < h; y++) { b[y * w] = 0; b[y * w + w - 1] = 0; }
  thin(b, w, h);
  const k = widthMM / w; // мм на пиксель
  const strokes = traceSkeleton(b, w, h, Math.max(2, Math.round(0.6 / k)));
  const out: Path[] = [];
  for (const s of strokes) {
    const pts = s.map(([x, y]) => [x * k, y * k] as Pt);
    const simp = pts.length > 2 ? simplify(pts, 0.08) : pts;
    let len = 0;
    for (let i = 1; i < simp.length; i++) len += Math.hypot(simp[i][0] - simp[i - 1][0], simp[i][1] - simp[i - 1][1]);
    if (len >= 0.5 || simp.length === 1) out.push({ points: simp });
  }
  return out;
}
