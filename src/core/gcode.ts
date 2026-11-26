// Генерация G-кода, расчёт времени и проверка рабочего поля.
import { dist, pathLength, type Path, type Pt } from './geometry';

export type PenMode = 'z' | 'zinv' | 'servo' | 'solenoid' | 'custom';
export type Origin = 'top-left' | 'bottom-left';

export interface MachineProfile {
  id: string;
  name: string;
  baud: number;
  penMode: PenMode;
  penUp: string;          // команды «ручка вверх» (через \n)
  penDown: string;        // команды «ручка вниз»
  penDownDelay: number;   // пауза после опускания, с
  penUpDelay: number;     // пауза после подъёма, с
  drawSpeed: number;      // мм/мин
  travelSpeed: number;    // мм/мин (для расчёта времени; G0 идёт на макс. скорости)
  accel: number;          // мм/с² (для расчёта времени)
  workW: number;          // рабочее поле, мм
  workH: number;
  origin: Origin;         // где начало координат на листе
  invertX: boolean;
  invertY: boolean;
  swapXY: boolean;
  scaleX: number;         // поправка масштаба (по итогам теста-квадрата)
  scaleY: number;
  offsetX: number;        // смещение листа относительно начала координат машины, мм
  offsetY: number;
  useG0ForTravel: boolean;
  safetyMargin: number;   // мм
  restAfterMin: number;   // напоминание об отдыхе моторов, мин (0 — выкл.)
  streaming: 'count' | 'simple';
}

export const PEN_PRESETS: Record<Exclude<PenMode, 'custom'>, { up: string; down: string; downDelay: number; upDelay: number }> = {
  z: { up: 'G0 Z5', down: 'G1 Z0 F1000', downDelay: 0, upDelay: 0 },
  // GUANGKU: ось Z работает наоборот — Z+3 ручка пишет, Z−1,5 поднята (проверено на машине)
  zinv: { up: 'G1 Z-1.5 F600', down: 'G1 Z3 F600', downDelay: 0, upDelay: 0 },
  servo: { up: 'M3 S30', down: 'M3 S90', downDelay: 0.15, upDelay: 0.15 },
  solenoid: { up: 'M5', down: 'M3 S1000', downDelay: 0.05, upDelay: 0.05 },
};

/** Рабочие настройки GUANGKU: ось Z наоборот, поле 210×300. */
export function guangkuProfile(): Partial<MachineProfile> {
  return {
    penMode: 'zinv', penUp: PEN_PRESETS.zinv.up, penDown: PEN_PRESETS.zinv.down, penDownDelay: 0, penUpDelay: 0,
    // скорость письма — из рабочего G-кода машины
    drawSpeed: 8000, travelSpeed: 2500, workW: 210, workH: 300, origin: 'top-left',
    invertX: false, invertY: true, swapXY: false, scaleX: 1, scaleY: 1,
  };
}

export function defaultProfile(): MachineProfile {
  return {
    id: 'default', name: 'GUANGKU', baud: 115200,
    penMode: 'z', penUp: '', penDown: '', penDownDelay: 0, penUpDelay: 0,
    drawSpeed: 3000, travelSpeed: 5000, accel: 500,
    workW: 180, workH: 250, origin: 'top-left', invertX: false, invertY: true, swapXY: false,
    scaleX: 1, scaleY: 1, offsetX: 0, offsetY: 0, useG0ForTravel: true, safetyMargin: 0,
    restAfterMin: 40, streaming: 'count',
    ...guangkuProfile(),
  };
}

const fmt = (n: number) => {
  const r = Math.round(n * 100) / 100;
  return (Object.is(r, -0) ? 0 : r).toString();
};

/** Координаты листа → «прямые» координаты машины (до разворота осей), от начальной точки ручки. */
export function toWork(p: Pt, prof: MachineProfile, sheetH: number): Pt {
  const x = (p[0] - prof.offsetX) * prof.scaleX;
  const y = (prof.origin === 'top-left' ? p[1] : sheetH - p[1]) - prof.offsetY;
  return [x, y * prof.scaleY];
}

/** Перевод координат листа (мм, Y вниз, от левого верхнего угла) в координаты машины. */
export function toMachine(p: Pt, prof: MachineProfile, sheetH: number): Pt {
  let [x, y] = toWork(p, prof, sheetH);
  if (prof.invertX) x = -x;
  if (prof.invertY) y = -y;
  if (prof.swapXY) [x, y] = [y, x];
  return [x, y];
}

