import { useMemo, useRef, useState } from 'react';
import { Copy, FileUp, ImagePlus, PenTool, Shuffle, Trash2 } from 'lucide-react';
import { PhotoArt } from './PhotoArt';
import { GENERATORS, type GenDef } from '../core/generators';
import { bboxOf, chaikin, simplify, type Path, type Pt } from '../core/geometry';
import { findFont, uid, useApp, useProfile, type ArtItem } from '../store';
import { Check, Modal, Num, Section, Sel, Txt, pickFile } from '../ui/controls';
import { Thumb } from '../ui/SheetView';
import { itemLocalPaths, placeItem, PEN_COLORS, COLOR_NAMES } from '../job';
import { t } from '../i18n';
import { compileExpr as compile } from '../core/expr';
import { parseMath } from '../core/math';
import { parseSvg } from '../core/svgparse';
import { encodeQr, type Ecc } from '../core/qr';

export function ArtRight() {
  const doc = useApp((s) => s.doc);
  const setDoc = useApp((s) => s.setDoc);
  const sel = useApp((s) => s.selectedItem);
  const setState = useApp((s) => s.setState);
  const notify = useApp((s) => s.notify);
  const userFonts = useApp((s) => s.userFonts);
  const font = findFont(doc.fontId, userFonts);
  const [sig, setSig] = useState(false);
  const [photoArt, setPhotoArt] = useState(false);
  const item = doc.items.find((i) => i.id === sel);
  const prof = useProfile();
  // Свободная область: пересечение листа и рабочего поля машины, с отступом 10 мм
  const area = {
    x: Math.max(0, prof.offsetX) + 10, y: Math.max(0, prof.offsetY) + 10,
    w: Math.min(doc.sheet.w, prof.offsetX + prof.workW) - Math.max(0, prof.offsetX) - 20,
    h: Math.min(doc.sheet.h, prof.offsetY + prof.workH) - Math.max(0, prof.offsetY) - 20,
  };
  const fit = (w: number, h: number) => {
    const k = Math.min(1, area.w / w, area.h / h);
    const scale = Math.floor(k * 100) / 100;
    const x = Math.round(area.x + (area.w - w * scale) / 2);
    let y = Math.round(area.y + (area.h - h * scale) / 2);
    // Не класть поверх уже стоящих рисунков: если ниже них есть место — ставим туда
    const boxes = doc.items.filter((i) => i.page === 0).map((i) => bboxOf(placeItem(i, font, doc.sheet))).filter((b): b is NonNullable<typeof b> => !!b);
    const overlaps = boxes.some((b) => b.minX < x + w * scale && b.maxX > x && b.minY < y + h * scale && b.maxY > y);
    if (overlaps) {
      const below = Math.max(...boxes.map((b) => b.maxY)) + 6;
      if (below + h * scale <= area.y + area.h) y = Math.round(below);
      else {
        const above = Math.min(...boxes.map((b) => b.minY)) - 6 - h * scale;
        if (above >= area.y) y = Math.round(above);
      }
    }
    return { scale, x, y };
  };

  const add = (g: GenDef) => {
    const it: ArtItem = { id: uid(), kind: g.kind, title: g.title, params: { ...g.defaults }, x: 20, y: 20, scale: 1, rotation: 0, page: 0 };
    if (g.kind === 'gost') { it.x = 0; it.y = 0; }
    // вписать в лист
    const b = bboxOf(itemLocalPaths(it, font, doc.sheet));
    if (b && g.kind !== 'gost') {
      Object.assign(it, fit(b.maxX - b.minX, b.maxY - b.minY));
    }
    setDoc((d) => ({ ...d, items: [...d.items, it] }));
    setState({ selectedItem: it.id });
  };
  const upd = (p: Partial<ArtItem>, merge = true) => item && setDoc((d) => ({ ...d, items: d.items.map((i) => (i.id === item.id ? { ...i, ...p } : i)) }), { merge });
  const updParam = (k: string, v: unknown) => item && upd({ params: { ...item.params, [k]: v } });

  const importSvg = async () => {
    const f = await pickFile('.svg,image/svg+xml');
    if (!f) return;
    try {
      const paths = svgToPaths(await f.text());
      if (!paths.length) throw new Error('В файле нет линий');
      const b = bboxOf(paths)!;
      const it: ArtItem = { id: uid(), kind: 'svg', title: f.name, params: {}, paths, rotation: 0, page: 0, ...fit(b.maxX - b.minX, b.maxY - b.minY) };
      setDoc((d) => ({ ...d, items: [...d.items, it] }));
      setState({ selectedItem: it.id });
      notify(`SVG загружен: ${paths.length} линий`, 'success');
    } catch (e) {
      notify('Не удалось прочитать SVG: ' + (e as Error).message, 'error');
    }
  };

  const gen = item ? GENERATORS.find((g) => g.kind === item.kind) : undefined;
  return (
    <div>
      <div className="panel-head"><h2>{t('Рисунки')}</h2>
        <div className="btn-row">
          <button className="btn small primary" onClick={() => setPhotoArt(true)} title="Фото превращается в рисунок для ручки: контуры, штриховка, точки, одна линия…"><ImagePlus />Фото</button>
          <button className="btn small" onClick={importSvg} title="Импорт SVG (Inkscape, Figma, AutoCAD → SVG)"><FileUp />SVG</button>
          <button className="btn small" onClick={() => setSig(true)} title="Нарисовать подпись"><PenTool />Подпись</button>
        </div>
      </div>
      {item ? (
        <>
          <Section title={item.title} right={<button className="btn small ghost" onClick={() => setState({ selectedItem: null })}>← все</button>}>
            <div className="grid2">
              <Num label="X, мм" value={round(item.x)} step={1} onChange={(v) => upd({ x: v })} />
              <Num label="Y, мм" value={round(item.y)} step={1} onChange={(v) => upd({ y: v })} />
              <Num label="Масштаб" value={item.scale} min={0.01} max={20} step={0.05} onChange={(v) => upd({ scale: v })} />
              <Num label="Поворот, °" value={item.rotation} min={-360} max={360} step={5} onChange={(v) => upd({ rotation: v })} />
              <Num label="Лист №" value={item.page + 1} min={1} max={99} onChange={(v) => upd({ page: v - 1 })} />
              <Sel label={t('Цвет (ручка)')} value={item.color ?? ''} onChange={(v) => upd({ color: v || undefined }, false)} options={PEN_COLORS.map((c) => [c, COLOR_NAMES[c] ?? c])} />
            </div>
            {gen && gen.params.map((pd) => {
              const v = item.params[pd.key];
              if (pd.type === 'number') return <Num key={pd.key} label={pd.label} value={Number(v)} min={pd.min} max={pd.max} step={pd.step} onChange={(x) => updParam(pd.key, x)} />;
              if (pd.type === 'bool') return <Check key={pd.key} label={pd.label} value={!!v} onChange={(x) => updParam(pd.key, x)} />;
              if (pd.type === 'select') return <Sel key={pd.key} label={pd.label} value={String(v)} options={pd.options!} onChange={(x) => updParam(pd.key, x)} />;
              return <Txt key={pd.key} label={pd.label} value={String(v ?? '')} onChange={(x) => updParam(pd.key, x)} />;
            })}
            {item.kind === 'graph' && <GraphCheck expr={String(item.params.exprs)} />}
            {item.kind === 'formula' && <FormulaHelp latex={String(item.params.latex ?? '')} onInsert={(s) => updParam('latex', String(item.params.latex ?? '') + s)} />}
            {item.kind === 'qr' && <QrInfo p={item.params} />}
            <div className="btn-row">
              {gen?.params.some((p) => p.key === 'seed') && <button className="btn small" onClick={() => updParam('seed', Math.floor(Math.random() * 99999) + 1)}><Shuffle />Случайно</button>}
              <button className="btn small" onClick={() => {
                const c = { ...item, id: uid(), x: item.x + 10, y: item.y + 10 };
                setDoc((d) => ({ ...d, items: [...d.items, c] })); setState({ selectedItem: c.id });
              }}><Copy />Копия</button>
              <button className="btn small" onClick={() => { setDoc((d) => ({ ...d, items: d.items.filter((i) => i.id !== item.id) })); setState({ selectedItem: null }); }}><Trash2 />{t('Удалить')}</button>
            </div>
            <div className="hint" style={{ marginTop: 8 }}>Перетаскивайте рисунок мышью прямо на листе. Отменить — Ctrl+Z.</div>
          </Section>
        </>
      ) : (
        <>
          {doc.items.length > 0 && (
            <Section title="На листе">
              <div className="list">
                {doc.items.map((i) => (
                  <div key={i.id} className="list-item" onClick={() => setState({ selectedItem: i.id })}>
                    <span className="grow">{i.title}</span><span className="hint">лист {i.page + 1}</span>
                  </div>
                ))}
              </div>
            </Section>
          )}
          <Section title={t('Добавить на лист')}>
            <div className="cards">
              {GENERATORS.map((g) => <GenCard key={g.kind} g={g} onClick={() => add(g)} />)}
            </div>
          </Section>
        </>
      )}
      {photoArt && <PhotoArt maxWidth={Math.max(30, area.w)} onClose={() => setPhotoArt(false)} onAdd={(paths, title) => {
        const b = bboxOf(paths)!;
        const it: ArtItem = { id: uid(), kind: 'svg', title, params: {}, paths, rotation: 0, page: 0, ...fit(b.maxX - b.minX, b.maxY - b.minY) };
        setDoc((d) => ({ ...d, items: [...d.items, it] }));
        setState({ selectedItem: it.id });
        setPhotoArt(false);
        notify('Рисунок добавлен на лист. Двигайте мышью, время письма — в «Печати».', 'success');
      }} />}
      {sig && <SignaturePad onClose={() => setSig(false)} onSave={(paths) => {
        const it: ArtItem = { id: uid(), kind: 'signature', title: 'Подпись', params: {}, paths, x: Math.max(area.x, area.x + area.w - 120), y: Math.max(area.y, area.y + area.h - 40), scale: 1, rotation: 0, page: 0 };
        setDoc((d) => ({ ...d, items: [...d.items, it] }));
        setState({ selectedItem: it.id });
        setSig(false);
      }} />}
    </div>
  );
}

