import { useMemo, useRef, useState } from 'react';
import { Check as CheckIcon, Download, Eraser, PenLine, Plus, Trash2, Undo2, Upload, ChevronLeft, ChevronRight, Pencil, Camera } from 'lucide-react';
import { PhotoFont } from './PhotoFont';
import { parseTtf } from '../core/ttf';
import { convertFont } from '../core/fontconvert';
import { builtinFonts, exportFont, HANDWRITING_SET, importFont, type Font, type GlyphVariant } from '../core/font';
import { chaikin, simplify, type Pt, type Stroke } from '../core/geometry';
import { textPaths } from '../core/generators';
import { layoutText, defaultTextOptions } from '../core/layout';
import { allFonts, uid, useApp } from '../store';
import { downloadText, pickFile, safeName, Txt } from '../ui/controls';
import { Thumb } from '../ui/SheetView';
import { t } from '../i18n';
import { toSvgD } from '../job';

const SAMPLE = 'Съешь же ещё этих мягких булок. Өмүр, үй, көңүл';

export function FontsRight() {
  const userFonts = useApp((s) => s.userFonts);
  const docFont = useApp((s) => s.doc.fontId);
  const setDoc = useApp((s) => s.setDoc);
  const setState = useApp((s) => s.setState);
  const notify = useApp((s) => s.notify);
  const addUserFont = useApp((s) => s.addUserFont);
  const removeUserFont = useApp((s) => s.removeUserFont);
  const updateUserFont = useApp((s) => s.updateUserFont);
  const editing = useApp((s) => s.editingFont);
  const fonts = allFonts(userFonts);
  const [photo, setPhoto] = useState(false);

  const create = () => {
    const f: Font = { id: 'u-' + uid(), name: 'Мой почерк', author: '', license: 'Личное использование', createdAt: Date.now(), glyphs: { ' ': { variants: [{ advance: 4, strokes: [] }] } } };
    addUserFont(f);
    setState({ editingFont: f.id, editingChar: 'А' });
  };
  const imp = async () => {
    const file = await pickFile('.kfont,.json,.ttf,application/json,font/ttf');
    if (!file) return;
    try {
      if (/\.(ttf|otf)$/i.test(file.name)) {
        // обычный шрифт → однолинейный: ручка пройдёт по середине линий, без двойной обводки
        notify('Переводим шрифт в однолинейный…');
        await new Promise((r) => setTimeout(r, 30));
        const ttf = parseTtf(await file.arrayBuffer());
        const f = convertFont(ttf, { id: 'u-' + uid(), name: ttf.name, license: 'Личное использование' });
        const n = Object.keys(f.glyphs).length - 1;
        if (n < 10) throw new Error('в шрифте почти нет нужных букв');
        addUserFont(f);
        const ru = [...'АБВабв'].filter((c) => f.glyphs[c]).length;
        notify(`Шрифт «${f.name}» добавлен: ${n} символов${ru < 6 ? ' (кириллицы нет — русский текст будет «Печатным»)' : ''}`, ru < 6 ? 'info' : 'success');
        return;
      }
      const f = importFont(JSON.parse(await file.text()));
      addUserFont(f);
      notify(`Шрифт «${f.name}» добавлен: ${Object.keys(f.glyphs).length} символов`, 'success');
    } catch (e) {
      notify('Не удалось открыть шрифт: ' + (e as Error).message, 'error');
    }
  };
  const del = (f: Font) => {
    if (!confirm(`Удалить шрифт «${f.name}»? Это нельзя отменить. Сначала можно сделать «Экспорт».`)) return;
    removeUserFont(f.id);
    if (docFont === f.id) setDoc((d) => ({ ...d, fontId: 'print' }));
    if (editing === f.id) setState({ editingFont: null });
  };

  return (
    <div>
      <div className="panel-head"><h2>{t('Почерки')}</h2>
        <button className="btn small" onClick={imp} title="Открыть .kfont или обычный шрифт .ttf (переведётся в однолинейный)"><Upload />{t('Импорт')}</button>
      </div>
      <div className="section">
        <button className="btn primary" style={{ width: '100%' }} onClick={() => setPhoto(true)}><Camera />Почерк по фото листа A4</button>
        <button className="btn" style={{ width: '100%', marginTop: 8 }} onClick={create}><PenLine />{t('Создать свой почерк')} на экране</button>
        <div className="hint" style={{ marginTop: 8 }}><b>По фото:</b> распечатайте шаблон, напишите буквы ручкой, сфотографируйте — программа сама найдёт и обведёт буквы. <b>На экране:</b> Пишите буквы мышкой, пальцем или стилусом — программа запомнит порядок и направление штрихов. Для каждой буквы можно сохранить несколько вариантов: «живой» почерк будет их чередовать.</div>
      </div>
      {photo && <PhotoFont onClose={() => setPhoto(false)} />}
      <div className="section">
        {fonts.map((f) => (
          <FontCard key={f.id} font={f} active={docFont === f.id}
            onUse={() => { setDoc((d) => ({ ...d, fontId: f.id })); notify(`Шрифт: ${f.name}`, 'success'); }}
            onEdit={f.builtin ? undefined : () => setState({ editingFont: f.id })}
            onExport={() => downloadText(safeName(f.name) + '.kfont', JSON.stringify(exportFont(f)), 'application/json')}
            onDelete={f.builtin ? undefined : () => del(f)}
            onRename={f.builtin ? undefined : (name) => updateUserFont(f.id, (x) => ({ ...x, name }))}
          />
        ))}
      </div>
    </div>
  );
}

