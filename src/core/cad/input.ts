// Ввод координат с клавиатуры, как в AutoCAD.
// Для пользователя начало координат — левый нижний угол листа, ось Y вверх, углы — против часовой стрелки.
//   10,20        — абсолютная точка          @10,5      — относительно предыдущей точки
//   @50<30       — 50 мм под углом 30°       50<30      — от начала координат
//   50           — число (длина по направлению курсора, радиус, угол, количество…)
//   10,5;20      — если дробная часть через запятую, координаты разделяются «;»
import type { Pt } from '../geometry';

export type Parsed =
  | { kind: 'point'; p: Pt }       // в координатах листа
  | { kind: 'number'; v: number }
  | { kind: 'word'; s: string }
  | { kind: 'error'; msg: string };

export const toUser = (p: Pt, H: number): Pt => [p[0], H - p[1]];
export const fromUser = (p: Pt, H: number): Pt => [p[0], H - p[1]];

const toNum = (s: string) => {
  const v = Number(s.trim().replace(',', '.'));
  return Number.isFinite(v) && s.trim() !== '' ? v : NaN;
};

export function parseInput(raw: string, last: Pt | null, H: number): Parsed {
  const s = raw.trim().replace(/\s+/g, '');
  if (!s) return { kind: 'error', msg: 'Пусто' };
  const rel = s.startsWith('@');
  const body = rel ? s.slice(1) : s;
  if (rel && !last) return { kind: 'error', msg: 'Нет предыдущей точки для «@»' };
  const base: Pt = rel && last ? toUser(last, H) : [0, 0];
  if (body.includes('<')) {
    const [l, a] = body.split('<').map(toNum);
    if (Number.isNaN(l) || Number.isNaN(a)) return { kind: 'error', msg: 'Формат: длина<угол, например @50<30' };
    const r = (a * Math.PI) / 180;
    return { kind: 'point', p: fromUser([base[0] + l * Math.cos(r), base[1] + l * Math.sin(r)], H) };
  }
  const parts = body.includes(';') ? body.split(';') : body.split(',');
  if (parts.length === 2) {
    const x = toNum(parts[0]), y = toNum(parts[1]);
    if (Number.isNaN(x) || Number.isNaN(y)) return { kind: 'error', msg: 'Формат точки: x,y (например 10,20 или @5,0)' };
    return { kind: 'point', p: fromUser([base[0] + x, base[1] + y], H) };
  }
  if (rel) return { kind: 'error', msg: 'После «@» нужно: dx,dy или длина<угол' };
  if (parts.length === 1) {
    const v = toNum(body);
    if (!Number.isNaN(v)) return { kind: 'number', v };
    return { kind: 'word', s: body.toUpperCase() };
  }
  return { kind: 'error', msg: 'Не понял ввод' };
}

/** Точка на расстоянии d от from в направлении to («прямой ввод расстояния»). */
export function along(from: Pt, to: Pt, d: number): Pt {
  const dx = to[0] - from[0], dy = to[1] - from[1], L = Math.hypot(dx, dy);
  if (L < 1e-9) return [from[0] + d, from[1]];
  return [from[0] + (dx / L) * d, from[1] + (dy / L) * d];
}

/** Ортогональный режим: только горизонталь или вертикаль от from. */
export function ortho(from: Pt, p: Pt): Pt {
  return Math.abs(p[0] - from[0]) >= Math.abs(p[1] - from[1]) ? [p[0], from[1]] : [from[0], p[1]];
}
