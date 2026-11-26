// Каллиграф для телефона: только «Писать» (A4 / тетрадь) и «Пульт». Скорость машины ≤ 2000 мм/мин.
import { useDeferredValue, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { builtinFonts, type Font } from '../core/font';
import { FontsTab } from './FontsTab';
import { layoutText, defaultTextOptions, type TextOptions } from '../core/layout';
import { optimizePaths, defaultOptimize } from '../core/optimize';
import { boundsGcode, estimateJob, formatDuration, generateGcode, type MachineProfile } from '../core/gcode';
import { dryRunLines, resumePlan } from './jobs';
import { appendSpoken, listen, recognizePhoto, signal, unlockAudio, voiceAvailable } from './native';
import type { Path } from '../core/geometry';
import { GrblController } from '../grbl/controller';
import { SerialTransport, SimTransport, serialSupported } from '../grbl/transport';
import { AndroidTransport, androidUsbAvailable } from './androidTransport';
import { MAX_F, limitLine, limitedTransport, mobileProfile } from './limit';
import { AUTHOR, COPYRIGHT } from '../author';

// ── Машина ───────────────────────────────────────────────────────────

const ctl = new GrblController();
let ver = 0;
ctl.subscribe(() => { ver++; });
function useCtl() {
  useSyncExternalStore((cb) => {
    let pending = false;
    return ctl.subscribe(() => { if (!pending) { pending = true; setTimeout(() => { pending = false; cb(); }, 80); } });
  }, () => ver);
  return ctl;
}

/** Отправить команды по одной, каждая — через ограничитель скорости. */
async function send(lines: string) {
  for (const l of lines.split('\n').map((x) => x.trim()).filter(Boolean)) await ctl.command(limitLine(l));
}

// ── Настройки (хранятся на телефоне) ─────────────────────────────────

type Fmt = 'a4' | 'nb';
type Size = 's' | 'm' | 'l';
type Theme = 'auto' | 'light' | 'dark';
interface Saved { name: string; text: string }
interface Settings {
  fmt: Fmt; text: string; fontId: string; size: Size; speed: number; swap: boolean; accuracy: number;
  startLine: number; saved: Saved[]; recent: string[]; theme: Theme; big: boolean; sound: boolean;
}
const DEFAULTS: Settings = {
  fmt: 'nb', text: 'Привет! Это Каллиграф на телефоне.\nНапишите сюда текст и нажмите «Писать».',
  fontId: 'hw-caveat', size: 'm', speed: MAX_F, swap: false, accuracy: 7,
  startLine: 1, recent: [], theme: 'auto', big: false, sound: true,
  saved: [
    { name: 'Заявление', text: 'Директору\nот ученика\n\nЗаявление.\n\nПрошу ' },
    { name: 'Конспект', text: 'Тема: \n\n1. \n2. \n3. ' },
  ],
};
const KEY = 'kalligraf-mobile';
const RESUME_KEY = 'kalligraf-mobile-resume';
const FONTS_KEY = 'kalligraf-mobile-fonts';
function loadFonts(): Font[] {
  try { const a = JSON.parse(localStorage.getItem(FONTS_KEY) || '[]'); return Array.isArray(a) ? a : []; } catch { return []; }
}
function loadSettings(): Settings {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; } catch { return DEFAULTS; }
}

/** То, что нужно, чтобы заново собрать ту же программу и продолжить после обрыва. */
type Snap = Pick<Settings, 'fmt' | 'text' | 'fontId' | 'size' | 'swap' | 'accuracy' | 'startLine'>;
interface ResumeInfo { snap: Snap; acked: number; total: number }
const snapOf = (s: Settings): Snap => ({ fmt: s.fmt, text: s.text, fontId: s.fontId, size: s.size, swap: s.swap, accuracy: s.accuracy, startLine: s.startLine });
function loadResume(): ResumeInfo | null {
  try { return JSON.parse(localStorage.getItem(RESUME_KEY) || 'null'); } catch { return null; }
}
function saveResume(r: ResumeInfo | null) {
  try { if (r) localStorage.setItem(RESUME_KEY, JSON.stringify(r)); else localStorage.removeItem(RESUME_KEY); } catch { /* нет места */ }
}
/** Какое задание сейчас идёт: настоящее письмо отслеживаем для «продолжить после обрыва». */
let track: { kind: 'write'; snap: Snap; headLen: number; from: number; total: number } | { kind: 'test' } | null = null;

