import { describe, expect, it } from 'vitest';
import { builtinFonts, exportFont, importFont, missingChars, parseGlyph } from '../core/font';
import { RU_LOWER, RU_UPPER, KY_EXTRA, EN_LOWER, EN_UPPER, DIGITS, PUNCT } from '../core/fontData';
import { defaultTextOptions, layoutText } from '../core/layout';
import { hyphenPoints } from '../core/hyphen';
import { optimizePaths, travelLength } from '../core/optimize';
import { defaultProfile, estimateJob, generateGcode, outOfBounds, toMachine } from '../core/gcode';
import { compileExpr } from '../core/expr';
import { carveMaze, maze, sudokuGrid, GENERATORS, runGenerator } from '../core/generators';
import { simplify, clipPath, dashPath, type Path } from '../core/geometry';
import { mulberry32 } from '../core/rng';

const font = builtinFonts()[0];
const A4 = { w: 210, h: 297 };

describe('шрифт', () => {
  it('содержит весь русский, кыргызский и английский алфавит, цифры и знаки', () => {
    const all = RU_UPPER + RU_LOWER + KY_EXTRA + EN_UPPER + EN_LOWER + DIGITS + PUNCT;
    expect(missingChars(all, font)).toEqual([]);
  });
  it('каждый глиф (кроме пробела) имеет штрихи с конечными координатами', () => {
    for (const [ch, g] of Object.entries(font.glyphs)) {
      if (ch === ' ') continue;
      const v = g.variants[0];
      expect(v.strokes.length, ch).toBeGreaterThan(0);
      for (const s of v.strokes) for (const [x, y] of s) {
        expect(Number.isFinite(x) && Number.isFinite(y), ch).toBe(true);
        expect(y, ch).toBeGreaterThan(-4);
        expect(y, ch).toBeLessThan(13.5);
      }
    }
  });
  it('разбирает дуги', () => {
    const s = parseGlyph('a(0,0,1,1,0,180)');
    expect(s[0][0][0]).toBeCloseTo(1);
    expect(s[0][s[0].length - 1][0]).toBeCloseTo(-1);
  });
  it('экспорт и импорт .kfont сохраняют буквы', () => {
    const f2 = importFont(JSON.parse(JSON.stringify(exportFont(font))));
    expect(Object.keys(f2.glyphs).length).toBe(Object.keys(font.glyphs).length);
    const a = font.glyphs['Ж'].variants[0].strokes[0][0], b = f2.glyphs['Ж'].variants[0].strokes[0][0];
    expect(b[0]).toBeCloseTo(a[0], 1);
  });
  it('импорт мусора даёт понятную ошибку', () => {
    expect(() => importFont({ foo: 1 })).toThrow(/glyphs/);
  });
});

describe('перенос', () => {
  it('ставит переносы в русских словах', () => {
    const pts = hyphenPoints('программа');
    expect(pts.length).toBeGreaterThan(0);
    for (const p of pts) { expect(p).toBeGreaterThanOrEqual(2); expect(p).toBeLessThanOrEqual(7); }
  });
  it('не отрывает ь и й', () => {
    for (const p of hyphenPoints('большой')) expect('ьй').not.toContain([...'большой'][p]);
  });
  it('не переносит короткие слова', () => expect(hyphenPoints('дом')).toEqual([]));
});

describe('раскладка', () => {
  it('всё внутри полей листа', () => {
    const text = 'Съешь же ещё этих мягких французских булок, да выпей чаю. '.repeat(40);
    const r = layoutText(text, font, { ...defaultTextOptions, accuracy: 10 }, A4);
    expect(r.pages.length).toBeGreaterThan(1);
    const m = defaultTextOptions.margins;
    for (const pg of r.pages) for (const p of pg.paths) for (const [x, y] of p.points) {
      expect(x).toBeGreaterThanOrEqual(m.left - 0.5);
      expect(x).toBeLessThanOrEqual(A4.w - m.right + 0.5);
      expect(y).toBeGreaterThanOrEqual(m.top - 2);
      expect(y).toBeLessThanOrEqual(A4.h - m.bottom + 3);
    }
  });
  it('один и тот же seed — одинаковый результат, другой — другой', () => {
    const o = { ...defaultTextOptions, accuracy: 3 };
    const a = layoutText('Привет, мир', font, o, A4);
    const b = layoutText('Привет, мир', font, o, A4);
    const c = layoutText('Привет, мир', font, { ...o, seed: 2 }, A4);
    expect(JSON.stringify(a.pages)).toBe(JSON.stringify(b.pages));
    expect(JSON.stringify(a.pages)).not.toBe(JSON.stringify(c.pages));
  });
  it('сообщает об отсутствующих символах', () => {
    const r = layoutText('漢字 ok', font, defaultTextOptions, A4);
    expect(r.missing).toEqual(['漢', '字']);
  });
  it('пустой текст — один пустой лист', () => {
    const r = layoutText('', font, defaultTextOptions, A4);
    expect(r.pages.length).toBe(1);
  });
  it('кыргызский текст раскладывается без пропусков', () => {
    const r = layoutText('Кыргызстан — көңүлдүү өлкө. Үй, Өмүр, Ңң', font, defaultTextOptions, A4);
    expect(r.missing).toEqual([]);
  });
});

