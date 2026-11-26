// Телефон: проверка без чернил и продолжение после обрыва.
import type { MachineProfile } from '../core/gcode';
import { buildResume } from '../grbl/controller';
import { limitLine } from './limit';

const cmdLines = (s: string) => s.split('\n').map((x) => x.trim()).filter(Boolean);

/** Проверка без чернил: та же программа, но ручка ни разу не опускается и нет пауз смены листа. */
export function dryRunLines(lines: string[], prof: MachineProfile): string[] {
  const down = new Set(cmdLines(prof.penDown));
  const up = new Set(cmdLines(prof.penUp));
  const out: string[] = [];
  for (const l of lines) {
    const t = l.trim();
    if (down.has(t) && !up.has(t)) continue;
    if (/^M0?[01]\b/i.test(t)) continue;
    if (/^G4\b/i.test(t)) continue; // выдержки после опускания не нужны
    out.push(l);
  }
  return out;
}

/**
 * Продолжить после обрыва. «ok» от GRBL значит «принято в буфер», а не «нарисовано»: в буфере
 * планировщика могло остаться до ~16 движений. Поэтому отступаем назад на запас строк и ещё до
 * ближайшего подъёма ручки — штрих перерисуется целиком поверх уже написанного.
 */
export function resumePlan(lines: string[], lastAcked: number, prof: MachineProfile, backoff = 20) {
  const up = new Set(cmdLines(prof.penUp));
  let i = Math.min(lastAcked, lines.length - 1) - backoff;
  while (i >= 0 && !up.has(lines[i].trim())) i--;
  // i — строка «ручка вверх» (или −1 = с начала); с неё и продолжаем
  if (i < 0) return { lines, headLen: 0, from: 0 };
  const r = buildResume(lines, i, prof.penUp, prof.penDown);
  const headLen = r.lines.length - (lines.length - (i + 1));
  return { lines: r.lines.map((l) => limitLine(l)), headLen, from: i + 1 };
}
