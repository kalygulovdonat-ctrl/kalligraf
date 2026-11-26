import { useEffect, useMemo, useRef, useState } from 'react';
import { Maximize, Minus, Plus } from 'lucide-react';
import type { Path, Pt } from '../../core/geometry';
import { annotate } from '../../core/cad/annotate';
import { shapeOf, styleLines, type CadDoc, type Entity } from '../../core/cad/model';
import { entitiesInBox, findSnap, hitTest } from '../../core/cad/ops';
import { ortho, toUser } from '../../core/cad/input';
import { toSvgD } from '../../job';
import { useApp } from '../../store';
import {
  cancelTool, currentStep, inputPoint, logMsg, pickAt, pressEnter, setViewScale, submitCommand, useCadUi,
} from './engine';

const INK = '#2b2d6e';
const SEL = '#ff8a2a';

function entityLines(e: Entity, cad: CadDoc): Pt[][] {
  if (e.t === 'dim' || e.t === 'text' || e.t === 'hatch') return annotate(e, cad);
  return styleLines(shapeOf(e), e.lt, false);
}
const dOf = (lines: Pt[][]) => toSvgD(lines.map((points) => ({ points })));

export function CadView({ background }: { background: Path[] }) {
  const doc = useApp((s) => s.doc);
  const cad = doc.cad;
  const W = doc.sheet.w, H = doc.sheet.h;
  const ui = useCadUi();
  const wrap = useRef<HTMLDivElement>(null);
  const cmdRef = useRef<HTMLInputElement>(null);
  const [size, setSize] = useState({ w: 800, h: 600 });
  const [view, setView] = useState({ zoom: 1, panX: 0, panY: 0 });
  const [box, setBox] = useState<{ a: Pt; b: Pt } | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [cmd, setCmd] = useState('');
  const drag = useRef<{ kind: 'pan' | 'box'; sx: number; sy: number; px: number; py: number; a: Pt; moved: boolean } | null>(null);
  const shift = useRef(false);
  const space = useRef(false);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const pad = 24;
  const fit = Math.min((size.w - pad * 2) / W, (size.h - pad * 2) / H);
  const k = Math.max(0.1, fit) * view.zoom;
  const ox = (size.w - W * k) / 2 + view.panX, oy = (size.h - H * k) / 2 + view.panY;
  useEffect(() => setViewScale(k), [k]);
  const toMM = (cx: number, cy: number): Pt => {
    const r = wrap.current!.getBoundingClientRect();
    return [(cx - r.left - ox) / k, (cy - r.top - oy) / k];
  };

  // Клавиатура
  useEffect(() => {
    const kd = (e: KeyboardEvent) => {
      shift.current = e.shiftKey;
      const t = e.target as HTMLElement;
      const inCmd = t === cmdRef.current;
      const inField = !!t?.closest?.('input,textarea,select') && !inCmd;
      if (inField) return;
      if (e.code === 'Space' && !inCmd) { space.current = true; }
      if (e.key === 'F8') { e.preventDefault(); useCadUi.setState((u) => ({ orthoOn: !u.orthoOn })); logMsg(`Орто: ${useCadUi.getState().orthoOn ? 'вкл' : 'выкл'}`); return; }
      if (e.key === 'F3') { e.preventDefault(); useCadUi.setState((u) => ({ snapOn: !u.snapOn })); logMsg(`Привязки: ${useCadUi.getState().snapOn ? 'вкл' : 'выкл'}`); return; }
      if (inCmd) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === 'Escape') { if (useCadUi.getState().tool) cancelTool(); else useCadUi.setState({ sel: [] }); return; }
      if (e.key === 'Enter') { e.preventDefault(); pressEnter(); return; }
      if (e.key === 'Delete' && useCadUi.getState().sel.length && !useCadUi.getState().tool) {
        const ids = new Set(useCadUi.getState().sel);
        useApp.getState().setDoc((d) => ({ ...d, cad: { ...d.cad, entities: d.cad.entities.filter((x) => !ids.has(x.id)) } }));
        useCadUi.setState({ sel: [] });
        return;
      }
      if (e.key.length === 1 && /[\p{L}\d@.,<\-;]/u.test(e.key)) cmdRef.current?.focus();
    };
    const ku = (e: KeyboardEvent) => { shift.current = e.shiftKey; if (e.code === 'Space') space.current = false; };
    window.addEventListener('keydown', kd);
    window.addEventListener('keyup', ku);
    return () => { window.removeEventListener('keydown', kd); window.removeEventListener('keyup', ku); };
  }, []);

  const step = currentStep();
  const wantsPoint = !!step && (step.kind === 'point' || step.kind === 'points' || step.kind === 'pointOrNumber');

  const track = (cx: number, cy: number) => {
    const raw = toMM(cx, cy);
    const u = useCadUi.getState();
    let p = raw, snap = null;
    if (wantsPoint || !u.tool) {
      if (u.snapOn) snap = findSnap(raw, cad, u.snaps, 12 / k, u.lastPt);
      if (snap && (snap.kind !== 'grid' || !(u.orthoOn !== shift.current && u.lastPt))) p = snap.p;
      else if (u.lastPt && wantsPoint && u.orthoOn !== shift.current) { p = ortho(u.lastPt, raw); snap = null; }
    }
    useCadUi.setState({ cursor: p, snap: wantsPoint ? snap : null });
    if (!wantsPoint) {
      const e = hitTest(raw, cad, 5 / k);
      setHover(e?.id ?? null);
    } else setHover(null);
    return raw;
  };

  const onDown = (e: React.PointerEvent) => {
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    const raw = toMM(e.clientX, e.clientY);
    if (e.button === 1 || space.current) {
      drag.current = { kind: 'pan', sx: e.clientX, sy: e.clientY, px: view.panX, py: view.panY, a: raw, moved: false };
      return;
    }
    if (e.button === 2) return;
    drag.current = { kind: 'box', sx: e.clientX, sy: e.clientY, px: 0, py: 0, a: raw, moved: false };
  };
  const onMove = (e: React.PointerEvent) => {
    const raw = track(e.clientX, e.clientY);
    const d = drag.current;
    if (!d) return;
    if (Math.hypot(e.clientX - d.sx, e.clientY - d.sy) > 4) d.moved = true;
    if (d.kind === 'pan') setView((v) => ({ ...v, panX: d.px + e.clientX - d.sx, panY: d.py + e.clientY - d.sy }));
    else if (d.moved && (!useCadUi.getState().tool || step?.kind === 'select')) setBox({ a: d.a, b: raw });
  };
  const onUp = (e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (d.kind === 'pan') return;
    const u = useCadUi.getState();
    if (box) {
      const crossing = box.b[0] < box.a[0];
      const found = entitiesInBox(cad, box.a, box.b, crossing).map((x) => x.id);
      useCadUi.setState({ sel: e.shiftKey || u.tool ? [...new Set([...u.sel, ...found])] : found });
      setBox(null);
      return;
    }
    const raw = toMM(e.clientX, e.clientY);
    if (u.tool) {
      if (wantsPoint) inputPoint(u.cursor);
      else pickAt(raw, 5 / k);
      return;
    }
    const hit = hitTest(raw, cad, 5 / k);
    if (!hit) { if (!e.shiftKey) useCadUi.setState({ sel: [] }); return; }
    useCadUi.setState({ sel: e.shiftKey ? (u.sel.includes(hit.id) ? u.sel.filter((x) => x !== hit.id) : [...u.sel, hit.id]) : [hit.id] });
  };
  const onWheel = (e: React.WheelEvent) => {
    const r = wrap.current!.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    const f = e.deltaY < 0 ? 1.18 : 1 / 1.18;
    setView((v) => {
      const z = Math.min(40, Math.max(0.2, v.zoom * f));
      const cx = (size.w - W * fit * v.zoom) / 2 + v.panX, cy = (size.h - H * fit * v.zoom) / 2 + v.panY;
      const real = z / v.zoom;
      const ncx = mx - (mx - cx) * real, ncy = my - (my - cy) * real;
      return { zoom: z, panX: ncx - (size.w - W * fit * z) / 2, panY: ncy - (size.h - H * fit * z) / 2 };
    });
  };

  // Отрисовка объектов (кэш по списку объектов)
  const layerMap = useMemo(() => new Map(cad.layers.map((l) => [l.id, l])), [cad.layers]);
  const drawn = useMemo(() => cad.entities.filter((e) => layerMap.get(e.layer)?.visible !== false).map((e) => ({
    e, d: dOf(entityLines(e, cad)), color: layerMap.get(e.layer)?.color || INK, thick: e.lt === 'main' && e.t !== 'dim' && e.t !== 'text',
  })), [cad, layerMap]);
  const bgD = useMemo(() => toSvgD(background), [background]);
  const sel = new Set(ui.sel);
  const ghosts = ui.tool?.preview && wantsPoint || ui.tool?.preview && step?.kind === 'pick' ? ui.tool!.preview!(ui.values, ui.cursor, { cad } as never) : [];
  const ghostD = dOf(ghosts.flatMap((g) => entityLines(g, cad)));
  const px = (n: number) => n / k;
  const cu = toUser(ui.cursor, H);

  const sm = ui.snap;
  const snapMark = sm && (() => {
    const s = px(6), [x, y] = sm.p;
    switch (sm.kind) {
      case 'end': return <rect x={x - s} y={y - s} width={2 * s} height={2 * s} fill="none" />;
      case 'mid': return <path d={`M${x} ${y - s * 1.2}L${x + s * 1.1} ${y + s * 0.8}L${x - s * 1.1} ${y + s * 0.8}Z`} fill="none" />;
      case 'center': return <circle cx={x} cy={y} r={s} fill="none" />;
      case 'quad': return <path d={`M${x} ${y - s}L${x + s} ${y}L${x} ${y + s}L${x - s} ${y}Z`} fill="none" />;
      case 'int': return <path d={`M${x - s} ${y - s}L${x + s} ${y + s}M${x + s} ${y - s}L${x - s} ${y + s}`} />;
      case 'perp': return <path d={`M${x - s} ${y - s}V${y + s}H${x + s}M${x - s} ${y}H${x}V${y + s}`} fill="none" />;
      default: return <path d={`M${x - s * 0.6} ${y}H${x + s * 0.6}M${x} ${y - s * 0.6}V${y + s * 0.6}`} />;
    }
  })();
  const SNAP_RU: Record<string, string> = { end: 'конечная точка', mid: 'середина', center: 'центр', quad: 'квадрант', int: 'пересечение', perp: 'нормаль', grid: 'сетка', near: 'ближайшая' };

  const grid = ui.snaps.grid;
  const showGrid = grid > 0 && grid * k >= 7;

  return (
    <div className="cad-wrap">
      <div ref={wrap} className="sheet-wrap" onWheel={onWheel} style={{ cursor: wantsPoint ? 'none' : 'default' }}
        onContextMenu={(e) => { e.preventDefault(); pressEnter(); }}>
        <svg className="sheet-svg" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerLeave={() => setHover(null)} role="img" aria-label="Поле чертежа">
          <defs>
            {showGrid && <pattern id="cadgrid" width={grid} height={grid} patternUnits="userSpaceOnUse"><circle cx={0} cy={0} r={px(0.9)} fill="#9fb3cc" /></pattern>}
          </defs>
          <g transform={`translate(${ox} ${oy}) scale(${k})`}>
            <rect x={0} y={0} width={W} height={H} fill="var(--paper)" />
            {showGrid && <rect x={0} y={0} width={W} height={H} fill="url(#cadgrid)" />}
            <path d={bgD} stroke="#9aa3b5" strokeWidth={px(1)} fill="none" opacity={0.6} />
            {drawn.map(({ e, d, color, thick }) => (
              <path key={e.id} d={d} stroke={sel.has(e.id) ? SEL : color} strokeWidth={px(sel.has(e.id) ? 2.4 : thick ? 1.7 : 1)} fill="none"
                strokeLinecap="round" strokeLinejoin="round" opacity={hover === e.id && !sel.has(e.id) ? 0.55 : 1} />
            ))}
            {ghostD && <path d={ghostD} stroke={SEL} strokeWidth={px(1.2)} strokeDasharray={`${px(4)} ${px(3)}`} fill="none" />}
            {box && <rect x={Math.min(box.a[0], box.b[0])} y={Math.min(box.a[1], box.b[1])} width={Math.abs(box.b[0] - box.a[0])} height={Math.abs(box.b[1] - box.a[1])}
              fill={box.b[0] < box.a[0] ? 'rgba(47,158,68,.08)' : 'rgba(25,113,194,.08)'} stroke={box.b[0] < box.a[0] ? '#2f9e44' : '#1971c2'} strokeWidth={px(1)} strokeDasharray={box.b[0] < box.a[0] ? `${px(4)} ${px(3)}` : undefined} />}
            {wantsPoint && (
              <g stroke="#e8590c" strokeWidth={px(1)}>
                <path d={`M${ui.cursor[0] - px(18)} ${ui.cursor[1]}H${ui.cursor[0] + px(18)}M${ui.cursor[0]} ${ui.cursor[1] - px(18)}V${ui.cursor[1] + px(18)}`} />
                <rect x={ui.cursor[0] - px(3)} y={ui.cursor[1] - px(3)} width={px(6)} height={px(6)} fill="none" />
              </g>
            )}
            {snapMark && <g stroke="#2f9e44" strokeWidth={px(2)}>{snapMark}</g>}
          </g>
        </svg>
        <div className="cad-status">
          <span>X <b>{cu[0].toFixed(2)}</b></span><span>Y <b>{cu[1].toFixed(2)}</b></span>
          {sm && wantsPoint && <span className="snap-tag">{SNAP_RU[sm.kind]}</span>}
          <button className={'chip' + (ui.snapOn ? ' on' : '')} onClick={() => useCadUi.setState({ snapOn: !ui.snapOn })} title="Объектные привязки (F3)">Привязка</button>
          <button className={'chip' + (ui.orthoOn ? ' on' : '')} onClick={() => useCadUi.setState({ orthoOn: !ui.orthoOn })} title="Только горизонталь/вертикаль (F8, или удерживайте Shift)">Орто</button>
        </div>
        <div className="sheet-tools">
          <button className="btn ghost icon small" onClick={() => setView((v) => ({ ...v, zoom: Math.max(0.2, v.zoom / 1.25) }))} aria-label="Уменьшить"><Minus /></button>
          <span className="zoom">{Math.round(view.zoom * 100)}%</span>
          <button className="btn ghost icon small" onClick={() => setView((v) => ({ ...v, zoom: Math.min(40, v.zoom * 1.25) }))} aria-label="Увеличить"><Plus /></button>
          <button className="btn ghost icon small" onClick={() => setView({ zoom: 1, panX: 0, panY: 0 })} aria-label="Весь лист"><Maximize /></button>
        </div>
      </div>
      <div className="cmdline">
        <div className="cmd-log">{ui.log.slice(-3).map((l, i) => <div key={i}>{l}</div>)}</div>
        <div className="cmd-row">
          <span className="cmd-prompt">{ui.tool ? `${ui.tool.name}: ${step?.prompt ?? ''}${step?.def ? ` <${step.def()}>` : ''}` : 'Команда'}</span>
          <input ref={cmdRef} value={cmd} onChange={(e) => setCmd(e.target.value)} spellCheck={false} aria-label="Командная строка"
            placeholder={ui.tool ? (step?.kind === 'text' ? 'текст' : 'x,y · @dx,dy · @длина<угол · число') : 'L, PL, C, A, REC, T, DLI, M, CO, RO, MI, O, TR, EX, H…'}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); const v = cmd; setCmd(''); submitCommand(v); }
              else if (e.key === 'Escape') { e.preventDefault(); setCmd(''); cancelTool(); cmdRef.current?.blur(); }
            }} />
        </div>
      </div>
    </div>
  );
}
