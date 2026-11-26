import { describe, expect, it } from 'vitest';
import { defaultParams, defaultPrep, photoToPaths, prepare, stipplePoints, tspTour, STYLES, canny, twoOptNeighbors } from '../core/photoart';
import type { Gray } from '../core/vision';
import type { Path, Pt } from '../core/geometry';

/** Тёмный круг на белом фоне (300×200). */
function disc(): Gray {
  const w = 300, h = 200, d = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) d[y * w + x] = Math.hypot(x - 150, y - 100) < 60 ? 30 : 240;
  return { w, h, d };
}
/** Горизонтальный градиент: слева чёрный, справа белый. */
function gradient(): Gray {
  const w = 300, h = 100, d = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) d[y * w + x] = Math.round((x / (w - 1)) * 255);
  return { w, h, d };
}
const inside = (paths: Path[], W: number, H: number) => paths.every((p) => p.points.every(([x, y]) => x >= -0.5 && y >= -0.5 && x <= W + 0.5 && y <= H + 0.5));
const length = (paths: Path[]) => paths.reduce((s, p) => { let l = 0; for (let i = 1; i < p.points.length; i++) l += Math.hypot(p.points[i][0] - p.points[i - 1][0], p.points[i][1] - p.points[i - 1][1]); return s + l; }, 0);

describe('фото → рисунок', () => {
  it('подготовка: инверсия и удаление фона', () => {
    const g = prepare(disc(), { ...defaultPrep, invert: true, contrast: 0 }, 1000);
    expect(g.d[100 * 300 + 150]).toBeGreaterThan(200);
    const bg = prepare(disc(), { ...defaultPrep, whiteBg: 20, contrast: 0 }, 1000);
    expect(bg.d[0]).toBe(255);
  });

  it('контуры круга — замкнутая линия длиной ≈ 2πR', () => {
    const paths = photoToPaths(disc(), 'contours', defaultParams, 150); // 150 мм ⇒ 0,5 мм/px, R = 30 мм
    expect(paths.length).toBe(1); // одна замкнутая линия, без обрывков
    const L = length(paths);
    expect(L).toBeGreaterThan(2 * Math.PI * 30 * 0.85);
    expect(L).toBeLessThan(2 * Math.PI * 30 * 1.25);
    // все точки — около окружности
    for (const p of paths) for (const [x, y] of p.points) expect(Math.abs(Math.hypot(x - 75, y - 50) - 30)).toBeLessThan(2);
  });

  it('штриховка гуще там, где темнее', () => {
    const paths = photoToPaths(gradient(), 'hatch', { ...defaultParams, layers: 4 }, 150);
    const dark = paths.filter((p) => p.points.some(([x]) => x < 40)).length;
    const light = paths.filter((p) => p.points.every(([x]) => x > 110)).length;
    expect(dark).toBeGreaterThan(light);
    expect(inside(paths, 150, 50)).toBe(true);
  });

  it('точки: нужное количество, в тёмной части больше', () => {
    const pts = stipplePoints(gradient(), 800, 1, 6);
    expect(pts.length).toBe(800);
    const left = pts.filter((p) => p[0] < 100).length, right = pts.filter((p) => p[0] > 200).length;
    expect(left).toBeGreaterThan(right * 3);
  });

  it('одна линия: все точки по одному разу, 2-opt не удлиняет путь', () => {
    const pts: Pt[] = Array.from({ length: 400 }, (_, i) => [((i * 37) % 100) + 0.5, ((i * 53) % 97) + 0.5]);
    const tour = tspTour(pts, 300);
    expect(tour.length).toBe(400);
    expect(new Set(tour.map((p) => p.join(','))).size).toBe(400);
    const L = (t: Pt[]) => t.slice(1).reduce((s, p, i) => s + Math.hypot(p[0] - t[i][0], p[1] - t[i][1]), 0);
    expect(L(tour)).toBeLessThan(L(pts));
    const one = photoToPaths(disc(), 'tsp', { ...defaultParams, points: 600 }, 150);
    expect(one.length).toBe(1);
    // после улучшения не остаётся «перелётов» длиннее четверти рисунка
    const seg = one[0].points.slice(1).map((p, i) => Math.hypot(p[0] - one[0].points[i][0], p[1] - one[0].points[i][1]));
    expect(Math.max(...seg)).toBeLessThan(40);
  });

  it('все стили: пути конечные и внутри рисунка', () => {
    for (const s of STYLES) {
      const paths = photoToPaths(disc(), s.id, { ...defaultParams, points: 500 }, 150);
      expect(paths.length, s.id).toBeGreaterThan(0);
      for (const p of paths) for (const [x, y] of p.points) expect(Number.isFinite(x) && Number.isFinite(y), s.id).toBe(true);
      expect(inside(paths, 150, 100), s.id).toBe(true);
    }
  });

  it('2-opt по соседям убирает пересечения на случайных точках', () => {
    let s = 7; const r = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    const pts: Pt[] = Array.from({ length: 1500 }, () => [r() * 100, r() * 100]);
    const L = (t: Pt[]) => t.slice(1).reduce((a, p, i) => a + Math.hypot(p[0] - t[i][0], p[1] - t[i][1]), 0);
    const opt = twoOptNeighbors(pts, 1000);
    expect(opt.length).toBe(1500);
    expect(L(opt)).toBeLessThan(L(pts) * 0.2); // случайный порядок → почти оптимальный
  });
  it('Кэнни на пустом изображении — пусто', () => {
    const g: Gray = { w: 50, h: 50, d: new Uint8Array(2500).fill(200) };
    expect(canny(g, 5).some((v) => v)).toBe(false);
  });
});

