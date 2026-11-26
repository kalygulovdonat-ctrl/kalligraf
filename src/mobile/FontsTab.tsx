// Телефон: свои почерки — по фото листа, рисованием пальцем и из файла (.ttf / .kfont с компьютера).
import { useMemo, useRef, useState } from 'react';
import { builtinFonts, exportFont, HANDWRITING_SET, importFont, type Font, type GlyphVariant } from '../core/font';
import { EN_LOWER, EN_UPPER } from '../core/fontData';
import { parseTtf } from '../core/ttf';
import { convertFont } from '../core/fontconvert';
import { textPaths } from '../core/generators';
import { chaikin, simplify, type Path, type Pt, type Stroke } from '../core/geometry';
import { CELLS_PER_PAGE, templateChars, templatesHtml } from '../core/template';
import { MarkersNotFound, processSheet, toGray, type Gray, type SheetResult } from '../core/vision';
import { CellCard, CornerEditor } from '../ui/photoParts';
import { printHtml, saveText } from './native';

type Msg = (m: { text: string; bad?: boolean }) => void;
const uid = () => Math.random().toString(36).slice(2, 10);
const SAMPLE = 'Привет, мир! Өмүр';

function svgD(paths: Path[]) {
  return paths.map((p) => p.points.length === 1
    ? `M${p.points[0][0].toFixed(1)} ${p.points[0][1].toFixed(1)}l0.05 0`
    : 'M' + p.points.map(([x, y]) => `${x.toFixed(1)} ${y.toFixed(1)}`).join('L')).join('');
}