/** Обратное преобразование: координаты машины → координаты листа (для показа позиции ручки). */
export function fromMachine(m: Pt, prof: MachineProfile, sheetH: number): Pt {
  let [x, y] = m;
  if (prof.swapXY) [x, y] = [y, x];
  if (prof.invertX) x = -x;
  if (prof.invertY) y = -y;
  x = x / (prof.scaleX || 1) + prof.offsetX;
  y = y / (prof.scaleY || 1) + prof.offsetY;
  return [x, prof.origin === 'top-left' ? y : sheetH - y];
}

const lines = (s: string) => s.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

export interface GcodeJob {
  /** Каждый элемент — набор путей одного листа/цвета; между ними — пауза M0 с сообщением. */
  sections: { paths: Path[]; pauseMessage?: string }[];
  sheetH: number;
}

export function generateGcode(job: GcodeJob, prof: MachineProfile): string[] {
  const out: string[] = [];
  const up = () => {
    out.push(...lines(prof.penUp));
    if (prof.penUpDelay > 0) out.push(`G4 P${fmt(prof.penUpDelay)}`);
  };
  const down = () => {
    out.push(...lines(prof.penDown));
    if (prof.penDownDelay > 0) out.push(`G4 P${fmt(prof.penDownDelay)}`);
  };
  out.push('; Каллиграф — G-код для GRBL', 'G21', 'G90');
  up();
  out.push('G0 X0 Y0');
  let first = true;
  for (const sec of job.sections) {
    if (!first && sec.pauseMessage) {
      up();
      out.push('G0 X0 Y0', `; ${sec.pauseMessage}`, 'M0');
    }
    first = false;
    for (const p of sec.paths) {
      if (!p.points.length) continue;
      const [sx, sy] = toMachine(p.points[0], prof, job.sheetH);
      out.push(prof.useG0ForTravel ? `G0 X${fmt(sx)} Y${fmt(sy)}` : `G1 X${fmt(sx)} Y${fmt(sy)} F${prof.travelSpeed}`);
      down();
      let feedSet = false;
      const pts = p.points.length === 1 ? [p.points[0], [p.points[0][0] + 0.05, p.points[0][1]] as Pt] : p.points;
      for (let i = 1; i < pts.length; i++) {
        const [x, y] = toMachine(pts[i], prof, job.sheetH);
        out.push(`G1 X${fmt(x)} Y${fmt(y)}${feedSet ? '' : ` F${prof.drawSpeed}`}`);
        feedSet = true;
      }
      up();
    }
  }
  out.push('G0 X0 Y0', 'M2');
  return out;
}

// ── Скорость ручки (ось Z) ───────────────────────────────────────────

const zOf = (cmd: string) => { const m = /Z\s*(-?\d*\.?\d+)/i.exec(cmd); return m ? parseFloat(m[1]) : null; };
const fOf = (cmd: string) => { const m = /\bF\s*(\d*\.?\d+)/i.exec(cmd); return m ? parseFloat(m[1]) : null; };

/** Скорость подъёма/опускания ручки по оси Z (мм/мин) или null, если ручка не на оси Z. */
export function penFeed(prof: MachineProfile): number | null {
  if (zOf(prof.penDown) === null) return null;
  return fOf(prof.penDown) ?? fOf(prof.penUp) ?? null;
}

/** Ход ручки по Z между «пишет» и «поднята», мм. */
export function penTravelZ(prof: MachineProfile): number {
  const d = zOf(prof.penDown), u = zOf(prof.penUp);
  return d === null || u === null ? 0 : Math.abs(d - u);
}

/** Поменять скорость Z в командах ручки (G0 Z… превращается в G1 Z… F…). */
export function withPenFeed(prof: MachineProfile, feed: number): Pick<MachineProfile, 'penUp' | 'penDown'> {
  const fix = (s: string) => s.split(/\r?\n/).map((l) => {
    if (zOf(l) === null) return l;
    const base = l.replace(/\bF\s*\d*\.?\d+/i, '').replace(/^\s*G0\b/i, 'G1').trim();
    return `${base} F${Math.round(feed)}`;
  }).join('\n');
  return { penUp: fix(prof.penUp), penDown: fix(prof.penDown) };
}

/** Время одного цикла «опустить + поднять» ручку, с. G0 по Z считаем как 1500 мм/мин. */
export function penCycleTime(prof: MachineProfile): number {
  const dz = penTravelZ(prof);
  if (!dz) return 0;
  const fd = fOf(prof.penDown) ?? (/^\s*G0/i.test(prof.penDown) ? 1500 : 600);
  const fu = fOf(prof.penUp) ?? (/^\s*G0/i.test(prof.penUp) ? 1500 : 600);
  return dz / (fd / 60) + dz / (fu / 60);
}

// ── Расчёт времени ───────────────────────────────────────────────────

