// Контроллер GRBL: команды, потоковая отправка G-кода, реального времени, опрос состояния.
import { explainResponse, parseStatus, type GrblStatus } from './codes';
import type { Transport } from './transport';

export type LogKind = 'tx' | 'rx' | 'info' | 'error';
export interface LogEntry { t: number; kind: LogKind; text: string }

export interface StreamProgress {
  total: number;
  sent: number;
  acked: number;
  running: boolean;
  paused: boolean;
  message?: string;      // сообщение паузы M0 («Положите новый лист»)
  draining?: boolean;    // всё отправлено, машина дописывает буфер
  error?: string;
  startedAt: number;
  finishedAt?: number;
}

type Listener = () => void;

const RX_BUFFER = 127;

export class GrblController {
  /** Фильтр каждой строки перед отправкой (в публичной версии — предел скорости). */
  static lineFilter: ((line: string) => string) | null = null;
  /** Запрещённые байты реального времени (например, «скорость +10%»). */
  static blockedRealtime = new Set<number>();

  transport: Transport | null = null;
  status: GrblStatus = { state: 'Disconnected' };
  log: LogEntry[] = [];
  version = '';
  settings: Record<number, string> = {};
  progress: StreamProgress | null = null;
  /** Индекс последней подтверждённой строки задания — для «продолжить после обрыва». */
  lastAckedIndex = -1;
  mode: 'count' | 'simple' = 'count';

  private listeners = new Set<Listener>();
  private wco: [number, number, number] | undefined;
  private poll: ReturnType<typeof setInterval> | null = null;
  // Ожидающие ответа строки: длина (для подсчёта символов) и обработчик
  private inflight: { len: number; idx: number; resolve?: (r: string[]) => void; reject?: (e: Error) => void; collected: string[] }[] = [];
  private job: { lines: string[]; messages: Map<number, string>; next: number } | null = null;

  subscribe(fn: Listener) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  private emit() { this.listeners.forEach((l) => l()); }

  private addLog(kind: LogKind, text: string) {
    this.log.push({ t: Date.now(), kind, text });
    if (this.log.length > 600) this.log.splice(0, this.log.length - 500);
  }

  get connected() { return !!this.transport; }

  async attach(t: Transport) {
    this.transport = t;
    this.bannerSeen = false;
    this.version = '';
    this.settings = {};
    this.status = { state: 'Unknown' };
    this.inflight = [];
    t.onLine((l) => this.onLine(l));
    t.onClose((reason) => this.onClosed(reason));
    this.addLog('info', t.kind === 'sim' ? 'Подключён симулятор машины' : 'Порт открыт');
    this.emit();
    // Плата перезагружается при открытии порта и присылает «Grbl 1.1x». Ждём приветствие,
    // иначе будим её переводом строки.
    const gotBanner = await new Promise<boolean>((resolve) => {
      const start = Date.now();
      const iv = setInterval(() => {
        if (this.bannerSeen) { clearInterval(iv); resolve(true); }
        else if (Date.now() - start > 2500 || !this.transport) { clearInterval(iv); resolve(false); }
      }, 20);
    });
    if (!this.transport) return;
    if (!gotBanner) {
      this.addLog('info', 'Приветствие не получено — пробуем разбудить плату');
      await t.write('\r\n\r\n').catch(() => {});
      await new Promise((r) => setTimeout(r, 300));
      this.inflight = [];
    }
    this.poll = setInterval(() => { this.transport?.write('?').catch(() => {}); }, 200);
    this.emit();
  }

  private bannerSeen = false;
  private idleCount = 0;

  async detach() {
    if (this.poll) clearInterval(this.poll);
    this.poll = null;
    const t = this.transport;
    this.transport = null;
    this.failInflight('Отключено');
    if (this.progress?.running) { this.progress.running = false; this.progress.error = 'Связь прервана'; }
    this.status = { state: 'Disconnected' };
    this.addLog('info', 'Отключено');
    this.emit();
    await t?.close();
  }

