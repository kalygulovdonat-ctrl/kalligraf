import { describe, expect, it } from 'vitest';
import { MAX_F, limitLine, limitedTransport, mobileProfile } from '../mobile/limit';
import { generateGcode } from '../core/gcode';
import type { Transport } from '../grbl/transport';

const feeds = (l: string) => [...l.matchAll(/F\s*(\d*\.?\d+)/gi)].map((m) => parseFloat(m[1]));

describe('телефон: предел скорости 2000', () => {
  it('срезает F и превращает G0 в G1 F2000', () => {
    expect(limitLine('G1 X10 Y5 F8000')).toBe('G1 X10 Y5 F2000');
    expect(limitLine('G1 X10 F300')).toBe('G1 X10 F300');
    expect(limitLine('G0 X0 Y0')).toBe('G1 X0 Y0 F2000');
    expect(limitLine('G00 X1')).toBe('G1 X1 F2000');
    expect(limitLine('G0 X1 F2500')).toBe('G1 X1 F2000');
    expect(limitLine('$J=G91 G21 X10')).toBe('$J=G91 G21 X10 F2000');
    expect(limitLine('$J=G91 X10 F15000')).toBe('$J=G91 X10 F2000');
    // G10, G20, G90 не трогаем
    expect(limitLine('G10 L20 P1 X0 Y0')).toBe('G10 L20 P1 X0 Y0');
    expect(limitLine('G90 G1 X0 Y0 F600')).toBe('G90 G1 X0 Y0 F600');
    expect(limitLine('; комментарий G0 F9000')).toBe('; комментарий G0 F9000');
  });

  it('весь G-код задания не быстрее 2000 и без G0', () => {
    const prof = mobileProfile(5000, false);
    expect(prof.drawSpeed).toBe(MAX_F);
    const lines = generateGcode({ sections: [{ paths: [{ points: [[10, 10], [20, 10]] }, { points: [[30, 30], [40, 35]] }] }, { paths: [{ points: [[5, 5], [6, 6]] }], pauseMessage: 'лист 2' }], sheetH: 297 }, prof).map((l) => limitLine(l));
    for (const l of lines) {
      const code = l.replace(/;.*$/, '');
      expect(/(^|[^0-9.])G0?0(?![0-9.])/i.test(code)).toBe(false);
      for (const f of feeds(code)) expect(f).toBeLessThanOrEqual(MAX_F);
    }
    // ручка на оси Z тоже не быстрее
    expect(feeds(prof.penUp)[0]).toBeLessThanOrEqual(MAX_F);
    expect(mobileProfile(300, false).drawSpeed).toBe(300);
  });

  it('страховка на порту срезает быструю подачу, не удлиняя строку', async () => {
    const sent: string[] = [];
    const t: Transport = { kind: 'sim', write: async (s) => { sent.push(s); }, writeByte: async () => {}, onLine: () => {}, onClose: () => {}, close: async () => {} };
    const lt = limitedTransport(t);
    await lt.write('G1 X5 F8000\n');
    await lt.write('G1 X5 F2500\n');
    await lt.write('G1 X5 F200\n');
    expect(sent).toEqual(['G1 X5 F2000\n', 'G1 X5 F2000\n', 'G1 X5 F200\n']);
  });
});
