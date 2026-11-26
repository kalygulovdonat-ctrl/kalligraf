// Транспорт: настоящий USB-порт (Web Serial) или виртуальная машина (симулятор GRBL).

export interface Transport {
  kind: 'serial' | 'sim';
  write(text: string): Promise<void>;
  writeByte(b: number): Promise<void>;
  onLine(cb: (line: string) => void): void;
  onClose(cb: (reason?: string) => void): void;
  close(): Promise<void>;
}

export const serialSupported = () => typeof navigator !== 'undefined' && 'serial' in navigator;

export class SerialTransport implements Transport {
  kind = 'serial' as const;
  private port: SerialPort;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private lineCbs: ((l: string) => void)[] = [];
  private closeCbs: ((r?: string) => void)[] = [];
  private closed = false;
  private enc = new TextEncoder();

  private constructor(port: SerialPort) { this.port = port; }

  /** Окно выбора порта показывает браузер; вызывать только по нажатию пользователя. */
  static async request(): Promise<SerialPort> {
    return navigator.serial.requestPort({});
  }

  static async open(port: SerialPort, baud: number): Promise<SerialTransport> {
    await port.open({ baudRate: baud, bufferSize: 4096 });
    const t = new SerialTransport(port);
    t.writer = port.writable!.getWriter();
    t.readLoop();
    return t;
  }

  private async readLoop() {
    const dec = new TextDecoder();
    let buf = '';
    try {
      while (this.port.readable && !this.closed) {
        this.reader = this.port.readable.getReader();
        try {
          for (;;) {
            const { value, done } = await this.reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            let i: number;
            while ((i = buf.search(/\r?\n/)) >= 0) {
              const line = buf.slice(0, i).trim();
              buf = buf.slice(buf[i] === '\r' ? i + 2 : i + 1);
              if (line) this.lineCbs.forEach((cb) => cb(line));
            }
          }
        } finally {
          this.reader.releaseLock();
          this.reader = null;
        }
      }
    } catch (e) {
      if (!this.closed) this.fireClose(String((e as Error)?.message ?? e));
      return;
    }
    if (!this.closed) this.fireClose('Порт закрыт');
  }

  private fireClose(reason?: string) {
    this.closed = true;
    this.closeCbs.forEach((cb) => cb(reason));
  }

  async write(text: string) {
    if (!this.writer) throw new Error('Порт не открыт');
    await this.writer.write(this.enc.encode(text));
  }
  async writeByte(b: number) {
    if (!this.writer) throw new Error('Порт не открыт');
    await this.writer.write(new Uint8Array([b]));
  }
  onLine(cb: (l: string) => void) { this.lineCbs.push(cb); }
  onClose(cb: (r?: string) => void) { this.closeCbs.push(cb); }
  async close() {
    this.closed = true;
    try { await this.reader?.cancel(); } catch { /* ignore */ }
    try { this.writer?.releaseLock(); } catch { /* ignore */ }
    try { await this.port.close(); } catch { /* ignore */ }
  }
}

// ── Симулятор GRBL ───────────────────────────────────────────────────

export interface SimMove { from: [number, number]; to: [number, number]; penDown: boolean }

interface Block { x: number; y: number; z: number; feed: number; rapid: boolean; dwell?: number; pause?: boolean; spin?: { on: boolean; s: number; z: boolean } }

const SIM_SETTINGS: [number, string][] = [
  [0, '10'], [1, '25'], [2, '0'], [3, '0'], [4, '0'], [5, '0'], [6, '0'], [10, '1'], [11, '0.010'], [12, '0.002'],
  [13, '0'], [20, '0'], [21, '0'], [22, '0'], [23, '0'], [24, '25.000'], [25, '500.000'], [26, '250'], [27, '1.000'],
  [30, '1000'], [31, '0'], [32, '0'], [100, '80.000'], [101, '80.000'], [102, '80.000'], [110, '8000.000'],
  [111, '8000.000'], [112, '3000.000'], [120, '500.000'], [121, '500.000'], [122, '300.000'], [130, '200.000'],
  [131, '260.000'], [132, '20.000'],
];

/**
 * Виртуальная машина: принимает G-код как GRBL 1.1, отвечает «ok», двигает виртуальную ручку
 * в реальном (или ускоренном) времени. Нужна для демо-режима и тестов.
 */
