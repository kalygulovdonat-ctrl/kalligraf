// Сборка встроенных рукописных шрифтов: TTF (OFL) → однолинейные JSON.
// Запуск: npm run build-fonts
import { readFileSync, writeFileSync } from 'fs';
import { parseTtf } from '../src/core/ttf';
import { convertFont } from '../src/core/fontconvert';

const FONTS = [
  { id: 'hw-badscript', file: 'badscript/BadScript-Regular.ttf', name: 'Рукописный «Школьный» (Bad Script)', author: 'Gaslight (OFL)', tight: 0.5 },
  { id: 'hw-marck', file: 'marckscript/MarckScript-Regular.ttf', name: 'Рукописный «Каллиграфия» (Marck Script)', author: 'Denis Masharov (OFL)', tight: 0.3 },
  { id: 'hw-caveat', file: 'caveat/Caveat[wght].ttf', name: 'Рукописный «Быстрый» (Caveat)', author: 'Impallari Type (OFL)', tight: 0.6 },
  { id: 'hw-neucha', file: 'neucha/Neucha.ttf', name: 'Рукописный «Печатный» (Neucha)', author: 'Jovanny Lemonad (OFL)' },
  { id: 'hw-pangolin', file: 'pangolin/Pangolin-Regular.ttf', name: 'Рукописный «Аккуратный» (Pangolin)', author: 'Kevin Burke (OFL)' },
];

{
  for (const f of FONTS) {
    const b = readFileSync('fonts-src/' + f.file);
    const ttf = parseTtf(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
    const font = convertFont(ttf, { id: f.id, name: f.name, author: f.author, license: 'SIL Open Font License 1.1' }, { tight: (f as { tight?: number }).tight });
    delete (font as { createdAt?: number }).createdAt;
    const json = JSON.stringify(font);
    writeFileSync(`src/fonts/${f.id}.json`, json);
    console.log(f.id, Object.keys(font.glyphs).length, 'символов', Math.round(json.length / 1024) + ' КБ');
  }
}
