// «Фото → рисунок»: выбор стиля, настройки, живой предпросмотр, время письма.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Camera, Check as CheckIcon, Crop as CropIcon, Dices, ImagePlus, RotateCcw, RotateCw } from 'lucide-react';
import { STYLES, defaultParams, defaultPrep, fullCrop, type ArtStyle, type Crop, type Prep, type StyleParams } from '../core/photoart';
import { CropEditor } from './CropEditor';
import type { Path } from '../core/geometry';
import type { Gray } from '../core/vision';
import { estimateJob, formatDuration } from '../core/gcode';
import { optimizePaths, defaultOptimize } from '../core/optimize';
import { toSvgD } from '../job';
import { useProfile } from '../store';
import { Check, Modal, Num, Slider } from '../ui/controls';
import { loadPhoto } from './PhotoFont';
import type { Pdf } from '../core/pdf';

let worker: Worker | null = null;
let seq = 0;
const getWorker = () => (worker ??= new Worker(new URL('../photoart.worker.ts', import.meta.url), { type: 'module' }));

function call<T>(msg: Record<string, unknown>, onProgress?: (s: string) => void): Promise<T> {
  const w = getWorker();
  const id = ++seq;
  return new Promise((resolve, reject) => {
    const h = (e: MessageEvent) => {
      const m = e.data;
      if (m.id !== id) return;
      if (m.type === 'progress') { onProgress?.(m.stage); return; }
      w.removeEventListener('message', h);
      if (m.type === 'error') reject(new Error(m.message)); else resolve(m as T);
    };
    w.addEventListener('message', h);
    w.postMessage({ ...msg, id });
  });
}

interface Result { paths: Path[]; prep: Gray; heightMM: number; ms: number }

const PARAM_UI: Record<keyof StyleParams, { label: string; min: number; max: number; step: number; fmt?: (v: number) => string }> = {
  detail: { label: 'Подробность', min: 1, max: 10, step: 1 },
  spacing: { label: 'Шаг линий, мм', min: 0.6, max: 5, step: 0.1, fmt: (v) => v.toFixed(1) },
  points: { label: 'Точек', min: 300, max: 8000, step: 100 },
  amplitude: { label: 'Размах волны, мм', min: 0.2, max: 4, step: 0.1, fmt: (v) => v.toFixed(1) },
  layers: { label: 'Слоёв штриховки', min: 1, max: 4, step: 1 },
  minLen: { label: 'Короче не рисовать, мм', min: 0, max: 10, step: 0.5 },
  seed: { label: 'Вариант', min: 1, max: 999, step: 1 },
};

