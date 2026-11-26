// Шаблон листа A4 для создания почерка по фото.
// Четыре чёрные метки по углам (левая верхняя — с белым окошком, по ней определяется поворот),
// сетка клеток 18×18 мм со светлыми направляющими, которые потом отсекаются порогом.
import { HANDWRITING_SET } from './font';

export const TPL = {
  pageW: 210,
  pageH: 297,
  marker: 9,                 // сторона метки, мм
  hole: 3.6,                 // окошко в левой верхней метке, мм
  // центры меток: ЛВ, ПВ, ПН, ЛН (по часовой стрелке)
  markers: [[12, 12], [198, 12], [198, 285], [12, 285]] as [number, number][],
  gridX: 15,
  gridY: 26,
  cols: 10,
  rows: 14,
  cell: 18,
  // внутри клетки (мм от верха клетки)
  capTop: 5,
  xTop: 7.4,
  base: 13,
  desc: 15.4,
  unitMM: 0.8,               // 1 единица шрифта = 0.8 мм (заглавная = 10 единиц = 8 мм)
  version: 1,
};

export const CELLS_PER_PAGE = TPL.cols * TPL.rows;

/** Символы на листе. Если набор не помещается — делим на листы; иначе каждый лист — ещё один вариант букв. */
export function templateChars(page: number, set: string = HANDWRITING_SET): string[] {
  const chars = [...set];
  if (chars.length <= CELLS_PER_PAGE) return chars;
  const pages = Math.ceil(chars.length / CELLS_PER_PAGE);
  const p = page % pages;
  return chars.slice(p * CELLS_PER_PAGE, (p + 1) * CELLS_PER_PAGE);
}

export function cellRect(i: number) {
  const col = i % TPL.cols, row = Math.floor(i / TPL.cols);
  return { x: TPL.gridX + col * TPL.cell, y: TPL.gridY + row * TPL.cell, w: TPL.cell, h: TPL.cell };
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** SVG шаблона в миллиметрах (печатать в масштабе 100%). */
export function templateSvg(page: number, chars: string[]): string {
  const T = TPL;
  const parts: string[] = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${T.pageW}mm" height="${T.pageH}mm" viewBox="0 0 ${T.pageW} ${T.pageH}">`);
  parts.push(`<rect width="${T.pageW}" height="${T.pageH}" fill="#fff"/>`);
  // метки
  T.markers.forEach(([cx, cy], k) => {
    const h = T.marker / 2;
    parts.push(`<rect x="${cx - h}" y="${cy - h}" width="${T.marker}" height="${T.marker}" fill="#000"/>`);
    if (k === 0) parts.push(`<rect x="${cx - T.hole / 2}" y="${cy - T.hole / 2}" width="${T.hole}" height="${T.hole}" fill="#fff"/>`);
  });
  parts.push(`<text x="105" y="14" font-family="Arial, sans-serif" font-size="4" text-anchor="middle" fill="#999">Каллиграф · шаблон почерка · лист ${page + 1}</text>`);
  parts.push(`<text x="105" y="20.5" font-family="Arial, sans-serif" font-size="2.8" text-anchor="middle" fill="#aaa">Пишите тёмной гелевой ручкой или линером. Заглавные — до верхней пунктирной линии, строчные — до средней, низ буквы — на синей линии.</text>`);
  const light = '#d3dae6';
  chars.forEach((ch, i) => {
    const r = cellRect(i);
    parts.push(`<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" fill="none" stroke="${light}" stroke-width="0.2"/>`);
    parts.push(`<line x1="${r.x + 1}" x2="${r.x + r.w - 1}" y1="${r.y + T.capTop}" y2="${r.y + T.capTop}" stroke="${light}" stroke-width="0.15" stroke-dasharray="0.8 0.6"/>`);
    parts.push(`<line x1="${r.x + 1}" x2="${r.x + r.w - 1}" y1="${r.y + T.xTop}" y2="${r.y + T.xTop}" stroke="${light}" stroke-width="0.15" stroke-dasharray="0.4 0.8"/>`);
    parts.push(`<line x1="${r.x + 1}" x2="${r.x + r.w - 1}" y1="${r.y + T.base}" y2="${r.y + T.base}" stroke="#a9c8ef" stroke-width="0.22"/>`);
    parts.push(`<text x="${r.x + 0.8}" y="${r.y + 2.8}" font-family="Arial, sans-serif" font-size="2.5" fill="#c4c4c4">${esc(ch)}</text>`);
  });
  parts.push('</svg>');
  return parts.join('');
}

/** Открывает окно печати с шаблонами (A4, без полей, масштаб 100%). */
export function printTemplates(pages: number, set: string = HANDWRITING_SET) {
  const w = window.open('', '_blank');
  if (!w) throw new Error('Браузер заблокировал окно печати. Разрешите всплывающие окна для этого сайта.');
  const svgs = Array.from({ length: pages }, (_, p) => `<div class="pg">${templateSvg(p, templateChars(p, set))}</div>`).join('');
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Шаблон почерка — Каллиграф</title>
<style>@page{size:A4;margin:0}html,body{margin:0}.pg{width:210mm;height:297mm;page-break-after:always;overflow:hidden}.pg svg{display:block}</style>
</head><body>${svgs}<script>window.onload=()=>setTimeout(()=>window.print(),300)<\/script></body></html>`);
  w.document.close();
}