function segTime(L: number, v: number, a: number, v0: number, v1: number): number {
  // Трапециевидный профиль скорости
  if (L <= 0) return 0;
  const d0 = (v * v - v0 * v0) / (2 * a);
  const d1 = (v * v - v1 * v1) / (2 * a);
  if (d0 + d1 <= L) return (v - v0) / a + (v - v1) / a + (L - d0 - d1) / v;
  // Треугольный профиль
  const vp = Math.sqrt(Math.max(0, (2 * a * L + v0 * v0 + v1 * v1) / 2));
  return Math.max(0, (vp - v0) / a) + Math.max(0, (vp - v1) / a);
}

export interface JobStats {
  drawLength: number;  // мм
  travelLength: number;
  penLifts: number;
  seconds: number;
  /** из них — на подъёмы и опускания ручки, с */
  penSeconds: number;
}

export function estimateJob(paths: Path[], prof: MachineProfile, start: Pt = [0, 0]): JobStats {
  const a = Math.max(10, prof.accel);
  const vDraw = prof.drawSpeed / 60;
  const vTravel = prof.travelSpeed / 60;
  let t = 0, draw = 0, travel = 0, pos = start, lifts = 0;
  const zCycle = penCycleTime(prof);
  for (const p of paths) {
    if (!p.points.length) continue;
    const d = dist(pos, p.points[0]);
    travel += d;
    t += segTime(d, vTravel, a, 0, 0);
    t += prof.penDownDelay + prof.penUpDelay + zCycle + 0.08; // ручка вниз и вверх
    lifts++;
    const pts = p.points;
    for (let i = 1; i < pts.length; i++) {
      const L = dist(pts[i - 1], pts[i]);
      draw += L;
      // скорость на стыках зависит от угла поворота
      const junction = (k: number) => {
        if (k <= 0 || k >= pts.length - 1) return 0;
        const ax = pts[k][0] - pts[k - 1][0], ay = pts[k][1] - pts[k - 1][1];
        const bx = pts[k + 1][0] - pts[k][0], by = pts[k + 1][1] - pts[k][1];
        const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
        if (!la || !lb) return 0;
        const cos = (ax * bx + ay * by) / (la * lb);
        return vDraw * Math.max(0, cos) ** 2;
      };
      t += segTime(L, vDraw, a, junction(i - 1), junction(i));
    }
    pos = pts[pts.length - 1];
  }
  const back = dist(pos, start);
  travel += back;
  t += segTime(back, vTravel, a, 0, 0);
  return { drawLength: draw, travelLength: travel, penLifts: lifts, seconds: t, penSeconds: lifts * (prof.penDownDelay + prof.penUpDelay + zCycle) };
}

export { pathLength };

/** Индексы путей (в координатах листа), которые выходят за рабочее поле машины. */
export function outOfBounds(paths: Path[], prof: MachineProfile, sheetH: number): number[] {
  const bad: number[] = [];
  const m = prof.safetyMargin, eps = 1e-6;
  paths.forEach((p, i) => {
    for (const pt of p.points) {
      const [x, y] = toWork(pt, prof, sheetH);
      if (x < m - eps || y < m - eps || x > prof.workW - m + eps || y > prof.workH - m + eps) {
        bad.push(i);
        break;
      }
    }
  });
  return bad;
}

export function formatDuration(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
}

/** Рамка всех путей на листе (мм) или null, если рисовать нечего. */
export function jobBounds(paths: Path[]): { minX: number; minY: number; maxX: number; maxY: number } | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of paths) for (const [x, y] of p.points) {
    if (x < minX) minX = x; if (y < minY) minY = y; if (x > maxX) maxX = x; if (y > maxY) maxY = y;
  }
  return minX === Infinity ? null : { minX, minY, maxX, maxY };
}

/**
 * «Обвести границы»: ручка поднята, машина медленно объезжает рамку будущего письма
 * (с остановкой в каждом углу) и возвращается в начальную точку. Бумага не пачкается.
 */
export function boundsGcode(paths: Path[], prof: MachineProfile, sheetH: number, laps = 1, speed = 2500): string[] {
  const b = jobBounds(paths);
  if (!b) return [];
  const corners: Pt[] = [[b.minX, b.minY], [b.maxX, b.minY], [b.maxX, b.maxY], [b.minX, b.maxY]];
  const out: string[] = ['; Каллиграф — обвод границ (ручка поднята)', 'G21', 'G90', ...lines(prof.penUp)];
  if (prof.penUpDelay > 0) out.push(`G4 P${fmt(prof.penUpDelay)}`);
  for (let lap = 0; lap < Math.max(1, laps); lap++)
    for (const c of [...corners, corners[0]]) {
      const [x, y] = toMachine(c, prof, sheetH);
      out.push(`G1 X${fmt(x)} Y${fmt(y)} F${Math.round(speed)}`, 'G4 P0.4');
    }
  out.push('G0 X0 Y0', 'M2');
  return out;
}
