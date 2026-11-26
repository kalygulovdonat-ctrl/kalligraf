// Мастер «Почерк по фото»: шаблон → фото → распознавание → проверка → сохранение в шрифт.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Camera, CheckSquare, Crosshair, Download, Printer, RotateCcw, Square } from 'lucide-react';
import type { Pt } from '../core/geometry';
import { TPL, CELLS_PER_PAGE, printTemplates, templateChars, templateSvg } from '../core/template';
import { HANDWRITING_SET } from '../core/font';
import { EN_LOWER, EN_UPPER } from '../core/fontData';
import { CELL_INSET, toGray, type CellResult, type Gray, type SheetResult } from '../core/vision';
import type { Font, GlyphVariant } from '../core/font';
import { uid, useApp } from '../store';
import { Check, Modal, Num, Sel, downloadText } from '../ui/controls';

type Stage = 'template' | 'photo' | 'busy' | 'corners' | 'review';

let worker: Worker | null = null;
let reqId = 0;
function getWorker() {
  if (!worker) worker = new Worker(new URL('../vision.worker.ts', import.meta.url), { type: 'module' });
  return worker;
}

function runWorker(gray: Gray, chars: string[], corners: Pt[] | null, onProgress: (s: string, p: number) => void): Promise<SheetResult> {
  const w = getWorker();
  const id = ++reqId;
  return new Promise((resolve, reject) => {
    const h = (e: MessageEvent) => {
      const m = e.data;
      if (m.id !== id) return;
      if (m.type === 'progress') onProgress(m.stage, m.pct);
      else {
        w.removeEventListener('message', h);
        if (m.type === 'result') resolve(m.res);
        else reject(Object.assign(new Error(m.message), { notFound: m.notFound }));
      }
    };
    w.addEventListener('message', h);
    w.onerror = (e) => { w.removeEventListener('message', h); reject(new Error('Ошибка обработки: ' + e.message)); };
    w.postMessage({ id, gray, chars, corners });
  });
}

/** Фото → оттенки серого (с уменьшением до 3200 px по большей стороне). */
export async function loadPhoto(file: File): Promise<{ gray: Gray; url: string; w: number; h: number }> {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' } as ImageBitmapOptions);
  const k = Math.min(1, 3200 / Math.max(bmp.width, bmp.height));
  const w = Math.round(bmp.width * k), h = Math.round(bmp.height * k);
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close?.();
  const data = ctx.getImageData(0, 0, w, h).data;
  const url = cv.toDataURL('image/jpeg', 0.8);
  return { gray: toGray(data, w, h), url, w, h };
}

