import { Component, useDeferredValue, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Ruler, Brush, Cable, FileDown, FolderOpen, Gamepad2, Keyboard, Monitor, Pause, Play, Printer, Redo2, Settings, Type, Undo2, PenLine, Square, Usb, Unplug } from 'lucide-react';
import { findFont, useApp, useProfile, type Module, type Doc } from './store';
import { buildJob, placeItem } from './job';
import { outOfBounds, formatDuration } from './core/gcode';
import { SheetView, boxesFor } from './ui/SheetView';
import { TextLeft, TextRight } from './features/TextPanel';
import { FontsLeft, FontsRight, GlyphCreator } from './features/FontsPanel';
import { ArtRight } from './features/ArtPanel';
import { PrintRight } from './features/PrintPanel';
import { ControlRight, jog } from './features/ControlPanel';
import { SettingsRight } from './features/SettingsPanel';
import { Wizard } from './features/Wizard';
import { CadView } from './features/cad/CadView';
import { CadLeft, CadRight } from './features/cad/CadPanels';
import { Modal, downloadText, pickFile, safeName } from './ui/controls';
import { connectSerial, connectSimulator, ctl, disconnect, notifyDone, sim, clearSimTrace, useMachine } from './machine';
import { emergencyStop, startWriting, togglePause, useAnim } from './actions';
import { preparePrint } from './printing';
import { serialSupported } from './grbl/transport';
import { STATE_RU } from './grbl/codes';
import { exportFont, importFont } from './core/font';
import { t } from './i18n';
import { LOCKED } from './edition';

const NAV: [Module, typeof Type, string][] = [
  ['text', Type, 'Текст'], ['fonts', PenLine, 'Почерки'], ['art', Brush, 'Рисунки'], ['cad', Ruler, 'Чертёж'],
  ['print', Printer, 'Печать'], ['control', Gamepad2, 'Пульт'], ['settings', Settings, 'Настройки'],
];

export default function App() {
  return <ErrorBoundary><Shell /></ErrorBoundary>;
}