describe('оптимизация', () => {
  const rnd = mulberry32(5);
  const paths: Path[] = Array.from({ length: 300 }, () => {
    const x = rnd() * 150, y = rnd() * 200;
    return { points: [[x, y], [x + rnd() * 5, y + rnd() * 5]] };
  });
  it('не теряет пути и сокращает холостой ход', () => {
    const { paths: out, report } = optimizePaths(paths, { merge: false, mergeTol: 0.1, reorder: true, twoOpt: true, timeBudgetMs: 200, simplifyTol: 0 });
    expect(out.length).toBe(paths.length);
    expect(report.travelAfter).toBeLessThan(report.travelBefore * 0.5);
    const key = (p: Path) => [p.points[0], p.points[1]].map((q) => q.join(',')).sort().join('|');
    expect(new Set(out.map(key))).toEqual(new Set(paths.map(key)));
  });
  it('склеивает соседние пути', () => {
    const r = optimizePaths([{ points: [[0, 0], [1, 0]] }, { points: [[1, 0], [2, 0]] }], { merge: true, mergeTol: 0.1, reorder: false, twoOpt: false, timeBudgetMs: 0, simplifyTol: 0 });
    expect(r.paths.length).toBe(1);
  });
  it('группы (слова) сохраняют порядок', () => {
    const ps: Path[] = [{ points: [[100, 0], [101, 0]] }, { points: [[0, 0], [1, 0]] }];
    const r = optimizePaths(ps, { merge: false, mergeTol: 0.1, reorder: true, twoOpt: true, timeBudgetMs: 10, simplifyTol: 0 }, [0, 0], [0, 1]);
    expect(r.paths[0].points[0][0]).toBeGreaterThanOrEqual(100);
    expect(travelLength(r.paths)).toBeGreaterThan(0);
  });
});

describe('G-код', () => {
  const prof = defaultProfile();
  it('шапка, переезды, ручка и конец программы', () => {
    const g = generateGcode({ sections: [{ paths: [{ points: [[10, 10], [20, 10]] }] }], sheetH: 297 }, prof);
    expect(g).toContain('G21');
    expect(g).toContain('G90');
    expect(g).toContain('G0 X10 Y-10');
    expect(g.some((l) => l === `G1 X20 Y-10 F${prof.drawSpeed}`)).toBe(true);
    expect(g.filter((l) => l === prof.penDown).length).toBe(1);
    expect(g[g.length - 1]).toBe('M2');
  });
  it('пауза M0 между листами с сообщением', () => {
    const g = generateGcode({ sections: [{ paths: [{ points: [[1, 1], [2, 2]] }] }, { paths: [{ points: [[1, 1], [2, 2]] }], pauseMessage: 'Положите лист 2' }], sheetH: 297 }, prof);
    const i = g.indexOf('M0');
    expect(i).toBeGreaterThan(0);
    expect(g[i - 1]).toContain('Положите лист 2');
  });
  it('проверка рабочего поля', () => {
    const inside: Path = { points: [[10, 10], [100, 100]] };
    const outside: Path = { points: [[10, 10], [300, 10]] };
    expect(outOfBounds([inside, outside], prof, 297)).toEqual([1]);
  });
  it('оси: инверсия и перестановка', () => {
    expect(toMachine([5, 7], { ...prof, invertY: false }, 297)).toEqual([5, 7]);
    expect(toMachine([5, 7], { ...prof, invertY: false, swapXY: true }, 297)).toEqual([7, 5]);
    expect(toMachine([5, 7], { ...prof, origin: 'bottom-left', invertY: false }, 297)).toEqual([5, 290]);
  });
  it('время письма разумное', () => {
    const st = estimateJob([{ points: [[0, 0], [100, 0]] }], prof);
    expect(st.drawLength).toBeCloseTo(100);
    expect(st.seconds).toBeGreaterThan(2); // 100 мм при 50 мм/с ≥ 2 с
    expect(st.seconds).toBeLessThan(10);
  });
});

describe('выражения', () => {
  it('считает формулы', () => {
    expect(compileExpr('2x^2 + 3')({ x: 2 })).toBe(11);
    expect(compileExpr('sin(pi/2)')({ x: 0 })).toBeCloseTo(1);
    expect(compileExpr('sqrt(x)*-1')({ x: 9 })).toBe(-3);
    expect(compileExpr('(x+1)(x-1)')({ x: 3 })).toBe(8);
    expect(compileExpr('2^3^2')({ x: 0 })).toBe(512);
  });
  it('ошибки понятны', () => {
    expect(() => compileExpr('2+')).toThrow();
    expect(() => compileExpr('alert(1)')).toThrow(/Неизвестное/);
  });
});