  private onClosed(reason?: string) {
    if (!this.transport) return;
    this.addLog('error', `Связь с машиной потеряна${reason ? ': ' + reason : ''}`);
    if (this.poll) clearInterval(this.poll);
    this.poll = null;
    this.transport = null;
    this.failInflight('Связь потеряна');
    if (this.progress?.running) {
      this.progress.running = false;
      this.progress.error = `Связь потеряна на строке ${this.lastAckedIndex + 2}. Можно продолжить после переподключения.`;
    }
    this.status = { state: 'Disconnected' };
    this.emit();
  }

  private failInflight(msg: string) {
    for (const f of this.inflight) f.reject?.(new Error(msg));
    this.inflight = [];
    this.job = null;
  }

  private onLine(line: string) {
    if (line.startsWith('<')) {
      const st = parseStatus(line, this.wco);
      if (st) {
        if (st.wco) this.wco = st.wco;
        this.status = st;
        if (this.progress?.running) {
          this.progress.paused = st.state.startsWith('Hold');
          if (this.progress.draining) {
            this.idleCount = st.state === 'Idle' ? this.idleCount + 1 : 0;
            if (this.idleCount >= 2) {
              this.progress.running = false;
              this.progress.draining = false;
              this.progress.finishedAt = Date.now();
              this.addLog('info', 'Письмо завершено');
            }
          }
        }
        this.emit();
      }
      return;
    }
    // «ok» на строки задания не пишем в журнал — их тысячи
    if (!(line === 'ok' && this.inflight[0] && this.inflight[0].idx >= 0)) this.addLog('rx', line);
    if (/^Grbl /i.test(line)) {
      this.version = line;
      this.bannerSeen = true;
      // Сброс платы: всё, что было в пути, потеряно
      if (this.inflight.length) this.failInflight('Плата перезагрузилась');
      if (this.progress?.running) { this.progress.running = false; this.progress.error = 'Остановлено (сброс)'; }
      this.emit();
      return;
    }
    if (line.startsWith('$') && /^\$\d+=/.test(line)) {
      const [k, v] = line.slice(1).split('=');
      this.settings[+k] = v;
    }
    if (line === 'ok' || /^error:/i.test(line)) {
      const f = this.inflight.shift();
      if (f) {
        if (line === 'ok') {
          f.resolve?.(f.collected);
          if (f.idx >= 0) { this.lastAckedIndex = f.idx; if (this.progress) this.progress.acked++; }
        } else {
          const ex = explainResponse(line) ?? line;
          this.addLog('error', ex);
          f.reject?.(new Error(ex));
          if (f.idx >= 0 && this.progress) {
            this.progress.error = `Строка ${f.idx + 1}: ${ex}`;
            this.progress.running = false;
            this.job = null;
          }
        }
      }
      this.pump();
      this.emit();
      return;
    }
    if (/^ALARM:/i.test(line)) {
      const ex = explainResponse(line) ?? line;
      this.addLog('error', ex);
      if (this.progress?.running) { this.progress.running = false; this.progress.error = ex; this.job = null; }
      this.status = { ...this.status, state: 'Alarm' };
      this.emit();
      return;
    }
    if (this.inflight.length) this.inflight[0].collected.push(line);
    this.emit();
  }

  private buffered() { return this.inflight.reduce((s, f) => s + f.len, 0); }

  /** Отправить одну команду и дождаться ok (или ошибки). */
  command(line: string): Promise<string[]> {
    const t = this.transport;
    if (!t) return Promise.reject(new Error('Машина не подключена'));
    const f = GrblController.lineFilter;
    const one = f ? f(line.trim()) : line.trim();
    const text = one + '\n';
    this.addLog('tx', one);
    return new Promise((resolve, reject) => {
      this.inflight.push({ len: text.length, idx: -1, resolve, reject, collected: [] });
      t.write(text).catch((e) => reject(e));
      this.emit();
    });
  }

  async realtime(byte: number | string) {
    const t = this.transport;
    if (!t) return;
    if (typeof byte === 'number' && GrblController.blockedRealtime.has(byte)) return;
    if (typeof byte === 'string') await t.write(byte);
    else await t.writeByte(byte);
  }