const SHEETS: Record<Fmt, { w: number; h: number; name: string }> = {
  a4: { w: 210, h: 297, name: 'A4' },
  nb: { w: 165, h: 205, name: 'Тетрадь' },
};
// высота букв и шаг строк, мм
const SIZES: Record<Fmt, Record<Size, [number, number]>> = {
  a4: { s: [4, 7], m: [6, 10], l: [8, 13] },
  nb: { s: [3.5, 10], m: [4, 10], l: [5, 10] }, // в тетради строка — через клетку (10 мм)
};

function textOptions(st: Pick<Settings, "fmt" | "size" | "accuracy">): TextOptions {
  const [size, lineHeight] = SIZES[st.fmt][st.size];
  const margins = st.fmt === 'nb' ? { top: 10, bottom: 5, left: 5, right: 25 } : defaultTextOptions.margins;
  return { ...defaultTextOptions, size, lineHeight, margins, indent: 10, accuracy: st.accuracy };
}

function gridPaths(w: number, h: number, step: number): Path[] {
  const out: Path[] = [];
  for (let x = step; x < w; x += step) out.push({ points: [[x, 0], [x, h]] });
  for (let y = step; y < h; y += step) out.push({ points: [[0, y], [w, y]] });
  return out;
}
function svgD(paths: Path[]) {
  let d = '';
  for (const p of paths) {
    if (!p.points.length) continue;
    d += `M${p.points[0][0].toFixed(1)} ${p.points[0][1].toFixed(1)}`;
    if (p.points.length === 1) d += 'l0.05 0';
    for (let i = 1; i < p.points.length; i++) d += `L${p.points[i][0].toFixed(1)} ${p.points[i][1].toFixed(1)}`;
  }
  return d;
}

function prepare(st: Snap, prof: MachineProfile, userFonts: Font[] = []) {
  const fonts = [...builtinFonts(), ...userFonts];
  const font = fonts.find((f) => f.id === st.fontId) ?? fonts[0];
  const sheet = SHEETS[st.fmt];
  // «Начать со строки N»: пропускаем N−1 строк только на первом листе
  const skip = Math.max(0, Math.round(st.startLine || 1) - 1);
  const lay = layoutText(String.fromCharCode(10).repeat(skip) + st.text, font, textOptions(st), sheet, font.id === fonts[0].id ? undefined : fonts[0]);
  const pages = lay.pages.map((pg) => optimizePaths(pg.paths, defaultOptimize, [0, 0], pg.groups).paths);
  const sections = pages.map((paths, i) => ({ paths, pauseMessage: i ? `Положите новый лист (лист ${i + 1})` : undefined }));
  const lines = generateGcode({ sections, sheetH: sheet.h }, prof).map((l) => limitLine(l));
  const stats = estimateJob(pages.flat(), prof);
  return { pages, lines, stats, missing: lay.missing };
}

// ── Интерфейс ────────────────────────────────────────────────────────