function Shell() {
  const s = useApp();
  const prof = useProfile();
  const c = useMachine();
  const anim = useAnim();
  const [viewPage, setViewPage] = useState(0);
  const font = findFont(s.doc.fontId, s.userFonts);
  const doc = useDeferredValue(s.doc);
  const job = useMemo(() => buildJob(doc, font), [doc, font]);
  const page = Math.min(viewPage, job.pages.length - 1);

  // Тема
  useEffect(() => {
    const apply = () => {
      const dark = s.theme === 'dark' || (s.theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
      document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    };
    apply();
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [s.theme]);
  useEffect(() => { document.documentElement.lang = s.lang; }, [s.lang]);

  // Подготовка к печати (только когда открыт модуль «Печать»)
  const prepared = useMemo(() => (s.module === 'print' ? preparePrint(doc, font, prof, s.optimize, s.printPage) : null), [s.module, doc, font, prof, s.optimize, s.printPage]);
  useEffect(() => { if (s.printPage >= 0) setViewPage(s.printPage); }, [s.printPage]);

  // Пути текущего листа для показа
  const view = useMemo(() => {
    if (prepared) {
      const pp = prepared.pages.find((p) => p.index === page) ?? prepared.pages[0];
      if (pp) return { paths: pp.paths, bad: new Set(pp.bad), order: pp.paths };
    }
    const pg = job.pages[page];
    const bad = outOfBounds(pg.paths, prof, doc.sheet.h);
    return { paths: pg.paths, bad: new Set(bad), order: pg.paths };
  }, [prepared, job, page, prof, doc.sheet.h]);

  // Под чертежом бледно показываем остальное содержимое листа (текст, рисунки, рамку)
  const cadBackground = useMemo(() => {
    if (s.module !== 'cad') return [];
    const pg = job.pages[doc.cad.page];
    return pg ? pg.paths.filter((_, i) => pg.groups[i] !== 2e6) : [];
  }, [s.module, job, doc.cad.page]);

  const boxes = useMemo(() => (s.module === 'art'
    ? boxesFor(doc.items.filter((i) => i.page === page).map((i) => ({ id: i.id, paths: placeItem(i, font, doc.sheet) })))
    // в «Печати» — рамка будущего письма (её же объезжает «Обвести границы»)
    : s.module === 'print' ? boxesFor([{ id: '__bounds', paths: view.paths }])
    : []), [s.module, doc.items, page, font, doc.sheet, view.paths]);

  // Уведомление «Готово», напоминание об отдыхе моторов
  const prevRun = useRef(false);
  const runStart = useRef<number | null>(null);
  const restWarned = useRef(false);
  useEffect(() => {
    const running = !!c.progress?.running;
    if (running && !prevRun.current) { runStart.current = runStart.current ?? Date.now(); }
    if (!running && prevRun.current && c.progress?.finishedAt) { notifyDone('Готово! Машина закончила писать.'); s.notify('Готово! Машина закончила писать.', 'success'); }
    if (!running && prevRun.current && c.progress?.error) s.notify(c.progress.error, 'error');
    prevRun.current = running;
    if (running && runStart.current && prof.restAfterMin > 0 && !restWarned.current && Date.now() - runStart.current > prof.restAfterMin * 60000) {
      restWarned.current = true;
      s.notify(`Моторы работают уже ${prof.restAfterMin} мин. После этого задания выключите машину на 5 минут, чтобы они остыли.`, 'info');
    }
    if (!running && c.progress && Date.now() - (c.progress.finishedAt ?? 0) > 5 * 60000) { runStart.current = null; restWarned.current = false; }
  });

  // Горячие клавиши
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const inField = !!(e.target as HTMLElement)?.closest?.('input,textarea,select,[contenteditable]');
      const mod = e.ctrlKey || e.metaKey;
      if (e.key === 'Escape' && ctl.connected && (ctl.progress?.running || ctl.status.state === 'Run' || ctl.status.state === 'Jog' || ctl.status.state.startsWith('Hold'))) { e.preventDefault(); emergencyStop(); return; }
      if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey && !inField) { e.preventDefault(); s.undo(); return; }
      if (mod && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey)) && !inField) { e.preventDefault(); s.redo(); return; }
      if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); saveProject(); return; }
      if (mod && e.key.toLowerCase() === 'p') { e.preventDefault(); startWriting(); return; }
      if (mod && e.key.toLowerCase() === 'o') { e.preventDefault(); openProject(); return; }
      if (inField) return;
      if (e.code === 'Space' && ctl.progress?.running) { e.preventDefault(); togglePause(); return; }
      if (e.key === '?') { s.setState({ shortcutsOpen: true }); return; }
      if (e.key === '+' || e.key === '=') window.dispatchEvent(new CustomEvent('kg-zoom', { detail: 1 }));
      if (e.key === '-') window.dispatchEvent(new CustomEvent('kg-zoom', { detail: -1 }));
      if (e.key.startsWith('Arrow')) {
        const d: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
        const [dx, dy] = d[e.key];
        if (s.module === 'control') { e.preventDefault(); jog(dx, dy, e.shiftKey ? 10 : 1); }
        else if (s.module === 'art' && s.selectedItem) {
          e.preventDefault();
          const k = e.shiftKey ? 10 : 1;
          s.setDoc((d0) => ({ ...d0, items: d0.items.map((i) => (i.id === s.selectedItem ? { ...i, x: i.x + dx * k, y: i.y + dy * k } : i)) }), { merge: true });
        }
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && s.module === 'art' && s.selectedItem) {
        s.setDoc((d0) => ({ ...d0, items: d0.items.filter((i) => i.id !== s.selectedItem) }));
        s.setState({ selectedItem: null });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [s]);

  const editingFont = s.module === 'fonts' && s.editingFont && s.userFonts.some((f) => f.id === s.editingFont);
  const left = s.module === 'text' ? <TextLeft job={job} /> : editingFont ? <FontsLeft /> : s.module === 'cad' ? <CadLeft /> : null;
  const right = {
    text: <TextRight />, fonts: <FontsRight />, art: <ArtRight />, cad: <CadRight />,
    print: prepared ? <PrintRight prepared={prepared} pageCount={job.pages.length} /> : null,
    control: <ControlRight />, settings: <SettingsRight />,
  }[s.module];

  const pausedMsg = c.progress?.running && c.progress.paused ? (c.progress.message ?? 'Пауза') : null;

  return (
    <div className="app">
      <TopBar />
      <div className={'main' + (left ? '' : ' no-left')}>
        <nav className="nav" aria-label="Разделы">
          {NAV.map(([m, Icon, label]) => (
            <button key={m} className={s.module === m ? 'active' : ''} onClick={() => s.setModule(m)} aria-current={s.module === m} data-tour={'nav-' + m}>
              <Icon />{t(label)}
            </button>
          ))}
        </nav>
        {left}
        <div className="center">
          {editingFont ? <GlyphCreator /> : s.module === 'cad' ? <CadView background={cadBackground} /> : (
            <>
              <SheetView
                w={doc.sheet.w} h={doc.sheet.h} paths={view.paths} bad={view.bad} profile={prof}
                ruling={doc.printRuling ? [] : job.pages[page]?.ruling}
                travel={anim.travel && s.module === 'print'}
                anim={s.module === 'print' && anim.on ? { order: view.order, t: anim.t } : null}
                boxes={boxes} selected={s.module === 'print' ? '__bounds' : s.selectedItem}
                onSelect={s.module === 'art' ? (id) => s.setState({ selectedItem: id }) : undefined}
                onMoveItem={s.module === 'art' ? (id, dx, dy) => s.setDoc((d) => ({ ...d, items: d.items.map((i) => (i.id === id ? { ...i, x: i.x + dx, y: i.y + dy } : i)) }), { merge: true }) : undefined}
                showSim={!!sim}
                bed={s.module === 'print' && anim.bed ? { x: anim.bedX, y: anim.bedY } : null}
              />
              {job.pages.length > 1 && (
                <div className="page-tabs">
                  {job.pages.map((_, i) => <button key={i} className={i === page ? 'on' : ''} onClick={() => setViewPage(i)}>{t('Лист')} {i + 1}</button>)}
                </div>
              )}
              <div className="legend">
                <span><i style={{ borderColor: '#2b2d6e' }} />письмо</span>
                <span><i style={{ borderColor: '#4dabf7', borderTopStyle: 'dashed' }} />рабочее поле</span>
                {view.bad.size > 0 && <span style={{ color: 'var(--danger)', fontWeight: 700 }}><i style={{ borderColor: '#e03131' }} />{t('Вне поля')}: {view.bad.size}</span>}
                {sim && <span><i style={{ borderColor: '#1c7ed6' }} />симулятор <button className="btn ghost small" style={{ padding: '0 4px' }} onClick={clearSimTrace}>очистить</button></span>}
              </div>
              {pausedMsg && (
                <div className="pause-banner" role="alert">
                  {pausedMsg}
                  <button className="btn small" style={{ background: '#fff', color: '#333' }} onClick={() => ctl.resume()}><Play />{t('Продолжить')}</button>
                </div>
              )}
            </>
          )}
        </div>
        <aside className="right-pane">{right}</aside>
      </div>
      <StatusBar />
      {s.toast && <div className={'toast ' + s.toast.kind} role="status" onClick={() => s.setState({ toast: null })}>{s.toast.text}</div>}
      {s.wizardOpen && <Wizard />}
      {s.shortcutsOpen && <Shortcuts />}
      {!s.tourDone && <Tour />}
    </div>
  );
}

