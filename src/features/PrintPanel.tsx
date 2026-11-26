import { useEffect } from 'react';
import { Download, Pause, Play, RotateCcw, Send, Square } from 'lucide-react';
import { formatDuration } from '../core/gcode';
import type { Prepared } from '../printing';
import { useApp } from '../store';
import { Check, Num, Section, Sel, Slider, downloadText, safeName } from '../ui/controls';
import { t } from '../i18n';
import { canResume, resumeAfterBreak, sendGcodeFile, startWriting, traceBounds, useAnim } from '../actions';
import { jobBounds } from '../core/gcode';
import { pickFile } from '../ui/controls';
import { SpeedBox } from './SpeedPanel';
import { useMachine } from '../machine';
import { LOCKED } from '../edition';

const fmtCm = (v: number) => (Math.round(v * 10) / 10).toLocaleString('ru-RU');

export function PrintRight({ prepared, pageCount }: { prepared: Prepared; pageCount: number }) {
  const optimize = useApp((s) => s.optimize);
  const setState = useApp((s) => s.setState);
  const printPage = useApp((s) => s.printPage);
  const name = useApp((s) => s.doc.name);
  const anim = useAnim();
  const sheetH = useApp((s) => s.doc.sheet.h);
  const ctl = useMachine();
  const st = prepared.stats, r = prepared.report;
  const saving = r.travelBefore > 0 ? Math.max(0, 1 - r.travelAfter / r.travelBefore) : 0;

  // Анимация
  useEffect(() => {
    if (!anim.playing) return;
    let raf = 0, last = performance.now();
    const step = (now: number) => {
      const dt = (now - last) / 1000; last = now;
      const total = Math.max(1, st.seconds);
      const nt = Math.min(1, useAnim.getState().t + (dt * useAnim.getState().speed) / total);
      useAnim.setState({ t: nt, playing: nt < 1 });
      if (nt < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [anim.playing, st.seconds]);
  useEffect(() => () => useAnim.setState({ on: false, playing: false }), []);

  const pr = ctl.progress;
  const bounds = jobBounds(prepared.sections.flatMap((x) => x.paths));
  return (
    <div>
      <div className="panel-head"><h2>{t('Печать')}</h2></div>
      <Section>
        <Sel label="Что писать" value={String(printPage)} onChange={(v) => setState({ printPage: Number(v) })}
          options={[['-1', `${t('Все листы')} (${pageCount})`], ...Array.from({ length: pageCount }, (_, i) => [String(i), `${t('Лист')} ${i + 1}`] as [string, string])]} />
        {prepared.badCount > 0 && <div className="err-box"><b>{t('Печать запрещена: часть рисунка вне рабочего поля')}.</b> {prepared.badCount} линий выделены красным. Синяя пунктирная рамка — рабочее поле машины (меняется в «Настройках»).</div>}
        <div className="stat-grid" style={{ marginBottom: 12 }}>
          <div className="stat"><div className="v">{formatDuration(st.seconds)}</div><div className="l">{t('Время письма')}</div></div>
          <div className="stat"><div className="v">{(st.drawLength / 1000).toFixed(2)} м</div><div className="l">{t('Длина письма')}</div></div>
          <div className="stat"><div className="v">{(st.travelLength / 1000).toFixed(2)} м</div><div className="l">{t('Холостой путь')}</div></div>
          <div className="stat"><div className="v">{st.penLifts}</div><div className="l">{t('Подъёмов ручки')}</div></div>
        </div>
        {!LOCKED && <SpeedBox stats={st} />}
        <button className="btn primary big" style={{ width: '100%' }} onClick={() => startWriting(prepared)} disabled={!ctl.connected || !!pr?.running || prepared.badCount > 0}
          title={ctl.connected ? 'Ctrl+P' : 'Сначала подключите машину или симулятор'}><Send />{t('Писать')}</button>
        <button className="btn" style={{ width: '100%', marginTop: 8 }} disabled={!ctl.connected || !!pr?.running}
          title="Ручка поднята: машина медленно объедет рамку будущего письма и вернётся. Бумага не пачкается."
          onClick={() => traceBounds(prepared)}><Square />Обвести границы{bounds ? ` (${Math.round(bounds.maxX - bounds.minX)}×${Math.round(bounds.maxY - bounds.minY)} мм)` : ''}</button>
        <div style={{ marginTop: 10 }}>
          <Check label="Показать стол GUANGKU под листом" value={anim.bed} onChange={(v) => useAnim.setState({ bed: v })}
            title="Фото стола с сеткой в сантиметрах — видно, на какие клетки ляжет письмо" />
          {anim.bed && (
            <>
              <div className="grid2">
                <Num label="Лист: левый край на X, см" value={anim.bedX} step={0.5} min={-5} max={20} onChange={(v) => useAnim.setState({ bedX: v })}
                  title="Где на шкале стола (0…18 внизу) лежит левый край листа" />
                <Num label="Нижний край на Y, см" value={anim.bedY} step={0.5} min={-10} max={28} onChange={(v) => useAnim.setState({ bedY: v })}
                  title="Где на шкале стола (0…28 слева) лежит нижний край листа" />
              </div>
              {bounds && (
                <div className="hint">
                  Рамка письма на столе: X {fmtCm(anim.bedX + bounds.minX / 10)}–{fmtCm(anim.bedX + bounds.maxX / 10)} см,
                  Y {fmtCm(anim.bedY + (sheetH - bounds.maxY) / 10)}–{fmtCm(anim.bedY + (sheetH - bounds.minY) / 10)} см.
                  Нажмите «Обвести границы» и сверьте с сеткой на столе.
                </div>
              )}
            </>
          )}
        </div>
        {!ctl.connected && <div className="hint" style={{ marginTop: 6 }}>Машина не подключена — можно посмотреть анимацию или скачать G-код для другой программы.</div>}
        <button className="btn" style={{ width: '100%', marginTop: 8 }} disabled={!ctl.connected || !!pr?.running}
          title="Готовый файл .nc / .gcode — отправится на машину как есть"
          onClick={async () => { const f = await pickFile('.nc,.gcode,.ngc,.txt,.tap'); if (f) sendGcodeFile(f); }}><Send />Отправить готовый G-код (.nc)</button>
        <button className="btn" style={{ width: '100%', marginTop: 8 }} onClick={() => downloadText(safeName(name) + '.gcode', prepared.lines.join('\n') + '\n')}><Download />{t('Скачать G-код')} ({prepared.lines.length} строк)</button>
        {canResume() && (
          <div className="warn-box" style={{ marginTop: 10 }}>
            Письмо прервалось на строке {ctl.lastAckedIndex + 1}. Не двигайте ручку и лист, переподключите машину и нажмите:
            <button className="btn small accent" style={{ marginTop: 6 }} onClick={resumeAfterBreak}><RotateCcw />Продолжить с места остановки</button>
          </div>
        )}
        {pr && (
          <div className="hint" style={{ marginTop: 10 }}>
            {pr.running ? (pr.draining ? 'Машина дописывает последние строки…' : `Отправлено ${pr.sent} из ${pr.total} строк`) : pr.error ? <span style={{ color: 'var(--danger)' }}>{pr.error}</span> : pr.finishedAt ? `Готово за ${formatDuration((pr.finishedAt - pr.startedAt) / 1000)}` : ''}
          </div>
        )}
      </Section>

      <Section title={t('Анимация')}>
        <div className="btn-row" style={{ marginBottom: 10 }}>
          <button className="btn" onClick={() => useAnim.setState({ on: true, playing: !anim.playing, t: anim.t >= 1 ? 0 : anim.t })}>{anim.playing ? <Pause /> : <Play />}{anim.playing ? t('Пауза') : 'Показать, как пишет'}</button>
          {anim.on && <button className="btn" onClick={() => useAnim.setState({ on: false, playing: false, t: 0 })}><Square />Скрыть</button>}
        </div>
        <Slider label="Ускорение" value={anim.speed} min={1} max={50} onChange={(v) => useAnim.setState({ speed: v })} fmt={(v) => v + '×'} />
        <Slider label="Положение" value={Math.round(anim.t * 1000)} min={0} max={1000} onChange={(v) => useAnim.setState({ on: true, t: v / 1000 })} fmt={() => formatDuration(anim.t * st.seconds)} />
        <div className="hint">Синие линии — письмо, серые пунктирные — холостые переезды (включите ниже).</div>
      </Section>

      <Section title={t('Оптимизация пути')}>
        <Check label="Менять порядок линий (меньше переездов)" value={optimize.reorder} onChange={(v) => setState({ optimize: { ...optimize, reorder: v } })} />
        <Check label="Улучшение 2-opt" value={optimize.twoOpt} onChange={(v) => setState({ optimize: { ...optimize, twoOpt: v } })} />
        <Check label="Склеивать соседние линии" value={optimize.merge} onChange={(v) => setState({ optimize: { ...optimize, merge: v } })} />
        <Check label={t('Показать переезды')} value={anim.travel} onChange={(v) => useAnim.setState({ travel: v })} />
        <div className="ok-box">
          Холостой путь: было <b>{(r.travelBefore / 1000).toFixed(2)} м</b> → стало <b>{(r.travelAfter / 1000).toFixed(2)} м</b>
          {saving > 0.005 && <>, экономия <b>{Math.round(saving * 100)}%</b></>}.
          <div className="hint">Текст пишется слева направо, строка за строкой — меняется только порядок штрихов внутри слова.</div>
        </div>
      </Section>
    </div>
  );
}
