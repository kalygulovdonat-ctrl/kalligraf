// Распознавание текста на картинке (Tesseract, работает без интернета: файлы лежат в ./ocr/).

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

/** Распознать текст на нескольких картинках по очереди (один запуск движка). */
export async function recognizeCanvases(canvases: HTMLCanvasElement[], onProgress: (p: number) => void): Promise<string> {
  const { createWorker } = await import('tesseract.js');
  const base = new URL('./ocr/', location.href).href;
  let page = 0;
  const worker = await createWorker('rus', 1, {
    workerPath: base + 'worker.min.js',
    corePath: base + 'tesseract-core-lstm.wasm.js',
    langPath: base.replace(/\/$/, ''),
    workerBlobURL: false,
    cacheMethod: 'none',
    logger: (m: { status: string; progress: number }) => {
      if (m.status === 'recognizing text') onProgress((page + m.progress) / canvases.length);
    },
  });
  try {
    const out: string[] = [];
    for (; page < canvases.length; page++) {
      const { data } = await worker.recognize(canvases[page]);
      out.push(cleanOcr(data.text));
    }
    return out.filter(Boolean).join('\n');
  } finally { await worker.terminate(); }
}
