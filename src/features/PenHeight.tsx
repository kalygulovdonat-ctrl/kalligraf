// «Высота ручки» и «где стоит ручка на листе» — настраиваются перед письмом прямо на машине.
import { useEffect, useState } from 'react';
import { ChevronsDown, ChevronsUp, PenLine } from 'lucide-react';
import { useMachine } from '../machine';
import { useApp, useProfile } from '../store';
import { Num, Section } from '../ui/controls';
import { sendLines } from './ControlPanel';
import { penFeed } from '../core/gcode';

const zOf = (cmd: string, def: number) => {
  const m = /Z\s*(-?\d*\.?\d+)/i.exec(cmd);
  return m ? Number(m[1]) : def;
};
const r1 = (n: number) => Math.round(n * 10) / 10;

export function PenHeight() {
  const c = useMachine();
  const prof = useProfile();
  const up = useApp((s) => s.updateProfile);
  const notify = useApp((s) => s.notify);
  const [zDown, setZDown] = useState(() => zOf(prof.penDown, 3));
  const [zUp, setZUp] = useState(() => zOf(prof.penUp, -1.5));
  const [step, setStep] = useState(0.5);
  useEffect(() => { setZDown(zOf(prof.penDown, 3)); setZUp(zOf(prof.penUp, -1.5)); }, [prof.penDown, prof.penUp]);

  const curZ = c.status.wpos?.[2];
  const busy = !c.connected || !!c.progress?.running;
  const zf = penFeed(prof) ?? 600;
  const downCmd = (z: number) => `G1 Z${r1(z)} F${zf}`;

  /** Сохранить высоты в профиль: ручка «пишет» и «поднята». */
  const save = (d: number, u: number) => {
    setZDown(d); setZUp(u);
    up({ penMode: 'custom', penDown: downCmd(d), penUp: downCmd(u), penDownDelay: 0, penUpDelay: 0 });
  };
  const jogZ = (d: number) => sendLines(`$J=G91 G21 Z${d} F600`);

  const gap = Math.abs(zDown - zUp);
  return (
    <Section title="Высота ручки (настройте перед письмом)">
      <ol className="hint" style={{ paddingLeft: 18, margin: '0 0 10px', lineHeight: 1.5 }}>
        <li>Кнопками ниже двигайте ручку по оси Z и смотрите на неё.</li>
        <li>Когда кончик <b>слегка прижат к бумаге</b> — нажмите «Здесь пишет».</li>
        <li>Поднимите на 3–5 мм над бумагой — нажмите «Здесь поднята».</li>
        <li>Проверьте «Тест: линия 2 см». Линия должна быть ровной и сплошной.</li>
      </ol>
      <div className="field"><span>Шаг по Z, мм</span>
        <div className="seg">
          {[0.1, 0.5, 1, 2].map((s) => <button key={s} className={step === s ? 'on' : ''} onClick={() => setStep(s)}>{String(s).replace('.', ',')}</button>)}
        </div>
      </div>
      <div className="btn-row" style={{ marginBottom: 8, alignItems: 'center' }}>
        <button className="btn" disabled={busy} onClick={() => jogZ(-step)} title="Ось Z в минус"><ChevronsUp />Z − {String(step).replace('.', ',')}</button>
        <button className="btn" disabled={busy} onClick={() => jogZ(step)} title="Ось Z в плюс"><ChevronsDown />Z + {String(step).replace('.', ',')}</button>
        <span className="hint">Сейчас Z = <b>{curZ !== undefined ? curZ.toFixed(2) : '—'}</b> мм</span>
      </div>
      <div className="hint" style={{ marginBottom: 8 }}>На GUANGKU «Z +» обычно опускает ручку к бумаге, «Z −» — поднимает. Смотрите, как двигается ваша.</div>
      <div className="btn-row" style={{ marginBottom: 10 }}>
        <button className="btn small primary" disabled={busy || curZ === undefined} onClick={() => { save(r1(curZ!), zUp); notify(`Запомнил: ручка пишет при Z = ${r1(curZ!)} мм`, 'success'); }}>Здесь пишет</button>
        <button className="btn small primary" disabled={busy || curZ === undefined} onClick={() => { save(zDown, r1(curZ!)); notify(`Запомнил: ручка поднята при Z = ${r1(curZ!)} мм`, 'success'); }}>Здесь поднята</button>
      </div>
      <div className="grid2">
        <Num label="Ручка пишет при Z, мм" value={zDown} step={0.1} min={-50} max={50} onChange={(v) => save(v, zUp)} />
        <Num label="Ручка поднята при Z, мм" value={zUp} step={0.1} min={-50} max={50} onChange={(v) => save(zDown, v)} />
      </div>
      <button className="btn small" style={{ marginBottom: 10 }} title="Если «Поднять» опускает ручку, а «Опустить» поднимает"
        onClick={() => { save(zUp, zDown); notify(`Поменял: пишет при Z = ${zUp}, поднята при Z = ${zDown}`, 'success'); }}>
        ⇅ Поменять вверх и вниз
      </button>
      {gap < 1.5 && <div className="warn-box">Между «пишет» и «поднята» всего {r1(gap)} мм — ручка может цеплять бумагу на переездах. Лучше 3–5 мм.</div>}
      <div className="btn-row">
        <button className="btn small" disabled={busy} onClick={() => sendLines(downCmd(zDown))}><ChevronsDown />Опустить</button>
        <button className="btn small" disabled={busy} onClick={() => sendLines(downCmd(zUp))}><ChevronsUp />Поднять</button>
        <button className="btn small" disabled={busy} title="Ручка опустится, проведёт линию 20 мм вправо, поднимется и вернётся"
          onClick={() => sendLines([downCmd(zUp), downCmd(zDown), 'G91', 'G1 X20 F1500', 'G90', downCmd(zUp), 'G91', 'G0 X-20', 'G90'].join('\n'))}>
          <PenLine />Тест: линия 2 см
        </button>
      </div>
    </Section>
  );
}

/** Где стоит ручка на листе перед стартом (в сантиметрах от левого и верхнего края листа). */
export function StartPoint() {
  const prof = useProfile();
  const up = useApp((s) => s.updateProfile);
  return (
    <Section title="Где стоит ручка на листе">
      <div className="hint" style={{ marginBottom: 8 }}>
        Перед письмом поставьте ручку рукой в любое место листа и впишите, сколько <b>сантиметров</b> от неё до левого и до верхнего края листа.
        0 и 0 — ручка стоит в левом верхнем углу листа.
      </div>
      <div className="grid2">
        <Num label="От левого края, см" value={r1(prof.offsetX / 10)} step={0.5} min={0} max={30} onChange={(v) => up({ offsetX: v * 10 })} />
        <Num label="От верхнего края, см" value={r1(prof.offsetY / 10)} step={0.5} min={0} max={40} onChange={(v) => up({ offsetY: v * 10 })} />
      </div>
      <div className="hint">Если часть текста окажется левее или выше ручки, «Печать» подсветит её красным и не начнёт письмо.</div>
    </Section>
  );
}
