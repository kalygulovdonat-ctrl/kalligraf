import { describe, expect, it } from 'vitest';
import jsQR from 'jsqr';
import { alignmentPositions, encodeQr, formatBits, qrPaths, rsRemainder, utf8Bytes, type Ecc } from '../core/qr';

/** Рисуем матрицу в картинку и читаем независимым декодером jsQR. */
function decode(text: string, ecc: Ecc = 'M') {
  const q = encodeQr(text, ecc);
  const s = 6, b = 4, n = (q.size + 2 * b) * s;
  const px = new Uint8ClampedArray(n * n * 4).fill(255);
  for (let y = 0; y < q.size; y++) for (let x = 0; x < q.size; x++) if (q.modules[y][x])
    for (let dy = 0; dy < s; dy++) for (let dx = 0; dx < s; dx++) {
      const i = (((y + b) * s + dy) * n + (x + b) * s + dx) * 4;
      px[i] = px[i + 1] = px[i + 2] = 0;
    }
  const r = jsQR(px, n, n);
  return { q, r };
}

describe('QR-код', () => {
  it('служебные вещи по стандарту', () => {
    expect(alignmentPositions(1)).toEqual([]);
    expect(alignmentPositions(7)).toEqual([6, 22, 38]);
    expect(alignmentPositions(32)).toEqual([6, 34, 60, 86, 112, 138]);
    expect(formatBits('M', 0)).toBe(0b101010000010010); // из таблицы стандарта
    expect(formatBits('L', 0)).toBe(0b111011111000100);
  });
  it('Рид–Соломон: пример из стандарта (версия 1-M, «01234567»)', () => {
    const data = [0x10, 0x20, 0x0c, 0x56, 0x61, 0x80, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11];
    // делитель степени 10 строится внутри; проверяем известный результат
    const ecc = rsRemainder(data, [216, 194, 159, 111, 199, 94, 95, 113, 157, 193]);
    expect(ecc).toEqual([0xa5, 0x24, 0xd4, 0xc1, 0xed, 0x36, 0xc7, 0x87, 0x2c, 0x55]);
  });
  const samples: [string, Ecc][] = [
    ['https://example.com', 'M'],
    ['Привет, мир! Каллиграф 2026', 'L'],
    ['Кыргызстан: Өмүр, үй, көңүл', 'Q'],
    ['WIFI:T:WPA;S:MyNet;P:secret123;;', 'H'],
    ['A'.repeat(300), 'M'],            // версия ≥ 10 (16-битная длина)
    ['Ж'.repeat(600), 'L'],            // версия ≥ 20, много блоков
  ];
  for (const [text, ecc] of samples) {
    it(`читается декодером: ${text.slice(0, 24)}… (${ecc})`, () => {
      const { q, r } = decode(text, ecc);
      expect(r, `версия ${q.version}`).not.toBeNull();
      expect(Array.from(r!.binaryData)).toEqual(utf8Bytes(text));
    });
  }
  it('уровень коррекции поднимается, если влезает', () => {
    expect(encodeQr('hi', 'L').ecc).toBe('H');
    expect(encodeQr('hi', 'L', false).ecc).toBe('L');
  });
  it('то, что нарисует ручка (линии 0,5 мм), читается декодером', () => {
    for (const [text, mod] of [['https://kalligraf.example/привет', 1.5], ['Каллиграф', 2]] as [string, number][]) {
      const q = encodeQr(text, 'M');
      const paths = qrPaths(q, { module: mod, pen: 0.5, border: 4, direction: 'h' });
      const ppm = 8, size = Math.ceil((q.size + 8) * mod * ppm);
      const px = new Uint8ClampedArray(size * size * 4).fill(255);
      const r = 0.25 * ppm; // половина толщины линии
      for (const pth of paths) {
        const [a, b] = pth.points.map(([x, y]) => [x * ppm, y * ppm]);
        for (let y = Math.floor(Math.min(a[1], b[1]) - r); y <= Math.ceil(Math.max(a[1], b[1]) + r); y++)
          for (let x = Math.floor(Math.min(a[0], b[0]) - r); x <= Math.ceil(Math.max(a[0], b[0]) + r); x++) {
            const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy;
            const t = L2 ? Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / L2)) : 0;
            if (Math.hypot(x - a[0] - t * dx, y - a[1] - t * dy) <= r && x >= 0 && y >= 0 && x < size && y < size) {
              const i = (y * size + x) * 4; px[i] = px[i + 1] = px[i + 2] = 20;
            }
          }
      }
      const res = jsQR(px, size, size);
      expect(res, text).not.toBeNull();
      expect(Array.from(res!.binaryData)).toEqual(utf8Bytes(text));
    }
  });
  it('штрихи ручки закрашивают только тёмные модули', () => {
    const q = encodeQr('test', 'M');
    const paths = qrPaths(q, { module: 2, pen: 0.5, border: 2, direction: 'h' });
    expect(paths.length).toBeGreaterThan(q.size);
    for (const p of paths) {
      const [a, b] = p.points;
      const r = Math.floor((a[1] - 4) / 2);
      for (const x of [a[0], (a[0] + b[0]) / 2, b[0]]) expect(q.modules[r][Math.floor((x - 4) / 2)]).toBe(true);
    }
  });
});