export function PhotoArt({ onClose, onAdd, maxWidth }: { onClose(): void; onAdd(paths: Path[], title: string): void; maxWidth: number }) {
  const prof = useProfile();
  const [photo, setPhoto] = useState<{ url: string; name: string } | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [style, setStyle] = useState<ArtStyle>('portrait');
  const [params, setParams] = useState<StyleParams>(defaultParams);
  const [prep, setPrep] = useState<Prep>(defaultPrep);
  const [widthMM, setWidthMM] = useState(Math.min(150, Math.floor(maxWidth)));
  const [res, setRes] = useState<Result | null>(null);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [showPhoto, setShowPhoto] = useState(false);
  // Кадр: поворот (×90°) и обрезка. Во время правки рамки рисунок не пересчитывается — только по «Готово».
  const [rot, setRot] = useState(0);
  const [crop, setCrop] = useState<Crop>(fullCrop);
  const [cropping, setCropping] = useState(false);
  const [draft, setDraft] = useState<Crop>(fullCrop);
  const latest = useRef(0);
  const isFull = crop.x0 === 0 && crop.y0 === 0 && crop.x1 === 1 && crop.y1 === 1;

  // PDF: страница рисуется в картинку и дальше обрабатывается как фото
  const [pdfDoc, setPdfDoc] = useState<{ pdf: Pdf; page: number; name: string } | null>(null);
  const loadPdfPage = async (pdf: Pdf, page: number, name: string) => {
    setErr(''); setBusy(`Открываем страницу ${page} из PDF`); setLoaded(false);
    try {
      const { renderPage } = await import('../core/pdf');
      const { canvas } = await renderPage(pdf, page, 6);
      const blob = await new Promise<Blob>((r, j) => canvas.toBlob((b) => (b ? r(b) : j(new Error('страница не нарисовалась'))), 'image/png'));
      const p = await loadPhoto(new File([blob], 'page.png', { type: 'image/png' }));
      await call({ type: 'load', gray: p.gray });
      setPdfDoc({ pdf, page, name });
      setPhoto({ url: p.url, name: `${name}, стр. ${page}` });
      setLoaded(true);
    } catch (e) { setErr((e as Error).message); setBusy(''); }
  };

  const onFile = async (f: File | null | undefined) => {
    if (!f) return;
    if (f.type === 'application/pdf' || /\.pdf$/i.test(f.name)) {
      try {
        setBusy('Открываем PDF');
        const { openPdf } = await import('../core/pdf');
        const pdf = await openPdf(f);
        setStyle('lines');
        await loadPdfPage(pdf, 1, f.name.replace(/\.pdf$/i, ''));
      } catch (e) { setErr((e as Error).message); setBusy(''); }
      return;
    }
    setPdfDoc(null);
    if (!/^image\//.test(f.type)) return setErr('Нужна картинка (JPG, PNG, WebP…) или PDF');
    setErr(''); setBusy('Загружаем фото'); setLoaded(false);
    try {
      const p = await loadPhoto(f);
      await call({ type: 'load', gray: p.gray });
      setPhoto({ url: p.url, name: f.name });
      setLoaded(true);
    } catch (e) { setErr('Не удалось открыть: ' + (e as Error).message); setBusy(''); }
  };

  // Перерисовка с задержкой при изменении настроек
  useEffect(() => {
    if (!loaded) return;
    const my = ++latest.current;
    setBusy('Рисуем');
    const t = setTimeout(async () => {
      try {
        const r = await call<Result>({ type: 'render', prep, style, params, widthMM, crop, rot }, (s) => { if (my === latest.current) setBusy(s); });
        if (my === latest.current) { setRes(r); setBusy(''); setErr(''); }
      } catch (e) { if (my === latest.current) { setErr((e as Error).message); setBusy(''); } }
    }, 280);
    return () => clearTimeout(t);
  }, [loaded, style, params, prep, widthMM, crop, rot]);

  /** Поворот на 90° по часовой: рамку обрезки поворачиваем вместе с фото. */
  const rotate = () => {
    const turn = (c: Crop): Crop => ({ x0: 1 - c.y1, y0: c.x0, x1: 1 - c.y0, y1: c.x1 });
    setRot((r) => (r + 1) % 4);
    setCrop(turn); setDraft(turn);
  };

  // Подготовленное фото — для подложки
  const prepUrl = useMemo(() => {
    if (!res) return '';
    const g = res.prep, cv = document.createElement('canvas');
    cv.width = g.w; cv.height = g.h;
    const ctx = cv.getContext('2d')!, im = ctx.createImageData(g.w, g.h);
    for (let i = 0; i < g.d.length; i++) { im.data[i * 4] = im.data[i * 4 + 1] = im.data[i * 4 + 2] = g.d[i]; im.data[i * 4 + 3] = 255; }
    ctx.putImageData(im, 0, 0);
    return cv.toDataURL();
  }, [res]);

  const stats = useMemo(() => {
    if (!res) return null;
    const opt = optimizePaths(res.paths, { ...defaultOptimize, twoOpt: false, simplifyTol: 0 });
    return { ...estimateJob(opt.paths, prof), lines: res.paths.length, opt: opt.paths };
  }, [res, prof]);

  const cur = STYLES.find((s) => s.id === style)!;
  const d = useMemo(() => (res ? toSvgD(res.paths) : ''), [res]);
  const H = res?.heightMM ?? widthMM * 0.75;
  const tooLong = stats && stats.seconds > 3600;

  return (
    <Modal title="Фото → рисунок" onClose={onClose} wide footer={<>
      <button className="btn" onClick={onClose}>Отмена</button>
      <button className="btn primary" disabled={!res || !res.paths.length || !!busy} onClick={() => res && onAdd(stats?.opt ?? res.paths, `Фото: ${cur.name.toLowerCase()}`)}><ImagePlus />Добавить на лист</button>
    </>}>
      {!photo ? (
        <div>
          <label className="drop" onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); onFile(e.dataTransfer.files?.[0]); }}>
            <input type="file" accept="image/*,application/pdf,.pdf" style={{ display: 'none' }} onChange={(e) => onFile(e.target.files?.[0])} />
            <Camera style={{ width: 36, height: 36 }} />
            <b>{busy || 'Выберите фото или PDF, или перетащите сюда'}</b>
            <span className="hint">Портрет, животное, здание, пейзаж. Лучше всего — чёткое фото с понятным объектом и спокойным фоном. Из PDF рисуется страница — для чертежей и схем подойдёт стиль «Линии как есть». Фото обрабатывается только на этом устройстве.</span>
          </label>
          {err && <div className="err-box" style={{ marginTop: 12 }}>{err}</div>}
        </div>
      ) : (
        <div className="pa-grid">
          <div className="pa-side">
            <div className="pa-styles">
              {STYLES.map((s) => (
                <button key={s.id} className={'chip-btn' + (s.id === style ? ' on' : '')} onClick={() => setStyle(s.id)} title={s.hint}>{s.name}</button>
              ))}
            </div>
            <div className="hint" style={{ margin: '6px 0 10px' }}>{cur.hint}</div>
            <div className="btn-row" style={{ marginBottom: 10 }}>
              {cropping
                ? <>
                    <button className="btn small primary" onClick={() => { setCrop(draft); setCropping(false); }}><CheckIcon />Готово</button>
                    <button className="btn small" onClick={() => { setDraft(fullCrop); }}>Весь кадр</button>
                    <button className="btn small ghost" onClick={() => { setDraft(crop); setCropping(false); }}>Отмена</button>
                  </>
                : <button className="btn small" onClick={() => { setDraft(crop); setCropping(true); }} title="Выделить лицо или нужную часть фото рамкой"><CropIcon />{isFull ? 'Обрезать' : 'Изменить обрезку'}</button>}
              <button className="btn small" onClick={rotate} title="Повернуть на 90° по часовой"><RotateCw />Повернуть</button>
            </div>
            {cur.uses.map((k) => {
              const u = PARAM_UI[k];
              return <Slider key={k} label={u.label} value={params[k]} min={u.min} max={u.max} step={u.step} fmt={u.fmt} onChange={(v) => setParams((p) => ({ ...p, [k]: v }))} />;
            })}
            {cur.uses.includes('seed') && <button className="btn small" style={{ marginBottom: 10 }} onClick={() => setParams((p) => ({ ...p, seed: Math.floor(Math.random() * 999) + 1 }))}><Dices />Другой вариант</button>}
            <div className="section" style={{ padding: '8px 0', borderTop: '1px solid var(--line)' }}>
              <h3>Фото</h3>
              <Slider label="Яркость" value={prep.brightness} min={-100} max={100} step={5} onChange={(v) => setPrep((p) => ({ ...p, brightness: v }))} />
              <Slider label="Контраст" value={prep.contrast} min={-100} max={100} step={5} onChange={(v) => setPrep((p) => ({ ...p, contrast: v }))} />
              <Slider label="Гамма" value={prep.gamma} min={0.3} max={3} step={0.1} fmt={(v) => v.toFixed(1)} onChange={(v) => setPrep((p) => ({ ...p, gamma: v }))} />
              <Slider label="Убрать светлый фон" value={prep.whiteBg} min={0} max={60} step={2} fmt={(v) => (v ? v + '%' : 'нет')} onChange={(v) => setPrep((p) => ({ ...p, whiteBg: v }))} />
              <Check label="Негатив" value={prep.invert} onChange={(v) => setPrep((p) => ({ ...p, invert: v }))} />
              <button className="btn small ghost" onClick={() => setPrep(defaultPrep)}><RotateCcw />Сбросить</button>
            </div>
            {pdfDoc && pdfDoc.pdf.numPages > 1 && <Num label={`Страница PDF (из ${pdfDoc.pdf.numPages})`} value={pdfDoc.page} min={1} max={pdfDoc.pdf.numPages} step={1} onChange={(v) => loadPdfPage(pdfDoc.pdf, Math.round(v), pdfDoc.name)} />}
            <Num label={`Ширина рисунка, мм (до ${Math.floor(maxWidth)})`} value={widthMM} min={20} max={Math.floor(maxWidth)} step={5} onChange={setWidthMM} />
            <button className="btn small ghost" onClick={() => { setPhoto(null); setPdfDoc(null); setLoaded(false); setRes(null); setCrop(fullCrop); setDraft(fullCrop); setRot(0); setCropping(false); }}>Другое фото</button>
          </div>
          <div className="pa-preview">
            {cropping ? (
              <>
                <CropEditor url={photo.url} rot={rot} crop={draft} onChange={setDraft} />
                <div className="hint" style={{ marginTop: 8 }}>Тяните углы рамки или саму рамку. Для портрета оставьте голову и плечи — так лицо получится крупнее и подробнее. Затем «Готово».</div>
              </>
            ) : <>
            <div className="pa-canvas" style={{ aspectRatio: `${widthMM} / ${H}` }}>
              <svg viewBox={`0 0 ${widthMM} ${H}`} preserveAspectRatio="xMidYMid meet">
                <rect width={widthMM} height={H} fill="var(--paper)" />
                {showPhoto && prepUrl && <image href={prepUrl} width={widthMM} height={H} opacity={0.35} />}
                <path d={d} stroke="#2b2d6e" strokeWidth={style === 'stipple' ? 0.6 : Math.max(0.25, widthMM / 600)} fill="none" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              {busy && <div className="pa-busy">{busy}…</div>}
            </div>
            <div className="pa-stats">
              {stats && <>
                <span>Время письма ≈ <b style={{ color: tooLong ? 'var(--danger)' : undefined }}>{formatDuration(stats.seconds)}</b></span>
                <span>Линий: <b>{stats.lines}</b></span>
                <span>Длина: <b>{(stats.drawLength / 1000).toFixed(1)} м</b></span>
                <span>{Math.round(widthMM)}×{Math.round(H)} мм</span>
                {res && <span className="hint">рассчитано за {res.ms} мс</span>}
              </>}
              <label className="check" style={{ margin: 0 }}><input type="checkbox" checked={showPhoto} onChange={(e) => setShowPhoto(e.target.checked)} />Показать фото под рисунком</label>
            </div>
            {tooLong && <div className="warn-box" style={{ marginTop: 8 }}>Больше часа письма. Уменьшите подробность, число точек или размер — и не забудьте про отдых моторов.</div>}
            </>}
            {err && <div className="err-box" style={{ marginTop: 8 }}>{err}</div>}
          </div>
        </div>
      )}
    </Modal>
  );
}