export function PhotoFont({ onClose }: { onClose(): void }) {
  const userFonts = useApp((s) => s.userFonts);
  const addUserFont = useApp((s) => s.addUserFont);
  const updateUserFont = useApp((s) => s.updateUserFont);
  const setState = useApp((s) => s.setState);
  const setDoc = useApp((s) => s.setDoc);
  const notify = useApp((s) => s.notify);

  const [stage, setStage] = useState<Stage>('template');
  const [pages, setPages] = useState(1);
  const [photo, setPhoto] = useState<{ gray: Gray; url: string; w: number; h: number } | null>(null);
  const [progress, setProgress] = useState<[string, number]>(['', 0]);
  const [res, setRes] = useState<SheetResult | null>(null);
  const [err, setErr] = useState('');
  const [include, setInclude] = useState<Set<number>>(new Set());
  const [target, setTarget] = useState<string>('new');
  const [newName, setNewName] = useState('Мой почерк');
  const [corners, setCorners] = useState<Pt[] | null>(null);
  const [latin, setLatin] = useState(false);
  const [page, setPage] = useState(0);
  const set = latin ? HANDWRITING_SET + EN_UPPER + EN_LOWER : HANDWRITING_SET;
  const chunks = Math.ceil([...set].length / CELLS_PER_PAGE);
  const chars = useMemo(() => templateChars(page, set), [page, set]);

  const process = async (p: NonNullable<typeof photo>, manual: Pt[] | null) => {
    setStage('busy'); setErr('');
    try {
      const r = await runWorker(p.gray, chars, manual, (s, pct) => setProgress([s, pct]));
      setRes(r);
      setCorners(r.corners);
      setInclude(new Set(r.cells.filter((c) => c.strokes.length && !c.flags.includes('many') && !c.flags.includes('big')).map((c) => c.index)));
      setStage('review');
    } catch (e) {
      const ex = e as Error & { notFound?: boolean };
      setErr(ex.message);
      if (ex.notFound) {
        // Ручная разметка: начальные углы — по краям кадра
        const m = 0.08;
        setCorners([[p.w * m, p.h * m], [p.w * (1 - m), p.h * m], [p.w * (1 - m), p.h * (1 - m)], [p.w * m, p.h * (1 - m)]]);
        setStage('corners');
      } else setStage('photo');
    }
  };

  const onFile = async (f: File | null | undefined) => {
    if (!f) return;
    if (!/^image\//.test(f.type)) return setErr('Это не изображение. Нужна фотография листа (JPG, PNG, HEIC в Safari).');
    setErr('');
    try {
      const p = await loadPhoto(f);
      setPhoto(p);
      process(p, null);
    } catch (e) {
      setErr('Не удалось открыть фото: ' + (e as Error).message);
    }
  };

  const save = () => {
    if (!res) return;
    const chosen = res.cells.filter((c) => include.has(c.index) && c.strokes.length);
    if (!chosen.length) return;
    const add = (f: Font): Font => {
      const glyphs = { ...f.glyphs };
      for (const c of chosen) {
        const v: GlyphVariant = { advance: c.advance, strokes: c.strokes };
        const old = glyphs[c.char]?.variants.filter((x) => x.strokes.length) ?? [];
        glyphs[c.char] = { variants: [...old, v] };
      }
      if (!glyphs[' ']) glyphs[' '] = { variants: [{ advance: 4, strokes: [] }] };
      return { ...f, glyphs };
    };
    let id = target;
    if (target === 'new') {
      const f: Font = add({ id: 'u-' + uid(), name: newName.trim() || 'Мой почерк', author: '', license: 'Личное использование', createdAt: Date.now(), glyphs: {} });
      addUserFont(f);
      id = f.id;
    } else updateUserFont(target, add);
    setDoc((d) => ({ ...d, fontId: id }));
    setState({ editingFont: id, editingChar: chosen[0].char });
    notify(`Добавлено букв: ${chosen.length}. Шрифт выбран для текста — проверьте буквы и при необходимости перерисуйте.`, 'success');
    onClose();
  };

  const stepNo = { template: 0, photo: 1, busy: 1, corners: 1, review: 2 }[stage];
  return (
    <Modal title="Почерк по фото" onClose={onClose} wide footer={
      stage === 'review' ? <>
        <button className="btn" onClick={() => { setStage('photo'); setRes(null); }}><RotateCcw />Другое фото</button>
        <button className="btn primary" onClick={save} disabled={!include.size}>Добавить {include.size} букв в шрифт</button>
      </> : stage === 'template' ? <>
        <span />
        <button className="btn primary" onClick={() => setStage('photo')}>Лист заполнен — загрузить фото</button>
      </> : stage === 'corners' ? <>
        <button className="btn" onClick={() => setStage(res ? 'review' : 'photo')}>Назад</button>
        <button className="btn primary" onClick={() => photo && corners && process(photo, corners)}><Crosshair />Распознать по этим углам</button>
      </> : <>
        <button className="btn" onClick={() => setStage('template')}>Назад</button>
        <span />
      </>
    }>
      <div className="steps" style={{ padding: '0 0 14px' }}>{[0, 1, 2].map((i) => <div key={i} className={i <= stepNo ? 'on' : ''} />)}</div>

      {stage === 'template' && <TemplateStep pages={pages} setPages={setPages} chars={chars} set={set} latin={latin} setLatin={(v) => { setLatin(v); setPage(0); if (v && pages < 2) setPages(2); }} />}

      {stage === 'photo' && (
        <div>
          <p>Сфотографируйте заполненный лист <b>целиком</b>, все 4 чёрные метки должны быть в кадре. Наклон не страшен — программа выпрямит лист.</p>
          <label className="drop" onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); onFile(e.dataTransfer.files?.[0]); }}>
            <input type="file" accept="image/*" capture="environment" style={{ display: 'none' }} onChange={(e) => onFile(e.target.files?.[0])} />
            <Camera style={{ width: 36, height: 36 }} />
            <b>Выберите фото или перетащите сюда</b>
            <span className="hint">На телефоне откроется камера. Фото обрабатывается только на этом устройстве и никуда не отправляется.</span>
          </label>
          {chunks > 1 && (
            <div style={{ maxWidth: 260, marginTop: 12 }}>
              <Sel label="Какой лист на фото" value={String(page % chunks)} onChange={(v) => setPage(Number(v))}
                options={Array.from({ length: chunks }, (_, i) => [String(i), `Лист ${i + 1} (${templateChars(i, set)[0]}…${templateChars(i, set).slice(-1)[0]})`] as [string, string])} />
            </div>
          )}
          {err && <div className="err-box" style={{ marginTop: 12 }}>{err}</div>}
          <Tips />
        </div>
      )}

      {stage === 'busy' && (
        <div style={{ padding: '30px 0', textAlign: 'center' }}>
          <div style={{ fontWeight: 700, marginBottom: 10 }}>{progress[0] || 'Обработка…'}</div>
          <div className="progress" style={{ maxWidth: 420, margin: '0 auto' }}><div style={{ width: progress[1] + '%' }} /></div>
        </div>
      )}

      {stage === 'corners' && photo && corners && (
        <div>
          {err && <div className="warn-box">{err}</div>}
          <p>Перетащите 4 кружка на <b>центры чёрных меток</b>: 1 — метка с белым окошком (левая верхняя), дальше по часовой стрелке.</p>
          <CornerEditor url={photo.url} w={photo.w} h={photo.h} corners={corners} onChange={setCorners} />
        </div>
      )}

      {stage === 'review' && res && (
        <Review res={res} include={include} setInclude={setInclude} target={target} setTarget={setTarget}
          newName={newName} setNewName={setNewName} fonts={userFonts}
          onCorners={() => setStage('corners')} />
      )}
    </Modal>
  );
}

