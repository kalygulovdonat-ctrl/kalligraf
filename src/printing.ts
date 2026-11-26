// Подготовка к письму: оптимизация, проверка поля, G-код, расчёт времени.
import { estimateJob, generateGcode, outOfBounds, type JobStats, type MachineProfile } from './core/gcode';
import { optimizePaths, type OptimizeOptions, type OptimizeReport } from './core/optimize';
import type { Path } from './core/geometry';
import type { Font } from './core/font';
import { buildJob, COLOR_NAMES, groupByColor } from './job';
import type { Doc } from './store';

export interface PreparedPage { index: number; paths: Path[]; bad: number[]; report: OptimizeReport }
export interface Prepared {
  pages: PreparedPage[];
  sections: { paths: Path[]; pauseMessage?: string }[];
  lines: string[];
  stats: JobStats;
  report: OptimizeReport;
  badCount: number;
  missing: string[];
}

export function preparePrint(doc: Doc, font: Font, prof: MachineProfile, opt: OptimizeOptions, pageIndex: number): Prepared {
  const job = buildJob(doc, font);
  const idx = pageIndex < 0 ? job.pages.map((_, i) => i) : [Math.min(pageIndex, job.pages.length - 1)];
  const pages: PreparedPage[] = [];
  const sections: Prepared['sections'] = [];
  const sum: OptimizeReport = { travelBefore: 0, travelAfter: 0, pathsBefore: 0, pathsAfter: 0 };
  let badCount = 0;
  idx.forEach((pi, n) => {
    const pg = job.pages[pi];
    const { paths, report } = optimizePaths(pg.paths, opt, [prof.offsetX, prof.offsetY], opt.reorder ? undefinedIfArt(pg.groups) : pg.groups);
    const bad = outOfBounds(paths, prof, doc.sheet.h);
    badCount += bad.length;
    pages.push({ index: pi, paths, bad, report });
    for (const k of Object.keys(sum) as (keyof OptimizeReport)[]) sum[k] += report[k];
    // Внутри листа: по цвету (смена ручки)
    const byColor = [...groupByColor(paths).entries()];
    byColor.forEach(([color, ps], ci) => {
      const parts: string[] = [];
      if (n > 0 && ci === 0) parts.push(`Положите новый лист (лист ${pi + 1})`);
      const prevColor = sections.length ? sections[sections.length - 1].paths[0]?.color ?? '' : '';
      if (sections.length && color !== prevColor) parts.push(`Вставьте ${COLOR_NAMES[color] ?? color} ручку`);
      sections.push({ paths: ps, pauseMessage: parts.length ? parts.join('. ') : undefined });
    });
  });
  // Если первым цветом идёт не основная ручка — попросим вставить нужную в начале
  const first = sections[0]?.paths[0]?.color;
  const lines = generateGcode({ sections, sheetH: doc.sheet.h }, prof);
  if (first) lines.splice(1, 0, `; Вставьте ${COLOR_NAMES[first] ?? first} ручку`, 'M0');
  const stats = estimateJob(sections.flatMap((s) => s.paths), prof, [prof.offsetX, prof.offsetY]);
  // паузы M0 не входят во время
  return { pages, sections, lines, stats, report: sum, badCount, missing: job.missing };
}

/**
 * Текст оптимизируем только внутри слова (естественный порядок письма),
 * а рисунки (группы ≥ 1e6) и разметку — свободно.
 */
function undefinedIfArt(groups: number[]): number[] {
  return groups.map((g) => (g >= 1e6 || g < 0 ? -2 : g));
}
