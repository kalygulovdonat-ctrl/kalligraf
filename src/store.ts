// Состояние приложения (Zustand) с автосохранением в браузере и отменой/повтором.
import { create } from 'zustand';
import { defaultProfile, guangkuProfile, type MachineProfile } from './core/gcode';
import { defaultTextOptions, type TextOptions } from './core/layout';
import { defaultOptimize, type OptimizeOptions } from './core/optimize';
import { builtinFonts, type Font } from './core/font';
import type { GenKind, MarkupKind } from './core/generators';
import type { Path } from './core/geometry';
import { setLang, type Lang } from './i18n';
import { defaultCad, type CadDoc } from './core/cad/model';
import { lockProfile } from './edition';

export type Module = 'text' | 'fonts' | 'art' | 'cad' | 'print' | 'control' | 'settings';

export interface ArtItem {
  id: string;
  kind: GenKind | 'svg' | 'signature';
  title: string;
  params: Record<string, unknown>;
  paths?: Path[];        // для импортированных SVG и подписей
  x: number;
  y: number;
  scale: number;
  rotation: number;
  page: number;
  color?: string;
}

export interface SheetSpec { format: 'A4' | 'A5' | 'notebook' | 'postcard' | 'custom'; w: number; h: number }

export const SHEETS: Record<Exclude<SheetSpec['format'], 'custom'>, [number, number, string]> = {
  A4: [210, 297, 'A4 210×297'],
  A5: [148, 210, 'A5 148×210'],
  notebook: [165, 205, 'Тетрадь 165×205'],
  postcard: [148, 105, 'Открытка 148×105'],
};

export interface Doc {
  name: string;
  text: string;
  fontId: string;
  textOpts: TextOptions;
  sheet: SheetSpec;
  ruling: 'none' | MarkupKind;
  rulingStep: number;
  printRuling: boolean;
  items: ArtItem[];
  cad: CadDoc;
}

export const defaultDoc = (): Doc => ({
  name: 'Новый проект',
  text: 'Привет! Это Каллиграф — программа для робота-писателя.\nСъешь же ещё этих мягких французских булок, да выпей чаю.\nКыргызча: Өмүр, үй, көңүл. English: The quick brown fox jumps over the lazy dog.',
  fontId: 'print',
  textOpts: { ...defaultTextOptions },
  sheet: { format: 'A4', w: 210, h: 297 },
  ruling: 'grid',
  rulingStep: 5,
  printRuling: false,
  items: [],
  cad: defaultCad(),
});

export interface SavedState {
  lang: Lang;
  theme: 'system' | 'light' | 'dark';
  profiles: MachineProfile[];
  activeProfileId: string;
  userFonts: Font[];
  doc: Doc;
  optimize: OptimizeOptions;
  tourDone: boolean;
  wizardDone: boolean;
}

interface UiState {
  module: Module;
  selectedItem: string | null;
  past: Doc[];
  future: Doc[];
  lastPush: number;
  toast: { id: number; text: string; kind: 'info' | 'error' | 'success' } | null;
  wizardOpen: boolean;
  shortcutsOpen: boolean;
  printPage: number;  // -1 — все листы
  editingFont: string | null;
  editingChar: string;
}

interface Actions {
  setModule(m: Module): void;
  setDoc(fn: (d: Doc) => Doc, opts?: { merge?: boolean }): void;
  undo(): void;
  redo(): void;
  setState(p: Partial<SavedState & UiState>): void;
  updateProfile(p: Partial<MachineProfile>): void;
  addUserFont(f: Font): void;
  updateUserFont(id: string, fn: (f: Font) => Font): void;
  removeUserFont(id: string): void;
  notify(text: string, kind?: 'info' | 'error' | 'success'): void;
}

export type AppState = SavedState & UiState & Actions;

const KEY = 'kalligraf:v1';

function load(): Partial<SavedState> {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const s = JSON.parse(raw) as Partial<SavedState>;
    // миграция: новые поля профиля/документа получают значения по умолчанию
    if (s.profiles) s.profiles = s.profiles.map((p) => {
      const m = { ...defaultProfile(), ...p };
      // Старые версии сохраняли для GUANGKU неверную ручку (G0 Z5 — «вверх», а на этой машине это «вниз»)
      // и, возможно, переставленные оси. Такой профиль переводим на рабочие настройки GUANGKU.
      if (m.id === 'default' && m.penUp === 'G0 Z5' && m.penDown === 'G1 Z0 F1000') return { ...m, ...guangkuProfile(), name: 'GUANGKU' };
      // ранние «Настройки GUANGKU» ставили 15000 мм/мин; реально у друга машина пишет на 8000
      if (m.penMode === 'zinv' && m.drawSpeed === 15000) return { ...m, drawSpeed: 8000, travelSpeed: 2500 };
      return m;
    });
    if (s.doc) s.doc = { ...defaultDoc(), ...s.doc, cad: { ...defaultCad(), ...s.doc.cad }, textOpts: { ...defaultTextOptions, ...s.doc.textOpts, margins: { ...defaultTextOptions.margins, ...s.doc.textOpts?.margins } } };
    if (s.optimize) s.optimize = { ...defaultOptimize, ...s.optimize };
    // 0,1 мм — старый допуск: штрихи с концами ближе 0,3 мм (тоньше линии ручки) пишем без подъёма
    if (s.optimize && s.optimize.mergeTol === 0.1) s.optimize.mergeTol = 0.3;
    return s;
  } catch {
    return {};
  }
}

