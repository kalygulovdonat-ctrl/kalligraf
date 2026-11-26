// Общие действия: начать письмо, пауза, СТОП, продолжить после обрыва.
import { create } from 'zustand';
import { ctl } from './machine';
import { buildResume } from './grbl/controller';
import { boundsGcode, jobBounds } from './core/gcode';
import { preparePrint, type Prepared } from './printing';
import { findFont, useApp } from './store';

export const useAnim = create<{ playing: boolean; t: number; speed: number; on: boolean; travel: boolean; bed: boolean; bedX: number; bedY: number }>(() => ({
  playing: false, t: 0, speed: 10, on: false, travel: false,
  // фото стола GUANGKU под листом; bedX/bedY — где на столе (в см по его шкале) лежит левый нижний угол листа
  bed: true, bedX: 0, bedY: 0,
}));

/** Последнее отправленное задание — для «Продолжить с места остановки». */
export const lastJob: { lines: string[] | null } = { lines: null };

export function currentPrepared(): Prepared {
  const s = useApp.getState();
  const prof = s.profiles.find((p) => p.id === s.activeProfileId) ?? s.profiles[0];
  return preparePrint(s.doc, findFont(s.doc.fontId, s.userFonts), prof, s.optimize, s.printPage);
}

export function startWriting(prepared?: Prepared) {
  const s = useApp.getState();
  if (!ctl.connected) {
    s.notify('Сначала подключите машину (кнопка вверху) или включите симулятор.', 'error');
    return;
  }
  if (ctl.progress?.running) {
    s.notify('Машина уже пишет. Дождитесь окончания или нажмите СТОП.', 'info');
    return;
  }
  if (ctl.status.state === 'Alarm') {
    s.notify('Машина в состоянии тревоги. Нажмите «Разблокировать» в разделе «Пульт».', 'error');
    return;
  }
  const p = prepared ?? currentPrepared();
  if (p.badCount > 0) {
    s.notify(`Печать запрещена: ${p.badCount} линий выходят за рабочее поле машины (подсвечены красным). Уменьшите текст/рисунок или поля.`, 'error');
    s.setModule('print');
    return;
  }
  if (!p.sections.some((x) => x.paths.length)) {
    s.notify('Нечего писать: лист пустой.', 'info');
    return;
  }
  const prof = s.profiles.find((x) => x.id === s.activeProfileId) ?? s.profiles[0];
  ctl.mode = prof.streaming;
  lastJob.lines = p.lines;
  try { if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission(); } catch { /* нет */ }
  ctl.stream(p.lines);
  s.notify('Пишем! Пауза — пробел, СТОП — Esc.', 'success');
}

export function togglePause() {
  if (!ctl.progress?.running) return;
  if (ctl.progress.paused || ctl.status.state.startsWith('Hold')) ctl.resume();
  else ctl.pause();
}

export function emergencyStop() {
  const s = useApp.getState();
  const prof = s.profiles.find((x) => x.id === s.activeProfileId) ?? s.profiles[0];
  if (!ctl.connected) return;
  ctl.stop(prof.penUp);
  s.notify('СТОП. Машина остановлена, ручка поднимается.', 'error');
}

/** Отправить на машину готовый G-код из файла (например, сделанный другой программой). */
export async function sendGcodeFile(file: File) {
  const s = useApp.getState();
  if (!ctl.connected) return s.notify('Сначала подключите машину или симулятор.', 'error');
  if (ctl.progress?.running) return s.notify('Машина уже пишет. Дождитесь окончания или нажмите СТОП.', 'info');
  if (file.size > 30_000_000) return s.notify('Файл слишком большой (больше 30 МБ).', 'error');
  // комментарии «; …» и «( … )» убираем — плата их не ждёт
  const lines = (await file.text()).split(/\r?\n/).map((l) => l.replace(/\(.*?\)/g, '').replace(/;.*$/, '').trim()).filter((l) => l && !l.startsWith('%'));
  if (!lines.length) return s.notify('В файле нет команд G-кода.', 'error');
  const moves = lines.filter((l) => /^G0?[01]/i.test(l)).length;
  if (!confirm(`Отправить «${file.name}» на машину? ${lines.length} строк, из них ${moves} движений. Перед стартом поставьте ручку в начальную точку.`)) return;
  const prof = s.profiles.find((x) => x.id === s.activeProfileId) ?? s.profiles[0];
  ctl.mode = prof.streaming;
  lastJob.lines = lines;
  ctl.stream(lines);
  s.notify(`Пишем файл «${file.name}». Пауза — пробел, СТОП — Esc.`, 'success');
}

/** Обвести границы будущего письма с поднятой ручкой — видно, куда ляжет текст или рисунок. */
export function traceBounds(prepared?: Prepared) {
  const s = useApp.getState();
  if (!ctl.connected) return s.notify('Сначала подключите машину или симулятор.', 'error');
  if (ctl.progress?.running) return s.notify('Машина уже пишет. Дождитесь окончания или нажмите СТОП.', 'info');
  const p = prepared ?? currentPrepared();
  const paths = p.sections.flatMap((x) => x.paths);
  const prof = s.profiles.find((x) => x.id === s.activeProfileId) ?? s.profiles[0];
  const lines = boundsGcode(paths, prof, s.doc.sheet.h);
  if (!lines.length) return s.notify('Нечего обводить: лист пустой.', 'info');
  ctl.mode = prof.streaming;
  ctl.stream(lines);
  const b = jobBounds(paths)!;
  s.notify(`Обвожу границы ${Math.round(b.maxX - b.minX)}×${Math.round(b.maxY - b.minY)} мм, ручка поднята. Смотрите, помещается ли на листе.`, 'success');
}

export function canResume() {
  return !!lastJob.lines && !!ctl.progress && !ctl.progress.running && ctl.lastAckedIndex >= 0 && ctl.lastAckedIndex < lastJob.lines.length - 2;
}

export function resumeAfterBreak() {
  const s = useApp.getState();
  if (!lastJob.lines) return;
  if (!ctl.connected) return s.notify('Сначала переподключите машину. Ручку не двигайте — начало координат должно совпасть.', 'error');
  const prof = s.profiles.find((x) => x.id === s.activeProfileId) ?? s.profiles[0];
  const r = buildResume(lastJob.lines, ctl.lastAckedIndex, prof.penUp, prof.penDown);
  ctl.clearProgress();
  ctl.mode = prof.streaming;
  ctl.stream(r.lines);
  lastJob.lines = r.lines;
  s.notify('Продолжаем с места остановки', 'success');
}
