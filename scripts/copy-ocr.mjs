// Файлы распознавания текста (Tesseract) для телефонной версии: кладём в mobile/public/ocr,
// чтобы они попали в APK и работали без интернета.
import { copyFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'mobile', 'public', 'ocr');
mkdirSync(out, { recursive: true });
const files = [
  ['node_modules/tesseract.js/dist/worker.min.js', 'worker.min.js'],
  ['node_modules/tesseract.js-core/tesseract-core-lstm.wasm.js', 'tesseract-core-lstm.wasm.js'],
  ['node_modules/@tesseract.js-data/rus/4.0.0_best_int/rus.traineddata.gz', 'rus.traineddata.gz'],
];
for (const [from, to] of files) {
  const src = join(root, from), dst = join(out, to);
  if (existsSync(dst) && statSync(dst).size === statSync(src).size) continue;
  copyFileSync(src, dst);
  console.log('OCR:', to);
}