const round = (n: number) => Math.round(n * 10) / 10;

function GraphCheck({ expr }: { expr: string }) {
  const err = useMemo(() => {
    try {
      // проверяем каждую формулу
      for (const e of expr.split(';').map((s) => s.trim()).filter(Boolean)) {
        compile(e.replace(/^y\s*=\s*/i, ''));
      }
      return '';
    } catch (e) { return (e as Error).message; }
  }, [expr]);
  return err ? <div className="err-box">Ошибка в формуле: {err}</div> : <div className="hint" style={{ marginBottom: 8 }}>Можно: + − * / ^, sin, cos, tg, sqrt, abs, ln, log, exp, pi. Пример: <b>x^2 - 2x + 1</b></div>;
}

const SNIPPETS: [string, string][] = [['a/b', '\\frac{}{}'], ['√', '\\sqrt{}'], ['xⁿ', '^{}'], ['xₙ', '_{}'], ['Σ', '\\sum_{i=1}^{n} '], ['∫', '\\int_{a}^{b} '], ['lim', '\\lim_{x \\to 0} '],
  ['( )', '\\left( \\right)'], ['π', '\\pi '], ['α', '\\alpha '], ['Δ', '\\Delta '], ['±', '\\pm '], ['·', '\\cdot '], ['≤', '\\le '], ['≥', '\\ge '], ['≠', '\\ne '], ['∞', '\\infty '], ['sin', '\\sin '], ['→', '\\to '], ['⏎', ' \\\\ ']];

