// Лист бумаги в реальном масштабе: пути, разметка, рабочее поле, анимация, след симулятора.
import { useEffect, useMemo, useRef, useState, type PointerEvent as RPE } from 'react';
import { Maximize, Minus, Plus } from 'lucide-react';
import type { Path, Pt } from '../core/geometry';
import { bboxOf } from '../core/geometry';
import { fromMachine, type MachineProfile } from '../core/gcode';
import { groupByColor, toSvgD } from '../job';
import { simTrace, useMachine } from '../machine';
import bedUrl from '../assets/guangku-bed.jpg';

export interface SheetItemBox { id: string; x: number; y: number; w: number; h: number }

interface Props {
  w: number;
  h: number;
  paths: Path[];
  ruling?: Path[];
  bad?: Set<number>;
  profile: MachineProfile;
  showWork?: boolean;
  travel?: boolean;
  anim?: { order: Path[]; t: number } | null; // t — доля 0..1 пройденного пути
  boxes?: SheetItemBox[];
  selected?: string | null;
  onSelect?: (id: string | null) => void;
  onMoveItem?: (id: string, dx: number, dy: number) => void;
  showSim?: boolean;
  /** Фото стола под листом: где на столе (см) лежит левый нижний угол листа. */
  bed?: { x: number; y: number } | null;
}

/** Выпрямленное фото стола GUANGKU: 40 px/см, по шкале стола X −1,5…20,5 см, Y −1,5…29,5 см. */
export const BED = { x0: -1.5, x1: 20.5, y0: -1.5, y1: 29.5 };

const INK = '#2b2d6e';