function FontCard(p: { font: Font; active: boolean; onUse(): void; onEdit?(): void; onExport(): void; onDelete?(): void; onRename?(n: string): void }) {
  const fb = builtinFonts()[0];
  const sample = useMemo(() => textPaths(SAMPLE.slice(0, 26), { ...fb, glyphs: { ...(p.font.builtin ? {} : fb.glyphs), ...p.font.glyphs } }, 0, 10, 10), [p.font, fb]);
  const count = Object.keys(p.font.glyphs).filter((c) => c !== ' ').length;
  const variants = Object.values(p.font.glyphs).reduce((s, g) => s + g.variants.length, 0);
  const langs = ['А', 'Ң', 'A'].map((c, i) => (p.font.glyphs[c] ? ['RU', 'KY', 'EN'][i] : null)).filter(Boolean);
  return (
    <div className={'font-card' + (p.active ? ' on' : '')}>
      <div className="name">
        {p.onRename ? <input type="text" value={p.font.name} onChange={(e) => p.onRename!(e.target.value)} style={{ fontWeight: 800, padding: '3px 6px' }} aria-label="Название шрифта" /> : <span>{p.font.name}</span>}
        {p.active && <span className="badge">в работе</span>}
      </div>
      <Thumb paths={sample} />
      <div className="hint">{count} симв. · {variants} вар. · {langs.join(' / ') || '—'}{p.font.builtin ? ' · встроенный' : ''}</div>
      <div className="btn-row" style={{ marginTop: 8 }}>
        <button className="btn small primary" onClick={p.onUse} disabled={p.active}><CheckIcon />{t('Использовать')}</button>
        {p.onEdit && <button className="btn small" onClick={p.onEdit}><Pencil />Буквы</button>}
        <button className="btn small ghost" onClick={p.onExport} title="Скачать .kfont"><Download /></button>
        {p.onDelete && <button className="btn small ghost" onClick={p.onDelete} title={t('Удалить')}><Trash2 /></button>}
      </div>
    </div>
  );
}

/** Левая панель: сетка букв редактируемого шрифта. */
export function FontsLeft() {
  const editing = useApp((s) => s.editingFont);
  const ch = useApp((s) => s.editingChar);
  const userFonts = useApp((s) => s.userFonts);
  const setState = useApp((s) => s.setState);
  const updateUserFont = useApp((s) => s.updateUserFont);
  const font = userFonts.find((f) => f.id === editing);
  const [extra, setExtra] = useState('');
  if (!font) return null;
  const set = [...new Set([...HANDWRITING_SET, ...Object.keys(font.glyphs).filter((c) => c !== ' ')])];
  const done = set.filter((c) => font.glyphs[c]?.variants.some((v) => v.strokes.length)).length;
  return (
    <div className="left-pane">
      <div className="panel-head">
        <h2>Буквы: {done} / {set.length}</h2>
        <button className="btn small" onClick={() => setState({ editingFont: null })}>{t('Готово')}</button>
      </div>
      <div style={{ padding: '0 16px' }}>
        <Txt label="Автор" value={font.author ?? ''} onChange={(v) => updateUserFont(font.id, (f) => ({ ...f, author: v }))} />
      </div>
      <div className="glyph-grid">
        {set.map((c) => {
          const n = font.glyphs[c]?.variants.filter((v) => v.strokes.length).length ?? 0;
          return (
            <button key={c} className={(n ? 'done ' : '') + (c === ch ? 'cur' : '')} onClick={() => setState({ editingChar: c })} title={n ? `${n} вариант(а)` : 'Не нарисована'}>
              {c}{n > 1 && <sup>{n}</sup>}
            </button>
          );
        })}
      </div>
      <div style={{ padding: '8px 16px 14px', display: 'flex', gap: 6 }}>
        <input type="text" placeholder="Другой символ" value={extra} maxLength={2} onChange={(e) => setExtra(e.target.value)} />
        <button className="btn small" disabled={!extra.trim()} onClick={() => { setState({ editingChar: [...extra.trim()][0] }); setExtra(''); }}><Plus /></button>
      </div>
    </div>
  );
}