function saveProject() {
  const s = useApp.getState();
  const font = s.userFonts.find((f) => f.id === s.doc.fontId);
  const data = { kind: 'kalligraf-project', version: 1, doc: s.doc, font: font ? exportFont(font) : undefined };
  downloadText(safeName(s.doc.name) + '.kproj', JSON.stringify(data), 'application/json');
  s.notify('Проект сохранён в файл', 'success');
}

async function openProject() {
  const s = useApp.getState();
  const f = await pickFile('.kproj,.json');
  if (!f) return;
  try {
    const data = JSON.parse(await f.text()) as { kind?: string; doc?: Doc; font?: unknown };
    if (data.kind !== 'kalligraf-project' || !data.doc) throw new Error('это не проект Каллиграфа');
    let doc = data.doc;
    if (data.font) {
      const font = importFont(data.font);
      s.addUserFont(font);
      doc = { ...doc, fontId: font.id };
    }
    s.setDoc(() => ({ ...useApp.getState().doc, ...doc }));
    s.notify(`Открыт проект «${doc.name}»`, 'success');
  } catch (e) {
    s.notify('Не удалось открыть проект: ' + (e as Error).message, 'error');
  }
}

function TopBar() {
  const s = useApp();
  const c = useMachine();
  const prof = useProfile();
  const [menu, setMenu] = useState(false);
  const state = c.status.state.split(':')[0];
  const dot = !c.connected ? '' : state === 'Alarm' ? 'alarm' : state === 'Run' || state === 'Jog' ? 'run' : 'on';
  const label = !c.connected ? t('Не подключено') : (c.transport?.kind === 'sim' ? 'Симулятор · ' : '') + (STATE_RU[state] ?? t('Подключено'));
  const usb = async () => {
    setMenu(false);
    try {
      const baud = await connectSerial(prof.baud, () => {});
      s.updateProfile({ baud });
      s.notify(`Машина подключена (${baud})`, 'success');
      if (!s.wizardDone) s.setState({ wizardOpen: true });
    } catch (e) {
      const m = (e as Error).message;
      if (!/No port selected/i.test(m)) s.notify(m, 'error');
    }
  };
  return (
    <header className="topbar">
      <div className="logo">
        <svg viewBox="0 0 64 64" aria-hidden><rect width="64" height="64" rx="14" fill="#2b2d6e" /><path d="M14 44c8-2 10-22 18-22s4 16 10 16 6-10 8-12" fill="none" stroke="#ff8a2a" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" /></svg>
        <span className="hide-sm">Каллиграф</span>
      </div>
      <input className="project-name" value={s.doc.name} onChange={(e) => { const v = e.target.value; s.setDoc((d) => ({ ...d, name: v }), { merge: true }); }} aria-label="Название проекта" />
      <button className="btn ghost icon" onClick={s.undo} disabled={!s.past.length} title={`${t('Отменить')} (Ctrl+Z)`} aria-label={t('Отменить')}><Undo2 /></button>
      <button className="btn ghost icon" onClick={s.redo} disabled={!s.future.length} title={`${t('Повторить')} (Ctrl+Y)`} aria-label={t('Повторить')}><Redo2 /></button>
      <button className="btn ghost icon" onClick={openProject} title={`${t('Открыть проект')} (Ctrl+O)`} aria-label={t('Открыть проект')}><FolderOpen /></button>
      <button className="btn ghost icon" onClick={saveProject} title={`${t('Сохранить проект')} (Ctrl+S)`} aria-label={t('Сохранить проект')}><FileDown /></button>
      <button className="btn ghost icon hide-sm" onClick={() => s.setState({ shortcutsOpen: true })} title={`${t('Горячие клавиши')} (?)`} aria-label={t('Горячие клавиши')}><Keyboard /></button>
      <div className="spacer" />
      <span className="conn" data-tour="conn"><span className={'dot ' + dot} />{label}</span>
      <div style={{ position: 'relative' }}>
        {c.connected
          ? <button className="btn" onClick={() => disconnect()} disabled={!!c.progress?.running}><Unplug />{t('Отключить')}</button>
          : <button className="btn primary" onClick={() => setMenu(!menu)} data-tour="connect"><Cable />{t('Подключить машину')}</button>}
        {menu && (
          <div style={{ position: 'absolute', right: 0, top: 44, background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 12, boxShadow: 'var(--shadow)', padding: 8, zIndex: 20, width: 280, display: 'flex', flexDirection: 'column', gap: 6 }}>
            <button className="btn" onClick={usb} disabled={!serialSupported()}><Usb />По USB-кабелю</button>
            {!serialSupported() && <div className="hint" style={{ padding: '0 4px' }}>USB работает только в Chrome, Edge, Opera, Яндекс.Браузере.</div>}
            <button className="btn" onClick={() => { setMenu(false); connectSimulator(1); s.notify('Симулятор включён: виртуальная ручка пишет синим', 'success'); }}><Monitor />{t('Симулятор')} (без машины)</button>
            <button className="btn ghost" onClick={() => { setMenu(false); s.setState({ wizardOpen: true }); }}>{t('Мастер настройки')}…</button>
          </div>
        )}
      </div>
    </header>
  );
}

