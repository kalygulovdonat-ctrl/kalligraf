// Фоновый поток для «Фото → рисунок»: фото загружается один раз, дальше только перерисовка.
import { frameGray, fullCrop, photoToPaths, prepare, type ArtStyle, type Crop, type Prep, type StyleParams } from './core/photoart';
import type { Gray } from './core/vision';

let photo: Gray | null = null;
const post = (m: unknown) => (self as unknown as Worker).postMessage(m);

self.onmessage = (e: MessageEvent) => {
  const m = e.data;
  if (m.type === 'load') { photo = m.gray; post({ id: m.id, type: 'loaded' }); return; }
  if (m.type === 'render') {
    if (!photo) return post({ id: m.id, type: 'error', message: 'Фото не загружено' });
    try {
      const t0 = performance.now();
      // сначала кадр (поворот и обрезка), потом подготовка и рисунок
      const framed = frameGray(photo, Number(m.rot) || 0, (m.crop as Crop) ?? fullCrop);
      const prep = prepare(framed, m.prep as Prep, 900);
      const paths = photoToPaths(prep, m.style as ArtStyle, m.params as StyleParams, m.widthMM, (s) => post({ id: m.id, type: 'progress', stage: s }));
      post({ id: m.id, type: 'result', paths, prep, heightMM: (prep.h / prep.w) * m.widthMM, ms: Math.round(performance.now() - t0) });
    } catch (err) {
      post({ id: m.id, type: 'error', message: (err as Error).message });
    }
  }
};
