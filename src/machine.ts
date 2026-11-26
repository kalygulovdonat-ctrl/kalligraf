// Связь интерфейса с машиной: один контроллер на всё приложение.
import { useSyncExternalStore } from 'react';
import { GrblController } from './grbl/controller';
import { SerialTransport, SimTransport, serialSupported } from './grbl/transport';
import type { Pt } from './core/geometry';
import { useApp } from './store';

export const ctl = new GrblController();
let version = 0;
ctl.subscribe(() => { version++; });

/** Перерисовка компонента при любом изменении состояния машины (не чаще ~20 раз/с). */
export function useMachine() {
  useSyncExternalStore(
    (cb) => {
      let pending = false;
      return ctl.subscribe(() => {
        if (pending) return;
        pending = true;
        setTimeout(() => { pending = false; cb(); }, 50);
      });
    },
    () => version,
  );
  return ctl;
}

// След ручки симулятора (в координатах машины) — для «виртуальной бумаги»
export const simTrace: { segs: [Pt, Pt][]; listeners: Set<() => void> } = { segs: [], listeners: new Set() };
export let sim: SimTransport | null = null;

export async function connectSimulator(speed = 1) {
  await disconnect();
  sim = new SimTransport({ speed });
  const st = useApp.getState();
  const prof = st.profiles.find((p) => p.id === st.activeProfileId) ?? st.profiles[0];
  // симулятор понимает, при каком Z ручка пишет — как настоящая машина
  sim.zDownHigh = prof?.penMode === 'zinv' || /Z\s*[1-9]/i.test(prof?.penDown ?? '');
  simTrace.segs = [];
  sim.onMove((m) => {
    if (!m.penDown) return;
    simTrace.segs.push([m.from, m.to]);
    if (simTrace.segs.length > 200000) simTrace.segs.splice(0, 50000);
    simTrace.listeners.forEach((l) => l());
  });
  await ctl.attach(sim);
}

export function clearSimTrace() {
  simTrace.segs = [];
  simTrace.listeners.forEach((l) => l());
}

/** Подключение по USB с подбором скорости порта. */
export async function connectSerial(preferredBaud: number, log: (s: string) => void): Promise<number> {
  if (!serialSupported()) throw new Error('Этот браузер не умеет работать с USB-портом. Откройте программу в Google Chrome, Microsoft Edge, Opera или Яндекс.Браузере.');
  const port = await SerialTransport.request();
  await disconnect();
  const bauds = [preferredBaud, 115200, 250000, 9600].filter((b, i, a) => a.indexOf(b) === i);
  for (const baud of bauds) {
    log(`Пробуем скорость ${baud}…`);
    let t: SerialTransport;
    try {
      t = await SerialTransport.open(port, baud);
    } catch (e) {
      const msg = String((e as Error).message || e);
      if (/already open/i.test(msg)) throw new Error('Порт уже занят другой программой (например, родной программой машины или LaserGRBL). Закройте её и попробуйте снова.');
      throw new Error('Не удалось открыть порт: ' + msg);
    }
    await ctl.attach(t);
    // Проверка ответа
    const ok = await Promise.race([
      ctl.command('$I').then(() => true).catch(() => false),
      new Promise<boolean>((r) => setTimeout(() => r(false), 1500)),
    ]);
    if (ok || ctl.version) {
      log(`Машина ответила на скорости ${baud}${ctl.version ? ': ' + ctl.version : ''}`);
      return baud;
    }
    log(`Нет ответа на ${baud}`);
    await ctl.detach();
  }
  throw new Error('Машина не отвечает. Проверьте кабель и питание. Если на компьютере нет драйвера CH340 — установите его (ссылка в подсказке) и переподключите кабель.');
}

export async function disconnect() {
  if (ctl.connected) await ctl.detach();
  if (sim) { await sim.close(); sim = null; }
}

/** Звук и системное уведомление «Готово». */
export function notifyDone(text: string) {
  try {
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ac = new AC();
    [660, 880, 1320].forEach((f, i) => {
      const o = ac.createOscillator(), g = ac.createGain();
      o.frequency.value = f; o.connect(g); g.connect(ac.destination);
      g.gain.setValueAtTime(0.0001, ac.currentTime + i * 0.15);
      g.gain.exponentialRampToValueAtTime(0.2, ac.currentTime + i * 0.15 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + i * 0.15 + 0.14);
      o.start(ac.currentTime + i * 0.15); o.stop(ac.currentTime + i * 0.15 + 0.15);
    });
  } catch { /* без звука */ }
  try {
    if ('Notification' in window && Notification.permission === 'granted') new Notification('Каллиграф', { body: text });
  } catch { /* без уведомления */ }
}
