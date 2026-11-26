import { AlignCenter, AlignJustify, AlignLeft, AlignRight, Dices, FileUp, CalendarDays } from 'lucide-react';
import { Check, Num, Sel, Section, Seg, Slider, pickFile } from '../ui/controls';
import { allFonts, SHEETS, useApp, type Doc } from '../store';
import { t } from '../i18n';
import { estimateJob, formatDuration } from '../core/gcode';
import { useProfile } from '../store';
import type { BuiltJob } from '../job';
import { PEN_COLORS, COLOR_NAMES } from '../job';
import { Thumb } from '../ui/SheetView';
import { textPaths } from '../core/generators';
import { useMemo } from 'react';
import type { Align } from '../core/layout';

export function TextLeft({ job }: { job: BuiltJob }) {
  const doc = useApp((s) => s.doc);
  const setDoc = useApp((s) => s.setDoc);
  const notify = useApp((s) => s.notify);
  const prof = useProfile();
  const secs = useMemo(() => estimateJob(job.pages.flatMap((p) => p.paths), prof).seconds, [job, prof]);

  const importTxt = async () => {
    const f = await pickFile('.txt,.md,.csv,text/plain');
    if (!f) return;
    if (f.size > 2_000_000) return notify('Файл слишком большой (больше 2 МБ)', 'error');
    const txt = await f.text();
    setDoc((d) => ({ ...d, text: txt, name: f.name.replace(/\.[^.]+$/, '') }));
    notify(`Загружен текст: ${f.name}`, 'success');
  };
  const insert = (s: string) => setDoc((d) => ({ ...d, text: d.text + (d.text && !d.text.endsWith('\n') ? '\n' : '') + s }));

  return (
    <div className="left-pane" data-tour="text">
      <div className="panel-head">
        <h2>{t('Текст')}</h2>
        <div className="btn-row">
          <button className="btn small ghost" onClick={() => insert(new Date().toLocaleDateString('ru-RU'))} title="Вставить сегодняшнюю дату"><CalendarDays /></button>
          <button className="btn small ghost" onClick={() => setDoc((d) => ({ ...d, text: d.text + (d.text && !/\s$/.test(d.text) ? ' ' : '') + '$x^2$' }))} title="Вставить формулу $…$ (синтаксис LaTeX)">∑</button>
          <button className="btn small" onClick={importTxt} title="Загрузить текст из файла .txt"><FileUp />TXT</button>
        </div>
      </div>
      <textarea
        className="editor" value={doc.text} placeholder={t('Введите текст…')} spellCheck
        onChange={(e) => { const v = e.target.value; setDoc((d) => ({ ...d, text: v }), { merge: true }); }}
        onDragOver={(e) => e.preventDefault()}
        onDrop={async (e) => {
          const f = e.dataTransfer.files?.[0];
          if (f && /text|\.txt$/.test(f.type + f.name)) { e.preventDefault(); const txt = await f.text(); setDoc((d) => ({ ...d, text: txt })); }
        }}
        aria-label="Текст для письма"
      />
      {job.mathErrors.length > 0 && (
        <div style={{ padding: '8px 14px 0' }}>
          <div className="err-box" style={{ margin: 0 }}>
            {job.mathErrors.slice(0, 3).map((e) => <div key={e.src}>Формула <b>{e.src}</b>: {e.message}</div>)}
            <div className="hint" style={{ marginTop: 4 }}>Формула с ошибкой будет написана как обычный текст.</div>
          </div>
        </div>
      )}
      <div className="hint" style={{ padding: '6px 14px 0' }}>Формулы: <b>{'$x^2$'}</b> внутри строки, <b>{'$$\\frac{a}{b}$$'}</b> — отдельной строкой.</div>
      {job.missing.length > 0 && (
        <div style={{ padding: '8px 14px' }}>
          <div className="err-box" style={{ margin: 0 }}>
            {t('Нет в шрифте')}: {job.missing.map((c) => <span key={c} className="missing-char">{c}</span>)}
            <div className="hint" style={{ marginTop: 4 }}>Эти символы будут пропущены. Выберите другой шрифт или добавьте буквы в свой почерк.</div>
          </div>
        </div>
      )}
      <div className="editor-foot">
        <span><b>{[...doc.text].filter((c) => c.trim()).length}</b> {t('символов')}</span>
        <span><b>{job.lines}</b> {t('строк')}</span>
        <span><b>{job.pages.length}</b> {t('листов')}</span>
        <span title="Примерное время письма с учётом ускорений">≈ <b>{formatDuration(secs)}</b></span>
      </div>
    </div>
  );
}

