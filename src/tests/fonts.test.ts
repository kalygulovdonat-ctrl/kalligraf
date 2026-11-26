import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { parseTtf } from '../core/ttf';
import { convertGlyph, rasterize } from '../core/fontconvert';
import { builtinFonts, missingChars } from '../core/font';
import { RU_LOWER, RU_UPPER } from '../core/fontData';
import { defaultProfile, generateGcode, guangkuProfile, PEN_PRESETS } from '../core/gcode';
import { SimTransport } from '../grbl/transport';
import { GrblController } from '../grbl/controller';

const load = (f: string) => { const b = readFileSync('fonts-src/' + f); return parseTtf(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); };
const FILES = ['badscript/BadScript-Regular.ttf', 'caveat/Caveat[wght].ttf', 'marckscript/MarckScript-Regular.ttf', 'neucha/Neucha.ttf', 'pangolin/Pangolin-Regular.ttf'];

describe('TTF → однолинейный шрифт', () => {
  it('разбирает все пять шрифтов, включая составные буквы (ё = е + точки)', () => {
    for (const f of FILES) {
      const t = load(f);
      expect(t.capHeight, f).toBeGreaterThan(0);
      expect(t.glyphIndex('Ж'.codePointAt(0)!), f).toBeGreaterThan(0);
      expect(t.contours(t.glyphIndex('ё'.codePointAt(0)!)).length, f).toBeGreaterThanOrEqual(3);
    }
  });

  it('заливка контура: квадрат 10×10 при 2 px/ед. ≈ 400 пикселей', () => {
    const r = rasterize([[[0, 0], [10, 0], [10, 10], [0, 10]]], 2, 0)!;
    const n = r.bin.reduce((s, v) => s + v, 0);
    expect(Math.abs(n - 400)).toBeLessThan(45);
    // дыра в «О»: внутренний контур в обратную сторону — не закрашивается
    const ring = rasterize([[[0, 0], [10, 0], [10, 10], [0, 10]], [[3, 3], [3, 7], [7, 7], [7, 3]]], 2, 0)!;
    expect(ring.bin.reduce((s, v) => s + v, 0)).toBeLessThan(n - 50);
  });

  it('буквы получаются одной линией нужной высоты, точки сохраняются', () => {
    for (const f of FILES) {
      const t = load(f);
      const H = convertGlyph(t, 'Н')!.variants[0];
      const ys = H.strokes.flat().map((p) => p[1]);
      expect(Math.max(...ys), f).toBeGreaterThan(8.5);   // заглавная ≈ 10 единиц
      expect(Math.max(...ys), f).toBeLessThan(11.5);
      expect(Math.min(...ys), f).toBeGreaterThan(-2.5); // у каллиграфических шрифтов бывают росчерки
      const yo = convertGlyph(t, 'ё')!.variants[0];
      expect(yo.strokes.length, f).toBeGreaterThanOrEqual(3); // буква + 2 точки
      // «О» — одна линия, а не двойной контур
      const O = convertGlyph(t, 'О')!.variants[0];
      expect(O.strokes.filter((s) => s.length > 3).length, f).toBeLessThanOrEqual(2);
    }
  });

  it('встроенные рукописные шрифты: полный русский алфавит', () => {
    const hw = builtinFonts().filter((f) => f.id.startsWith('hw-'));
    expect(hw.length).toBe(5);
    for (const f of hw) {
      expect(missingChars(RU_UPPER + RU_LOWER, f), f.name).toEqual([]);
      expect(Object.keys(f.glyphs).length, f.name).toBeGreaterThan(150);
    }
  });
});

describe('профиль GUANGKU (из программы друга)', () => {
  it('ручка наоборот: Z3 — пишет, Z−1,5 — поднята', () => {
    const p = { ...defaultProfile(), ...guangkuProfile() };
    expect(p.penDown).toBe(PEN_PRESETS.zinv.down);
    const g = generateGcode({ sections: [{ paths: [{ points: [[10, 10], [20, 10]] }] }], sheetH: 297 }, p);
    const iDown = g.indexOf('G1 Z3 F600'), iDraw = g.findIndex((l) => l.startsWith('G1 X20'));
    expect(iDown).toBeGreaterThan(0);
    expect(iDraw).toBeGreaterThan(iDown);
    // перед первым переездом ручка поднята (а не опущена, как была ошибка у друга)
    const iUp = g.indexOf('G1 Z-1.5 F600'), iTravel = g.findIndex((l) => l.startsWith('G0 X10'));
    expect(iUp).toBeGreaterThan(-1);
    expect(iUp).toBeLessThan(iTravel);
  });

  it('симулятор с обратной осью Z рисует только буквы, без линий переездов', async () => {
    const p = { ...defaultProfile(), ...guangkuProfile(), drawSpeed: 3000 };
    const sim = new SimTransport({ speed: 3000 });
    sim.zDownHigh = true;
    let drawn = 0;
    sim.onMove((m) => { if (m.penDown) drawn += Math.hypot(m.to[0] - m.from[0], m.to[1] - m.from[1]); });
    const c = new GrblController();
    await c.attach(sim);
    // два штриха по 10 мм, далеко друг от друга
    c.stream(generateGcode({ sections: [{ paths: [{ points: [[10, 10], [20, 10]] }, { points: [[100, 100], [110, 100]] }] }], sheetH: 297 }, p));
    for (let i = 0; i < 300 && c.progress?.running; i++) await new Promise((r) => setTimeout(r, 10));
    expect(drawn).toBeGreaterThan(19);
    expect(drawn).toBeLessThan(21); // переезды (~130 мм) не рисуются
    await c.detach();
  });
});