function StatusBar() {
  const c = useMachine();
  const prof = useProfile();
  const pr = c.progress;
  const wp = c.status.wpos;
  const pct = pr ? Math.round((pr.acked / Math.max(1, pr.total)) * 100) : 0;
  const penDown = wp ? (prof.penMode === 'z' ? wp[2] < 0.5 : prof.penMode === 'zinv' ? wp[2] > 1 : false) : false;
  const elapsed = pr?.running ? (Date.now() - pr.startedAt) / 1000 : 0;
  const left = pr?.running && pct > 2 ? (elapsed / pct) * (100 - pct) : 0;
  return (
    <footer className="statusbar">
      <div className="status-items">
        <span>X: <b>{wp ? wp[0].toFixed(1) : '—'}</b></span>
        <span>Y: <b>{wp ? wp[1].toFixed(1) : '—'}</b></span>
        {(prof.penMode === 'z' || prof.penMode === 'zinv') && <span>{t('Ручка')}: <b>{wp ? (penDown ? t('опущена') : t('поднята')) : '—'}</b></span>}
        {!LOCKED && <span className="hide-sm">{t('Скорость')}: <b>{c.status.feed ?? prof.drawSpeed}</b>{c.status.overrides && c.status.overrides[0] !== 100 ? ` (${c.status.overrides[0]}%)` : ''}</span>}
        {pr?.running && <span>{t('Время')}: <b>{formatDuration(elapsed)}</b>{left > 0 && <> · осталось ≈ <b>{formatDuration(left)}</b></>}</span>}
      </div>
      <div className="btn-row">
        <button className="btn primary big" onClick={() => startWriting()} disabled={!c.connected || !!pr?.running} title="Ctrl+P"><Play />{t('Писать')}</button>
        <button className="btn big" onClick={togglePause} disabled={!pr?.running} title="Пробел">{pr?.running && pr.paused ? <Play /> : <Pause />}{pr?.running && pr.paused ? t('Продолжить') : t('Пауза')}</button>
        <button className="btn stop" onClick={emergencyStop} disabled={!c.connected} title="Esc — аварийная остановка"><Square />{t('СТОП')}</button>
      </div>
      <div className="progress" aria-label="Прогресс письма" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}><div style={{ width: pct + '%' }} /></div>
      <b style={{ minWidth: 38, fontVariantNumeric: 'tabular-nums' }}>{pr ? pct + '%' : ''}</b>
    </footer>
  );
}

