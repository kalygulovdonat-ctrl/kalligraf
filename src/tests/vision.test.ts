import { describe, expect, it } from 'vitest';
import { builtinFonts } from '../core/font';
import { TPL, cellRect, templateChars, templateSvg } from '../core/template';
import { applyH, homography, processSheet, thin, traceSkeleton, findMarkers, type Gray, MarkersNotFound } from '../core/vision';
import { mulberry32 } from '../core/rng';
import type { Pt } from '../core/geometry';

const font = builtinFonts()[0];
const R = 5; // px/мм эталонного растра шаблона

function drawSeg(g: Gray, a: Pt, b: Pt, r: number, v: number) {
  const x0 = Math.floor(Math.min(a[0], b[0]) - r), x1 = Math.ceil(Math.max(a[0], b[0]) + r);
  const y0 = Math.floor(Math.min(a[1], b[1]) - r), y1 = Math.ceil(Math.max(a[1], b[1]) + r);
  const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy;
  for (let y = Math.max(0, y0); y <= Math.min(g.h - 1, y1); y++)
    for (let x = Math.max(0, x0); x <= Math.min(g.w - 1, x1); x++) {
      const t = L2 ? Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / L2)) : 0;
      if (Math.hypot(x - a[0] - t * dx, y - a[1] - t * dy) <= r) g.d[y * g.w + x] = Math.min(g.d[y * g.w + x], v);
    }
}
function rect(g: Gray, x: number, y: number, w: number, h: number, v: number) {
  for (let yy = Math.round(y * R); yy < Math.round((y + h) * R); yy++)
    for (let xx = Math.round(x * R); xx < Math.round((x + w) * R); xx++) g.d[yy * g.w + xx] = v;
}

/** Растр заполненного шаблона: метки, светлые направляющие, подписи, буквы «рукой» (шрифтом). */
function filledTemplate(chars: string[]): Gray {
  const g: Gray = { w: TPL.pageW * R, h: TPL.pageH * R, d: new Uint8Array(TPL.pageW * R * TPL.pageH * R).fill(245) };
  TPL.markers.forEach(([cx, cy], k) => {
    rect(g, cx - TPL.marker / 2, cy - TPL.marker / 2, TPL.marker, TPL.marker, 15);
    if (k === 0) rect(g, cx - TPL.hole / 2, cy - TPL.hole / 2, TPL.hole, TPL.hole, 245);
  });
  chars.forEach((ch, i) => {
    const r = cellRect(i);
    // светлые линии и подпись
    for (const yy of [TPL.capTop, TPL.xTop, TPL.base]) drawSeg(g, [(r.x + 1) * R, (r.y + yy) * R], [(r.x + r.w - 1) * R, (r.y + yy) * R], 0.6, 205);
    rect(g, r.x + 0.8, r.y + 0.8, 1.6, 2, 196);
    const v = font.glyphs[ch]?.variants[0];
    if (!v) return;
    for (const s of v.strokes) {
      const pts = s.map(([x, y]) => [(r.x + 3 + x * TPL.unitMM) * R, (r.y + TPL.base - y * TPL.unitMM) * R] as Pt);
      if (pts.length === 1) drawSeg(g, pts[0], pts[0], 0.35 * R, 45);
      for (let k = 1; k < pts.length; k++) drawSeg(g, pts[k - 1], pts[k], 0.3 * R, 45);
    }
  });
  return g;
}

/** «Фотография»: перспектива, фон стола, градиент света, шум. corners — углы листа на фото (ЛВ, ПВ, ПН, ЛН). */
function photograph(tpl: Gray, W: number, H: number, corners: Pt[], seed = 1): { img: Gray; Hp: number[] } {
  const page: Pt[] = [[0, 0], [TPL.pageW, 0], [TPL.pageW, TPL.pageH], [0, TPL.pageH]];
  const Hp = homography(page, corners);           // мм → фото
  const Hi = homography(corners, page);           // фото → мм
  const rnd = mulberry32(seed);
  const img: Gray = { w: W, h: H, d: new Uint8Array(W * H) };
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const [u, v] = applyH(Hi, [x + 0.5, y + 0.5]);
      let val = 95; // стол
      if (u >= 0 && v >= 0 && u < TPL.pageW && v < TPL.pageH) val = tpl.d[Math.floor(v * R) * tpl.w + Math.floor(u * R)];
      const light = 0.68 + 0.32 * (x / W) * (1 - 0.3 * (y / H)); // тень
      img.d[y * W + x] = Math.max(0, Math.min(255, val * light + (rnd() - 0.5) * 14));
    }
  return { img, Hp };
}

const chars = templateChars(0);

