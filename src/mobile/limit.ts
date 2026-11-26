// Телефонная версия: жёсткий предел скорости. Ни одна команда не уходит на машину быстрее MAX_F.
import { defaultProfile, penFeed, withPenFeed, type MachineProfile } from '../core/gcode';
import type { Transport } from '../grbl/transport';

export const MAX_F = 2000; // мм/мин (по просьбе пользователя; было 600)

/**
 * Привести строку G-кода к пределу скорости:
 * F больше предела → F{max}; G0 (ускоренный ход, идёт на максимуме платы) → G1 с F{max};
 * $J=… без F или с большим F → F{max}.
 */
export function limitLine(line: string, max = MAX_F): string {
  const code = line.replace(/;.*$/, '').replace(/\(.*?\)/g, '');
  if (!code.trim()) return line;
  let s = line.replace(/F\s*(\d*\.?\d+)/gi, (m, v) => (parseFloat(v) > max ? `F${max}` : m));
  const isJog = /^\s*\$J=/i.test(s);
  // G0 / G00 → G1 (только как отдельное слово)
  if (!isJog && /(^|[^0-9.])G0?0(?![0-9.])/i.test(code)) {
    s = s.replace(/(^|[^0-9.])G0?0(?![0-9.])/gi, '$1G1');
    if (!/F\s*\d/i.test(s.replace(/;.*$/, ''))) s = addF(s, max);
  }
  if (isJog && !/F\s*\d/i.test(s)) s = addF(s, max);
  return s;
}

function addF(s: string, max: number) {
  const i = s.indexOf(';');
  return i < 0 ? `${s.trimEnd()} F${max}` : `${s.slice(0, i).trimEnd()} F${max} ${s.slice(i)}`;
}

/** Профиль машины для телефона: настройки GUANGKU, все скорости ≤ предела, переезды через G1. */
export function mobileProfile(speed: number, swapPen: boolean): MachineProfile {
  const base = defaultProfile();
  const v = Math.max(50, Math.min(MAX_F, Math.round(speed)));
  let p: MachineProfile = { ...base, drawSpeed: v, travelSpeed: v, useG0ForTravel: false, workW: 210, workH: 300, offsetX: 0, offsetY: 0 };
  if (swapPen) p = { ...p, penUp: base.penDown, penDown: base.penUp };
  return { ...p, ...withPenFeed(p, Math.min(MAX_F, penFeed(p) ?? MAX_F)) };
}

/**
 * Страховка на уровне порта: даже если где-то проскочит быстрая команда, F срезается.
 * Здесь только замены той же или меньшей длины — иначе собьётся подсчёт буфера GRBL.
 */
export function limitedTransport(t: Transport, max = MAX_F): Transport {
  const clamp = (text: string) => text.replace(/F(\d*\.?\d+)/gi, (m, v) => {
    if (parseFloat(v) <= max) return m;
    const r = `F${max}`;
    return r.length <= m.length ? r : m;
  });
  return {
    kind: t.kind,
    write: (text) => t.write(clamp(text)),
    writeByte: (b) => t.writeByte(b),
    onLine: (cb) => t.onLine(cb),
    onClose: (cb) => t.onClose(cb),
    close: () => t.close(),
  };
}