function Preview({ font }: { font: Font }) {
  const d = useMemo(() => {
    const fb = builtinFonts()[0];
    return svgD(textPaths(SAMPLE, { ...fb, glyphs: { ...(font.builtin ? {} : fb.glyphs), ...font.glyphs } }, 0, 10, 8));
  }, [font]);
  return (
    <svg className="m-font-prev" viewBox="-2 -1 112 15">
      <path d={d} stroke="#22307a" strokeWidth={0.45} fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function FontsTab({ userFonts, setUserFonts, fontId, onUse, setMsg }: {
  userFonts: Font[]; setUserFonts: (f: (x: Font[]) => Font[]) => void; fontId: string; onUse: (id: string) => void; setMsg: Msg;
}) {
  const [mode, setMode] = useState<null | 'photo' | { draw: string }>(null);
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const builtins = builtinFonts().filter((f) => !f.id.startsWith('drafting'));
  const update = (id: string, fn: (f: Font) => Font) => setUserFonts((xs) => xs.map((f) => (f.id === id ? fn(f) : f)));

  async function importFile(file: File | undefined) {
    if (!file) return;
    try {
      let f: Font;
      if (/\.(ttf|otf)$/i.test(file.name)) {
        setMsg({ text: 'Перевожу шрифт в однолинейный…' });
        await new Promise((r) => setTimeout(r, 50));
        const ttf = parseTtf(await file.arrayBuffer());
        f = convertFont(ttf, { id: 'u-' + uid(), name: ttf.name || file.name.replace(/\.\w+$/, ''), license: 'Личное использование' });
        if (Object.keys(f.glyphs).length < 11) throw new Error('в шрифте почти нет нужных букв');
      } else {
        f = importFont(JSON.parse(await file.text()));
        f = { ...f, id: userFonts.some((x) => x.id === f.id) || builtins.some((x) => x.id === f.id) ? 'u-' + uid() : f.id, builtin: false };
      }
      setUserFonts((xs) => [...xs, f]);
      onUse(f.id);
      const ru = [...'АБВабв'].filter((c) => f.glyphs[c]).length;
      setMsg({ text: `Почерк «${f.name}» добавлен: ${Object.keys(f.glyphs).length - 1} символов${ru < 6 ? '. Русских букв нет — они напишутся «Печатным»' : ''}` });
    } catch (e) {
      setMsg({ text: 'Не удалось открыть шрифт: ' + (e as Error).message, bad: true });
    } finally { if (fileRef.current) fileRef.current.value = ''; }
  }

  function create() {
    const f: Font = { id: 'u-' + uid(), name: 'Мой почерк', license: 'Личное использование', createdAt: Date.now(), glyphs: { ' ': { variants: [{ advance: 4, strokes: [] }] } } };
    setUserFonts((xs) => [...xs, f]);
    setMode({ draw: f.id });
  }

  if (mode === 'photo') return <PhotoWizard userFonts={userFonts} setUserFonts={setUserFonts} onUse={onUse} setMsg={setMsg} onClose={() => setMode(null)} />;
  if (mode && typeof mode === 'object') {
    const f = userFonts.find((x) => x.id === mode.draw);
    if (f) return <DrawEditor font={f} update={(fn) => update(f.id, fn)} onClose={() => { setMode(null); onUse(f.id); }} />;
  }

  return (
    <div className="m-pult">
      <button className="m-btn primary" onClick={() => setMode('photo')}>📷 Почерк по фото листа</button>
      <div className="m-grid2">
        <button className="m-btn" onClick={create}>✎ Нарисовать пальцем</button>
        <button className="m-btn" onClick={() => fileRef.current?.click()}>⬆ Из файла</button>
      </div>
      <input ref={fileRef} type="file" accept=".ttf,.otf,.kfont,.json" hidden onChange={(e) => importFile(e.target.files?.[0])} />
      <div className="m-hint">
        <b>По фото:</b> распечатайте шаблон, напишите буквы ручкой и сфотографируйте. <b>Из файла:</b> обычный шрифт .ttf
        или почерк .kfont, сохранённый на компьютере («Почерки» → скачать).
      </div>

      {userFonts.length > 0 && <div className="m-section">Мои почерки</div>}
      {userFonts.map((f) => (
        <div key={f.id} className={'m-font' + (fontId === f.id ? ' on' : '')}>
          <input className="m-font-name" value={f.name} onChange={(e) => update(f.id, (x) => ({ ...x, name: e.target.value }))} aria-label="Название почерка" />
          <Preview font={f} />
          <div className="m-hint">{Object.keys(f.glyphs).filter((c) => c !== ' ').length} символов</div>
          <div className="m-tools">
            <button className="m-btn small primary" disabled={fontId === f.id} onClick={() => onUse(f.id)}>{fontId === f.id ? '✓ Выбран' : 'Выбрать'}</button>
            <button className="m-btn small" onClick={() => setMode({ draw: f.id })}>Буквы</button>
            <button className="m-btn small" onClick={() => saveText(f.name.replace(/[^\wа-яё -]+/gi, '_') + '.kfont', 'application/json', JSON.stringify(exportFont(f)))
              .then((where) => setMsg({ text: `Сохранено: ${where}` })).catch((e) => setMsg({ text: String(e.message || e), bad: true }))}>Сохранить файл</button>
            {confirmDel === f.id
              ? <button className="m-btn small danger" onClick={() => { setUserFonts((xs) => xs.filter((x) => x.id !== f.id)); if (fontId === f.id) onUse('hw-caveat'); setConfirmDel(null); }}>Точно удалить?</button>
              : <button className="m-btn small" onClick={() => setConfirmDel(f.id)}>✕</button>}
          </div>
        </div>
      ))}

      <div className="m-section">Встроенные</div>
      {builtins.map((f) => (
        <div key={f.id} className={'m-font' + (fontId === f.id ? ' on' : '')}>
          <b>{f.name}</b>
          <Preview font={f} />
          <button className="m-btn small primary" disabled={fontId === f.id} onClick={() => onUse(f.id)}>{fontId === f.id ? '✓ Выбран' : 'Выбрать'}</button>
        </div>
      ))}
    </div>
  );
}

// ── почерк по фото ─────────────────────────────────────────────────────

async function loadPhoto(file: File): Promise<{ gray: Gray; url: string; w: number; h: number }> {
  let src: ImageBitmap | HTMLImageElement;
  try {
    src = await createImageBitmap(file, { imageOrientation: 'from-image' } as ImageBitmapOptions);
  } catch {
    const url = URL.createObjectURL(file);
    src = await new Promise<HTMLImageElement>((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('не удалось открыть фото')); i.src = url; });
  }
  const W = 'naturalWidth' in src ? src.naturalWidth : src.width, H = 'naturalHeight' in src ? src.naturalHeight : src.height;
  const k = Math.min(1, 3200 / Math.max(W, H));
  const w = Math.round(W * k), h = Math.round(H * k);
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(src, 0, 0, w, h);
  if ('close' in src) src.close();
  const gray = toGray(ctx.getImageData(0, 0, w, h).data, w, h);
  return { gray, url: cv.toDataURL('image/jpeg', 0.7), w, h };
}

function PhotoWizard({ userFonts, setUserFonts, onUse, setMsg, onClose }: {
  userFonts: Font[]; setUserFonts: (f: (x: Font[]) => Font[]) => void; onUse: (id: string) => void; setMsg: Msg; onClose: () => void;
}) {
  const [stage, setStage] = useState<'template' | 'photo' | 'busy' | 'corners' | 'review'>('template');
  const [latin, setLatin] = useState(false);
  const [page, setPage] = useState(0);
  const [photo, setPhoto] = useState<Awaited<ReturnType<typeof loadPhoto>> | null>(null);
  const [res, setRes] = useState<SheetResult | null>(null);
  const [corners, setCorners] = useState<Pt[] | null>(null);
  const [include, setInclude] = useState<Set<number>>(new Set());
  const [target, setTarget] = useState('new');
  const [name, setName] = useState('Мой почерк');
  const [progress, setProgress] = useState('');
  const [err, setErr] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const set = latin ? HANDWRITING_SET + EN_UPPER + EN_LOWER : HANDWRITING_SET;
  const pages = Math.ceil([...set].length / CELLS_PER_PAGE);
  const chars = useMemo(() => templateChars(page, set), [page, set]);

  async function run(p: NonNullable<typeof photo>, manual: Pt[] | null) {
    setStage('busy'); setErr(''); setProgress('Ищу метки на листе…');
    await new Promise((r) => setTimeout(r, 60)); // дать экрану обновиться
    try {
      const r = processSheet(p.gray, chars, { corners: manual, onProgress: (s) => setProgress(s) });
      setRes(r);
      setCorners(r.corners);
      setInclude(new Set(r.cells.filter((c) => c.strokes.length && !c.flags.includes('many') && !c.flags.includes('big')).map((c) => c.index)));
      setStage('review');
    } catch (e) {
      setErr((e as Error).message);
      if (e instanceof MarkersNotFound) {
        const m = 0.08;
        setCorners([[p.w * m, p.h * m], [p.w * (1 - m), p.h * m], [p.w * (1 - m), p.h * (1 - m)], [p.w * m, p.h * (1 - m)]]);
        setStage('corners');
      } else setStage('photo');
    }
  }
  async function onFile(f: File | undefined) {
    if (!f) return;
    try { const p = await loadPhoto(f); setPhoto(p); run(p, null); }
    catch (e) { setErr('Не удалось открыть фото: ' + (e as Error).message); }
    finally { if (fileRef.current) fileRef.current.value = ''; }
  }
  function save() {
    if (!res) return;
    const chosen = res.cells.filter((c) => include.has(c.index) && c.strokes.length);
    if (!chosen.length) return;
    const add = (f: Font): Font => {
      const glyphs = { ...f.glyphs };
      for (const c of chosen) {
        const v: GlyphVariant = { advance: c.advance, strokes: c.strokes };
        glyphs[c.char] = { variants: [...(glyphs[c.char]?.variants.filter((x) => x.strokes.length) ?? []), v] };
      }
      if (!glyphs[' ']) glyphs[' '] = { variants: [{ advance: 4, strokes: [] }] };
      return { ...f, glyphs };
    };
    let id = target;
    if (target === 'new') {
      const f = add({ id: 'u-' + uid(), name: name.trim() || 'Мой почерк', license: 'Личное использование', createdAt: Date.now(), glyphs: {} });
      setUserFonts((xs) => [...xs, f]);
      id = f.id;
    } else setUserFonts((xs) => xs.map((f) => (f.id === target ? add(f) : f)));
    onUse(id);
    setMsg({ text: `Добавлено букв: ${chosen.length}. Почерк выбран для письма.` });
    onClose();
  }

  return (
    <div className="m-pult">
      <div className="m-row"><button className="m-btn small" onClick={onClose}>← Назад</button><b style={{ alignSelf: 'center' }}>Почерк по фото</b></div>

      {stage === 'template' && <>
        <ol className="m-steps">
          <li>Распечатайте шаблон на A4 <b>в масштабе 100%</b>. На телефоне откроется печать — можно выбрать принтер или «Сохранить как PDF» и распечатать позже.</li>
          <li>Напишите в каждой клетке букву, подписанную серым в углу: низ буквы — на синей линии.</li>
          <li>Сфотографируйте лист целиком, чтобы были видны 4 чёрные метки.</li>
        </ol>
        <button className={'m-btn' + (latin ? ' on' : '')} onClick={() => { setLatin(!latin); setPage(0); }}>{latin ? '✓ ' : ''}Добавить английские буквы (+1 лист)</button>
        <button className="m-btn" onClick={() => { try { printHtml(templatesHtml(pages, set), 'Шаблон почерка'); } catch (e) { setMsg({ text: (e as Error).message, bad: true }); } }}>🖨 Распечатать шаблон ({pages} {pages > 1 ? 'листа' : 'лист'})</button>
        <button className="m-btn primary" onClick={() => setStage('photo')}>Лист заполнен — сфотографировать</button>
        <div className="m-hint">Хотите «живой» почерк — заполните шаблон 2–3 раза и добавьте каждое фото в тот же почерк: у букв будет несколько вариантов.</div>
      </>}

      {stage === 'photo' && <>
        {pages > 1 && (
          <div className="m-seg small">
            {Array.from({ length: pages }, (_, i) => <button key={i} className={page === i ? 'on' : ''} onClick={() => setPage(i)}>Лист {i + 1}</button>)}
          </div>
        )}
        <button className="m-btn primary big" onClick={() => fileRef.current?.click()}>📷 Сфотографировать лист{pages > 1 ? ` ${page + 1}` : ''}</button>
        <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => onFile(e.target.files?.[0])} />
        {err && <div className="m-hint warn">{err}</div>}
        <div className="m-hint">Советы: тёмная гелевая ручка, ровный свет без тени от телефона, камера над листом, лист без сгибов.</div>
      </>}

      {stage === 'busy' && <div className="m-banner">{progress || 'Распознаю буквы…'}</div>}

      {stage === 'corners' && photo && corners && <>
        {err && <div className="m-hint warn">{err}</div>}
        <div className="m-hint">Перетащите 4 кружка на <b>центры чёрных меток</b>: 1 — метка с белым окошком (левая верхняя), дальше по часовой стрелке.</div>
        <CornerEditor url={photo.url} w={photo.w} h={photo.h} corners={corners} onChange={setCorners} />
        <div className="m-grid2">
          <button className="m-btn" onClick={() => setStage('photo')}>Другое фото</button>
          <button className="m-btn primary" onClick={() => run(photo, corners)}>Распознать</button>
        </div>
      </>}

      {stage === 'review' && res && <>
        <div className="m-hint">Красные линии — как будет писать машина. Нажмите на клетку, чтобы включить или выключить букву. Жёлтые стоит проверить.</div>
        <div className="m-tools">
          <button className="m-btn small" onClick={() => setInclude(new Set(res.cells.filter((c) => c.strokes.length).map((c) => c.index)))}>Все</button>
          <button className="m-btn small" onClick={() => setInclude(new Set())}>Ни одной</button>
          <button className="m-btn small" onClick={() => setStage('corners')}>Углы</button>
        </div>
        <div className="cell-grid">
          {res.cells.map((c) => <CellCard key={c.index} c={c} S={res.pxPerMM} on={include.has(c.index)} onClick={() => {
            if (!c.strokes.length) return;
            const s = new Set(include); if (s.has(c.index)) s.delete(c.index); else s.add(c.index); setInclude(s);
          }} />)}
        </div>
        <label className="m-field"><span>Куда добавить</span>
          <select value={target} onChange={(e) => setTarget(e.target.value)}>
            <option value="new">Новый почерк</option>
            {userFonts.map((f) => <option key={f.id} value={f.id}>{f.name} (добавить варианты)</option>)}
          </select>
        </label>
        {target === 'new' && <label className="m-field"><span>Название</span><input value={name} onChange={(e) => setName(e.target.value)} /></label>}
        <div className="m-grid2">
          <button className="m-btn" onClick={() => setStage('photo')}>Другое фото</button>
          <button className="m-btn primary" disabled={!include.size} onClick={save}>Добавить {include.size} букв</button>
        </div>
      </>}
    </div>
  );
}