export function MobileApp() {
  const [st, setSt] = useState<Settings>(loadSettings);
  const [tab, setTab] = useState<'write' | 'fonts' | 'pult'>('write');
  const [userFonts, setUserFonts] = useState<Font[]>(loadFonts);
  useEffect(() => { try { localStorage.setItem(FONTS_KEY, JSON.stringify(userFonts)); } catch { setMsg({ text: 'Мало места: почерк не сохранён', bad: true }); } }, [userFonts]);
  const [page, setPage] = useState(0);
  const [msg, setMsg] = useState<{ text: string; bad?: boolean } | null>(null);
  const [connecting, setConnecting] = useState(false);
  const c = useCtl();
  const set = (p: Partial<Settings>) => setSt((s) => ({ ...s, ...p }));
  useEffect(() => { try { localStorage.setItem(KEY, JSON.stringify(st)); } catch { /* нет места */ } }, [st]);
  useEffect(() => { if (msg) { const t = setTimeout(() => setMsg(null), msg.bad ? 6000 : 3000); return () => clearTimeout(t); } }, [msg]);

  const prof = useMemo(() => mobileProfile(MAX_F, st.swap), [st.swap]); // скорость всегда максимальная (2000)
  const deferred = useDeferredValue(st);
  const job = useMemo(() => prepare(deferred, prof, userFonts), [deferred, prof, userFonts]);
  const pg = Math.min(page, job.pages.length - 1);
  const sheet = SHEETS[st.fmt];

  const pr = c.progress;
  const running = !!pr?.running;
  const state = c.status.state;
  const pos = c.status.wpos;

  async function connect() {
    setConnecting(true);
    try {
      if (androidUsbAvailable()) await ctl.attach(limitedTransport(await AndroidTransport.open(115200)));
      else if (serialSupported()) {
        const port = await SerialTransport.request();
        await ctl.attach(limitedTransport(await SerialTransport.open(port, 115200)));
      } else throw new Error('Откройте приложение «Каллиграф» на телефоне — в обычном браузере USB нет.');
      setMsg({ text: 'Машина подключена' });
    } catch (e) {
      setMsg({ text: String((e as Error).message || e), bad: true });
    } finally { setConnecting(false); }
  }
  async function demo() {
    const sim = new SimTransport({ speed: 4 });
    sim.zDownHigh = !st.swap;
    await ctl.attach(limitedTransport(sim));
    setMsg({ text: 'Демо: виртуальная машина' });
  }
  const guard = async (f: () => Promise<unknown>) => {
    try { await f(); } catch (e) { setMsg({ text: String((e as Error).message || e), bad: true }); }
  };

  // ── продолжение после обрыва, сигналы ──
  const [resume, setResume] = useState<ResumeInfo | null>(loadResume);
  const soundRef = useRef(st.sound);
  soundRef.current = st.sound;
  useEffect(() => {
    let lastSave = 0, lastMsg: string | undefined, wasRunning = false;
    const off = ctl.subscribe(() => {
      const p = ctl.progress;
      const t = track;
      if (p?.running && p.message && p.message !== lastMsg && soundRef.current) signal('page');
      lastMsg = p?.running ? p.message : undefined;
      if (t?.kind === 'write') {
        const orig = Math.min(t.total - 1, ctl.lastAckedIndex - t.headLen + t.from);
        if (p?.running) {
          wasRunning = true;
          if (Date.now() - lastSave > 1000) { lastSave = Date.now(); saveResume({ snap: t.snap, acked: orig, total: t.total }); }
        } else if (wasRunning) {
          wasRunning = false;
          track = null;
          if (p && !p.error) { saveResume(null); setResume(null); if (soundRef.current) signal('done'); }
          else { const r = { snap: t.snap, acked: orig, total: t.total }; saveResume(r); setResume(r); }
        }
      } else if (t?.kind === 'test' && p && !p.running) {
        track = null;
        if (!p.error && soundRef.current) signal('done');
      }
    });
    return () => { off(); };
  }, []);

  function startJob(lines: string[], t: typeof track) {
    if (!c.connected) { setMsg({ text: 'Сначала подключите машину', bad: true }); return false; }
    unlockAudio();
    try { track = t; c.stream(lines); setTab('write'); return true; } catch (e) { track = null; setMsg({ text: String((e as Error).message), bad: true }); return false; }
  }
  function write() {
    if (!job.pages.some((p) => p.length)) return setMsg({ text: 'Напишите текст', bad: true });
    const snap = snapOf(st);
    if (startJob(job.lines, { kind: 'write', snap, headLen: 0, from: 0, total: job.lines.length })) {
      saveResume(null); setResume(null);
      const t = st.text.trim();
      if (t) set({ recent: [t, ...st.recent.filter((x) => x !== t)].slice(0, 5) });
    }
  }
  function dryRun() {
    if (!job.pages.some((p) => p.length)) return setMsg({ text: 'Напишите текст', bad: true });
    if (startJob(dryRunLines(job.lines, prof), { kind: 'test' })) setMsg({ text: 'Проверка: ручка не опускается' });
  }
  function traceBounds() {
    const paths = job.pages[pg] ?? [];
    if (!paths.length) return setMsg({ text: 'Напишите текст', bad: true });
    if (startJob(boundsGcode(paths, prof, sheet.h, 1, MAX_F).map((l) => limitLine(l)), { kind: 'test' })) setMsg({ text: 'Обвожу рамку текста' });
  }
  function continueResume() {
    if (!resume) return;
    const rprof = mobileProfile(MAX_F, resume.snap.swap);
    const full = prepare(resume.snap, rprof, userFonts).lines;
    const plan = resumePlan(full, resume.acked, rprof);
    startJob(plan.lines, { kind: 'write', snap: resume.snap, headLen: plan.headLen, from: plan.from, total: full.length });
  }

  // ── голос и фото ──
  const [busy, setBusy] = useState<string | null>(null);
  const [showSaved, setShowSaved] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  async function voice() {
    setBusy('Говорите…');
    try { const s = await listen(); setSt((x) => ({ ...x, text: appendSpoken(x.text, s) })); }
    catch (e) { setMsg({ text: String((e as Error).message || e), bad: true }); }
    finally { setBusy(null); }
  }
  async function photo(f: File | undefined) {
    if (!f) return;
    setBusy('Читаю текст с фото…');
    try {
      const text = await recognizePhoto(f, (p) => setBusy(`Читаю текст с фото… ${Math.round(p * 100)}%`));
      if (!text.trim()) throw new Error('Текст на фото не найден. Снимите ровнее и при хорошем свете.');
      setSt((x) => ({ ...x, text: x.text.trim() ? x.text.replace(/\s+$/, '') + '\n' + text : text }));
      setMsg({ text: 'Текст добавлен — проверьте ошибки' });
    } catch (e) { setMsg({ text: String((e as Error).message || e), bad: true }); }
    finally { setBusy(null); if (fileRef.current) fileRef.current.value = ''; }
  }

  // тема и крупный шрифт
  useEffect(() => {
    const r = document.documentElement;
    if (st.theme === 'auto') r.removeAttribute('data-theme'); else r.setAttribute('data-theme', st.theme);
    r.classList.toggle('m-big', st.big);
  }, [st.theme, st.big]);

  const pct = pr ? Math.round((pr.acked / Math.max(1, pr.total)) * 100) : 0;
  const fonts = [...builtinFonts().filter((f) => !f.id.startsWith('drafting')), ...userFonts];
  const maxLine = Math.floor((sheet.h - (st.fmt === 'nb' ? 15 : 20)) / SIZES[st.fmt][st.size][1]);

  return (
    <div className="m-app">
      <header className="m-top">
        <b>Каллиграф</b>
        <span className={'m-dot ' + (c.connected ? (state === 'Alarm' ? 'warn' : 'on') : '')} />
        <span className="m-state">{c.connected ? stateName(state) : 'не подключено'}</span>
        {c.connected
          ? <button className="m-btn small" onClick={() => guard(() => ctl.detach())}>Отключить</button>
          : <button className="m-btn small primary" disabled={connecting} onClick={connect}>{connecting ? 'Подключаю…' : 'Подключить'}</button>}
      </header>

      {pr?.message && running && (
        <div className="m-banner">{pr.message}<button className="m-btn small" onClick={() => c.resume()}>Продолжить</button></div>
      )}
      {state === 'Alarm' && (
        <div className="m-banner warn">Тревога: машина заблокирована<button className="m-btn small" onClick={() => guard(() => send('$X'))}>Разблокировать</button></div>
      )}
      {resume && !running && (
        <div className="m-banner info">
          <span>Письмо прервано на {Math.round(((resume.acked + 1) / Math.max(1, resume.total)) * 100)}%.
            <small> Если машину выключали — сначала поставьте ручку в начало листа на «Пульте».</small></span>
          <span className="m-banner-btns">
            <button className="m-btn small primary" disabled={!c.connected} onClick={continueResume}>Продолжить</button>
            <button className="m-btn small" onClick={() => { saveResume(null); setResume(null); }}>Забыть</button>
          </span>
        </div>
      )}
      {busy && <div className="m-banner">{busy}</div>}

      <main className="m-main">
        {tab === 'write' ? (
          <>
            <div className="m-seg">
              {(['nb', 'a4'] as Fmt[]).map((f) => (
                <button key={f} className={st.fmt === f ? 'on' : ''} disabled={running} onClick={() => { set({ fmt: f }); setPage(0); }}>
                  {f === 'nb' ? 'Тетрадь 165×205' : 'A4 210×297'}
                </button>
              ))}
            </div>
            <textarea className="m-text" value={st.text} disabled={running} onChange={(e) => set({ text: e.target.value })} placeholder="Текст для письма" rows={5} />
            <div className="m-tools">
              {voiceAvailable() && <button className="m-btn small" disabled={running || !!busy} onClick={voice}>🎤 Голос</button>}
              <button className="m-btn small" disabled={running || !!busy} onClick={() => fileRef.current?.click()}>📷 Фото</button>
              <button className={'m-btn small' + (showSaved ? ' on' : '')} disabled={running} onClick={() => setShowSaved(!showSaved)}>☆ Заготовки</button>
              <button className="m-btn small" disabled={running || !st.text} onClick={() => set({ text: '' })}>✕</button>
              <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => photo(e.target.files?.[0])} />
            </div>
            {showSaved && (
              <div className="m-saved">
                <button className="m-btn small primary" disabled={!st.text.trim()} onClick={() => {
                  const t = st.text.trim();
                  const name = t.split('\n')[0].slice(0, 28) || 'Без названия';
                  set({ saved: [{ name, text: st.text }, ...st.saved.filter((s) => s.text !== st.text)] });
                  setMsg({ text: 'Сохранено в заготовки' });
                }}>＋ Сохранить этот текст</button>
                {st.saved.map((s, i) => (
                  <div key={'s' + i} className="m-saved-row">
                    <button className="m-link" onClick={() => { set({ text: s.text }); setShowSaved(false); }}>☆ {s.name}</button>
                    <button className="m-x" title="Удалить" onClick={() => set({ saved: st.saved.filter((_, j) => j !== i) })}>✕</button>
                  </div>
                ))}
                {st.recent.length > 0 && <div className="m-hint">Недавние</div>}
                {st.recent.map((t, i) => (
                  <div key={'r' + i} className="m-saved-row">
                    <button className="m-link" onClick={() => { set({ text: t }); setShowSaved(false); }}>↺ {t.replace(/\s+/g, ' ').slice(0, 40)}</button>
                  </div>
                ))}
              </div>
            )}
            <div className="m-row">
              <select value={st.fontId} disabled={running} onChange={(e) => set({ fontId: e.target.value })}>
                {fonts.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
              </select>
              <div className="m-seg small">
                {(['s', 'm', 'l'] as Size[]).map((z) => (
                  <button key={z} className={st.size === z ? 'on' : ''} disabled={running} onClick={() => set({ size: z })}>{z === 's' ? 'Мелко' : z === 'm' ? 'Средне' : 'Крупно'}</button>
                ))}
              </div>
            </div>
            {job.missing.length > 0 && <div className="m-hint warn">Нет в почерке: {job.missing.join(' ')} — напишутся печатными.</div>}
            <div className="m-stepper">
              <span>Начать со строки</span>
              <button className="m-btn small" disabled={running || st.startLine <= 1} onClick={() => setSt((x) => ({ ...x, startLine: Math.max(1, x.startLine - 1) }))}>−</button>
              <b>{st.startLine}</b>
              <button className="m-btn small" disabled={running || st.startLine >= maxLine} onClick={() => setSt((x) => ({ ...x, startLine: Math.min(maxLine, x.startLine + 1) }))}>＋</button>
            </div>

            <div className="m-sheet-wrap">
              <svg className="m-sheet" viewBox={`-2 -2 ${sheet.w + 4} ${sheet.h + 4}`} style={{ aspectRatio: `${sheet.w + 4} / ${sheet.h + 4}` }}>
                <rect x={0} y={0} width={sheet.w} height={sheet.h} fill="#fffdf6" stroke="#c9c4b5" strokeWidth={0.4} />
                {st.fmt === 'nb' && <path d={svgD(gridPaths(sheet.w, sheet.h, 5))} stroke="#bcd3ea" strokeWidth={0.25} />}
                {st.fmt === 'nb' && <path d={`M${sheet.w - 25} 0V${sheet.h}`} stroke="#e8a0a0" strokeWidth={0.35} />}
                <path d={svgD(job.pages[pg] ?? [])} stroke="#22307a" strokeWidth={0.35} fill="none" strokeLinecap="round" strokeLinejoin="round" />
                {pos && c.connected && <circle cx={pos[0]} cy={-pos[1]} r={2} fill="none" stroke="#e8590c" strokeWidth={0.6} />}
              </svg>
            </div>
            {job.pages.length > 1 && (
              <div className="m-seg small">
                {job.pages.map((_, i) => <button key={i} className={i === pg ? 'on' : ''} onClick={() => setPage(i)}>Лист {i + 1}</button>)}
              </div>
            )}
            <div className="m-hint">
              Листов: <b>{job.pages.length}</b> · время ≈ <b>{formatDuration(job.stats.seconds)}</b> · подъёмов ручки: {job.stats.penLifts}
            </div>
            <div className="m-grid2">
              <button className="m-btn" disabled={!c.connected || running} onClick={traceBounds}>⬚ Обвести границы</button>
              <button className="m-btn" disabled={!c.connected || running} onClick={dryRun}>◌ Проверка без чернил</button>
            </div>

            {pr && (
              <div className="m-progress">
                <div className="m-bar"><i style={{ width: pct + '%' }} /></div>
                <span>{running ? (pr.draining ? 'Дописывает…' : `${pct}%`) : pr.error ? pr.error : 'Готово'}</span>
              </div>
            )}
          </>
        ) : tab === 'fonts' ? (
          <FontsTab userFonts={userFonts} setUserFonts={setUserFonts} fontId={st.fontId} onUse={(id) => set({ fontId: id })} setMsg={setMsg} />
        ) : (
          <Pult prof={prof} st={st} set={set} running={running} guard={guard} setMsg={setMsg} />
        )}
      </main>

      <footer className="m-actions">
        {!running
          ? <button className="m-btn primary big" disabled={!c.connected} onClick={write}>✎ Писать</button>
          : state.startsWith('Hold')
            ? <button className="m-btn primary big" onClick={() => c.resume()}>▶ Продолжить</button>
            : <button className="m-btn big" onClick={() => c.pause()}>❚❚ Пауза</button>}
        <button className="m-btn danger big" disabled={!c.connected} onClick={() => guard(() => c.stop(prof.penUp))}>■ СТОП</button>
      </footer>
      <nav className="m-tabs">
        <button className={tab === 'write' ? 'on' : ''} onClick={() => setTab('write')}>✎ Писать</button>
        <button className={tab === 'fonts' ? 'on' : ''} onClick={() => setTab('fonts')}>✍ Почерки</button>
        <button className={tab === 'pult' ? 'on' : ''} onClick={() => setTab('pult')}>✥ Пульт</button>
      </nav>
      {!c.connected && !androidUsbAvailable() && <button className="m-demo" onClick={demo}>демо без машины</button>}
      {msg && <div className={'m-toast' + (msg.bad ? ' bad' : '')}>{msg.text}</div>}
    </div>
  );
}