function TemplateStep({ pages, setPages, chars, set, latin, setLatin }: { pages: number; setPages(n: number): void; chars: string[]; set: string; latin: boolean; setLatin(v: boolean): void }) {
  const notify = useApp((s) => s.notify);
  const svg = useMemo(() => templateSvg(0, chars), [chars]);
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 220px', gap: 18, alignItems: 'start' }}>
      <div>
        <ol style={{ paddingLeft: 18, margin: '0 0 12px', lineHeight: 1.6 }}>
          <li>Распечатайте шаблон на A4 <b>в масштабе 100%</b> (без «уместить на странице»).</li>
          <li>Напишите в каждой клетке букву, которая подписана серым в углу: низ буквы — на синей линии, заглавные — до верхней пунктирной, строчные — до средней.</li>
          <li>Сфотографируйте лист и загрузите фото.</li>
        </ol>
        <p className="hint">{latin ? 'Два листа: на первом русский алфавит, кыргызские Ң Ө Ү, цифры и знаки, на втором — английские буквы.' : `На листе ${chars.length} символов: русский алфавит, кыргызские Ң Ө Ү, цифры и знаки.`} Хотите «живой» почерк — заполните шаблон 2–3 раза: каждый раз добавляется ещё один вариант букв.</p>
        <Check label="Добавить английские буквы (+1 лист)" value={latin} onChange={setLatin} />
        <div style={{ maxWidth: 200 }}><Num label="Сколько листов распечатать" value={pages} min={1} max={5} onChange={setPages} /></div>
        <div className="btn-row">
          <button className="btn primary" onClick={() => { try { printTemplates(pages, set); } catch (e) { notify((e as Error).message, 'error'); } }}><Printer />Распечатать шаблон</button>
          <button className="btn" onClick={() => downloadText('kalligraf-shablon.svg', svg, 'image/svg+xml')}><Download />Скачать SVG</button>
        </div>
        <p className="hint" style={{ marginTop: 10 }}>Нет принтера? Распечатайте SVG в копи-центре — или пишите буквы стилусом прямо на экране («Создать свой почерк»). Рисовать сетку от руки не нужно: программе нужны точные метки.</p>
      </div>
      <div style={{ background: '#fff', borderRadius: 8, boxShadow: 'var(--shadow)', overflow: 'hidden' }} dangerouslySetInnerHTML={{ __html: svg.replace('width="210mm" height="297mm"', 'width="100%"') }} />
    </div>
  );
}

