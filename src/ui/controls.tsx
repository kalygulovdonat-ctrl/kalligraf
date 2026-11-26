import { useEffect, useState, type ReactNode } from 'react';
import { X } from 'lucide-react';

export function Num(props: { label: string; value: number; onChange: (v: number) => void; min?: number; max?: number; step?: number; title?: string }) {
  const [txt, setTxt] = useState(String(props.value));
  useEffect(() => { if (Number(txt.replace(',', '.')) !== props.value) setTxt(String(props.value)); }, [props.value]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <label className="field" title={props.title}>
      <span>{props.label}</span>
      <input
        type="number" value={txt} min={props.min} max={props.max} step={props.step ?? 1}
        onChange={(e) => {
          setTxt(e.target.value);
          const v = Number(e.target.value.replace(',', '.'));
          if (e.target.value !== '' && Number.isFinite(v)) {
            const c = Math.min(props.max ?? Infinity, Math.max(props.min ?? -Infinity, v));
            props.onChange(c);
          }
        }}
        onBlur={() => setTxt(String(props.value))}
      />
    </label>
  );
}

export function Slider(props: { label: string; value: number; onChange: (v: number) => void; min: number; max: number; step?: number; fmt?: (v: number) => string; title?: string }) {
  return (
    <label className="field" title={props.title}>
      <span>{props.label}<em>{props.fmt ? props.fmt(props.value) : props.value}</em></span>
      <input type="range" min={props.min} max={props.max} step={props.step ?? 1} value={props.value} onChange={(e) => props.onChange(Number(e.target.value))} />
    </label>
  );
}

export function Sel<T extends string>(props: { label: string; value: T; onChange: (v: T) => void; options: [T, string][]; title?: string }) {
  return (
    <label className="field" title={props.title}>
      <span>{props.label}</span>
      <select value={props.value} onChange={(e) => props.onChange(e.target.value as T)}>
        {props.options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
    </label>
  );
}

export function Txt(props: { label: string; value: string; onChange: (v: string) => void; placeholder?: string; mono?: boolean }) {
  return (
    <label className="field">
      <span>{props.label}</span>
      <input type="text" value={props.value} placeholder={props.placeholder} onChange={(e) => props.onChange(e.target.value)} style={props.mono ? { fontFamily: 'ui-monospace, monospace' } : undefined} />
    </label>
  );
}

export function Check(props: { label: string; value: boolean; onChange: (v: boolean) => void; title?: string }) {
  return (
    <label className="check" title={props.title}>
      <input type="checkbox" checked={props.value} onChange={(e) => props.onChange(e.target.checked)} />
      {props.label}
    </label>
  );
}

export function Seg<T extends string>(props: { value: T; onChange: (v: T) => void; options: [T, ReactNode, string][] }) {
  return (
    <div className="seg" role="radiogroup">
      {props.options.map(([v, node, title]) => (
        <button key={v} type="button" className={props.value === v ? 'on' : ''} onClick={() => props.onChange(v)} title={title} aria-label={title} role="radio" aria-checked={props.value === v}>
          {node}
        </button>
      ))}
    </div>
  );
}

export function Section(props: { title?: string; children: ReactNode; right?: ReactNode }) {
  return (
    <div className="section">
      {props.title && <h3 style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>{props.title}{props.right}</h3>}
      {props.children}
    </div>
  );
}

export function Modal(props: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); props.onClose(); } };
    window.addEventListener('keydown', k, true);
    return () => window.removeEventListener('keydown', k, true);
  }, [props]);
  return (
    <div className="modal-back" onMouseDown={(e) => { if (e.target === e.currentTarget) props.onClose(); }}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={props.title} style={props.wide ? { width: 'min(820px, 100%)' } : undefined}>
        <div className="modal-head">
          <h2>{props.title}</h2>
          <button className="btn ghost icon" onClick={props.onClose} aria-label="Закрыть"><X /></button>
        </div>
        <div className="modal-body">{props.children}</div>
        {props.footer && <div className="modal-foot">{props.footer}</div>}
      </div>
    </div>
  );
}

export function downloadText(name: string, text: string, type = 'text/plain') {
  const blob = new Blob([text], { type: type + ';charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

export function pickFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = accept;
    inp.onchange = () => resolve(inp.files?.[0] ?? null);
    inp.click();
  });
}

export const safeName = (s: string) => (s || 'kalligraf').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 60);