describe('генераторы', () => {
  it('лабиринт — связное дерево (у DFS/Прима/Краскала/Уилсона)', () => {
    for (const algo of ['dfs', 'prim', 'kruskal', 'wilson'] as const) {
      const cols = 12, rows = 9;
      const open = carveMaze(cols, rows, algo, mulberry32(3));
      let edges = 0;
      for (let i = 0; i < open.length; i++) { if (open[i] & 2) edges++; if (open[i] & 4) edges++; }
      expect(edges, algo).toBe(cols * rows - 1);
    }
    expect(maze({ cols: 10, rows: 10, cell: 5, algo: 'dfs', seed: 1, solution: true, shape: 'square' }).some((p) => p.layer === 'Решение')).toBe(true);
  });
  it('судоку: единственное решение и правильный ответ', () => {
    const { puzzle, solution } = sudokuGrid(7, 30);
    expect(puzzle.filter(Boolean).length).toBeGreaterThanOrEqual(30);
    for (let r = 0; r < 9; r++) expect(new Set(solution.slice(r * 9, r * 9 + 9)).size).toBe(9);
    puzzle.forEach((v, i) => { if (v) expect(v).toBe(solution[i]); });
  });
  it('все генераторы работают с настройками по умолчанию', () => {
    for (const g of GENERATORS) {
      const paths = runGenerator(g.kind, g.defaults, font, A4);
      expect(paths.length, g.kind).toBeGreaterThan(0);
      for (const p of paths) for (const [x, y] of p.points) expect(Number.isFinite(x) && Number.isFinite(y), g.kind).toBe(true);
    }
  });
});

describe('геометрия', () => {
  it('упрощение сохраняет концы', () => {
    const pts = Array.from({ length: 100 }, (_, i) => [i, 0] as [number, number]);
    expect(simplify(pts, 0.01)).toEqual([[0, 0], [99, 0]]);
  });
  it('обрезка по полю', () => {
    const parts = clipPath([[-10, 5], [20, 5]], { minX: 0, minY: 0, maxX: 10, maxY: 10 });
    expect(parts).toEqual([[[0, 5], [10, 5]]]);
  });
  it('пунктир', () => {
    const d = dashPath([[0, 0], [10, 0]], [2, 1]);
    expect(d.length).toBe(4);
  });
});

describe('обвести границы', () => {
  it('ручка поднята, машина объезжает рамку всех линий и возвращается', async () => {
    const { boundsGcode, jobBounds, defaultProfile } = await import('../core/gcode');
    const prof = defaultProfile();
    const paths = [{ points: [[20, 30], [50, 30]] as [number, number][] }, { points: [[40, 80], [90, 60]] as [number, number][] }];
    expect(jobBounds(paths)).toEqual({ minX: 20, minY: 30, maxX: 90, maxY: 80 });
    const g = boundsGcode(paths, prof, 297);
    expect(g).toContain(prof.penUp.split('\n')[0]);
    expect(g).not.toContain(prof.penDown.split('\n')[0]);         // ручка ни разу не опускается
    const moves = g.filter((l) => l.startsWith('G1 X'));
    expect(moves.length).toBe(5);                                  // 4 угла + замыкание
    expect(moves[0]).toMatch(/^G1 X20 Y-30 /);
    expect(moves[2]).toMatch(/^G1 X90 Y-80 /);
    expect(g[g.length - 2]).toBe('G0 X0 Y0');
    expect(boundsGcode([], prof, 297)).toEqual([]);
  });
});

describe('скорость ручки', () => {
  it('меняет F в командах Z и учитывает ход ручки во времени', async () => {
    const g = await import('../core/gcode');
    const prof = g.defaultProfile();
    expect(g.penFeed(prof)).toBe(600);
    expect(g.penTravelZ(prof)).toBeCloseTo(4.5);
    expect(g.penCycleTime(prof)).toBeCloseTo(0.9, 2);
    const fast = { ...prof, ...g.withPenFeed(prof, 1500) };
    expect(fast.penDown).toBe('G1 Z3 F1500');
    expect(fast.penUp).toBe('G1 Z-1.5 F1500');
    expect(g.penCycleTime(fast)).toBeCloseTo(0.36, 2);
    const paths = [{ points: [[0, 0], [5, 0]] as [number, number][] }, { points: [[10, 0], [15, 0]] as [number, number][] }] as any;
    const a = g.estimateJob(paths, prof), b = g.estimateJob(paths, fast);
    expect(a.penSeconds).toBeCloseTo(1.8, 2);
    expect(a.seconds - b.seconds).toBeCloseTo(1.8 - 0.72, 2);
    // G0 по Z превращается в G1 с подачей
    expect(g.withPenFeed({ ...prof, penUp: 'G0 Z5', penDown: 'G1 Z0 F1000' }, 2000).penUp).toBe('G1 Z5 F2000');
  });
});