export function SheetView(p: Props) {
  const wrap = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ zoom: 1, panX: 0, panY: 0 });
  const [size, setSize] = useState({ w: 800, h: 600 });
  const [panning, setPanning] = useState(false);
  const space = useRef(false);
  const drag = useRef<{ kind: 'pan' | 'item'; id?: string; sx: number; sy: number; px: number; py: number } | null>(null);
  const ctl = useMachine();

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const kd = (e: KeyboardEvent) => { if (e.code === 'Space' && !(e.target as HTMLElement)?.closest?.('input,textarea,select')) space.current = true; };
    const ku = (e: KeyboardEvent) => { if (e.code === 'Space') space.current = false; };
    const zoom = (e: Event) => setView((v) => ({ ...v, zoom: Math.min(12, Math.max(0.2, v.zoom * ((e as CustomEvent).detail > 0 ? 1.2 : 1 / 1.2))) }));
    window.addEventListener('keydown', kd);
    window.addEventListener('keyup', ku);
    window.addEventListener('kg-zoom', zoom);
    return () => { window.removeEventListener('keydown', kd); window.removeEventListener('keyup', ku); window.removeEventListener('kg-zoom', zoom); };
  }, []);

  // Перерисовка следа симулятора
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!p.showSim) return;
    let pending = false;
    const l = () => { if (!pending) { pending = true; requestAnimationFrame(() => { pending = false; setTick((t) => t + 1); }); } };
    simTrace.listeners.add(l);
    return () => { simTrace.listeners.delete(l); };
  }, [p.showSim]);

  // мм → пиксели: лист вписан в окно с отступом
  const pad = 30;
  const fit = Math.min((size.w - pad * 2) / p.w, (size.h - pad * 2) / p.h);
  const k = Math.max(0.1, fit) * view.zoom;
  const ox = (size.w - p.w * k) / 2 + view.panX;
  const oy = (size.h - p.h * k) / 2 + view.panY;

  const onWheel = (e: React.WheelEvent) => {
    const r = wrap.current!.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    const f = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    setView((v) => {
      const z = Math.min(12, Math.max(0.2, v.zoom * f));
      const real = z / v.zoom;
      // зум вокруг курсора
      const cx = (size.w - p.w * fit * v.zoom) / 2 + v.panX;
      const cy = (size.h - p.h * fit * v.zoom) / 2 + v.panY;
      const ncx = mx - (mx - cx) * real, ncy = my - (my - cy) * real;
      return { zoom: z, panX: ncx - (size.w - p.w * fit * z) / 2, panY: ncy - (size.h - p.h * fit * z) / 2 };
    });
  };

  const onDown = (e: RPE) => {
    const target = e.target as Element;
    const itemId = target.getAttribute('data-item');
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    if (e.button === 1 || space.current || (!itemId && e.button === 0 && !p.onSelect)) {
      drag.current = { kind: 'pan', sx: e.clientX, sy: e.clientY, px: view.panX, py: view.panY };
      setPanning(true);
      return;
    }
    if (itemId && p.onMoveItem) {
      p.onSelect?.(itemId);
      drag.current = { kind: 'item', id: itemId, sx: e.clientX, sy: e.clientY, px: 0, py: 0 };
      return;
    }
    p.onSelect?.(null);
    drag.current = { kind: 'pan', sx: e.clientX, sy: e.clientY, px: view.panX, py: view.panY };
    setPanning(true);
  };
  const onMove = (e: RPE) => {
    const d = drag.current;
    if (!d) return;
    if (d.kind === 'pan') setView((v) => ({ ...v, panX: d.px + e.clientX - d.sx, panY: d.py + e.clientY - d.sy }));
    else if (d.id) {
      const dx = (e.clientX - d.sx) / k, dy = (e.clientY - d.sy) / k;
      if (Math.abs(dx) + Math.abs(dy) > 0.05) {
        p.onMoveItem?.(d.id, dx, dy);
        d.sx = e.clientX; d.sy = e.clientY;
      }
    }
  };
  const onUp = () => { drag.current = null; setPanning(false); };

  // Пути по цветам; плохие (вне поля) — красным
  const layers = useMemo(() => {
    const good: Path[] = [], bad: Path[] = [];
    p.paths.forEach((x, i) => (p.bad?.has(i) ? bad : good).push(x));
    return { byColor: [...groupByColor(good).entries()].map(([c, ps]) => [c, toSvgD(ps)] as const), bad: toSvgD(bad) };
  }, [p.paths, p.bad]);
  const rulingD = useMemo(() => (p.ruling ? toSvgD(p.ruling) : ''), [p.ruling]);

  const travelD = useMemo(() => {
    if (!p.travel) return '';
    const src = p.anim?.order ?? p.paths;
    let d = '', pos: Pt = [0, 0];
    for (const x of src) {
      if (!x.points.length) continue;
      d += `M${pos[0].toFixed(1)} ${pos[1].toFixed(1)}L${x.points[0][0].toFixed(1)} ${x.points[0][1].toFixed(1)}`;
      pos = x.points[x.points.length - 1];
    }
    return d;
  }, [p.travel, p.paths, p.anim?.order]);

  // Анимация «ручка пишет»
  const animData = useMemo(() => {
    if (!p.anim) return null;
    const lens: number[] = [];
    let total = 0, pos: Pt = [0, 0];
    for (const x of p.anim.order) {
      let L = x.points.length ? Math.hypot(x.points[0][0] - pos[0], x.points[0][1] - pos[1]) : 0;
      for (let i = 1; i < x.points.length; i++) L += Math.hypot(x.points[i][0] - x.points[i - 1][0], x.points[i][1] - x.points[i - 1][1]);
      lens.push(L); total += L;
      if (x.points.length) pos = x.points[x.points.length - 1];
    }
    return { lens, total };
  }, [p.anim?.order]); // eslint-disable-line react-hooks/exhaustive-deps

  let animDone = '', animPen: Pt | null = null, animPenDown = false;
  if (p.anim && animData) {
    let left = p.anim.t * animData.total;
    const done: Path[] = [];
    let pos: Pt = [0, 0];
    for (let i = 0; i < p.anim.order.length; i++) {
      const x = p.anim.order[i];
      if (left >= animData.lens[i]) { done.push(x); left -= animData.lens[i]; if (x.points.length) pos = x.points[x.points.length - 1]; continue; }
      if (!x.points.length) break;
      const t0 = Math.hypot(x.points[0][0] - pos[0], x.points[0][1] - pos[1]);
      if (left < t0) {
        const f = t0 ? left / t0 : 0;
        animPen = [pos[0] + (x.points[0][0] - pos[0]) * f, pos[1] + (x.points[0][1] - pos[1]) * f];
        break;
      }
      left -= t0;
      const part: Pt[] = [x.points[0]];
      for (let j = 1; j < x.points.length; j++) {
        const a = x.points[j - 1], b = x.points[j];
        const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (left >= L) { part.push(b); left -= L; continue; }
        const f = L ? left / L : 0;
        const m: Pt = [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
        part.push(m); animPen = m; break;
      }
      done.push({ ...x, points: part });
      animPenDown = true;
      break;
    }
    animDone = toSvgD(done);
    if (!animPen && p.anim.t >= 1) animPen = [0, 0];
  }

  // След симулятора и позиция ручки машины — в координатах листа
  const simD = useMemo(() => {
    if (!p.showSim || !simTrace.segs.length) return '';
    let d = '';
    for (const [a, b] of simTrace.segs) {
      const A = fromMachine(a, p.profile, p.h), B = fromMachine(b, p.profile, p.h);
      d += `M${A[0].toFixed(2)} ${A[1].toFixed(2)}L${B[0].toFixed(2)} ${B[1].toFixed(2)}`;
    }
    return d;
  }, [p.showSim, simTrace.segs.length, p.profile, p.h]); // eslint-disable-line react-hooks/exhaustive-deps

  const wp = ctl.status.wpos;
  const machinePen = wp ? fromMachine([wp[0], wp[1]], p.profile, p.h) : null;

  // рабочее поле машины на листе (от начальной точки)
  const wa = (() => {
    const pr = p.profile;
    const x0 = pr.offsetX, x1 = pr.offsetX + pr.workW / (pr.scaleX || 1);
    const yA = pr.offsetY, yB = pr.offsetY + pr.workH / (pr.scaleY || 1);
    const [y0, y1] = pr.origin === 'top-left' ? [yA, yB] : [p.h - yB, p.h - yA];
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  })();

  const sw = 1.4 / k; // толщина линии ≈ 1.4 px

  return (
    <div ref={wrap} className={'sheet-wrap' + (panning ? ' panning' : '')} onWheel={onWheel}>
      <svg className="sheet-svg" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} role="img" aria-label="Предпросмотр листа">
        <defs>
          <filter id="paper-shadow" x="-10%" y="-10%" width="120%" height="120%"><feDropShadow dx="0" dy={2 / k} stdDeviation={6 / k} floodOpacity=".16" /></filter>
        </defs>
        <g transform={`translate(${ox} ${oy}) scale(${k})`}>
          {p.bed && (
            <image href={bedUrl} preserveAspectRatio="none"
              x={(BED.x0 - p.bed.x) * 10} y={p.h - (BED.y1 - p.bed.y) * 10}
              width={(BED.x1 - BED.x0) * 10} height={(BED.y1 - BED.y0) * 10} />
          )}
          {/* с фото стола лист полупрозрачный — сквозь него видна сетка стола */}
          <rect x={0} y={0} width={p.w} height={p.h} fill="var(--paper)" opacity={p.bed ? 0.6 : 1}
            stroke={p.bed ? '#fff' : 'none'} strokeWidth={1.2 / k} filter={p.bed ? undefined : 'url(#paper-shadow)'} />
          {rulingD && <path d={rulingD} stroke="var(--paper-line)" strokeWidth={0.8 / k} fill="none" />}
          {p.showWork !== false && (
            <rect x={wa.x} y={wa.y} width={wa.w} height={wa.h} fill="none" stroke="#4dabf7" strokeDasharray={`${4 / k} ${3 / k}`} strokeWidth={1 / k} opacity={0.8} />
          )}
          {p.showWork !== false && <circle cx={p.profile.offsetX} cy={p.profile.origin === 'top-left' ? p.profile.offsetY : p.h - p.profile.offsetY} r={3 / k} fill="#4dabf7" />}
          {travelD && <path d={travelD} stroke="#868e96" strokeWidth={0.8 / k} strokeDasharray={`${3 / k} ${3 / k}`} fill="none" opacity={0.7} />}
          {p.anim
            ? <>
                {layers.byColor.map(([c, d]) => <path key={c} d={d} stroke={c || INK} strokeWidth={sw} fill="none" opacity={0.13} strokeLinecap="round" strokeLinejoin="round" />)}
                <path d={animDone} stroke={INK} strokeWidth={sw * 1.15} fill="none" strokeLinecap="round" strokeLinejoin="round" />
                {animPen && <circle cx={animPen[0]} cy={animPen[1]} r={(animPenDown ? 4 : 5) / k} fill={animPenDown ? 'var(--accent)' : 'none'} stroke="var(--accent)" strokeWidth={1.5 / k} />}
              </>
            : layers.byColor.map(([c, d]) => <path key={c} d={d} stroke={c || INK} strokeWidth={sw} fill="none" strokeLinecap="round" strokeLinejoin="round" />)}
          {layers.bad && <path d={layers.bad} stroke="#e03131" strokeWidth={sw * 1.6} fill="none" strokeLinecap="round" />}
          {simD && <path d={simD} stroke="#1c7ed6" strokeWidth={sw * 1.3} fill="none" strokeLinecap="round" opacity={0.85} />}
          {p.boxes?.map((b) => (
            <rect key={b.id} data-item={b.id} x={b.x - 1} y={b.y - 1} width={b.w + 2} height={b.h + 2}
              fill="transparent" stroke={p.selected === b.id ? 'var(--accent)' : 'rgba(77,171,247,.35)'}
              strokeWidth={(p.selected === b.id ? 1.6 : 1) / k} strokeDasharray={p.selected === b.id ? undefined : `${3 / k} ${2 / k}`}
              style={{ cursor: 'move' }} />
          ))}
          {machinePen && ctl.connected && (
            <g>
              <circle cx={machinePen[0]} cy={machinePen[1]} r={6 / k} fill="none" stroke="#e8590c" strokeWidth={1.5 / k} />
              <path d={`M${machinePen[0] - 9 / k} ${machinePen[1]}h${18 / k}M${machinePen[0]} ${machinePen[1] - 9 / k}v${18 / k}`} stroke="#e8590c" strokeWidth={1 / k} />
            </g>
          )}
        </g>
      </svg>
      <div className="sheet-tools">
        <button className="btn ghost icon small" onClick={() => setView((v) => ({ ...v, zoom: Math.max(0.2, v.zoom / 1.2) }))} title="Уменьшить (−)" aria-label="Уменьшить"><Minus /></button>
        <span className="zoom">{Math.round(view.zoom * 100)}%</span>
        <button className="btn ghost icon small" onClick={() => setView((v) => ({ ...v, zoom: Math.min(12, v.zoom * 1.2) }))} title="Увеличить (+)" aria-label="Увеличить"><Plus /></button>
        <button className="btn ghost icon small" onClick={() => setView({ zoom: 1, panX: 0, panY: 0 })} title="Весь лист" aria-label="Весь лист"><Maximize /></button>
      </div>
    </div>
  );
}

export function boxesFor(items: { id: string; paths: Path[] }[]): SheetItemBox[] {
  const out: SheetItemBox[] = [];
  for (const it of items) {
    const b = bboxOf(it.paths);
    if (b) out.push({ id: it.id, x: b.minX, y: b.minY, w: b.maxX - b.minX, h: b.maxY - b.minY });
  }
  return out;
}

/** Миниатюра путей (для карточек шрифтов и рисунков). */
export function Thumb({ paths, className }: { paths: Path[]; className?: string }) {
  const b = bboxOf(paths);
  if (!b) return <svg className={className} />;
  const w = Math.max(1, b.maxX - b.minX), h = Math.max(1, b.maxY - b.minY);
  const m = Math.max(w, h) * 0.08;
  return (
    <svg className={className} viewBox={`${b.minX - m} ${b.minY - m} ${w + 2 * m} ${h + 2 * m}`} preserveAspectRatio="xMidYMid meet">
      <path d={toSvgD(paths)} stroke={INK} strokeWidth={Math.max(w, h) / 160} fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