  /** Потоковая отправка программы. Строки-комментарии перед M0 становятся сообщением паузы. */
  stream(lines: string[], startIndex = 0) {
    if (!this.transport) throw new Error('Машина не подключена');
    if (this.progress?.running) throw new Error('Уже идёт письмо');
    const messages = new Map<number, string>();
    let lastComment = '';
    lines.forEach((l, i) => {
      if (l.startsWith(';')) lastComment = l.slice(1).trim();
      else if (/^M0\b/i.test(l) || /^M1\b/i.test(l)) messages.set(i, lastComment || 'Пауза');
    });
    this.job = { lines, messages, next: startIndex };
    this.progress = { total: lines.length, sent: startIndex, acked: startIndex, running: true, paused: false, startedAt: Date.now() };
    this.lastAckedIndex = startIndex - 1;
    this.addLog('info', `Начато письмо: ${lines.length} строк`);
    this.pump();
    this.emit();
  }

  private pump() {
    const t = this.transport, job = this.job;
    if (!t || !job || !this.progress?.running) return;
    while (job.next < job.lines.length) {
      const raw = job.lines[job.next];
      const f = GrblController.lineFilter;
      const line = (f ? f(raw) : raw).replace(/;.*$/, '').trim();
      if (!line) {
        job.next++;
        this.progress.sent++; this.progress.acked++;
        this.lastAckedIndex = job.next - 1;
        continue;
      }
      const text = line + '\n';
      if (this.mode === 'simple' ? this.inflight.length > 0 : this.buffered() + text.length > RX_BUFFER) break;
      const idx = job.next;
      if (job.messages.has(idx)) this.progress.message = job.messages.get(idx);
      this.inflight.push({ len: text.length, idx, collected: [] });
      t.write(text).catch(() => {});
      job.next++;
      this.progress.sent++;
    }
    if (job.next >= job.lines.length && this.inflight.every((f) => f.idx < 0)) {
      this.progress.acked = this.progress.total;
      this.progress.draining = true;
      this.idleCount = 0;
      this.job = null;
    }
  }

  pause() { this.realtime('!'); this.addLog('info', 'Пауза'); }
  resume() { if (this.progress) this.progress.message = undefined; this.realtime('~'); this.addLog('info', 'Продолжить'); }

  /** Аварийная остановка: мягкий сброс 0x18, затем поднять ручку. */
  async stop(penUp?: string) {
    this.job = null;
    if (this.progress?.running) { this.progress.running = false; this.progress.paused = false; this.progress.error = 'Остановлено пользователем'; }
    this.inflight = this.inflight.filter((f) => f.idx < 0);
    for (const f of this.inflight) f.reject?.(new Error('Остановлено'));
    this.inflight = [];
    await this.realtime(0x18);
    this.addLog('info', 'СТОП: мягкий сброс');
    this.emit();
    if (penUp) {
      setTimeout(async () => {
        try {
          if (this.status.state === 'Alarm') await this.command('$X');
          for (const l of penUp.split('\n').filter(Boolean)) await this.command(l);
        } catch { /* машина могла не ответить */ }
      }, 400);
    }
  }

  clearProgress() { this.progress = null; this.emit(); }
}

/**
 * Программа для продолжения после обрыва связи: шапка, ручка вверх, переезд к последней
 * подтверждённой точке, ручка вниз (если была опущена), затем оставшиеся строки.
 */
export function buildResume(lines: string[], lastAcked: number, penUp: string, penDown: string): { lines: string[]; startIndex: number } {
  let penIsDown = false;
  let x = 0, y = 0;
  const up = penUp.split('\n').map((s) => s.trim()).filter(Boolean);
  const down = penDown.split('\n').map((s) => s.trim()).filter(Boolean);
  for (let i = 0; i <= lastAcked && i < lines.length; i++) {
    const l = lines[i].trim();
    if (up.includes(l)) penIsDown = false;
    else if (down.includes(l)) penIsDown = true;
    const mx = /X(-?\d*\.?\d+)/i.exec(l), my = /Y(-?\d*\.?\d+)/i.exec(l);
    if (/^G[01]\b/i.test(l)) { if (mx) x = +mx[1]; if (my) y = +my[1]; }
  }
  const head = ['G21', 'G90', ...up, `G0 X${x} Y${y}`, ...(penIsDown ? down : [])];
  return { lines: [...head, ...lines.slice(lastAcked + 1)], startIndex: 0 };
}