function check(res: ReturnType<typeof processSheet>) {
  const byChar = new Map(res.cells.map((c) => [c.char, c]));
  let good = 0;
  const bad: string[] = [];
  for (const ch of chars) {
    const c = byChar.get(ch)!;
    const v = font.glyphs[ch].variants[0];
    const ys = v.strokes.flat().map((p) => p[1]), xs = v.strokes.flat().map((p) => p[0]);
    const ref = { w: Math.max(...xs) - Math.min(...xs), top: Math.max(...ys), bot: Math.min(...ys) };
    if (!c.strokes.length) { bad.push(ch + ':пусто'); continue; }
    const cy = c.strokes.flat().map((p) => p[1]), cx = c.strokes.flat().map((p) => p[0]);
    const got = { w: Math.max(...cx) - Math.min(...cx), top: Math.max(...cy), bot: Math.min(...cy) };
    const tol = 0.9;
    if (Math.abs(got.w - ref.w) < tol && Math.abs(got.top - ref.top) < tol && Math.abs(got.bot - ref.bot) < tol) good++;
    else bad.push(`${ch}:${JSON.stringify(got)} vs ${JSON.stringify(ref)}`);
  }
  return { good, bad, byChar };
}

describe('почерк по фото', () => {
  it('шаблон: SVG с метками и всеми буквами', () => {
    const svg = templateSvg(0, chars);
    expect(svg).toContain('width="210mm"');
    expect((svg.match(/fill="#000"/g) ?? []).length).toBe(4);
    expect(chars.length).toBeLessThanOrEqual(TPL.cols * TPL.rows);
    expect(chars).toContain('Ң');
  });

  it('с английскими буквами — два листа без потерь и повторов', () => {
    const set = templateChars(0).join('') + 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
    const a = templateChars(0, set), b = templateChars(1, set);
    expect(a.length).toBeLessThanOrEqual(TPL.cols * TPL.rows);
    expect([...a, ...b].join('')).toBe(set);
  });

  it('скелет: «Т» → 2 штриха, «О» → 1 замкнутый', () => {
    const w = 60, h = 60;
    const b = new Uint8Array(w * h);
    for (let y = 10; y < 50; y++) for (let x = 28; x < 33; x++) b[y * w + x] = 1;
    for (let y = 10; y < 15; y++) for (let x = 10; x < 50; x++) b[y * w + x] = 1;
    thin(b, w, h);
    const t = traceSkeleton(b, w, h, 5);
    expect(t.filter((s) => s.length > 3).length).toBe(2);
    const o = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const r = Math.hypot(x - 30, y - 30); if (r > 15 && r < 20) o[y * w + x] = 1; }
    thin(o, w, h);
    const os = traceSkeleton(o, w, h, 5);
    expect(os.length).toBe(1);
    const s = os[0];
    expect(Math.hypot(s[0][0] - s[s.length - 1][0], s[0][1] - s[s.length - 1][1])).toBeLessThan(3);
  });

  const tpl = filledTemplate(chars);

  it('распознаёт ровное фото с тенью и шумом', () => {
    const corners: Pt[] = [[140, 120], [1480, 170], [1520, 2050], [90, 2000]];
    const { img, Hp } = photograph(tpl, 1600, 2160, corners, 3);
    const res = processSheet(img, chars);
    // метки найдены точно
    TPL.markers.forEach((m, k) => {
      const exp = applyH(Hp, m);
      expect(Math.hypot(res.corners[k][0] - exp[0], res.corners[k][1] - exp[1])).toBeLessThan(3);
    });
    const { good, bad, byChar } = check(res);
    // Острые углы («, », <, >) скелет немного укорачивает — это свойство скелетизации.
    expect(bad.length, bad.join('\n')).toBeLessThanOrEqual(2);
    expect(bad.every((b) => '«»<>'.includes(b[0])), bad.join('\n')).toBe(true);
    expect(good).toBeGreaterThanOrEqual(chars.length - 2);
    for (const ch of ':!?ёй') expect(byChar.get(ch)!.strokes.length, ch).toBeGreaterThanOrEqual(2);
    expect(byChar.get('О')!.strokes.length).toBe(1);
    expect(byChar.get('Т')!.strokes.length).toBeLessThanOrEqual(2);
    expect(byChar.get('ё')!.strokes.length).toBeGreaterThanOrEqual(3); // буква + 2 точки
  }, 60000);

  it('фото, перевёрнутое на 180°, тоже распознаётся (по метке с окошком)', () => {
    const corners: Pt[] = [[1500, 2060], [120, 2010], [80, 110], [1460, 140]];
    const { img } = photograph(tpl, 1600, 2160, corners, 5);
    const res = processSheet(img, chars);
    const { bad } = check(res);
    expect(bad.length, bad.join('\n')).toBeLessThanOrEqual(2);
  }, 60000);

  it('без меток — понятная ошибка; ручные углы — работают', () => {
    const blank: Gray = { w: 400, h: 560, d: new Uint8Array(400 * 560).fill(230) };
    expect(findMarkers(blank)).toBeNull();
    expect(() => processSheet(blank, chars)).toThrow(MarkersNotFound);
    const corners: Pt[] = [[140, 120], [1480, 170], [1520, 2050], [90, 2000]];
    const { img, Hp } = photograph(tpl, 1600, 2160, corners, 7);
    const manual = TPL.markers.map((m) => applyH(Hp, m));
    const res = processSheet(img, chars, { corners: manual });
    expect(check(res).bad.length).toBeLessThanOrEqual(2);
  }, 60000);
});