// ── рисование букв пальцем ─────────────────────────────────────────────

const VB = { x0: -2, x1: 16, y0: -5, y1: 14 };

function DrawEditor({ font, update, onClose }: { font: Font; update: (fn: (f: Font) => Font) => void; onClose: () => void }) {
  const set = useMemo(() => [...new Set([...HANDWRITING_SET, ...Object.keys(font.glyphs).filter((c) => c !== ' ')])], [font]);
  const [ch, setCh] = useState(set.find((c) => /[А-Я]/.test(c)) ?? set[0]);
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const cur = useRef<Pt[] | null>(null);
  const [, force] = useState(0);
  const svg = useRef<SVGSVGElement>(null);
  const variants = font.glyphs[ch]?.variants.filter((v) => v.strokes.length) ?? [];
  const done = set.filter((c) => font.glyphs[c]?.variants.some((v) => v.strokes.length)).length;

  const toUnits = (e: React.PointerEvent): Pt => {
    const r = svg.current!.getBoundingClientRect();
    return [VB.x0 + ((e.clientX - r.left) / r.width) * (VB.x1 - VB.x0), VB.y1 - ((e.clientY - r.top) / r.height) * (VB.y1 - VB.y0)];
  };
  const down = (e: React.PointerEvent) => { (e.target as Element).setPointerCapture?.(e.pointerId); cur.current = [toUnits(e)]; force((n) => n + 1); };
  const move = (e: React.PointerEvent) => {
    if (!cur.current) return;
    const p = toUnits(e), last = cur.current[cur.current.length - 1];
    if (Math.hypot(p[0] - last[0], p[1] - last[1]) > 0.12) { cur.current.push(p); force((n) => n + 1); }
  };
  const up = () => {
    const s = cur.current; cur.current = null;
    if (s) setStrokes((x) => [...x, s.length > 2 ? chaikin(simplify(s, 0.06), 1) : s]);
  };
  const go = (d: number) => { setStrokes([]); setCh(set[(set.indexOf(ch) + d + set.length) % set.length]); };
  const save = () => {
    if (!strokes.length) return;
    const xs = strokes.flat().map((p) => p[0]);
    const minX = Math.min(...xs), maxX = Math.max(...xs), shift = 0.3 - minX;
    const v: GlyphVariant = { advance: maxX - minX + 0.9, strokes: strokes.map((s) => s.map(([x, y]) => [x + shift, y] as Pt)) };
    update((f) => ({ ...f, glyphs: { ...f.glyphs, [ch]: { variants: [...(f.glyphs[ch]?.variants.filter((x) => x.strokes.length) ?? []), v] } } }));
    go(1);
  };
  const delVariant = (i: number) => update((f) => {
    const vs = (f.glyphs[ch]?.variants ?? []).filter((x) => x.strokes.length).filter((_, k) => k !== i);
    const glyphs = { ...f.glyphs };
    if (vs.length) glyphs[ch] = { variants: vs }; else delete glyphs[ch];
    return { ...f, glyphs };
  });
  const d = (ss: Pt[][]) => ss.map((s) => (s.length === 1 ? `M${s[0][0]} ${-s[0][1]}l0.05 0` : 'M' + s.map(([x, y]) => `${x.toFixed(2)} ${(-y).toFixed(2)}`).join('L'))).join('');
  const live = cur.current ? [...strokes, cur.current] : strokes;

  return (
    <div className="m-pult">
      <div className="m-row">
        <button className="m-btn small primary" onClick={onClose}>✓ Готово</button>
        <span className="m-hint" style={{ alignSelf: 'center' }}>Букв: {done} / {set.length}</span>
      </div>
      <div className="m-draw-head">
        <button className="m-btn" onClick={() => go(-1)}>◀</button>
        <div className="m-big-char">{ch}</div>
        <button className="m-btn" onClick={() => go(1)}>▶</button>
      </div>
      <svg ref={svg} className="m-draw-pad" viewBox={`${VB.x0} ${-VB.y1} ${VB.x1 - VB.x0} ${VB.y1 - VB.y0}`}
        onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
        {[[10, '#c9d6ea'], [7, '#dee6f2'], [0, '#4dabf7'], [-3, '#dee6f2']].map(([y, c]) => (
          <line key={String(y)} x1={VB.x0} x2={VB.x1} y1={-(y as number)} y2={-(y as number)} stroke={c as string} strokeWidth={y === 0 ? 0.12 : 0.07} strokeDasharray={y === 0 ? undefined : '0.4 0.3'} />
        ))}
        <path d={d(live)} stroke="#2b2d6e" strokeWidth={0.4} fill="none" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <div className="m-hint">Пишите букву пальцем: низ — на синей линии, заглавные — до верхней пунктирной.</div>
      <div className="m-tools">
        <button className="m-btn small" disabled={!strokes.length} onClick={() => setStrokes((s) => s.slice(0, -1))}>↶ Штрих</button>
        <button className="m-btn small" disabled={!strokes.length} onClick={() => setStrokes([])}>Очистить</button>
        <button className="m-btn small primary" disabled={!strokes.length} onClick={save}>Сохранить и дальше</button>
      </div>
      {variants.length > 0 && (
        <div className="m-variants">
          {variants.map((v, i) => (
            <div key={i} className="m-variant">
              <svg viewBox={`-1 -13 ${Math.max(8, v.advance + 2)} 17`}>
                <line x1={-1} x2={20} y1={0} y2={0} stroke="#4dabf7" strokeWidth={0.1} />
                <path d={d(v.strokes)} stroke="#2b2d6e" strokeWidth={0.45} fill="none" strokeLinecap="round" />
              </svg>
              <button className="m-x" onClick={() => delVariant(i)} aria-label="Удалить вариант">✕</button>
            </div>
          ))}
        </div>
      )}
      <div className="m-glyphs">
        {set.map((c) => {
          const n = font.glyphs[c]?.variants.filter((v) => v.strokes.length).length ?? 0;
          return <button key={c} className={(n ? 'done ' : '') + (c === ch ? 'cur' : '')} onClick={() => { setStrokes([]); setCh(c); }}>{c}</button>;
        })}
      </div>
    </div>
  );
}