function Tips() {
  return (
    <div className="hint" style={{ marginTop: 12, lineHeight: 1.6 }}>
      <b>Советы для хорошего результата:</b> тёмная гелевая ручка или линер 0.5–0.7 (не карандаш) · ровный дневной свет без тени от телефона · камера примерно над листом · лист лежит ровно, без сгибов.
    </div>
  );
}

function CornerEditor({ url, w, h, corners, onChange }: { url: string; w: number; h: number; corners: Pt[]; onChange(c: Pt[]): void }) {
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

function Review(p: {
  res: SheetResult; include: Set<number>; setInclude(s: Set<number>): void; target: string; setTarget(s: string): void;
  newName: string; setNewName(s: string): void; fonts: Font[]; onCorners(): void;
}) {
  const { res } = p;
  const ok = res.cells.filter((c) => c.strokes.length && !c.flags.length).length;
  const warn = res.cells.filter((c) => c.strokes.length && c.flags.length).length;
  const empty = res.cells.filter((c) => !c.strokes.length).length;
  const toggle = (i: number) => { const s = new Set(p.include); if (s.has(i)) s.delete(i); else s.add(i); p.setInclude(s); };
  return (
    <div>
      <div className="btn-row" style={{ alignItems: 'center', marginBottom: 10 }}>
        <span className="badge" style={{ background: 'var(--ok-soft)', color: 'var(--ok)' }}>{ok} хорошо</span>
        {warn > 0 && <span className="badge" style={{ background: 'var(--accent-soft)', color: 'var(--warn)' }}>{warn} проверьте</span>}
        {empty > 0 && <span className="badge" style={{ background: 'var(--panel-2)', color: 'var(--muted)' }}>{empty} пустых</span>}
        <span className="spacer" />
        <button className="btn small" onClick={() => p.setInclude(new Set(res.cells.filter((c) => c.strokes.length).map((c) => c.index)))}><CheckSquare />Все</button>
        <button className="btn small" onClick={() => p.setInclude(new Set())}><Square />Ни одной</button>
        <button className="btn small" onClick={p.onCorners} title="Если буквы съехали — поправьте углы"><Crosshair />Углы</button>
      </div>
      <p className="hint" style={{ marginTop: 0 }}>Красные линии — как будет писать машина, поверх вашего фото. Нажмите на клетку, чтобы включить или выключить букву. Жёлтые — стоит проверить (много штрихов или вышла за линии).</p>
      <div className="cell-grid">
        {res.cells.map((c) => <CellCard key={c.index} c={c} S={res.pxPerMM} on={p.include.has(c.index)} onClick={() => c.strokes.length && toggle(c.index)} />)}
      </div>
      <div className="grid2" style={{ marginTop: 14 }}>
        <label className="field"><span>Куда добавить</span>
          <select value={p.target} onChange={(e) => p.setTarget(e.target.value)}>
            <option value="new">Новый почерк</option>
            {p.fonts.map((f) => <option key={f.id} value={f.id}>{f.name} (добавить варианты)</option>)}
          </select>
        </label>
        {p.target === 'new' && <label className="field"><span>Название</span><input type="text" value={p.newName} onChange={(e) => p.setNewName(e.target.value)} /></label>}
      </div>
    </div>
  );
}

function CellCard({ c, S, on, onClick }: { c: CellResult; S: number; on: boolean; onClick(): void }) {
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

