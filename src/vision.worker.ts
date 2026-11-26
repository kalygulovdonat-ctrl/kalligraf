// Фоновый поток: распознавание почерка не замораживает интерфейс.
import { MarkersNotFound, processSheet, type Gray } from './core/vision';
import type { Pt } from './core/geometry';

interface Req { id: number; gray: Gray; chars: string[]; corners: Pt[] | null }

self.onmessage = (e: MessageEvent<Req>) => {
  const { id, gray, chars, corners } = e.data;
  try {
    const res = processSheet(gray, chars, {
      corners,
      onProgress: (stage, pct) => (self as unknown as Worker).postMessage({ id, type: 'progress', stage, pct }),
    });
    (self as unknown as Worker).postMessage({ id, type: 'result', res });
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, type: 'error', notFound: err instanceof MarkersNotFound, message: (err as Error).message });
  }
};