function Shortcuts() {
  const close = () => useApp.getState().setState({ shortcutsOpen: false });
  const rows: [string, string][] = [
    ['Ctrl+Z / Ctrl+Y', 'Отменить / повторить'], ['Ctrl+S', 'Сохранить проект в файл'], ['Ctrl+O', 'Открыть проект'],
    ['Ctrl+P', 'Писать (отправить на машину)'], ['Пробел', 'Пауза / продолжить во время письма'], ['Esc', 'СТОП — аварийная остановка'],
    ['Стрелки', 'Двигать ручку (Пульт) или рисунок (Рисунки); с Shift — шаг 10 мм'], ['+ / −', 'Масштаб листа'],
    ['Колесо мыши', 'Масштаб вокруг курсора'], ['Пробел + мышь', 'Двигать лист'], ['Delete', 'Удалить выбранный рисунок'], ['?', 'Этот список'],
  ];
  return (
    <Modal title={t('Горячие клавиши')} onClose={close}>
      <table className="settings-table"><tbody>
        {rows.map(([k, v]) => <tr key={k}><td style={{ width: 150 }}><span className="kbd">{k}</span></td><td>{v}</td></tr>)}
      </tbody></table>
    </Modal>
  );
}

const TOUR: [string, string, string][] = [
  ['nav-text', 'Пишите здесь', 'Введите текст в поле слева — справа сразу видно, как машина напишет его на листе.'],
  ['nav-fonts', 'Свой почерк', 'В «Почерках» можно выбрать шрифт или нарисовать свои буквы мышкой, пальцем или стилусом.'],
  ['nav-art', 'Рисунки', 'Лабиринты, судоку, графики функций, мандалы, кыргызский орнамент, рамка ГОСТ и импорт SVG.'],
  ['connect', 'Подключение', 'Подключите машину по USB — или включите симулятор, чтобы попробовать без машины.'],
  ['nav-print', 'Печать', 'Здесь — время письма, анимация, проверка поля и кнопка «Писать». Красная кнопка СТОП (Esc) всегда внизу.'],
];