function FormulaHelp({ latex, onInsert }: { latex: string; onInsert(s: string): void }) {
  const err = useMemo(() => { try { parseMath(latex); return ''; } catch (e) { return (e as Error).message; } }, [latex]);
  return (
    <div style={{ marginBottom: 10 }}>
      {err ? <div className="err-box">Ошибка в формуле: {err}</div> : <div className="ok-box" style={{ padding: '5px 9px' }}>Формула в порядке</div>}
      <div className="btn-row" style={{ gap: 4 }}>
        {SNIPPETS.map(([l, s]) => <button key={l} className="btn small" style={{ padding: '3px 7px' }} onClick={() => onInsert(s)} title={s}>{l}</button>)}
      </div>
      <div className="hint" style={{ marginTop: 6 }}>Пишется как в LaTeX: {['x^2', 'a_1', '\\frac{a}{b}', '\\sqrt{x}', '\\sum_{i=1}^n', '\\int_0^1', '\\alpha', '\\text{слово}'].map((s, i) => <span key={s}>{i ? ', ' : ''}<b>{s}</b></span>)}, новая строка — <b>{'\\\\'}</b>.</div>
    </div>
  );
}

function QrInfo({ p }: { p: Record<string, unknown> }) {
  const info = useMemo(() => {
    try {
      const q = encodeQr(String(p.text || ' '), p.ecc as Ecc);
      const side = (q.size + 2 * Number(p.border)) * Number(p.module);
      return { ok: true, text: `Версия ${q.version}, ${q.size}×${q.size} клеток, надёжность ${q.ecc}. Размер ${side.toFixed(0)}×${side.toFixed(0)} мм.`, small: Number(p.module) < 1.2 };
    } catch (e) { return { ok: false, text: (e as Error).message, small: false }; }
  }, [p]);
  return (
    <div style={{ marginBottom: 10 }}>
      <div className={info.ok ? 'hint' : 'err-box'}>{info.text}</div>
      {info.small && <div className="warn-box" style={{ marginTop: 6 }}>Клетка меньше 1,2 мм — телефон может не прочитать. Сделайте клетку крупнее или текст короче.</div>}
      <div className="hint" style={{ marginTop: 6 }}>Клетки закрашиваются штрихами с шагом в толщину линии ручки — укажите её точно (гелевая ≈ 0,5 мм, линер 0,3–0,8 мм). Проверьте готовый код камерой телефона.</div>
    </div>
  );
}

