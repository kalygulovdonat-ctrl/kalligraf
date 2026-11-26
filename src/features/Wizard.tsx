import { useEffect, useState } from 'react';
import { Cpu, Monitor, Usb } from 'lucide-react';
import { builtinFonts } from '../core/font';
import { defaultProfile, generateGcode, PEN_PRESETS, type MachineProfile, type PenMode } from '../core/gcode';
import { textPaths } from '../core/generators';
import type { Path } from '../core/geometry';
import { serialSupported } from '../grbl/transport';
import { connectSerial, connectSimulator, ctl, useMachine } from '../machine';
import { useApp, useProfile } from '../store';
import { Modal, Num } from '../ui/controls';
import { t } from '../i18n';
import { sendLines } from './ControlPanel';
import { LOCKED } from '../edition';

const STEPS = ['Подключение', 'Прошивка', 'Подъём ручки', 'Поле и оси', ...(LOCKED ? [] : ['Скорость'])];

function runTest(paths: Path[], prof: MachineProfile, speed?: number) {
  const s = useApp.getState();
  if (!ctl.connected) return s.notify('Машина не подключена', 'error');
  if (ctl.progress?.running) return s.notify('Машина ещё пишет', 'error');
  const shifted = paths.map((p) => ({ ...p, points: p.points.map(([x, y]) => [x + prof.offsetX, y + prof.offsetY] as [number, number]) }));
  const lines = generateGcode({ sections: [{ paths: shifted }], sheetH: s.doc.sheet.h }, speed ? { ...prof, drawSpeed: speed } : prof);
  ctl.mode = prof.streaming;
  ctl.stream(lines);
}

export function Wizard() {
  const [step, setStep] = useState(0);
  const close = () => useApp.getState().setState({ wizardOpen: false });
  const c = useMachine();
  return (
    <Modal title={`${t('Мастер настройки')}: ${STEPS[step]}`} onClose={close} wide footer={<>
      <button className="btn" onClick={() => (step ? setStep(step - 1) : close())}>{step ? t('Назад') : t('Закрыть')}</button>
      {step < STEPS.length - 1
        ? <button className="btn primary" onClick={() => setStep(step + 1)} disabled={step === 0 && !c.connected}>{t('Далее')}</button>
        : <button className="btn primary" onClick={() => { useApp.getState().setState({ wizardDone: true, wizardOpen: false }); useApp.getState().notify('Профиль машины сохранён', 'success'); }}>{t('Готово')}</button>}
    </>}>
      <div className="steps" style={{ padding: '0 0 14px' }}>{STEPS.map((_, i) => <div key={i} className={i <= step ? 'on' : ''} />)}</div>
      {step === 0 && <StepConnect />}
      {step === 1 && <StepFirmware />}
      {step === 2 && <StepPen />}
      {step === 3 && <StepAxes />}
      {step === 4 && <StepSpeed />}
    </Modal>
  );
}

function StepConnect() {
  const prof = useProfile();
  const up = useApp((s) => s.updateProfile);
  const c = useMachine();
  const [log, setLog] = useState<string[]>([]);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const usb = async () => {
    setErr(''); setLog([]); setBusy(true);
    try {
      const baud = await connectSerial(prof.baud, (s) => setLog((l) => [...l, s]));
      up({ baud });
    } catch (e) {
      const m = (e as Error).message;
      if (!/No port selected|requestPort/i.test(m)) setErr(m); else setErr('Порт не выбран.');
    } finally { setBusy(false); }
  };
  return (
    <div>
      <p>Подключите машину USB-кабелем и включите питание. Затем нажмите кнопку — браузер покажет список портов (обычно <b>USB-SERIAL CH340</b>).</p>
      {!serialSupported() && <div className="err-box">Этот браузер не поддерживает USB-порт (Web Serial). Откройте программу в <b>Google Chrome</b>, <b>Microsoft Edge</b>, <b>Opera</b> или <b>Яндекс.Браузере</b>. Здесь можно только готовить задания и скачивать G-код — или попробовать симулятор.</div>}
      <div className="btn-row" style={{ margin: '12px 0' }}>
        <button className="btn primary big" onClick={usb} disabled={busy || !serialSupported()}><Usb />{busy ? 'Подключаем…' : 'Подключить по USB'}</button>
        <button className="btn big" onClick={() => connectSimulator(1)} disabled={busy}><Monitor />Нет машины — симулятор</button>
      </div>
      {log.length > 0 && <div className="console" style={{ height: 110 }}>{log.map((l, i) => <div key={i} className="rx">{l}</div>)}</div>}
      {err && <div className="err-box" style={{ marginTop: 10 }}>{err}</div>}
      {c.connected && <div className="ok-box" style={{ marginTop: 10 }}>Подключено{c.version ? `: ${c.version}` : ''}. Нажмите «Далее».</div>}
      <p className="hint">Машина не находится? Установите драйвер CH340 с сайта производителя чипа: <a href="https://www.wch-ic.com/downloads/CH341SER_EXE.html" target="_blank" rel="noreferrer">wch-ic.com</a>, затем отключите и снова подключите кабель. Закройте родную программу машины — порт может быть занят.</p>
    </div>
  );
}

