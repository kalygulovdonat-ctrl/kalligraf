// Связь с машиной из Android-приложения: USB-OTG мост на Java (окно window.KalligrafUsb).
import type { Transport } from '../grbl/transport';

interface UsbBridge {
  open(baud: number): void;
  write(text: string): void;
  close(): void;
}

declare global {
  interface Window {
    KalligrafUsb?: UsbBridge;
    /** Сюда Java присылает события: open / data / error / closed. */
    __usb?: (type: string, data: string) => void;
  }
}

export const androidUsbAvailable = () => typeof window !== 'undefined' && !!window.KalligrafUsb;

export class AndroidTransport implements Transport {
  kind = 'serial' as const;
  private lineCbs: ((l: string) => void)[] = [];
  private closeCbs: ((r?: string) => void)[] = [];
  private buf = '';
  private closed = false;

  private constructor(private usb: UsbBridge) {}

  /** Открыть порт. Android может спросить разрешение на USB — ждём ответа пользователя. */
  static open(baud = 115200): Promise<AndroidTransport> {
    const usb = window.KalligrafUsb;
    if (!usb) return Promise.reject(new Error('USB доступен только в приложении на телефоне'));
    const t = new AndroidTransport(usb);
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => { if (!settled) { settled = true; reject(new Error('Нет ответа от USB. Переподключите кабель.')); } }, 60000);
      window.__usb = (type, data) => {
        if (type === 'open' && !settled) { settled = true; clearTimeout(timer); resolve(t); return; }
        if (type === 'error' && !settled) { settled = true; clearTimeout(timer); reject(new Error(data)); return; }
        t.onEvent(type, data);
      };
      usb.open(baud);
    });
  }

  private onEvent(type: string, data: string) {
    if (type === 'data') {
      this.buf += data;
      let i: number;
      while ((i = this.buf.search(/\r?\n/)) >= 0) {
        const line = this.buf.slice(0, i).trim();
        this.buf = this.buf.slice(this.buf[i] === '\r' ? i + 2 : i + 1);
        if (line) this.lineCbs.forEach((cb) => cb(line));
      }
    } else if (type === 'closed' || type === 'error') {
      if (!this.closed) { this.closed = true; this.closeCbs.forEach((cb) => cb(data || 'Кабель отключён')); }
    }
  }

  async write(text: string) {
    if (this.closed) throw new Error('Порт закрыт');
    this.usb.write(text);
  }
  async writeByte(b: number) { await this.write(String.fromCharCode(b)); }
  onLine(cb: (l: string) => void) { this.lineCbs.push(cb); }
  onClose(cb: (r?: string) => void) { this.closeCbs.push(cb); }
  async close() {
    this.closed = true;
    try { this.usb.close(); } catch { /* ignore */ }
  }
}