function GenCard({ g, onClick }: { g: GenDef; onClick(): void }) {
  const userFonts = useApp((s) => s.userFonts);
  const fontId = useApp((s) => s.doc.fontId);
  const paths = useMemo(() => {
    const p = { ...g.defaults };
    if (g.kind === 'maze') Object.assign(p, { cols: 10, rows: 5 });
    if (g.kind === 'flow') Object.assign(p, { lines: 80 });
    if (g.kind === 'sudoku') Object.assign(p, { clues: 70 });
    return itemLocalPaths({ id: 'x', kind: g.kind, title: '', params: p, x: 0, y: 0, scale: 1, rotation: 0, page: 0 }, findFont(fontId, userFonts), { w: 210, h: 297 });
  }, [g, fontId, userFonts]);
  return (
    <button className="card" onClick={onClick} title={`Добавить: ${g.title}`}>
      <Thumb paths={paths} className="thumb" />
      <span className="title">{g.title}</span>
    </button>
  );
}

/** SVG → пути в мм. Свой быстрый разбор (кривые считаются сами, без браузерных вызовов на каждую точку). */
export function svgToPaths(text: string): Path[] {
  return parseSvg(text).paths;
}

function SignaturePad({ onClose, onSave }: { onClose(): void; onSave(p: Path[]): void }) {
  const [strokes, setStrokes] = useState<Pt[][]>([]);
  const cur = useRef<Pt[] | null>(null);
  const [, f] = useState(0);
  const ref = useRef<SVGSVGElement>(null);
  const W = 120, H = 40;
  const pos = (e: React.PointerEvent): Pt => {
    const r = ref.current!.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * W, ((e.clientY - r.top) / r.height) * H];
  };
  const d = (cur.current ? [...strokes, cur.current] : strokes).map((s) => 'M' + s.map((p) => p.map((n) => n.toFixed(2)).join(' ')).join('L')).join('');
  return (
    <Modal title="Подпись" onClose={onClose} footer={<>
      <button className="btn" onClick={() => setStrokes([])}>{t('Очистить')}</button>
      <button className="btn primary" disabled={!strokes.length} onClick={() => {
        const b = bboxOf(strokes.map((points) => ({ points })))!;
        onSave(strokes.map((s) => ({ points: s.map(([x, y]) => [x - b.minX, y - b.minY] as Pt) })));
      }}>Добавить на лист</button>
    </>}>
      <p className="hint">Распишитесь мышкой, пальцем или стилусом. Поле — 120×40 мм. Подпись хранится только на этом компьютере. Не используйте чужую подпись.</p>
      <svg ref={ref} viewBox={`0 0 ${W} ${H}`} className="draw-pad" style={{ width: '100%', aspectRatio: `${W}/${H}` }}
        onPointerDown={(e) => { (e.target as Element).setPointerCapture?.(e.pointerId); cur.current = [pos(e)]; f((n) => n + 1); }}
        onPointerMove={(e) => { if (cur.current) { cur.current.push(pos(e)); f((n) => n + 1); } }}
        onPointerUp={() => { const s = cur.current; cur.current = null; if (s && s.length) setStrokes((x) => [...x, chaikin(simplify(s, 0.08), 1)]); }}>
        <line x1={5} x2={115} y1={32} y2={32} stroke="#c9d6ea" strokeWidth={0.3} />
        <path d={d} stroke="#2b2d6e" strokeWidth={0.6} fill="none" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </Modal>
  );
}