function StepFirmware() {
  const c = useMachine();
  const up = useApp((s) => s.updateProfile);
  const [info, setInfo] = useState<string[]>([]);
  const [err, setErr] = useState('');
  useEffect(() => {
    (async () => {
      try {
        const r = await ctl.command('$I');
        setInfo(r);
        await ctl.command('$$');
      } catch (e) { setErr((e as Error).message); }
    })();
  }, []);
  const s = c.settings;
  const isGrbl = /grbl/i.test(c.version) || info.some((l) => /VER:/i.test(l));
  return (
    <div>
      {err && <div className="err-box">{err}</div>}
      {isGrbl ? <div className="ok-box">Прошивка: <b>GRBL</b> {c.version.replace(/^Grbl\s*/i, '').replace(/\[.*$/, '')} — всё подходит.</div>
        : <div className="warn-box">Ответ не похож на GRBL. Возможно, у машины закрытая прошивка. Попробуйте другую скорость порта или посмотрите консоль в «Пульте».</div>}
      {info.length > 0 && <div className="console" style={{ height: 70 }}>{info.map((l, i) => <div key={i} className="rx">{l}</div>)}</div>}
      {Object.keys(s).length > 0 && (
        <table className="settings-table" style={{ marginTop: 10 }}><tbody>
          {[[100, 'Шагов на мм по X'], [101, 'Шагов на мм по Y'], ...(LOCKED ? [] : [[110, 'Макс. скорость X, мм/мин'], [111, 'Макс. скорость Y, мм/мин']]), [130, 'Ход X, мм'], [131, 'Ход Y, мм'], [22, 'Концевики (homing)'], [20, 'Мягкие пределы']].map(([k, l]) => (
            <tr key={k}><td>${k}</td><td>{l}</td><td><b>{s[+k] ?? '—'}</b></td></tr>
          ))}
        </tbody></table>
      )}
      {Number(s[130]) > 0 && Number(s[131]) > 0 && (
        <button className="btn small" style={{ marginTop: 10 }} onClick={() => { up({ workW: Number(s[130]), workH: Number(s[131]) }); useApp.getState().notify('Размер поля взят из платы', 'success'); }}>
          Взять размер поля из платы ({s[130]}×{s[131]} мм)
        </button>
      )}
      <p className="hint">Концевиков {s[22] === '1' ? 'есть — можно использовать «Домой»' : 'нет: перед каждым письмом ставьте ручку в начальную точку рукой'}.</p>
    </div>
  );
}

function StepPen() {
  const prof = useProfile();
  const up = useApp((s) => s.updateProfile);
  const [zUp, setZUp] = useState(5);
  const [sUp, setSUp] = useState(30);
  const [sDown, setSDown] = useState(90);
  const modes: [Exclude<PenMode, 'custom'>, string, string, string][] = [
    ['zinv', 'GUANGKU: ось Z наоборот', 'G1 Z-1.5 F600', 'G1 Z3 F600'],
    ['z', 'Мотор по оси Z', `G0 Z${zUp}`, 'G1 Z0 F1000'],
    ['servo', 'Сервопривод', `M3 S${sUp}`, `M3 S${sDown}`],
    ['solenoid', 'Соленоид', 'M5', 'M3 S1000'],
  ];
  return (
    <div>
      <p>Нажимайте «вверх» / «вниз» и смотрите на ручку. Выберите способ, при котором ручка <b>поднимается и опускается</b>.</p>
      {modes.map(([m, name, u, d]) => (
        <div key={m} className={'font-card' + (prof.penMode === m ? ' on' : '')}>
          <div className="name"><span><Cpu style={{ width: 16, verticalAlign: -3 }} /> {name}</span>{prof.penMode === m && <span className="badge">выбрано</span>}</div>
          <div className="hint" style={{ margin: '4px 0 8px', fontFamily: 'ui-monospace, monospace' }}>вверх: {u} · вниз: {d}</div>
          {m === 'z' && <Num label="Высота подъёма Z, мм" value={zUp} min={0.5} max={30} step={0.5} onChange={setZUp} />}
          {m === 'servo' && <div className="grid2"><Num label="S вверх" value={sUp} min={0} max={1000} onChange={setSUp} /><Num label="S вниз" value={sDown} min={0} max={1000} onChange={setSDown} /></div>}
          <div className="btn-row">
            <button className="btn small" onClick={() => sendLines(u)}>Вверх</button>
            <button className="btn small" onClick={() => sendLines(d)}>Вниз</button>
            <button className="btn small primary" onClick={() => up({ penMode: m, penUp: u, penDown: d, penDownDelay: Math.max(PEN_PRESETS[m].downDelay, 0.05), penUpDelay: PEN_PRESETS[m].upDelay })}>Работает так</button>
          </div>
        </div>
      ))}
      <p className="hint">Ручка в держателе должна стоять так, чтобы в поднятом положении кончик был на 2–4 мм выше бумаги.</p>
    </div>
  );
}

function StepAxes() {
  const prof = useProfile();
  const up = useApp((s) => s.updateProfile);
  const [mw, setMw] = useState(20);
  const [mh, setMh] = useState(20);
  const test: Path[] = [
    { points: [[5, 5], [25, 5], [25, 25], [5, 25], [5, 5]] },
    { points: [[5, 32], [25, 32]] }, { points: [[21, 30], [25, 32], [21, 34]] },
  ];
  return (
    <div>
      <ol style={{ paddingLeft: 18, margin: '0 0 10px' }}>
        <li>Положите лист. Рукой (или кнопками «Пульта») подведите кончик ручки к <b>левому верхнему углу</b> листа.</li>
        <li>Нажмите «Это начальная точка», затем «Нарисовать тест».</li>
        <li>Машина нарисует квадрат 20×20 мм и стрелку <b>вправо</b> под ним.</li>
      </ol>
      <div className="btn-row" style={{ marginBottom: 12 }}>
        <button className="btn" onClick={() => sendLines('G10 L20 P1 X0 Y0')}>Это начальная точка</button>
        <button className="btn primary" onClick={() => runTest(test, prof)}>Нарисовать тест</button>
      </div>
      <p><b>Что получилось?</b></p>
      <div className="btn-row" style={{ marginBottom: 10 }}>
        <button className="btn small" onClick={() => up({ invertX: !prof.invertX })}>Стрелка смотрит влево → развернуть X</button>
        <button className="btn small" onClick={() => up({ invertY: !prof.invertY })}>Рисует выше начальной точки → развернуть Y</button>
        <button className="btn small" onClick={() => up({ swapXY: !prof.swapXY })}>Стрелка вертикальная → поменять оси</button>
      </div>
      <p className="hint">Измерьте квадрат линейкой и впишите размеры — программа поправит масштаб.</p>
      <div className="grid2">
        <Num label="Ширина квадрата, мм" value={mw} min={1} max={100} step={0.1} onChange={setMw} />
        <Num label="Высота квадрата, мм" value={mh} min={1} max={100} step={0.1} onChange={setMh} />
      </div>
      <button className="btn small primary" disabled={mw === 20 && mh === 20} onClick={() => {
        up({ scaleX: +(prof.scaleX * (20 / mw)).toFixed(4), scaleY: +(prof.scaleY * (20 / mh)).toFixed(4) });
        setMw(20); setMh(20);
        useApp.getState().notify('Масштаб исправлен. Нарисуйте тест ещё раз для проверки.', 'success');
      }}>Исправить масштаб</button>
      <p className="hint">Сейчас: масштаб X {prof.scaleX}, Y {prof.scaleY}; X {prof.invertX ? 'развёрнут' : 'обычный'}, Y {prof.invertY ? 'развёрнут' : 'обычный'}{prof.swapXY ? ', оси переставлены' : ''}.</p>
      <button className="btn small ghost" onClick={() => { const d = defaultProfile(); up({ scaleX: 1, scaleY: 1, invertX: d.invertX, invertY: d.invertY, swapXY: false }); }}>Вернуть как было по умолчанию</button>
    </div>
  );
}

function StepSpeed() {
  const prof = useProfile();
  const up = useApp((s) => s.updateProfile);
  const speeds = [1500, 3000, 5000];
  const font = builtinFonts()[0];
  return (
    <div>
      <p>Машина напишет слово три раза с разной скоростью (сверху вниз — медленно, средне, быстро). Выберите самую быструю, при которой буквы ещё ровные.</p>
      <div className="btn-row" style={{ marginBottom: 12 }}>
        {speeds.map((sp, i) => (
          <button key={sp} className="btn" onClick={() => runTest(textPaths(`Каллиграф ${sp}`, font, 5, 48 + i * 12, 6), prof, sp)}>Написать на {sp} мм/мин</button>
        ))}
      </div>
      <div className="btn-row">
        {speeds.map((sp) => <button key={sp} className={'btn small' + (prof.drawSpeed === sp ? ' primary' : '')} onClick={() => up({ drawSpeed: sp })}>Выбрать {sp}</button>)}
      </div>
      <p className="hint">Текущая скорость письма: <b>{prof.drawSpeed} мм/мин</b>. Её всегда можно поменять в «Настройках» или на ходу в «Пульте».</p>
    </div>
  );
}
