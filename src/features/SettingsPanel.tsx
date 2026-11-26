import { Copy, Download, RotateCcw, Trash2, Upload, Wand2 } from 'lucide-react';
import { PEN_PRESETS, guangkuProfile, type MachineProfile, type PenMode } from '../core/gcode';
import { resetAll, restoreBackup, snapshot, uid, useApp, useProfile } from '../store';
import { Check, Num, Section, Sel, Txt, downloadText, pickFile } from '../ui/controls';
import { t, type Lang } from '../i18n';
import { LOCKED } from '../edition';
import { AUTHOR, COPYRIGHT, REPO_URL } from '../author';

export function SettingsRight() {
  const s = useApp();
  const prof = useProfile();
  const up = s.updateProfile;
  const setPen = (m: PenMode) => {
    if (m === 'custom') return up({ penMode: m });
    const p = PEN_PRESETS[m];
    up({ penMode: m, penUp: p.up, penDown: p.down, penDownDelay: p.downDelay, penUpDelay: p.upDelay });
  };

  return (
    <div>
      <div className="panel-head"><h2>{t('Настройки')}</h2></div>
      <Section title="Интерфейс">
        <div className="grid2">
          <Sel<Lang> label={t('Язык')} value={s.lang} onChange={(v) => s.setState({ lang: v })} options={[['ru', 'Русский'], ['ky', 'Кыргызча'], ['en', 'English']]} />
          <Sel label={t('Тема')} value={s.theme} onChange={(v) => s.setState({ theme: v })} options={[['system', t('Как в системе')], ['light', t('Светлая')], ['dark', t('Тёмная')]]} />
        </div>
        <button className="btn small" onClick={() => s.setState({ tourDone: false })}>Показать подсказки для новичка</button>
      </Section>

      <Section title={t('Профиль машины')}>
        <div style={{ display: 'flex', gap: 6, alignItems: 'flex-end' }}>
          <div style={{ flex: 1 }}><Sel label="Машина" value={s.activeProfileId} onChange={(v) => s.setState({ activeProfileId: v })} options={s.profiles.map((p) => [p.id, p.name])} /></div>
          <button className="btn icon" style={{ marginBottom: 10 }} title="Копия профиля" aria-label="Копия профиля" onClick={() => {
            const id = uid();
            s.setState({ profiles: [...s.profiles, { ...prof, id, name: prof.name + ' (копия)' }], activeProfileId: id });
          }}><Copy /></button>
          <button className="btn icon" style={{ marginBottom: 10 }} title="Удалить профиль" aria-label="Удалить профиль" disabled={s.profiles.length < 2} onClick={() => {
            if (!confirm(`Удалить профиль «${prof.name}»?`)) return;
            const rest = s.profiles.filter((p) => p.id !== prof.id);
            s.setState({ profiles: rest, activeProfileId: rest[0].id });
          }}><Trash2 /></button>
        </div>
        <Txt label="Название" value={prof.name} onChange={(v) => up({ name: v })} />
        <div className="btn-row">
          <button className="btn small primary" onClick={() => s.setState({ wizardOpen: true })}><Wand2 />{t('Мастер настройки')}</button>
          <button className="btn small" title="Ось Z наоборот, поле 210×300, оси без поворота" onClick={() => {
            if (!confirm('Применить рабочие настройки GUANGKU? Ручка, оси и поле будут заменены.')) return;
            up(guangkuProfile()); s.notify('Применены настройки GUANGKU: Z3 — пишет, Z−1,5 — поднята', 'success');
          }}>Настройки GUANGKU</button>
        </div>
      </Section>

      <Section title="Подъём ручки">
        <Sel<PenMode> label="Как поднимается ручка" value={prof.penMode} onChange={setPen}
          options={[['zinv', 'GUANGKU: ось Z наоборот (Z3 пишет, Z−1,5 поднята)'], ['z', 'Мотор по оси Z (G0 Z…)'], ['servo', 'Сервопривод (M3 S…)'], ['solenoid', 'Соленоид (M3 / M5)'], ['custom', 'Свои команды']]} />
        <div className="grid2">
          <Txt label="Команда «вверх»" value={prof.penUp} mono onChange={(v) => up({ penUp: v, penMode: 'custom' })} />
          <Txt label="Команда «вниз»" value={prof.penDown} mono onChange={(v) => up({ penDown: v, penMode: 'custom' })} />
          <Num label="Пауза после опускания, с" value={prof.penDownDelay} min={0} max={3} step={0.05} onChange={(v) => up({ penDownDelay: v })} title="Чтобы чернила успели лечь" />
          <Num label="Пауза после подъёма, с" value={prof.penUpDelay} min={0} max={3} step={0.05} onChange={(v) => up({ penUpDelay: v })} />
        </div>
      </Section>

      <Section title={LOCKED ? 'Отправка' : t('Скорость')}>
        <div className="grid2">
          {!LOCKED && <><Num label="Письмо, мм/мин" value={prof.drawSpeed} min={100} max={20000} step={100} onChange={(v) => up({ drawSpeed: v })} />
          <Num label="Переезды, мм/мин" value={prof.travelSpeed} min={100} max={30000} step={100} onChange={(v) => up({ travelSpeed: v })} /></>}
          <Num label="Ускорение, мм/с²" value={prof.accel} min={10} max={10000} step={50} onChange={(v) => up({ accel: v })} title="Только для расчёта времени; настоящее ускорение — $120/$121" />
          <Sel label="Отправка" value={prof.streaming} onChange={(v) => up({ streaming: v as MachineProfile['streaming'] })} options={[['count', 'Быстрая (буфер 128 байт)'], ['simple', 'Простая (строка → ok)']]} />
        </div>
        {!LOCKED && <Check label="Переезды командой G0 (максимальная скорость)" value={prof.useG0ForTravel} onChange={(v) => up({ useG0ForTravel: v })} />}
      </Section>

      <Section title="Рабочее поле и оси">
        <div className="grid2">
          <Num label="Поле по X, мм" value={prof.workW} min={10} max={2000} onChange={(v) => up({ workW: v })} />
          <Num label="Поле по Y, мм" value={prof.workH} min={10} max={2000} onChange={(v) => up({ workH: v })} />
          <Num label="Начало: отступ X, мм" value={prof.offsetX} min={-500} max={500} step={0.5} onChange={(v) => up({ offsetX: v })} title="Где на листе стоит ручка в начальной точке" />
          <Num label="Начало: отступ Y, мм" value={prof.offsetY} min={-500} max={500} step={0.5} onChange={(v) => up({ offsetY: v })} />
          <Num label="Масштаб X" value={prof.scaleX} min={0.5} max={2} step={0.001} onChange={(v) => up({ scaleX: v })} />
          <Num label="Масштаб Y" value={prof.scaleY} min={0.5} max={2} step={0.001} onChange={(v) => up({ scaleY: v })} />
          <Num label="Отступ безопасности, мм" value={prof.safetyMargin} min={0} max={50} step={0.5} onChange={(v) => up({ safetyMargin: v })} />
          <Sel label="Начальная точка листа" value={prof.origin} onChange={(v) => up({ origin: v as MachineProfile['origin'] })} options={[['top-left', 'Левый верхний угол'], ['bottom-left', 'Левый нижний угол']]} />
        </div>
        <Check label="Развернуть ось X" value={prof.invertX} onChange={(v) => up({ invertX: v })} />
        <Check label="Развернуть ось Y (Y вниз по листу = минус)" value={prof.invertY} onChange={(v) => up({ invertY: v })} />
        <Check label="Поменять оси X и Y местами" value={prof.swapXY} onChange={(v) => up({ swapXY: v })} />
        <Num label="Напоминать об отдыхе моторов через, мин (0 — нет)" value={prof.restAfterMin} min={0} max={600} onChange={(v) => up({ restAfterMin: v })} />
        <div className="hint">По инструкции машины: перед письмом подведите кончик ручки рукой в начальную точку (на 2–4 мм выше бумаги, если ручка на оси Z). После долгой работы выключите машину на 5 минут.</div>
      </Section>

      <Section title="Данные">
        <div className="hint" style={{ marginBottom: 8 }}>Всё хранится только в этом браузере: проекты, почерки, подписи, профили.</div>
        <div className="btn-row">
          <button className="btn small" onClick={() => downloadText(`kalligraf-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(snapshot(useApp.getState())), 'application/json')}><Download />{t('Резервная копия')}</button>
          <button className="btn small" onClick={async () => {
            const f = await pickFile('.json,application/json');
            if (!f) return;
            try { restoreBackup(JSON.parse(await f.text())); s.notify('Данные восстановлены', 'success'); }
            catch (e) { s.notify('Не удалось восстановить: ' + (e as Error).message, 'error'); }
          }}><Upload />{t('Восстановить')}</button>
          <button className="btn small" onClick={() => {
            if (!confirm('Сбросить все настройки, профили и свои почерки к заводским? Сначала лучше сделать резервную копию.')) return;
            resetAll(); s.notify('Сброшено к заводским настройкам');
          }}><RotateCcw />{t('Сбросить всё')}</button>
        </div>
      </Section>
      <div className="hint" style={{ padding: '12px 16px 18px', textAlign: 'center' }}>
        Каллиграф · автор <b>{AUTHOR}</b> · <a href={REPO_URL} target="_blank" rel="noreferrer">GitHub</a><br />{COPYRIGHT}
      </div>
    </div>
  );
}
