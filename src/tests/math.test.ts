import { describe, expect, it } from 'vitest';
import { formulaPaths, parseMath, MathError } from '../core/math';

export const bbox = (f: ReturnType<typeof formulaPaths>) => {
  const xs = f.paths.flatMap((p) => p.points.map((q) => q[0])), ys = f.paths.flatMap((p) => p.points.map((q) => q[1]));
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
};

describe('формулы', () => {
  it('разбирает типичные школьные и вузовские формулы', () => {
    const ok = [
      'x^2 + y^2 = r^2',
      '\\frac{a+b}{c}',
      'x_{1,2} = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}',
      '\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}',
      '\\int_0^1 x^2\\,dx = \\frac{1}{3}',
      '\\lim_{x \\to 0} \\frac{\\sin x}{x} = 1',
      '\\sqrt[3]{8} = 2',
      '\\left( \\frac{a}{b} \\right)^2',
      'E = mc^2',
      '\\alpha + \\beta \\ne \\gamma, \\quad \\Delta = \\pi r^2',
      '\\vec{F} = m\\vec{a}',
      '\\text{Ответ: } x \\ge 5',
      'a^2 + b^2 = c^2 \\\\ \\sin^2 x + \\cos^2 x = 1',
      '\\oint_C \\vec{E} \\cdot d\\vec{l} = 0',
    ];
    for (const s of ok) {
      const f = formulaPaths(s, 5);
      expect(f.paths.length, s).toBeGreaterThan(0);
      expect(f.w, s).toBeGreaterThan(0);
      for (const p of f.paths) for (const [x, y] of p.points) expect(Number.isFinite(x) && Number.isFinite(y), s).toBe(true);
    }
  });

  it('понятные ошибки', () => {
    expect(() => parseMath('\\frac{a}{b')).toThrow(MathError);
    expect(() => parseMath('\\foo')).toThrow(/Неизвестная команда/);
    expect(() => parseMath('x^')).toThrow();
    expect(() => parseMath('a}')).toThrow(/Лишняя/);
    expect(() => parseMath('\\left( x')).toThrow(/right/);
    expect(() => parseMath('x^2^3')).toThrow(/Два верхних/);
  });

  it('дробь выше одной строки, числитель над знаменателем', () => {
    const line = formulaPaths('ab', 5), frac = formulaPaths('\\frac{a}{b}', 5);
    expect(frac.h).toBeGreaterThan(line.h * 1.6);
    // числитель «a» — над чертой, знаменатель «b» — под ней
    const parts = formulaPaths('\\frac{1}{2}', 5);
    const bar = parts.paths.find((p) => p.points.length === 2 && Math.abs(p.points[0][1] - p.points[1][1]) < 1e-9)!;
    const barY = bar.points[0][1];
    const others = parts.paths.filter((p) => p !== bar);
    expect(others.some((p) => p.points.every(([, y]) => y < barY))).toBe(true);
    expect(others.some((p) => p.points.every(([, y]) => y > barY))).toBe(true);
  });

  it('верхний индекс меньше и выше основания', () => {
    const xw = formulaPaths('x', 5).w;
    const f = formulaPaths('x^2', 5);
    const base = f.paths.filter((p) => p.points.every(([x]) => x < xw * 0.95));
    const sup = f.paths.filter((p) => p.points.every(([x]) => x > xw * 0.9));
    const top = (ps: typeof f.paths) => Math.min(...ps.flatMap((p) => p.points.map((q) => q[1])));
    const bot = (ps: typeof f.paths) => Math.max(...ps.flatMap((p) => p.points.map((q) => q[1])));
    expect(base.length).toBeGreaterThan(0);
    expect(sup.length).toBeGreaterThan(0);
    expect(top(sup)).toBeLessThan(top(base));          // выше (ось Y вниз)
    expect(bot(sup)).toBeLessThan(bot(base) - 1);      // низ индекса выше строки
    expect(bot(sup) - top(sup)).toBeLessThan(5 * 0.8); // меньше заглавной 5 мм
  });


  it('скобки \\left \\right растут вместе с содержимым', () => {
    const small = formulaPaths('\\left( x \\right)', 5), big = formulaPaths('\\left( \\frac{1}{x} \\right)', 5);
    expect(big.h).toBeGreaterThan(small.h * 1.5);
  });

  it('размер масштабирует формулу', () => {
    const a = formulaPaths('\\sum_{k=1}^{n} k^2', 4), b = formulaPaths('\\sum_{k=1}^{n} k^2', 8);
    expect(b.w / a.w).toBeCloseTo(2, 1);
  });
});