describe('портрет', () => {
  it('автоуровни растягивают тусклую картинку на весь диапазон', async () => {
    const { autoLevels } = await import('../core/photoart');
    const d = new Uint8Array(10000).map((_, i) => 100 + (i % 50)); // всё в 100…149
    const r = autoLevels({ w: 100, h: 100, d });
    expect(Math.min(...r.d)).toBeLessThan(10);
    expect(Math.max(...r.d)).toBeGreaterThan(245);
  });
  it('CLAHE вытягивает плавные тени в тёмной половине', async () => {
    const { clahe } = await import('../core/photoart');
    const w = 200, h = 100, d = new Uint8Array(w * h);
    // слева тёмный плавный переход 20…50, справа светлое
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) d[y * w + x] = x < 100 ? 20 + Math.round((x / 99) * 30) : 220;
    const r = clahe({ w, h, d });
    const row = Array.from({ length: 100 }, (_, x) => r.d[50 * w + x]);
    // мягкое ограничение (по умолчанию) — заметно, но без «пластика»
    expect(Math.max(...row) - Math.min(...row)).toBeGreaterThan(33); // было 30
    // без ограничения — сильное растяжение: сам алгоритм работает
    const strong = clahe({ w, h, d }, 8, 40);
    const row2 = Array.from({ length: 100 }, (_, x) => strong.d[50 * w + x]);
    expect(Math.max(...row2) - Math.min(...row2)).toBeGreaterThan(100);
  });
  it('стиль «Портрет»: контуры + штриховка, внутри рисунка', () => {
    const w = 300, h = 400, d = new Uint8Array(w * h);
    // «лицо»: светлый овал на тёмном фоне, тёмные «глаза» и «рот»
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const face = ((x - 150) / 90) ** 2 + ((y - 200) / 130) ** 2 < 1;
      const eye = Math.hypot(x - 115, y - 170) < 12 || Math.hypot(x - 185, y - 170) < 12;
      const mouth = Math.abs(y - 260) < 6 && Math.abs(x - 150) < 35;
      d[y * w + x] = eye || mouth ? 40 : face ? 215 - Math.round((x / w) * 60) : 70;
    }
    const paths = photoToPaths({ w, h, d }, 'portrait', defaultParams, 90);
    expect(paths.length).toBeGreaterThan(50);
    for (const p of paths) for (const [x, y] of p.points) { expect(x).toBeGreaterThanOrEqual(-0.5); expect(x).toBeLessThanOrEqual(90.5); expect(y).toBeLessThanOrEqual(120.5); }
    // фон (тёмный) заштрихован гуще, чем лицо
    const inFace = (x: number, y: number) => ((x - 45) / 27) ** 2 + ((y - 60) / 39) ** 2 < 0.8;
    const pts = paths.flatMap((p) => p.points);
    const face = pts.filter(([x, y]) => inFace(x, y)).length, bg = pts.filter(([x, y]) => !inFace(x, y)).length;
    expect(bg).toBeGreaterThan(face);
  });
});

describe('кадр фото', () => {
  it('поворот на 90° по часовой и обратно', async () => {
    const { rotateGray } = await import('../core/photoart');
    // 3×2: 1 2 3 / 4 5 6
    const g = { w: 3, h: 2, d: Uint8Array.from([1, 2, 3, 4, 5, 6]) };
    const r = rotateGray(g, 1);
    expect([r.w, r.h]).toEqual([2, 3]);
    expect(Array.from(r.d)).toEqual([4, 1, 5, 2, 6, 3]); // левый столбец снизу вверх → верхняя строка
    expect(Array.from(rotateGray(rotateGray(r, 1), 2).d)).toEqual(Array.from(g.d)); // 4 поворота = исходное
  });
  it('обрезка вырезает нужную часть', async () => {
    const { frameGray } = await import('../core/photoart');
    const w = 10, h = 10, d = new Uint8Array(100).map((_, i) => i);
    const f = frameGray({ w, h, d }, 0, { x0: 0.2, y0: 0.5, x1: 0.6, y1: 1 });
    expect([f.w, f.h]).toEqual([4, 5]);
    expect(f.d[0]).toBe(52); // строка 5, столбец 2
  });
});