export class SimTransport implements Transport {
  kind = 'sim' as const;
  speed = 1;               // ускорение времени
  penDownThreshold = { z: 0.5, s: 50 };
  /** true — ручка пишет при большом Z (как у GUANGKU: Z3 пишет, Z−1,5 поднята). */
  zDownHigh = false;
  private lineCbs: ((l: string) => void)[] = [];
  private closeCbs: ((r?: string) => void)[] = [];
  private moveCbs: ((m: SimMove) => void)[] = [];
  private rx = '';
  private pending: string[] = [];
  private planner: Block[] = [];
  private readonly plannerSize = 15;
  private pos = { x: 0, y: 0, z: 0 };
  private wco = { x: 0, y: 0, z: 0 };
  private s = 0;
  private spindle = false;
  private feed = 1000;
  private absolute = true;
  private state = 'Idle';
  private hold = false;
  private feedOv = 100;
  private timer: ReturnType<typeof setInterval> | null = null;
  private cur: { b: Block; t: number; dur: number; from: { x: number; y: number; z: number } } | null = null;
  private last = 0;
  private closed = false;

  constructor(opts?: { speed?: number; autoStart?: boolean }) {
    this.speed = opts?.speed ?? 1;
    if (opts?.autoStart !== false) {
      this.timer = setInterval(() => this.tick(), 10);
      this.last = Date.now();
      setTimeout(() => this.emit("Grbl 1.1h ['$' for help]"), 50);
    }
  }

  onMove(cb: (m: SimMove) => void) { this.moveCbs.push(cb); }
  onLine(cb: (l: string) => void) { this.lineCbs.push(cb); }
  onClose(cb: (r?: string) => void) { this.closeCbs.push(cb); }
  async close() {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
  }
  /** Имитация обрыва кабеля (для тестов). */
  unplug() { this.close(); this.closeCbs.forEach((cb) => cb('Связь потеряна')); }

  // Ответы приходят асинхронно, как через настоящий порт
  private outQ: string[] = [];
  private emit(l: string) {
    if (this.closed) return;
    this.outQ.push(l);
    if (this.outQ.length === 1) setTimeout(() => this.drainOut(), 0);
  }
  private drainOut() {
    const q = this.outQ;
    this.outQ = [];
    for (const l of q) if (!this.closed) this.lineCbs.forEach((cb) => cb(l));
  }

  private zMode = true;
  private qSpin = false;
  private qS = 0;
  private isPenDown() { return this.zMode ? (this.zDownHigh ? this.pos.z > 1 : this.pos.z < this.penDownThreshold.z) : this.spindle && this.s >= this.penDownThreshold.s; }

  async writeByte(b: number) { this.realtime(b); }

  async write(text: string) {
    for (const ch of text) {
      const code = ch.charCodeAt(0);
      if (ch === '?' || ch === '!' || ch === '~' || code === 0x18 || code >= 0x80) { this.realtime(code); continue; }
      if (ch === '\n') { this.pending.push(this.rx); this.rx = ''; }
      else if (ch !== '\r') this.rx += ch;
    }
    this.processPending();
  }

  private realtime(code: number) {
    if (code === 0x3f) this.report();
    else if (code === 0x21) { if (this.state === 'Run' || this.planner.length || this.cur) { this.hold = true; this.state = 'Hold:0'; } }
    else if (code === 0x7e) { if (this.hold) { this.hold = false; this.state = this.cur || this.planner.length ? 'Run' : 'Idle'; } }
    else if (code === 0x18) {
      this.planner = []; this.pending = []; this.cur = null; this.hold = false; this.rx = ''; this.spindle = false; this.qSpin = false;
      this.state = 'Idle'; this.feedOv = 100;
      setTimeout(() => this.emit("Grbl 1.1h ['$' for help]"), 20);
    } else if (code === 0x90) this.feedOv = 100;
    else if (code === 0x91) this.feedOv = Math.min(200, this.feedOv + 10);
    else if (code === 0x92) this.feedOv = Math.max(10, this.feedOv - 10);
    else if (code === 0x93) this.feedOv = Math.min(200, this.feedOv + 1);
    else if (code === 0x94) this.feedOv = Math.max(10, this.feedOv - 1);
  }

