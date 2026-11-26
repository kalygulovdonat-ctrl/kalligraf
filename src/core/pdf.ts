// PDF: текст со страниц (или распознавание, если это скан) и страница как рисунок из линий.
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.js?url';
import type { PDFDocumentProxy } from 'pdfjs-dist/types/src/display/api';
import type { Path } from './geometry';
import type { Gray } from './vision';
import { lineArt } from './lineart';
import { recognizeCanvases } from './ocr';

export type Pdf = PDFDocumentProxy;

async function lib() {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf');
  pdfjs.GlobalWorkerOptions.workerSrc = new URL(workerUrl, location.href).href;
  return pdfjs;
}

export async function openPdf(file: File | ArrayBuffer): Promise<Pdf> {
  const data = file instanceof ArrayBuffer ? file : await file.arrayBuffer();
  const pdfjs = await lib();
  try {
    return await pdfjs.getDocument({ data: new Uint8Array(data), isEvalSupported: false }).promise;
  } catch (e) {
    const m = String((e as Error).message || e);
    throw new Error(/password/i.test(m) ? 'PDF защищён паролем' : 'Не удалось открыть PDF: ' + m);
  }
}

interface Item { str: string; hasEOL?: boolean; transform: number[]; height: number }

/** Текст одной страницы: строки собираются по координатам, абзацы — по увеличенному интервалу. */
export async function pageText(pdf: Pdf, n: number): Promise<string> {
  const page = await pdf.getPage(n);
  const tc = await page.getTextContent();
  const lines: { y: number; h: number; s: string }[] = [];
  let cur: { y: number; h: number; s: string } | null = null;
  for (const raw of tc.items as Item[]) {
    if (!('str' in raw)) continue;
    const y = raw.transform[5];
    if (!cur || Math.abs(y - cur.y) > Math.max(2, raw.height * 0.5)) {
      if (cur) lines.push(cur);
      cur = { y, h: raw.height || 10, s: '' };
    }
    cur.s += raw.str;
    if (raw.hasEOL) { lines.push(cur); cur = null; }
  }
  if (cur) lines.push(cur);
  const ls = lines.map((l) => ({ ...l, s: l.s.replace(/\s+/g, ' ').trim() })).filter((l) => l.s);
  if (!ls.length) return '';
  // обычный шаг строк — медиана расстояний
  const gaps = ls.slice(1).map((l, i) => Math.abs(ls[i].y - l.y)).filter((g) => g > 0).sort((a, b) => a - b);
  const step = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 12;
  let out = ls[0].s;
  for (let i = 1; i < ls.length; i++) {
    const gap = Math.abs(ls[i - 1].y - ls[i].y);
    const prev = out;
    // новый абзац: интервал заметно больше обычного или больше ~1,7 высоты строки
    const hMax = Math.max(ls[i - 1].h, ls[i].h);
    if (gap > step * 1.45 || gap > hMax * 1.7 || Math.abs(ls[i - 1].h - ls[i].h) > hMax * 0.25) out += '\n' + ls[i].s;
    else if (/[A-Za-zА-Яа-яЁё]-$/.test(prev) && /^[a-zа-яё]/.test(ls[i].s)) out = prev.slice(0, -1) + ls[i].s;
    else out += ' ' + ls[i].s;
  }
  return out;
}

/** Нарисовать страницу в canvas с заданным числом пикселей на миллиметр. */
export async function renderPage(pdf: Pdf, n: number, pxPerMM: number): Promise<{ canvas: HTMLCanvasElement; wMM: number; hMM: number }> {
  const page = await pdf.getPage(n);
  const base = page.getViewport({ scale: 1 }); // 1 = 72 точки на дюйм
  const wMM = (base.width / 72) * 25.4, hMM = (base.height / 72) * 25.4;
  const scale = Math.min(pxPerMM * 25.4 / 72, 4000 / Math.max(base.width, base.height));
  const vp = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(vp.width); canvas.height = Math.ceil(vp.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  return { canvas, wMM, hMM };
}

export function canvasGray(c: HTMLCanvasElement): Gray {
  const d = c.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, c.width, c.height).data;
  const g = new Uint8Array(c.width * c.height);
  for (let i = 0; i < g.length; i++) g[i] = (d[i * 4] * 77 + d[i * 4 + 1] * 150 + d[i * 4 + 2] * 29) >> 8;
  return { w: c.width, h: c.height, d: g };
}

/** Страница PDF → линии в мм (размер страницы). */
export async function pageLines(pdf: Pdf, n: number, pxPerMM = 6): Promise<{ paths: Path[]; wMM: number; hMM: number }> {
  const { canvas, wMM, hMM } = await renderPage(pdf, n, pxPerMM);
  await new Promise((r) => setTimeout(r, 20));
  return { paths: lineArt(canvasGray(canvas), wMM), wMM, hMM };
}

/**
 * Весь текст PDF. Если текста почти нет (скан) — страницы распознаются как фото.
 * maxScanPages — сколько страниц скана распознавать (это долго).
 */
export async function pdfText(pdf: Pdf, onProgress: (s: string) => void, maxScanPages = 10): Promise<{ text: string; scanned: boolean }> {
  const parts: string[] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    onProgress(`Читаю текст: страница ${i} из ${pdf.numPages}`);
    parts.push(await pageText(pdf, i));
  }
  const text = parts.filter(Boolean).join('\n');
  if (text.replace(/\s/g, '').length >= 20 * Math.min(pdf.numPages, 3)) return { text, scanned: false };
  // скан: распознаём страницы как фото
  const n = Math.min(pdf.numPages, maxScanPages);
  const canvases: HTMLCanvasElement[] = [];
  for (let i = 1; i <= n; i++) {
    onProgress(`Готовлю скан: страница ${i} из ${n}`);
    canvases.push((await renderPage(pdf, i, 8)).canvas);
  }
  const ocr = await recognizeCanvases(canvases, (p) => onProgress(`Распознаю скан… ${Math.round(p * 100)}%`));
  return { text: ocr, scanned: true };
}
