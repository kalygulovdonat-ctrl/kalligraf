// Скорость письма: пресеты, скорость ручки по Z и подсказка, куда уходит время.
import { Gauge } from 'lucide-react';
import { formatDuration, penFeed, penTravelZ, withPenFeed, type JobStats } from '../core/gcode';
import { useApp, useProfile } from '../store';
import { Slider } from '../ui/controls';

const PRESETS: { id: string; label: string; draw: number; z: number; hint: string }[] = [
  { id: 'neat', label: 'Аккуратно', draw: 6000, z: 600, hint: 'медленно, самые ровные буквы' },
  { id: 'friend', label: 'Как у друга', draw: 8000, z: 600, hint: 'F8000, ручка F600' },
  { id: 'fast', label: 'Быстро', draw: 10000, z: 1500, hint: 'ручка ходит в 2,5 раза быстрее' },
  { id: 'max', label: 'Максимум', draw: 15000, z: 3000, hint: 'проверьте на черновике' },
];

const r1 = (v: number) => String(Math.round(v * 10) / 10).replace('.', ',');

export function SpeedBox({ stats }: { stats: JobStats }) {
  const prof = useProfile();
  const up = useApp((s) => s.updateProfile);
  const zf = penFeed(prof);
  const dz = penTravelZ(prof);
  const active = PRESETS.find((p) => p.draw === prof.drawSpeed && (zf === null || p.z === zf))?.id;
  const setZ = (f: number) => up(withPenFeed(prof, f));
  const penShare = stats.seconds > 0 ? stats.penSeconds / stats.seconds : 0;

  // уменьшить ход ручки до 2 мм: «поднята» ставим в 2 мм от «пишет» в ту же сторону
  const zDown = /Z\s*(-?\d*\.?\d+)/i.exec(prof.penDown)?.[1];
  const zUp = /Z\s*(-?\d*\.?\d+)/i.exec(prof.penUp)?.[1];
  const shrinkLift = () => {
    if (zDown === undefined || zUp === undefined) return;
    const d = parseFloat(zDown), u = parseFloat(zUp);
    const nu = Math.round((d + Math.sign(u - d) * 2) * 10) / 10;
    up({ penUp: prof.penUp.replace(/Z\s*-?\d*\.?\d+/i, `Z${nu}`) });
  };

  return (
    <div className="speed-box" style={{ marginBottom: 12 }}>
      <div className="field"><span><Gauge size={14} style={{ verticalAlign: -2 }} /> Скорость</span></div>
      <div className="btn-row" style={{ flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
        {PRESETS.map((p) => (
          <button key={p.id} className={'btn small' + (active === p.id ? ' primary' : '')} title={p.hint}
            onClick={() => up({ drawSpeed: p.draw, ...(zf !== null ? withPenFeed(prof, p.z) : {}) })}>{p.label}</button>
        ))}
      </div>
      <Slider label="Письмо, мм/мин" value={prof.drawSpeed} min={2000} max={20000} step={500} onChange={(v) => up({ drawSpeed: v })} />
      {zf !== null && (
        <Slider label="Ручка вверх/вниз, мм/мин" value={zf} min={300} max={5000} step={100} onChange={setZ}
          title="Скорость оси Z. Чем выше — тем меньше ждёт машина на каждом штрихе" />
      )}
      {zf !== null && stats.penLifts > 0 && (
        <div className={penShare > 0.4 ? 'warn-box' : 'hint'} style={{ marginTop: 4 }}>
          Ручка поднимается {stats.penLifts} раз — на это уходит <b>{formatDuration(stats.penSeconds)}</b> из {formatDuration(stats.seconds)}
          {penShare > 0.4 && <> (<b>{Math.round(penShare * 100)}%</b> времени)</>}.
          {' '}Ход ручки {r1(dz)} мм.
          {penShare > 0.4 && <> Ускорить: поднимите «Ручка вверх/вниз»{dz > 2.5 && <> или уменьшите ход ручки</>}.</>}
          {dz > 2.5 && (
            <div style={{ marginTop: 6 }}>
              <button className="btn small" onClick={shrinkLift} title="Над бумагой обычно хватает 2 мм. После этого проверьте в «Пульте», что ручка не чиркает при переездах">Ход ручки 2 мм</button>
            </div>
          )}
        </div>
      )}
      <div className="hint" style={{ marginTop: 4 }}>
        Если на высокой скорости буквы кривые или «съезжают» — машина теряет шаги, верните скорость ниже.
        Предел задаёт сама плата: $110/$111 (X/Y), $112 (Z), разгон $120–$122 — «Пульт» → «Настройки платы».
      </div>
    </div>
  );
}