  private report() {
    const f = (n: number) => n.toFixed(3);
    const st = this.state.startsWith('Hold') ? 'Hold:0' : this.state;
    this.emit(`<${st}|MPos:${f(this.pos.x)},${f(this.pos.y)},${f(this.pos.z)}|FS:${this.cur ? Math.round(this.cur.b.feed) : 0},${this.s}|WCO:${f(this.wco.x)},${f(this.wco.y)},${f(this.wco.z)}|Ov:${this.feedOv},100,100>`);
  }

  private processPending() {
    while (this.pending.length && this.planner.length < this.plannerSize) {
      const line = this.pending.shift()!;
      this.handleLine(line);
    }
  }

  private handleLine(raw: string) {
    const line = raw.replace(/\(.*?\)/g, '').replace(/;.*$/, '').trim().toUpperCase();
    if (!line) { this.emit('ok'); return; }
    if (line.startsWith('$')) return this.handleDollar(line);
    if (this.state === 'Alarm') { this.emit('error:9'); return; }
    const words = [...line.matchAll(/([A-Z])\s*(-?\d*\.?\d+)/g)].map((m) => [m[1], Number(m[2])] as [string, number]);
    if (!words.length) { this.emit('error:1'); return; }
    const last = this.planner.length ? this.planner[this.planner.length - 1] : null;
    const tgt = { x: last ? last.x : this.cur ? this.cur.b.x : this.pos.x, y: last ? last.y : this.cur ? this.cur.b.y : this.pos.y, z: last ? last.z : this.cur ? this.cur.b.z : this.pos.z };
    let motion: number | null = null, hasAxis = false, dwell: number | null = null;
    let spinOn: boolean | null = null, newS: number | null = null;
    const get = (k: string) => words.find((w) => w[0] === k)?.[1];
    for (const [k, v] of words) {
      if (k === 'G') {
        if (v === 0 || v === 1) motion = v;
        else if (v === 4) dwell = get('P') ?? 0;
        else if (v === 90) this.absolute = true;
        else if (v === 91) this.absolute = false;
        else if (v === 92) {
          const cx = this.pos.x, cy = this.pos.y, cz = this.pos.z;
          if (get('X') !== undefined) this.wco.x = cx - get('X')!;
          if (get('Y') !== undefined) this.wco.y = cy - get('Y')!;
          if (get('Z') !== undefined) this.wco.z = cz - get('Z')!;
          this.emit('ok'); return;
        } else if (v === 10) {
          // G10 L20 P1 X0 Y0 — текущая точка = ноль
          if (get('X') !== undefined) this.wco.x = this.pos.x - get('X')!;
          if (get('Y') !== undefined) this.wco.y = this.pos.y - get('Y')!;
          if (get('Z') !== undefined) this.wco.z = this.pos.z - get('Z')!;
          this.emit('ok'); return;
        } else if (![17, 21, 40, 49, 54, 80, 94].includes(v)) { this.emit('error:20'); return; }
      } else if (k === 'M') {
        if (v === 3 || v === 4) spinOn = true;
        else if (v === 5) spinOn = false;
        else if (v === 0 || v === 1) { this.planner.push({ ...tgt, feed: 0, rapid: true, pause: true }); }
        else if (v === 2 || v === 30) { /* конец программы */ }
        else if (![7, 8, 9].includes(v)) { this.emit('error:20'); return; }
      } else if (k === 'F') this.feed = v;
      else if (k === 'S') newS = v;
      else if (k === 'X' || k === 'Y' || k === 'Z') {
        hasAxis = true;
        const key = k.toLowerCase() as 'x' | 'y' | 'z';
        const w = this.wco[key];
        tgt[key] = this.absolute ? v + w : tgt[key] + v;
      }
    }
    if (spinOn !== null || newS !== null) {
      this.qSpin = spinOn ?? this.qSpin; this.qS = newS ?? this.qS;
      this.planner.push({ ...tgt, feed: 0, rapid: true, dwell: 0, spin: { on: this.qSpin, s: this.qS, z: false } });
    }
    if (dwell !== null) this.planner.push({ ...tgt, feed: 0, rapid: true, dwell });
    if (hasAxis) {
      const m = motion ?? 1;
      if (m === 1 && !this.feed) { this.emit('error:22'); return; }
      this.planner.push({ ...tgt, feed: m === 0 ? 8000 : this.feed, rapid: m === 0 });
    }
    if (this.state === 'Idle' && this.planner.length && !this.hold) this.state = 'Run';
    this.emit('ok');
  }

