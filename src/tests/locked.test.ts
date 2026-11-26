import { afterEach, describe, expect, it } from 'vitest';
import { GrblController } from '../grbl/controller';
import { defaultProfile, generateGcode, guangkuProfile } from '../core/gcode';
import { limitLine } from '../mobile/limit';
import type { Transport } from '../grbl/transport';

const feeds = (l: string) => [...l.matchAll(/F\s*(\d*\.?\d+)/gi)].map((m) => parseFloat(m[1]));

describe('публичная версия: скорость 2000 на уровне контроллера', () => {
  afterEach(() => { GrblController.lineFilter = null; GrblController.blockedRealtime.clear(); });

  it('всё, что уходит в порт, не быстрее 2000 и без G0; «скорость +» не отправляется', async () => {
    GrblController.lineFilter = (l) => limitLine(l, 2000);
    GrblController.blockedRealtime.add(0x91);
    const sent: string[] = [];
    let onLine: (l: string) => void = () => {};
    const t: Transport = {
      kind: 'sim',
      write: async (s) => { sent.push(s); for (const _ of s.split('\n').filter(Boolean)) setTimeout(() => onLine('ok'), 0); },
      writeByte: async (b) => { sent.push('#' + b); },
      onLine: (cb) => { onLine = cb; }, onClose: () => {}, close: async () => {},
    };
    const c = new GrblController();
    c.transport = t; // без рукопожатия
    t.onLine((l) => (c as unknown as { onLine(l: string): void }).onLine(l));
    const prof = { ...defaultProfile(), ...guangkuProfile(), drawSpeed: 8000, travelSpeed: 15000, useG0ForTravel: true };
    const lines = generateGcode({ sections: [{ paths: [{ points: [[10, 10], [50, 10]] }, { points: [[60, 60], [70, 70]] }] }], sheetH: 297 }, prof);
    expect(lines.some((l) => /^G0 /.test(l))).toBe(true);
    c.stream(lines);
    await c.command('$J=G91 X10 F9000');
    await c.realtime(0x91);
    await new Promise((r) => setTimeout(r, 50));
    const text = sent.join('');
    expect(text).not.toMatch(/(^|\n)G0 /);
    for (const f of feeds(text)) expect(f).toBeLessThanOrEqual(2000);
    expect(sent).not.toContain('#145');
  });
});
