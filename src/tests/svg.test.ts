import { describe, expect, it } from 'vitest';
import { parsePathD, parseSvg, parseTransform } from '../core/svgparse';

const near = (a: number, b: number, tol = 0.05) => Math.abs(a - b) < tol;

describe('разбор SVG', () => {
  it('единицы и viewBox: квадрат 100×100 в листе 100 мм', () => {
    const r = parseSvg('<svg width="100mm" height="100mm" viewBox="0 0 1000 1000"><rect x="100" y="200" width="300" height="400"/></svg>');
    const xs = r.paths[0].points.map((p) => p[0]), ys = r.paths[0].points.map((p) => p[1]);
    expect(Math.min(...xs)).toBeCloseTo(10); expect(Math.max(...xs)).toBeCloseTo(40);
    expect(Math.min(...ys)).toBeCloseTo(20); expect(Math.max(...ys)).toBeCloseTo(60);
  });
  it('команды пути: относительные, H V, Z, неявный L после M', () => {
    const p = parsePathD('m10 10 20 0 v20 h-20 z M50 50 L60 60 70 50', 1);
    expect(p.length).toBe(2);
    expect(p[0]).toEqual([[10, 10], [30, 10], [30, 30], [10, 30], [10, 10]]);
    expect(p[1][p[1].length - 1]).toEqual([70, 50]);
  });
  it('кривые и дуги проходят через правильные точки', () => {
    const c = parsePathD('M0 0 C0 10 10 10 10 0', 0.5)[0];
    const mid = c[Math.floor(c.length / 2)];
    expect(near(mid[1], 7.5, 0.6)).toBe(true); // высота кубической кривой посередине = 7,5
    const a = parsePathD('M0 0 A10 10 0 0 1 20 0', 0.5)[0];
    expect(Math.min(...a.map((p) => p[1]))).toBeCloseTo(-10, 0); // полукруг радиусом 10 вверх
    expect(a[a.length - 1][0]).toBeCloseTo(20);
  });
  it('трансформации вложенных групп', () => {
    const m = parseTransform('translate(10 20) scale(2)');
    expect(m).toEqual([2, 0, 0, 2, 10, 20]);
    const r = parseSvg('<svg width="10mm" height="10mm" viewBox="0 0 10 10"><g transform="translate(5 0)"><g transform="rotate(90)"><line x1="0" y1="0" x2="2" y2="0"/></g></g></svg>');
    const [a, b] = r.paths[0].points;
    expect(a).toEqual([5, 0]);
    expect(near(b[0], 5) && near(b[1], 2)).toBe(true);
  });
  it('скрытое и служебное не рисуется', () => {
    const r = parseSvg('<svg width="10mm" height="10mm" viewBox="0 0 10 10"><defs><path d="M0 0 L5 5"/></defs><g style="display:none"><line x1="0" y1="0" x2="1" y2="1"/></g><circle cx="5" cy="5" r="2"/></svg>');
    expect(r.paths.length).toBe(1);
  });
  it('большой SVG (~300 КБ кривых) разбирается быстро', () => {
    let s = 7;
    const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
    const paths: string[] = [];
    for (let p = 0; p < 55; p++) {
      let d = `M${(rnd() * 500).toFixed(2)} ${(rnd() * 700).toFixed(2)}`;
      for (let i = 0; i < 160; i++) d += ` c${[0, 0, 0, 0, 0, 0].map(() => (rnd() * 20 - 10).toFixed(2)).join(' ')}`;
      paths.push(`<path d="${d}" fill="none" stroke="#000"/>`);
    }
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="210mm" height="297mm" viewBox="0 0 600 800"><g transform="translate(10 20) scale(0.9)">${paths.join('')}</g></svg>`;
    expect(svg.length).toBeGreaterThan(290_000); // в 3 раза больше файла, на котором зависал старый импорт
    const t0 = performance.now();
    const r = parseSvg(svg);
    const ms = performance.now() - t0;
    expect(r.paths.length).toBe(55);
    expect(ms).toBeLessThan(1500);
  });
});
