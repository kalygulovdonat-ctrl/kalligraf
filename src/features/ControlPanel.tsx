import { useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, ChevronsDown, ChevronsUp, Crosshair, Home, LockOpen, RefreshCw, RotateCcw, Send } from 'lucide-react';
import { toMachine } from '../core/gcode';
import { GRBL_SETTINGS, STATE_RU } from '../grbl/codes';
import { ctl, useMachine } from '../machine';
import { useApp, useProfile } from '../store';
import { Section, Seg } from '../ui/controls';
import { t } from '../i18n';
import { PenHeight, StartPoint } from './PenHeight';
import { LOCKED } from '../edition';

const fmt = (n: number) => String(Math.round(n * 1000) / 1000);

export async function jog(dx: number, dy: number, step: number) {
  const s = useApp.getState();
  const prof = s.profiles.find((p) => p.id === s.activeProfileId) ?? s.profiles[0];
  if (!ctl.connected) return s.notify('Машина не подключена', 'error');
  if (ctl.progress?.running) return s.notify('Во время письма двигать ручку нельзя', 'error');
  const h = s.doc.sheet.h;
  const a = toMachine([0, 0], prof, h), b = toMachine([dx * step, dy * step], prof, h);
  const mx = b[0] - a[0], my = b[1] - a[1];
  try {
    await ctl.command(`$J=G91 G21 X${fmt(mx)} Y${fmt(my)} F${Math.min(prof.travelSpeed, 4000)}`);
  } catch (e) {
    s.notify((e as Error).message, 'error');
  }
}

export async function sendLines(text: string) {
  const s = useApp.getState();
  if (!ctl.connected) return s.notify('Машина не подключена', 'error');
  for (const l of text.split('\n').map((x) => x.trim()).filter(Boolean)) {
    try { await ctl.command(l); } catch (e) { s.notify((e as Error).message, 'error'); return; }
  }
}