const saved = load();
setLang(saved.lang ?? 'ru');

export const useApp = create<AppState>((set, get) => ({
  lang: saved.lang ?? 'ru',
  theme: saved.theme ?? 'system',
  profiles: (saved.profiles?.length ? saved.profiles : [defaultProfile()]).map(lockProfile),
  activeProfileId: saved.activeProfileId ?? 'default',
  userFonts: saved.userFonts ?? [],
  doc: saved.doc ?? defaultDoc(),
  optimize: saved.optimize ?? defaultOptimize,
  tourDone: saved.tourDone ?? false,
  wizardDone: saved.wizardDone ?? false,

  module: 'text',
  selectedItem: null,
  past: [],
  future: [],
  lastPush: 0,
  toast: null,
  wizardOpen: false,
  shortcutsOpen: false,
  printPage: -1,
  editingFont: null,
  editingChar: 'А',

  setModule: (module) => set({ module }),
  setDoc: (fn, opts) => {
    const { doc, past, lastPush } = get();
    const next = fn(doc);
    if (next === doc) return;
    const now = Date.now();
    const merge = opts?.merge && now - lastPush < 800;
    set({ doc: next, past: merge ? past : [...past.slice(-99), doc], future: [], lastPush: now });
  },
  undo: () => {
    const { past, doc, future } = get();
    if (!past.length) return;
    set({ doc: past[past.length - 1], past: past.slice(0, -1), future: [doc, ...future].slice(0, 100), lastPush: 0 });
  },
  redo: () => {
    const { past, doc, future } = get();
    if (!future.length) return;
    set({ doc: future[0], future: future.slice(1), past: [...past, doc], lastPush: 0 });
  },
  setState: (p) => {
    if (p.lang) setLang(p.lang);
    set(p as Partial<AppState>);
  },
  updateProfile: (p) => set((s) => ({ profiles: s.profiles.map((x) => (x.id === s.activeProfileId ? lockProfile({ ...x, ...p }) : x)) })),
  addUserFont: (f) => set((s) => ({ userFonts: [...s.userFonts, f] })),
  updateUserFont: (id, fn) => set((s) => ({ userFonts: s.userFonts.map((f) => (f.id === id ? fn(f) : f)) })),
  removeUserFont: (id) => set((s) => ({ userFonts: s.userFonts.filter((f) => f.id !== id) })),
  notify: (text, kind = 'info') => {
    const id = Date.now();
    set({ toast: { id, text, kind } });
    setTimeout(() => { if (get().toast?.id === id) set({ toast: null }); }, kind === 'error' ? 7000 : 3500);
  },
}));

// Автосохранение (с задержкой, чтобы не писать на каждое нажатие клавиши)
let saveTimer: ReturnType<typeof setTimeout> | null = null;
export function snapshot(s: AppState): SavedState {
  return {
    lang: s.lang, theme: s.theme, profiles: s.profiles, activeProfileId: s.activeProfileId,
    userFonts: s.userFonts, doc: s.doc, optimize: s.optimize, tourDone: s.tourDone, wizardDone: s.wizardDone,
  };
}
useApp.subscribe((s) => {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(snapshot(s)));
    } catch (e) {
      console.warn('Не удалось сохранить', e);
    }
  }, 600);
});

export function restoreBackup(data: Partial<SavedState>) {
  if (!data || typeof data !== 'object' || !('doc' in data || 'userFonts' in data || 'profiles' in data))
    throw new Error('Это не резервная копия Каллиграфа');
  useApp.getState().setState({
    ...data,
    profiles: data.profiles?.map((p) => lockProfile({ ...defaultProfile(), ...p })) ?? useApp.getState().profiles,
    doc: data.doc ? { ...defaultDoc(), ...data.doc } : useApp.getState().doc,
  } as Partial<SavedState>);
}

export function resetAll() {
  try { localStorage.removeItem(KEY); } catch { /* ignore */ }
  useApp.getState().setState({
    profiles: [lockProfile(defaultProfile())], activeProfileId: 'default', userFonts: [], doc: defaultDoc(),
    optimize: defaultOptimize, tourDone: false, wizardDone: false, past: [], future: [],
  });
}

// ── Удобные селекторы ────────────────────────────────────────────────

export const useProfile = () => useApp((s) => s.profiles.find((p) => p.id === s.activeProfileId) ?? s.profiles[0]);

export function allFonts(userFonts: Font[]): Font[] {
  return [...builtinFonts(), ...userFonts];
}
export function findFont(id: string, userFonts: Font[]): Font {
  return allFonts(userFonts).find((f) => f.id === id) ?? builtinFonts()[0];
}

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
