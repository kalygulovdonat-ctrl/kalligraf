// Телефон: голос, вибрация, звук и распознавание текста с фото.

interface NativeBridge {
  voice?(): void;
  vibrate?(ms: number): void;
  print?(html: string, name: string): void;
  saveFile?(name: string, mime: string, text: string): void;
}

/** Печать страницы (шаблон почерка). В приложении — системная печать Android (можно «Сохранить как PDF»). */
export function printHtml(html: string, name: string) {
  const n = window.KalligrafNative;
  if (n?.print) { n.print(html, name); return; }
  const w = window.open('', '_blank');
  if (!w) throw new Error('Браузер заблокировал окно печати');
  w.document.write(html);
  w.document.close();
  setTimeout(() => w.print(), 400);
}

/** Сохранить текстовый файл. В приложении — в папку «Загрузки». */
export function saveText(name: string, mime: string, text: string): Promise<string> {
  const n = window.KalligrafNative;
  if (n?.saveFile) {
    return new Promise((resolve, reject) => {
      waiters.set('save', (ok, data) => (ok ? resolve(data) : reject(new Error(data))));
      n.saveFile!(name, mime, text);
    });
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: mime }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  return Promise.resolve('Загрузки');
}

declare global {
  interface Window {
    KalligrafNative?: NativeBridge;
    /** Сюда Java присылает события: voice / voice-error. */
    __native?: (type: string, data: string) => void;
    webkitSpeechRecognition?: new () => SpeechRec;
    SpeechRecognition?: new () => SpeechRec;
  }
}
interface SpeechRec {
  lang: string; interimResults: boolean; maxAlternatives: number;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
}

const waiters = new Map<string, (ok: boolean, data: string) => void>();
if (typeof window !== 'undefined') {
  window.__native = (type, data) => {
    const base = type.replace(/-error$/, '');
    const w = waiters.get(base);
    if (w) { waiters.delete(base); w(!type.endsWith('-error'), data); }
  };
}

export const voiceAvailable = () =>
  typeof window !== 'undefined' && (!!window.KalligrafNative?.voice || !!(window.SpeechRecognition || window.webkitSpeechRecognition));

/** Распознать речь (русский). В приложении — через системный распознаватель Android. */
export function listen(): Promise<string> {
  const n = window.KalligrafNative;
  if (n?.voice) {
    return new Promise((resolve, reject) => {
      waiters.set('voice', (ok, data) => (ok ? resolve(data) : reject(new Error(data))));
      n.voice!();
    });
  }
  const R = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!R) return Promise.reject(new Error('Голосовой ввод недоступен на этом устройстве'));
  return new Promise((resolve, reject) => {
    const r = new R();
    r.lang = 'ru-RU'; r.interimResults = false; r.maxAlternatives = 1;
    let got = '';
    r.onresult = (e) => { got = Array.from(e.results).map((x) => x[0].transcript).join(' '); };
    r.onerror = (e) => reject(new Error(e.error === 'not-allowed' ? 'Нет доступа к микрофону' : 'Не расслышал, попробуйте ещё раз'));
    r.onend = () => (got ? resolve(got) : reject(new Error('Не расслышал, попробуйте ещё раз')));
    r.start();
  });
}

/** Склеить продиктованное с текстом: первая буква заглавная, точка в конце. */
export function appendSpoken(text: string, spoken: string): string {
  let s = spoken.trim();
  if (!s) return text;
  s = s[0].toUpperCase() + s.slice(1);
  if (!/[.!?…]$/.test(s)) s += '.';
  if (!text.trim()) return s;
  return text.replace(/\s+$/, '') + (/[.!?…]$/.test(text.trim()) ? ' ' : '. ') + s;
}

// ── сигнал: вибрация + короткий звук ───────────────────────────────────

let audio: AudioContext | null = null;
/** Вызвать по нажатию пользователя — иначе браузер не даст играть звук. */
export function unlockAudio() {
  try {
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!audio && AC) audio = new AC();
    void audio?.resume();
  } catch { /* без звука */ }
}

export function signal(kind: 'page' | 'done') {
  const pattern = kind === 'page' ? [300, 150, 300, 150, 300] : [600];
  try {
    if (window.KalligrafNative?.vibrate) pattern.forEach((ms, i) => { if (i % 2 === 0) setTimeout(() => window.KalligrafNative!.vibrate!(ms), pattern.slice(0, i).reduce((a, b) => a + b, 0)); });
    else navigator.vibrate?.(pattern);
  } catch { /* нет вибрации */ }
  try {
    if (!audio) return;
    const notes = kind === 'page' ? [880, 660, 880] : [660, 880, 1320];
    notes.forEach((f, i) => {
      const o = audio!.createOscillator(), g = audio!.createGain();
      const t = audio!.currentTime + i * 0.18;
      o.frequency.value = f; o.type = 'sine';
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.35, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
      o.connect(g).connect(audio!.destination);
      o.start(t); o.stop(t + 0.17);
    });
  } catch { /* без звука */ }
}

// ── текст с фото (Tesseract, работает без интернета) ───────────────────

/** Уменьшить снимок до разумного размера и перевести в оттенки серого. */
async function loadImage(file: File, maxSide = 2000): Promise<HTMLCanvasElement> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = () => rej(new Error('Не удалось открыть фото'));
      i.src = url;
    });
    const k = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
    const ctx = c.getContext('2d')!;
    ctx.filter = 'grayscale(1) contrast(1.3)';
    ctx.drawImage(img, 0, 0, c.width, c.height);
    return c;
  } finally { URL.revokeObjectURL(url); }
}

/** Убрать переносы строк внутри абзацев, склеить слова с дефисом-переносом. */
export function cleanOcr(text: string): string {
  return text
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .split(/\n{2,}/)
    .map((p) => p.replace(/([A-Za-zА-Яа-яЁё])-\n([a-zа-яё])/g, '$1$2').replace(/\n/g, ' ').replace(/\s{2,}/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

export async function recognizePhoto(file: File, onProgress: (p: number) => void): Promise<string> {
  const canvas = await loadImage(file);
  const { createWorker } = await import('tesseract.js');
  const base = new URL('./ocr/', location.href).href;
  const worker = await createWorker('rus', 1, {
    workerPath: base + 'worker.min.js',
    corePath: base + 'tesseract-core-lstm.wasm.js',
    langPath: base.replace(/\/$/, ''),
    workerBlobURL: false,
    cacheMethod: 'none',
    logger: (m: { status: string; progress: number }) => { if (m.status === 'recognizing text') onProgress(m.progress); },
  });
  try {
    const { data } = await worker.recognize(canvas);
    return cleanOcr(data.text);
  } finally { await worker.terminate(); }
}