export function ControlRight() {
  const c = useMachine();
  const prof = useProfile();
  const notify = useApp((s) => s.notify);
  const [step, setStep] = useState('1');
  const [cmd, setCmd] = useState('');
  const [hist, setHist] = useState<string[]>([]);
  const [hi, setHi] = useState(-1);
  const logRef = useRef<HTMLDivElement>(null);
  const [edits, setEdits] = useState<Record<number, string>>({});
  useEffect(() => { logRef.current?.scrollTo(0, 1e9); }, [c.log.length]);

  const busy = !c.connected || !!c.progress?.running;
  const run = (l: string) => sendLines(l);
  const send = () => {
    const v = cmd.trim();
    if (!v) return;
    if (v === '?' || v === '!' || v === '~') c.realtime(v);
    else run(v);
    setHist((h) => [v, ...h.filter((x) => x !== v)].slice(0, 50));
    setCmd(''); setHi(-1);
  };
  const st = c.status;
  const wp = st.wpos;

  return (
    <div>
      <div className="panel-head"><h2>{t('Пульт')}</h2>
        <span className="badge">{STATE_RU[st.state.split(':')[0]] ?? (c.connected ? st.state : t('Не подключено'))}</span>
      </div>
      {!c.connected && <div className="section"><div className="warn-box" style={{ margin: 0 }}>Подключите машину или симулятор кнопкой вверху.</div></div>}
      <PenHeight />
      <StartPoint />
      <Section title="Движение ручки">
        <div className="field"><span>{t('Шаг, мм')}</span>
          <Seg value={step} onChange={setStep} options={['0.1', '1', '10', '50'].map((s) => [s, s, s + ' мм'])} />
        </div>
        <div className="jog">
          <span />
          <button className="btn" disabled={busy} onClick={() => jog(0, -1, +step)} aria-label="Вверх по листу" title="Стрелка ↑"><ArrowUp /></button>
          <span />
          <button className="btn" disabled={busy} onClick={() => jog(-1, 0, +step)} aria-label="Влево" title="Стрелка ←"><ArrowLeft /></button>
          <button className="btn" disabled={busy} onClick={() => run('G0 X0 Y0')} aria-label="В начальную точку" title="Вернуться в начальную точку (X0 Y0)"><Crosshair /></button>
          <button className="btn" disabled={busy} onClick={() => jog(1, 0, +step)} aria-label="Вправо" title="Стрелка →"><ArrowRight /></button>
          <span />
          <button className="btn" disabled={busy} onClick={() => jog(0, 1, +step)} aria-label="Вниз по листу" title="Стрелка ↓"><ArrowDown /></button>
          <span />
        </div>
        <div className="hint" style={{ textAlign: 'center', marginBottom: 10 }}>X: <b>{wp ? wp[0].toFixed(2) : '—'}</b> · Y: <b>{wp ? wp[1].toFixed(2) : '—'}</b> · Z: <b>{wp ? wp[2].toFixed(2) : '—'}</b></div>
        <div className="btn-row">
          <button className="btn small" disabled={busy} onClick={() => run(prof.penUp)}><ChevronsUp />{t('Ручка вверх')}</button>
          <button className="btn small" disabled={busy} onClick={() => run(prof.penDown)}><ChevronsDown />{t('Ручка вниз')}</button>
        </div>
        <button className="btn small primary" style={{ width: '100%', marginTop: 8 }} disabled={busy}
          onClick={async () => { await sendLines('G10 L20 P1 X0 Y0'); notify('Начальная точка установлена: текущее положение ручки = левый верхний угол листа', 'success'); }}
          title="Подведите кончик ручки к углу листа и нажмите"><Crosshair />{t('Сделать текущую точку началом')}</button>
        <div className="btn-row" style={{ marginTop: 8 }}>
          <button className="btn small" disabled={!c.connected} onClick={() => run('$X')} title="Снять блокировку после тревоги ($X)"><LockOpen />{t('Разблокировать')}</button>
          <button className="btn small" disabled={busy} onClick={() => run('$H')} title="Поиск нуля по концевикам ($H)"><Home />{t('Домой')}</button>
          <button className="btn small" disabled={!c.connected} onClick={() => c.realtime(0x18)} title="Мягкий сброс платы"><RotateCcw />{t('Сброс')}</button>
        </div>
      </Section>

      {!LOCKED && <Section title={`Скорость на ходу${st.overrides ? `: ${st.overrides[0]}%` : ''}`}>
        <div className="btn-row">
          <button className="btn small" disabled={!c.connected} onClick={() => c.realtime(0x92)}>−10%</button>
          <button className="btn small" disabled={!c.connected} onClick={() => c.realtime(0x94)}>−1%</button>
          <button className="btn small" disabled={!c.connected} onClick={() => c.realtime(0x90)}>100%</button>
          <button className="btn small" disabled={!c.connected} onClick={() => c.realtime(0x93)}>+1%</button>
          <button className="btn small" disabled={!c.connected} onClick={() => c.realtime(0x91)}>+10%</button>
        </div>
      </Section>}

      <Section title={t('Консоль')}>
        <div className="console" ref={logRef} aria-live="polite">
          {c.log.slice(-300).map((l, i) => <div key={i} className={l.kind}>{l.kind === 'tx' ? '› ' : ''}{l.text}</div>)}
        </div>
        <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
          <input type="text" value={cmd} placeholder="G0 X10 Y10, $$, $I…" style={{ fontFamily: 'ui-monospace, monospace' }} disabled={!c.connected}
            onChange={(e) => setCmd(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') send();
              else if (e.key === 'ArrowUp' && hist.length) { e.preventDefault(); const n = Math.min(hist.length - 1, hi + 1); setHi(n); setCmd(hist[n]); }
              else if (e.key === 'ArrowDown') { e.preventDefault(); const n = hi - 1; setHi(n); setCmd(n >= 0 ? hist[n] : ''); }
            }} aria-label="Команда G-кода" />
          <button className="btn primary" onClick={send} disabled={!c.connected} aria-label={t('Отправить')}><Send /></button>
        </div>
      </Section>

      <Section title="Настройки платы ($$)" right={<button className="btn small ghost" disabled={busy} onClick={() => run('$$')}><RefreshCw />Прочитать</button>}>
        {Object.keys(c.settings).length === 0 ? <div className="hint">Нажмите «Прочитать», чтобы увидеть настройки прошивки GRBL.</div> : (
          <>
            <div className="warn-box">Меняйте, только если понимаете, что делаете. Неверные значения могут сбить масштаб или скорость.</div>
            <table className="settings-table"><tbody>
              {Object.entries(c.settings).map(([k, v]) => {
                const info = GRBL_SETTINGS[+k];
                const ed = edits[+k];
                return (
                  <tr key={k}>
                    <td>${k}</td>
                    <td>{info?.[0] ?? '—'}<div className="hint">{info?.[1]}</div></td>
                    <td><input type="text" value={ed ?? v} onChange={(e) => setEdits((x) => ({ ...x, [k]: e.target.value }))} /></td>
                    <td>{ed !== undefined && ed !== v && <button className="btn small" disabled={busy} onClick={async () => {
                      if (!confirm(`Записать $${k}=${ed} в память платы?`)) return;
                      await sendLines(`$${k}=${ed}`); await sendLines('$$');
                      setEdits((x) => { const y = { ...x }; delete y[+k]; return y; });
                    }}>OK</button>}</td>
                  </tr>
                );
              })}
            </tbody></table>
          </>
        )}
      </Section>
    </div>
  );
}
