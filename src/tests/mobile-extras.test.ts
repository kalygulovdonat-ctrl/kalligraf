import { describe, expect, it } from 'vitest';
import { generateGcode } from '../core/gcode';
import { dryRunLines, resumePlan } from '../mobile/jobs';
import { MAX_F, limitLine, mobileProfile } from '../mobile/limit';
import { appendSpoken, cleanOcr } from '../mobile/native';

const prof = mobileProfile(MAX_F, false);
const job = () => generateGcode({
  sections: [
    { paths: Array.from({ length: 30 }, (_, i) => ({ points: [[10 + i, 10], [10 + i, 20]] as [number, number][] })) },
    { paths: [{ points: [[5, 5], [6, 6]] }], pauseMessage: 'лист 2' },
  ], sheetH: 205,
}, prof).map((l) => limitLine(l));

describe('телефон: проверка и продолжение', () => {
  it('проверка без чернил не опускает ручку и не ждёт смены листа', () => {
    const down = prof.penDown.trim();
    const lines = job();
    expect(lines).toContain(down);
    const dry = dryRunLines(lines, prof);
    expect(dry).not.toContain(down);
    expect(dry.some((l) => /^M0\b/.test(l))).toBe(false);
    expect(dry.some((l) => /^G1 X/.test(l))).toBe(true);
  });

  it('продолжение начинается с поднятой ручки и с запасом назад', () => {
    const lines = job();
    const plan = resumePlan(lines, 80, prof);
    expect(plan.from).toBeLessThanOrEqual(80 - 20 + 1);
    expect(plan.lines[plan.headLen - 1]).toMatch(/^G1 X.* F\d+/); // переезд к точке (G0 → G1)
    expect(plan.lines.slice(0, plan.headLen)).not.toContain(prof.penDown.trim());
    expect(plan.lines.slice(plan.headLen)).toEqual(lines.slice(plan.from));
    // в самом начале — просто с начала
    expect(resumePlan(lines, 5, prof).from).toBe(0);
  });
});

describe('телефон: голос и фото', () => {
  it('приклеивает продиктованное предложение', () => {
    expect(appendSpoken('', 'привет мир')).toBe('Привет мир.');
    expect(appendSpoken('Раз.', 'два')).toBe('Раз. Два.');
    expect(appendSpoken('Раз', 'два?')).toBe('Раз. Два?');
  });
  it('склеивает строки абзаца и переносы', () => {
    expect(cleanOcr('Машина пи-\nшет текст\nручкой.\n\nВторой абзац.\n')).toBe('Машина пишет текст ручкой.\nВторой абзац.');
  });
});