function Tour() {
  const [i, setI] = useState(0);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const done = () => useApp.getState().setState({ tourDone: true });
  useEffect(() => {
    const el = document.querySelector(`[data-tour="${TOUR[i][0]}"]`);
    if (!el) { setPos({ left: 100, top: 100 }); return; }
    const r = el.getBoundingClientRect();
    const left = Math.min(window.innerWidth - 316, r.right + 12 > window.innerWidth - 316 ? r.left - 312 : r.right + 12);
    setPos({ left: Math.max(8, left), top: Math.min(window.innerHeight - 200, Math.max(8, r.top)) });
  }, [i]);
  if (!pos) return null;
  return (
    <div className="tour" style={pos} role="dialog" aria-label="Подсказка">
      {i === 0 && <div style={{ fontWeight: 800, marginBottom: 4 }}>{t('Добро пожаловать в Каллиграф')}</div>}
      <div style={{ fontWeight: 700 }}>{TOUR[i][1]}</div>
      <div style={{ opacity: 0.9, margin: '4px 0 10px' }}>{TOUR[i][2]}</div>
      <div className="btn-row" style={{ justifyContent: 'space-between' }}>
        <button className="btn small" onClick={done}>{t('Пропустить')}</button>
        <span style={{ opacity: 0.7, alignSelf: 'center', fontSize: 12 }}>{i + 1} / {TOUR.length}</span>
        <button className="btn small" onClick={() => (i < TOUR.length - 1 ? setI(i + 1) : done())}>{i < TOUR.length - 1 ? t('Далее') : t('Готово')}</button>
      </div>
    </div>
  );
}

class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error) { console.error(error); }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div style={{ padding: 40, maxWidth: 640, margin: '40px auto', fontFamily: 'system-ui' }}>
        <h2>Что-то пошло не так</h2>
        <p>Ваш проект автоматически сохранён. Перезагрузите страницу — работа продолжится с того же места.</p>
        <pre style={{ whiteSpace: 'pre-wrap', background: '#f3f2ee', padding: 12, borderRadius: 8, fontSize: 12 }}>{this.state.error.message}</pre>
        <button onClick={() => location.reload()} style={{ padding: '10px 18px', borderRadius: 8, border: 0, background: '#2b2d6e', color: '#fff', fontWeight: 700, cursor: 'pointer' }}>Перезагрузить</button>
      </div>
    );
  }
}
