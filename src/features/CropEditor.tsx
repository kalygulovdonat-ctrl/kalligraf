// Обрезка фото: рамка с угловыми ручками поверх повёрнутого снимка.
import { useEffect, useRef, useState } from 'react';
import type { Crop } from '../core/photoart';

/** Поворот картинки (dataURL) на rot × 90° по часовой — для показа в редакторе. */
export function useRotatedUrl(url: string, rot: number): { url: string; w: number; h: number } | null {
  const [out, setOut] = useState<{ url: string; w: number; h: number } | null>(null);
  useEffect(() => {
    let alive = true;
    const img = new Image();
    img.onload = () => {
      const r = ((rot % 4) + 4) % 4;
      // для показа достаточно ~900 px по большей стороне
      const k = Math.min(1, 900 / Math.max(img.width, img.height));
      const iw = Math.round(img.width * k), ih = Math.round(img.height * k);
      const cv = document.createElement('canvas');
      cv.width = r % 2 ? ih : iw; cv.height = r % 2 ? iw : ih;
      const c = cv.getContext('2d')!;
      c.translate(cv.width / 2, cv.height / 2);
      c.rotate((r * Math.PI) / 2);
      c.drawImage(img, -iw / 2, -ih / 2, iw, ih);
      if (alive) setOut({ url: cv.toDataURL('image/jpeg', 0.85), w: cv.width, h: cv.height });
    };
    img.src = url;
    return () => { alive = false; };
  }, [url, rot]);
  return out;
}

type Handle = 'move' | 'nw' | 'ne' | 'sw' | 'se';
const MIN = 0.05;

export function CropEditor({ url, rot, crop, onChange }: { url: string; rot: number; crop: Crop; onChange(c: Crop): void }) {
  const img = useRotatedUrl(url, rot);
  const ref = useRef<SVGSVGElement>(null);
  const drag = useRef<{ h: Handle; start: [number, number]; c: Crop } | null>(null);
  if (!img) return <div className="hint" style={{ padding: 20 }}>Готовим фото…</div>;
  const { w, h } = img;

  const toNorm = (e: React.PointerEvent): [number, number] => {
    const m = ref.current!.getScreenCTM();
    if (!m) return [0, 0];
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse());
    return [Math.max(0, Math.min(1, p.x / w)), Math.max(0, Math.min(1, p.y / h))];
  };
  const down = (hd: Handle) => (e: React.PointerEvent) => {
    e.stopPropagation();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    drag.current = { h: hd, start: toNorm(e), c: crop };
  };
  const move = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const [x, y] = toNorm(e);
    const dx = x - d.start[0], dy = y - d.start[1];
    let { x0, y0, x1, y1 } = d.c;
    if (d.h === 'move') {
      const cw = x1 - x0, ch = y1 - y0;
      x0 = Math.max(0, Math.min(1 - cw, x0 + dx)); y0 = Math.max(0, Math.min(1 - ch, y0 + dy));
      x1 = x0 + cw; y1 = y0 + ch;
    } else {
      if (d.h.includes('w')) x0 = Math.max(0, Math.min(x1 - MIN, x0 + dx));
      if (d.h.includes('e')) x1 = Math.min(1, Math.max(x0 + MIN, x1 + dx));
      if (d.h.includes('n')) y0 = Math.max(0, Math.min(y1 - MIN, y0 + dy));
      if (d.h.includes('s')) y1 = Math.min(1, Math.max(y0 + MIN, y1 + dy));
    }
    onChange({ x0, y0, x1, y1 });
  };
  const up = () => { drag.current = null; };

  const X0 = crop.x0 * w, Y0 = crop.y0 * h, X1 = crop.x1 * w, Y1 = crop.y1 * h;
  const R = Math.max(w, h) / 45;
  const corners: [Handle, number, number][] = [['nw', X0, Y0], ['ne', X1, Y0], ['sw', X0, Y1], ['se', X1, Y1]];
  return (
    <svg ref={ref} viewBox={`0 0 ${w} ${h}`} style={{ width: '100%', maxHeight: '60vh', touchAction: 'none', display: 'block', background: '#222', borderRadius: 10 }}
      onPointerMove={move} onPointerUp={up} onPointerCancel={up} aria-label="Обрезка фото">
      <image href={img.url} x={0} y={0} width={w} height={h} />
      {/* затемнение вне кадра */}
      <path d={`M0 0H${w}V${h}H0Z M${X0} ${Y0}V${Y1}H${X1}V${Y0}Z`} fill="rgba(0,0,0,.55)" fillRule="evenodd" />
      {/* сетка третей — помогает поставить лицо */}
      <g stroke="rgba(255,255,255,.45)" strokeWidth={R / 8}>
        {[1, 2].map((k) => <line key={'v' + k} x1={X0 + ((X1 - X0) * k) / 3} x2={X0 + ((X1 - X0) * k) / 3} y1={Y0} y2={Y1} />)}
        {[1, 2].map((k) => <line key={'h' + k} y1={Y0 + ((Y1 - Y0) * k) / 3} y2={Y0 + ((Y1 - Y0) * k) / 3} x1={X0} x2={X1} />)}
      </g>
      <rect x={X0} y={Y0} width={X1 - X0} height={Y1 - Y0} fill="transparent" stroke="#ff8a2a" strokeWidth={R / 4} style={{ cursor: 'move' }} onPointerDown={down('move')} />
      {corners.map(([hd, x, y]) => (
        <rect key={hd} x={x - R / 2} y={y - R / 2} width={R} height={R} fill="#ff8a2a" stroke="#fff" strokeWidth={R / 8}
          style={{ cursor: hd === 'nw' || hd === 'se' ? 'nwse-resize' : 'nesw-resize' }} onPointerDown={down(hd)} />
      ))}
    </svg>
  );
}