function Pult({ prof, st, set, running, guard, setMsg }: {
  prof: MachineProfile; st: Settings; set: (p: Partial<Settings>) => void; running: boolean;
  guard: (f: () => Promise<unknown>) => Promise<void>; setMsg: (m: { text: string; bad?: boolean }) => void;
}) {
  const c = useCtl();
  const [step, setStep] = useState(10);
  const off = !c.connected || running;
  // Y машины растёт «от себя» (вверх по листу)
  const jog = (dx: number, dy: number) => guard(() => send(`$J=G91 G21 X${dx} Y${dy} F${MAX_F}`));
  const pos = c.status.wpos;
  return (
    <div className="m-pult">
      <div className="m-hint">Положение ручки: X <b>{pos ? pos[0].toFixed(1) : '—'}</b> · Y <b>{pos ? pos[1].toFixed(1) : '—'}</b> мм</div>
      <div className="m-seg small">
        {[1, 10, 50].map((s) => <button key={s} className={step === s ? 'on' : ''} onClick={() => setStep(s)}>{s} мм</button>)}
      </div>
      <div className="m-pad">
        <span />
        <button className="m-btn" disabled={off} onClick={() => jog(0, step)}>▲</button>
        <span />
        <button className="m-btn" disabled={off} onClick={() => jog(-step, 0)}>◀</button>
        <button className="m-btn" disabled={off} title="Остановить движение" onClick={() => c.realtime(0x85)}>●</button>
        <button className="m-btn" disabled={off} onClick={() => jog(step, 0)}>▶</button>
        <span />
        <button className="m-btn" disabled={off} onClick={() => jog(0, -step)}>▼</button>
        <span />
      </div>
      <div className="m-grid2">
        <button className="m-btn" disabled={off} onClick={() => guard(() => send(prof.penUp))}>Ручка вверх</button>
        <button className="m-btn" disabled={off} onClick={() => guard(() => send(prof.penDown))}>Ручка вниз</button>
        <button className="m-btn primary" disabled={off} onClick={() => guard(async () => { await send('G10 L20 P1 X0 Y0'); setMsg({ text: 'Начало листа запомнено' }); })}>Здесь начало листа</button>
        <button className="m-btn" disabled={off} onClick={() => guard(async () => { await send(prof.penUp); await send(`G90 G1 X0 Y0 F${MAX_F}`); })}>В начало</button>
        <button className="m-btn" disabled={off} onClick={() => guard(() => send('$X'))}>Разблокировать</button>
        <button className="m-btn" disabled={running} onClick={() => { set({ swap: !st.swap }); setMsg({ text: 'Вверх и вниз поменяны местами' }); }}>⇅ Поменять верх/низ</button>
      </div>
      <div className="m-hint">
        Перед письмом: поставьте ручку кнопками в <b>левый верхний угол листа</b> и нажмите «Здесь начало листа».
        Если «Ручка вниз» поднимает ручку — нажмите «Поменять верх/низ».
      </div>

      <div className="m-section">Вид и сигналы</div>
      <div className="m-seg small">
        {([['auto', 'Как в телефоне'], ['light', 'Светлая'], ['dark', 'Тёмная']] as const).map(([k, n]) => (
          <button key={k} className={st.theme === k ? 'on' : ''} onClick={() => set({ theme: k })}>{n}</button>
        ))}
      </div>
      <div className="m-grid2">
        <button className={'m-btn' + (st.big ? ' on' : '')} onClick={() => set({ big: !st.big })}>{st.big ? '✓ ' : ''}Крупный шрифт</button>
        <button className={'m-btn' + (st.sound ? ' on' : '')} onClick={() => { unlockAudio(); set({ sound: !st.sound }); if (!st.sound) signal('done'); }}>{st.sound ? '✓ ' : ''}Звук и вибрация</button>
      </div>
      <div className="m-hint">Сигнал звучит, когда пора положить новый лист, и когда письмо закончено.</div>
      <div className="m-hint" style={{ textAlign: 'center', marginTop: 12 }}>Каллиграф · автор <b>{AUTHOR}</b><br />{COPYRIGHT}</div>
    </div>
  );
}

function stateName(s: string) {
  if (s.startsWith('Hold')) return 'пауза';
  return ({ Idle: 'готова', Run: 'пишет', Jog: 'едет', Alarm: 'тревога', Unknown: 'подключается…', Home: 'в нуле', Door: 'дверь' } as Record<string, string>)[s] ?? s;
}
