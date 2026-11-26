// Части мастера «Почерк по фото», общие для ПК и телефона (без зависимости от хранилища).
import { useEffect, useRef } from 'react';
import type { Pt } from '../core/geometry';
import { TPL } from '../core/template';
import { CELL_INSET, type CellResult } from '../core/vision';

export function CornerEditor({ url, w, h, corners, onChange }: { url: string; w: number; h: number; corners: Pt[]; onChange(c: Pt[]): void }) {
  const ref = useRef<SVGSVGElement>(null);
  const drag = useRef<number | null>(null);
  // Экран → координаты фото (с учётом полей вокруг картинки при вписывании)
  const toImg = (e: React.PointerEvent): Pt => {
    const svg = ref.current!;
    const m = svg.getScreenCTM();
    if (!m) return [0, 0];
    const pt = new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse());
    return [Math.max(0, Math.min(w, pt.x)), Math.max(0, Math.min(h, pt.y))];
  };
  const R = Math.max(w, h) / 60;
  return (
    <svg ref={ref} viewBox={`0 0 ${w} ${h}`} style={{ width: '100%', maxHeight: '60vh', touchAction: 'none', background: '#222', borderRadius: 10 }}
      onPointerMove={(e) => { if (drag.current === null) return; const c = corners.slice(); c[drag.current] = toImg(e); onChange(c); }}
      onPointerUp={() => { drag.current = null; }}>
      <image href={url} x={0} y={0} width={w} height={h} />
      <polygon points={corners.map((p) => p.join(',')).join(' ')} fill="rgba(77,171,247,.12)" stroke="#4dabf7" strokeWidth={R / 5} />
      {corners.map(([x, y], i) => (
        <g key={i} style={{ cursor: 'grab' }} onPointerDown={(e) => { (e.target as Element).setPointerCapture?.(e.pointerId); drag.current = i; }}>
          <circle cx={x} cy={y} r={R} fill="rgba(255,138,42,.35)" stroke="#ff8a2a" strokeWidth={R / 5} />
          <circle cx={x} cy={y} r={R / 6} fill="#ff8a2a" />
          <text x={x + R * 1.2} y={y - R * 1.2} fontSize={R * 1.3} fill="#ff8a2a" fontWeight={800}>{i + 1}</text>
        </g>
      ))}
    </svg>
  );
}

export function CellCard({ c, S, on, onClick }: { c: CellResult; S: number; on: boolean; onClick(): void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const n = c.cropSize;
    cv.width = n; cv.height = n;
    const ctx = cv.getContext('2d')!;
    const img = ctx.createImageData(n, n);
    for (let i = 0; i < n * n; i++) { const v = c.crop[i]; img.data[i * 4] = v; img.data[i * 4 + 1] = v; img.data[i * 4 + 2] = v; img.data[i * 4 + 3] = 255; }
    ctx.putImageData(img, 0, 0);
    // базовая линия
    const by = (TPL.base - CELL_INSET) * S;
    ctx.strokeStyle = 'rgba(77,171,247,.6)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, by); ctx.lineTo(n, by); ctx.stroke();
    // штрихи
    ctx.strokeStyle = '#e03131'; ctx.fillStyle = '#e03131'; ctx.lineWidth = 1.6; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    const P = ([x, y]: Pt): Pt => [((x - c.shift) * TPL.unitMM - CELL_INSET) * S, (TPL.base - y * TPL.unitMM - CELL_INSET) * S];
    for (const s of c.strokes) {
      if (s.length === 1) { const [x, y] = P(s[0]); ctx.beginPath(); ctx.arc(x, y, 2, 0, 7); ctx.fill(); continue; }
      ctx.beginPath();
      s.forEach((pt, i) => { const [x, y] = P(pt); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
      ctx.stroke();
    }
  }, [c, S]);
  const cls = !c.strokes.length ? 'empty' : c.flags.length ? 'warn' : 'ok';
  const why = c.flags.map((f) => ({ empty: 'пусто', many: 'много штрихов', small: 'очень маленькая', big: 'вышла за линии' })[f]).join(', ');
  return (
    <button className={`cell-card ${cls} ${on ? 'on' : ''}`} onClick={onClick} title={`${c.char}${why ? ' — ' + why : ''}`} aria-pressed={on}>
      <canvas ref={ref} />
      <span className="lbl">{c.char}</span>
      {c.strokes.length > 0 && <span className="chk">{on ? '✓' : ''}</span>}
    </button>
  );
}