export function TextRight() {
  const doc = useApp((s) => s.doc);
  const setDoc = useApp((s) => s.setDoc);
  const userFonts = useApp((s) => s.userFonts);
  const fonts = allFonts(userFonts);
  const o = doc.textOpts;
  const set = (p: Partial<Doc['textOpts']>, merge = true) => setDoc((d) => ({ ...d, textOpts: { ...d.textOpts, ...p } }), { merge });
  const setM = (k: keyof Doc['textOpts']['margins'], v: number) => setDoc((d) => ({ ...d, textOpts: { ...d.textOpts, margins: { ...d.textOpts.margins, [k]: v } } }), { merge: true });
  const font = fonts.find((f) => f.id === doc.fontId) ?? fonts[0];
  const sample = useMemo(() => textPaths('Съешь же ещё этих мягких', font, 0, 10, 10), [font]);

  return (
    <div>
      <div className="panel-head"><h2>{t('Свойства')}</h2></div>
      <Section title={t('Шрифт')}>
        <Sel label={t('Шрифт')} value={doc.fontId} onChange={(v) => setDoc((d) => ({ ...d, fontId: v }))} options={fonts.map((f) => [f.id, f.name + (f.builtin ? '' : ' (мой)')])} />
        <div style={{ background: 'var(--paper)', borderRadius: 8, padding: 4, marginBottom: 10 }}><Thumb paths={sample} className="sample" /></div>
        <div className="grid2">
          <Num label={t('Размер, мм')} value={o.size} min={1.5} max={60} step={0.5} onChange={(v) => set({ size: v })} title="Высота заглавной буквы" />
          <Num label={t('Межстрочный, мм')} value={o.lineHeight} min={2} max={100} step={0.5} onChange={(v) => set({ lineHeight: v })} />
          <Num label={t('Межбуквенный, мм')} value={o.letterSpacing} min={-3} max={10} step={0.1} onChange={(v) => set({ letterSpacing: v })} />
          <Num label="Пробел, ×" value={o.wordSpacing} min={0.3} max={4} step={0.1} onChange={(v) => set({ wordSpacing: v })} />
        </div>
        <div className="field"><span>{t('Выравнивание')}</span>
          <Seg<Align> value={o.align} onChange={(v) => set({ align: v }, false)} options={[
            ['left', <AlignLeft />, t('Влево')], ['center', <AlignCenter />, t('По центру')], ['right', <AlignRight />, t('Вправо')], ['justify', <AlignJustify />, t('По ширине')]]} />
        </div>
        <div className="grid2">
          <Num label={t('Красная строка, мм')} value={o.indent} min={0} max={60} step={1} onChange={(v) => set({ indent: v })} />
          <Sel label={t('Цвет (ручка)')} value={o.color ?? ''} onChange={(v) => set({ color: v || undefined }, false)} options={PEN_COLORS.map((c) => [c, COLOR_NAMES[c] ?? c])} />
        </div>
        <Check label={t('Перенос по слогам')} value={o.hyphenate} onChange={(v) => set({ hyphenate: v }, false)} />
        <Check label={t('Номера страниц')} value={o.pageNumbers} onChange={(v) => set({ pageNumbers: v }, false)} />
      </Section>

      <Section title="«Живой» почерк">
        <Slider label={t('Аккуратность')} value={o.accuracy} min={1} max={10} onChange={(v) => set({ accuracy: v })}
          fmt={(v) => (v >= 10 ? '10 — идеально' : v <= 3 ? `${v} — небрежно` : String(v))} title="10 — ровно как по линейке, 1 — очень «живо»" />
        <Slider label={t('Наклон строки, °')} value={o.slopeDeg} min={-5} max={5} step={0.5} onChange={(v) => set({ slopeDeg: v })} />
        <button className="btn small" onClick={() => set({ seed: Math.floor(Math.random() * 1e6) + 1 }, false)} title="Тот же текст, но буквы чуть иначе"><Dices />{t('Другой вариант')}</button>
        <div className="hint" style={{ marginTop: 8 }}>Повороты, размер, сдвиг букв, волна строки, «гуляющее» поле и усталость к концу листа. Один и тот же вариант всегда повторяется одинаково.</div>
      </Section>

      <Section title={t('Формат листа')}>
        <Sel label={t('Формат листа')} value={doc.sheet.format} onChange={(v) => setDoc((d) => ({ ...d, sheet: v === 'custom' ? { ...d.sheet, format: v } : { format: v, w: SHEETS[v][0], h: SHEETS[v][1] } }))}
          options={[...Object.entries(SHEETS).map(([k, v]) => [k, k === 'notebook' ? t('Тетрадь 165×205') : v[2]] as [Doc['sheet']['format'], string]), ['custom', t('Свой')]]} />
        {doc.sheet.format === 'custom' && (
          <div className="grid2">
            <Num label="Ширина, мм" value={doc.sheet.w} min={30} max={600} onChange={(v) => setDoc((d) => ({ ...d, sheet: { ...d.sheet, w: v } }), { merge: true })} />
            <Num label="Высота, мм" value={doc.sheet.h} min={30} max={900} onChange={(v) => setDoc((d) => ({ ...d, sheet: { ...d.sheet, h: v } }), { merge: true })} />
          </div>
        )}
        <div className="field"><span>{t('Поля листа, мм')}</span></div>
        <div className="grid4">
          <Num label="сверху" value={o.margins.top} min={0} max={150} onChange={(v) => setM('top', v)} />
          <Num label="снизу" value={o.margins.bottom} min={0} max={150} onChange={(v) => setM('bottom', v)} />
          <Num label="слева" value={o.margins.left} min={0} max={150} onChange={(v) => setM('left', v)} />
          <Num label="справа" value={o.margins.right} min={0} max={150} onChange={(v) => setM('right', v)} />
        </div>
        <div className="grid2">
          <Sel label={t('Разметка (только на экране)')} value={doc.ruling} onChange={(v) => setDoc((d) => ({ ...d, ruling: v }))}
            options={[['none', t('Нет')], ['grid', t('Клетка')], ['lines', t('Линейка')], ['oblique', t('Косая линейка')], ['mm', 'Миллиметровка']]} />
          <Num label="Шаг разметки, мм" value={doc.rulingStep} min={2} max={30} step={0.5} onChange={(v) => setDoc((d) => ({ ...d, rulingStep: v }), { merge: true })} />
        </div>
        <Check label={t('Печатать разметку')} value={doc.printRuling} onChange={(v) => setDoc((d) => ({ ...d, printRuling: v }))} />
        <button className="btn small" onClick={() => setDoc((d) => ({ ...d, sheet: { format: 'notebook', w: 165, h: 205 }, ruling: 'grid', rulingStep: 5,
          textOpts: { ...d.textOpts, size: 4, lineHeight: 10, margins: { top: 10, bottom: 5, left: 5, right: 25 }, indent: 10 } }))}
          title="Лист тетради 165×205, клетка 5 мм, строка через клетку, поле справа 25 мм">Режим «Тетрадь в клетку»</button>
      </Section>
    </div>
  );
}