// Поле рисования: единицы шрифта, X: -2…16, Y (вверх): -5…14
const VB = { x0: -2, x1: 16, y0: -5, y1: 14 };

/** Центр: поле для рисования буквы. */
export function GlyphCreator() {
  const editing = useApp((s) => s.editingFont);
  const ch = useApp((s) => s.editingChar);
  const userFonts = useApp((s) => s.userFonts);
  const setState = useApp((s) => s.setState);
  const updateUserFont = useApp((s) => s.updateUserFont);
  const font = userFonts.find((f) => f.id === editing)!;
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const cur = useRef<Pt[] | null>(null);
  const [, force] = useState(0);
  const svg = useRef<SVGSVGElement>(null);
  const set = [...new Set([...HANDWRITING_SET, ...Object.keys(font.glyphs).filter((c) => c !== ' ')])];
  const variants = font.glyphs[ch]?.variants.filter((v) => v.strokes.length) ?? [];

  const toUnits = (e: React.PointerEvent): Pt => {
    const r = svg.current!.getBoundingClientRect();
    const x = VB.x0 + ((e.clientX - r.left) / r.width) * (VB.x1 - VB.x0);
    const y = VB.y1 - ((e.clientY - r.top) / r.height) * (VB.y1 - VB.y0);
    return [x, y];
  };
  const down = (e: React.PointerEvent) => {
    (e.target as Element).setPointerCapture?.(e.pointerId);
    cur.current = [toUnits(e)];
    force((n) => n + 1);
  };
  const move = (e: React.PointerEvent) => {
    if (!cur.current) return;
    const p = toUnits(e);
    const last = cur.current[cur.current.length - 1];
    if (Math.hypot(p[0] - last[0], p[1] - last[1]) > 0.12) { cur.current.push(p); force((n) => n + 1); }
  };
  const up = () => {
    const s = cur.current;
    cur.current = null;
    if (!s) return;
    const clean = s.length > 2 ? chaikin(simplify(s, 0.06), 1) : s;
    setStrokes((x) => [...x, clean]);
  };

  const go = (d: number) => {
    const i = set.indexOf(ch);
    setStrokes([]);
    setState({ editingChar: set[(i + d + set.length) % set.length] });
  };
  const save = () => {
    if (!strokes.length) return;
    const minX = Math.min(...strokes.flat().map((p) => p[0]));
    const maxX = Math.max(...strokes.flat().map((p) => p[0]));
    const shift = 0.3 - minX;
    const v: GlyphVariant = { advance: maxX - minX + 0.9, strokes: strokes.map((s) => s.map(([x, y]) => [x + shift, y] as Pt)) };
    updateUserFont(font.id, (f) => {
      const old = f.glyphs[ch]?.variants.filter((x) => x.strokes.length) ?? [];
      return { ...f, glyphs: { ...f.glyphs, [ch]: { variants: [...old, v] } } };
    });
    go(1);
  };
  const delVariant = (i: number) => updateUserFont(font.id, (f) => {
    const vs = (f.glyphs[ch]?.variants ?? []).filter((x) => x.strokes.length).filter((_, k) => k !== i);
    const glyphs = { ...f.glyphs };
    if (vs.length) glyphs[ch] = { variants: vs }; else delete glyphs[ch];
    return { ...f, glyphs };
  });

  // Тестовая строка: свой шрифт + запасной «Печатный»
  const test = useMemo(() => {
    const fb = builtinFonts()[0];
    const r = layoutText(SAMPLE, font, { ...defaultTextOptions, size: 6, margins: { top: 2, left: 2, right: 2, bottom: 2 }, indent: 0, accuracy: 10, lineHeight: 10 }, { w: 260, h: 30 }, fb);
    return r.pages[0]?.paths ?? [];
  }, [font]);

  const d = (ss: Pt[][]) => ss.map((s) => (s.length === 1 ? `M${s[0][0]} ${-s[0][1]}l0.05 0` : 'M' + s.map(([x, y]) => `${x.toFixed(2)} ${(-y).toFixed(2)}`).join('L'))).join('');
  const W = VB.x1 - VB.x0, H = VB.y1 - VB.y0;
  const live = cur.current ? [...strokes, cur.current] : strokes;

  return (
    <div className="creator">
      <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
        <button className="btn icon" onClick={() => go(-1)} aria-label="Предыдущая буква"><ChevronLeft /></button>
        <div style={{ textAlign: 'center' }}>
          <div className="big-char">{ch}</div>
          <div className="hint">Напишите букву между линиями. Синяя — основание строки.</div>
        </div>
        <button className="btn icon" onClick={() => go(1)} aria-label="Следующая буква"><ChevronRight /></button>
      </div>
      <svg ref={svg} className="draw-pad" viewBox={`${VB.x0} ${-VB.y1} ${W} ${H}`} style={{ width: 'min(460px, 80vw)', aspectRatio: `${W} / ${H}` }}
        onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} aria-label={`Поле для буквы ${ch}`}>
        {[[10, '#c9d6ea', 'заглавные'], [7, '#dee6f2', 'строчные'], [0, '#4dabf7', 'основание'], [-3, '#dee6f2', 'хвосты']].map(([y, c]) => (
          <line key={String(y)} x1={VB.x0} x2={VB.x1} y1={-(y as number)} y2={-(y as number)} stroke={c as string} strokeWidth={y === 0 ? 0.12 : 0.07} strokeDasharray={y === 0 ? undefined : '0.4 0.3'} />
        ))}
        <line x1={0} x2={0} y1={-VB.y1} y2={-VB.y0} stroke="#eceff4" strokeWidth={0.06} />
        <text x={VB.x0 + 0.3} y={-10.3} fontSize={0.8} fill="#9aa5b8">10</text>
        <text x={VB.x0 + 0.3} y={-7.3} fontSize={0.8} fill="#9aa5b8">7</text>
        <path d={d(live)} stroke="#2b2d6e" strokeWidth={0.35} fill="none" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <div className="btn-row">
        <button className="btn" onClick={() => setStrokes((s) => s.slice(0, -1))} disabled={!strokes.length}><Undo2 />Убрать штрих</button>
        <button className="btn" onClick={() => setStrokes([])} disabled={!strokes.length}><Eraser />{t('Очистить')}</button>
        <button className="btn primary" onClick={save} disabled={!strokes.length}><CheckIcon />Сохранить вариант и дальше</button>
      </div>
      {variants.length > 0 && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center' }}>
          {variants.map((v, i) => (
            <div key={i} style={{ position: 'relative' }}>
              <svg viewBox={`-1 -13 ${Math.max(8, v.advance + 2)} 17`} style={{ width: 54, height: 64, background: 'var(--paper)', borderRadius: 8, border: '1px solid var(--line)' }}>
                <line x1={-1} x2={20} y1={0} y2={0} stroke="#4dabf7" strokeWidth={0.1} />
                <path d={d(v.strokes)} stroke="#2b2d6e" strokeWidth={0.45} fill="none" strokeLinecap="round" />
              </svg>
              <button className="btn icon small" style={{ position: 'absolute', top: -6, right: -6, padding: 3, borderRadius: 99 }} onClick={() => delVariant(i)} aria-label={`Удалить вариант ${i + 1}`}><Trash2 /></button>
            </div>
          ))}
        </div>
      )}
      <div style={{ width: 'min(720px, 92%)' }}>
        <div className="hint" style={{ marginBottom: 4 }}>Тестовая строка (отсутствующие буквы — из шрифта «Печатный»):</div>
        <svg viewBox="0 0 260 16" style={{ width: '100%', background: 'var(--paper)', borderRadius: 10 }}>
          <path d={toSvgD(test)} stroke="#2b2d6e" strokeWidth={0.35} fill="none" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>
    </div>
  );
}
