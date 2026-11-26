import { describe, expect, it } from 'vitest';
import { SimTransport } from '../grbl/transport';
import { GrblController, buildResume } from '../grbl/controller';
import { explainResponse, parseStatus } from '../grbl/codes';
import { defaultProfile, generateGcode } from '../core/gcode';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('разбор ответов GRBL', () => {
  it('статус', () => {
    const s = parseStatus('<Idle|MPos:1.000,2.000,0.000|FS:0,0|WCO:1.000,0.000,0.000>');
    expect(s?.state).toBe('Idle');
    expect(s?.wpos).toEqual([0, 2, 0]);
  });
  it('ошибки по-русски', () => {
    expect(explainResponse('error:9')).toMatch(/Разблокировать/);
    expect(explainResponse('ALARM:1')).toMatch(/концевик/i);
    expect(explainResponse('ok')).toBeNull();
  });
});

describe('симулятор + контроллер', () => {
  it('отвечает на $$ и $I', async () => {
    const sim = new SimTransport({ speed: 1000 });
    const c = new GrblController();
    await c.attach(sim);
    const r = await c.command('$I');
    expect(r.join('\n')).toMatch(/VER:1\.1/);
    await c.command('$$');
    expect(c.settings[110]).toBeDefined();
    await c.detach();
  });

  it('потоково пишет задание целиком и рисует ручкой', async () => {
    const sim = new SimTransport({ speed: 2000 });
    const prof = defaultProfile();
    const paths = Array.from({ length: 40 }, (_, i) => ({ points: [[10 + i, 10], [10 + i, 30], [12 + i, 30]] as [number, number][] }));
    const lines = generateGcode({ sections: [{ paths }], sheetH: 297 }, prof);
    let drawn = 0;
    sim.onMove((m) => { if (m.penDown) drawn += Math.hypot(m.to[0] - m.from[0], m.to[1] - m.from[1]); });
    const c = new GrblController();
    await c.attach(sim);
    c.stream(lines);
    for (let i = 0; i < 400 && c.progress?.running; i++) await wait(10);
    expect(c.progress?.running).toBe(false);
    expect(c.progress?.error).toBeUndefined();
    expect(c.progress?.acked).toBe(lines.length);
    await wait(100);
    expect(drawn).toBeGreaterThan(40 * 22 * 0.95);
    await c.detach();
  });

  it('пауза M0 ждёт «продолжить»', async () => {
    const sim = new SimTransport({ speed: 2000 });
    const prof = defaultProfile();
    const sec = { paths: [{ points: [[1, 1], [5, 5]] as [number, number][] }] };
    const lines = generateGcode({ sections: [sec, { ...sec, pauseMessage: 'Положите новый лист' }], sheetH: 297 }, prof);
    const c = new GrblController();
    await c.attach(sim);
    c.stream(lines);
    for (let i = 0; i < 100 && !c.progress?.paused; i++) await wait(10);
    expect(c.progress?.paused).toBe(true);
    expect(c.progress?.message).toBe('Положите новый лист');
    c.resume();
    for (let i = 0; i < 300 && c.progress?.running; i++) await wait(10);
    expect(c.progress?.running).toBe(false);
    expect(c.progress?.error).toBeUndefined();
    await c.detach();
  });

  it('обрыв связи запоминает строку, продолжение собирается правильно', async () => {
    const sim = new SimTransport({ speed: 1 });
    const prof = defaultProfile();
    const paths = Array.from({ length: 200 }, (_, i) => ({ points: [[i % 150, 10], [i % 150, 60]] as [number, number][] }));
    const lines = generateGcode({ sections: [{ paths }], sheetH: 297 }, prof);
    const c = new GrblController();
    await c.attach(sim);
    c.stream(lines);
    await wait(150);
    sim.unplug();
    expect(c.connected).toBe(false);
    expect(c.progress?.error).toMatch(/Связь потеряна/);
    const idx = c.lastAckedIndex;
    expect(idx).toBeGreaterThan(0);
    expect(idx).toBeLessThan(lines.length - 1);
    const res = buildResume(lines, idx, prof.penUp, prof.penDown);
    expect(res.lines.slice(0, 3)).toEqual(['G21', 'G90', prof.penUp]);
    expect(res.lines[3]).toMatch(/^G0 X/);
    expect(res.lines[res.lines.length - 1]).toBe(lines[lines.length - 1]);
    expect(res.lines.length).toBeLessThanOrEqual(lines.length - idx - 1 + 6);
  });

  it('СТОП — мягкий сброс, задание прекращается', async () => {
    const sim = new SimTransport({ speed: 1 });
    const prof = defaultProfile();
    const lines = generateGcode({ sections: [{ paths: [{ points: [[0, 0], [150, 0], [150, 150]] }] }] , sheetH: 297 }, prof);
    const c = new GrblController();
    await c.attach(sim);
    c.stream(lines);
    await wait(50);
    await c.stop(prof.penUp);
    expect(c.progress?.running).toBe(false);
    expect(c.progress?.error).toMatch(/Остановлено/);
    await c.detach();
  });
});