  private handleDollar(line: string) {
    if (line === '$$') { for (const [k, v] of SIM_SETTINGS) this.emit(`$${k}=${v}`); this.emit('ok'); }
    else if (line === '$I') { this.emit('[VER:1.1h.20190825:Каллиграф-симулятор]'); this.emit('[OPT:V,15,128]'); this.emit('ok'); }
    else if (line === '$X') { this.state = 'Idle'; this.emit('[MSG:Caution: Unlocked]'); this.emit('ok'); }
    else if (line === '$H') this.emit('error:5');
    else if (line === '$G') { this.emit(`[GC:G0 G54 G17 G21 ${this.absolute ? 'G90' : 'G91'} G94 M5 M9 T0 F${this.feed} S${this.s}]`); this.emit('ok'); }
    else if (line === '$#') { this.emit(`[G54:${this.wco.x.toFixed(3)},${this.wco.y.toFixed(3)},${this.wco.z.toFixed(3)}]`); this.emit('ok'); }
    else if (line.startsWith('$J=')) {
      const words = [...line.slice(3).matchAll(/([A-Z])\s*(-?\d*\.?\d+)/g)];
      const rel = words.some((w) => w[1] === 'G' && Number(w[2]) === 91);
      const t = { ...this.pos };
      let f = 1000;
      for (const w of words) {
        const k = w[1].toLowerCase(), v = Number(w[2]);
        if (k === 'f') f = v;
        else if (k === 'x' || k === 'y' || k === 'z') (t as Record<string, number>)[k] = rel ? (t as Record<string, number>)[k] + v : v + (this.wco as Record<string, number>)[k];
      }
      this.planner.push({ ...t, feed: f, rapid: false });
      if (this.state === 'Idle') this.state = 'Jog';
      this.emit('ok');
    } else if (/^\$\d+=/.test(line)) this.emit('ok');
    else this.emit('error:3');
  }

  private tick() {
    const now = Date.now();
    let dt = ((now - this.last) / 1000) * this.speed;
    this.last = now;
    if (this.hold) return;
    while (dt > 0) {
      if (!this.cur) {
        const b = this.planner.shift();
        if (!b) { if (this.state === 'Run' || this.state === 'Jog') this.state = 'Idle'; break; }
        this.processPending();
        if (b.pause) { this.hold = true; this.state = 'Hold:0'; return; }
        if (b.spin) { this.spindle = b.spin.on; this.s = b.spin.s; this.zMode = false; }
        if (b.z !== this.pos.z) this.zMode = true;
        const from = { ...this.pos };
        const d = Math.hypot(b.x - from.x, b.y - from.y, b.z - from.z);
        const dur = b.dwell !== undefined ? b.dwell : d / (Math.max(1, b.feed * (b.rapid ? 1 : this.feedOv / 100)) / 60);
        this.cur = { b, t: 0, dur, from };
      }
      const c = this.cur;
      const step = Math.min(dt, c.dur - c.t);
      const prev = { x: this.pos.x, y: this.pos.y };
      c.t += step; dt -= step;
      const k = c.dur > 0 ? c.t / c.dur : 1;
      this.pos = { x: c.from.x + (c.b.x - c.from.x) * k, y: c.from.y + (c.b.y - c.from.y) * k, z: c.from.z + (c.b.z - c.from.z) * k };
      if (prev.x !== this.pos.x || prev.y !== this.pos.y) {
        const m: SimMove = { from: [prev.x - this.wco.x, prev.y - this.wco.y], to: [this.pos.x - this.wco.x, this.pos.y - this.wco.y], penDown: this.isPenDown() };
        this.moveCbs.forEach((cb) => cb(m));
      }
      if (c.t >= c.dur - 1e-9) { this.cur = null; this.processPending(); }
    }
  }

  /** Для тестов: выполнить всё мгновенно. */
  flush(maxSteps = 1e6) {
    let n = 0;
    while ((this.cur || this.planner.length || this.pending.length) && n++ < maxSteps) {
      if (this.hold) break;
      this.last = Date.now() - 1e9;
      this.speed = 1;
      this.tick();
    }
  }
}
