import { Download, Eye, EyeOff, FileUp, Lock, Plus, Trash2, Unlock } from 'lucide-react';
import type { Pt } from '../../core/geometry';
import { LINE_TYPES, cadToPaths, defaultCad, type CadDoc, type Entity, type LineType } from '../../core/cad/model';
import { annotate, dimValue, formatValue } from '../../core/cad/annotate';
import { exportDxf, parseDxf } from '../../core/cad/dxf';
import { move, newId, scaleEnt } from '../../core/cad/ops';
import { fromUser, toUser } from '../../core/cad/input';
import { COLOR_NAMES, PEN_COLORS, toSvgD } from '../../job';
import { uid, useApp, useProfile } from '../../store';
import { Check, Num, Section, Sel, downloadText, pickFile, safeName } from '../../ui/controls';
import { svgToPaths } from '../ArtPanel';
import { TOOLS, cancelTool, startTool, useCadUi } from './engine';

const GROUPS: [string, 'draw' | 'dim' | 'edit'][] = [['Рисование', 'draw'], ['Размеры (ГОСТ 2.307)', 'dim'], ['Правка', 'edit']];
const SCALES: [string, number][] = [['1:1', 1], ['1:2', 0.5], ['1:2,5', 0.4], ['1:4', 0.25], ['1:5', 0.2], ['1:10', 0.1], ['1:20', 0.05], ['2:1', 2], ['2,5:1', 2.5], ['4:1', 4], ['5:1', 5], ['10:1', 10]];
const TEXT_H = [2.5, 3.5, 5, 7, 10, 14];

function setCad(fn: (c: CadDoc) => CadDoc, merge = false) {
  useApp.getState().setDoc((d) => ({ ...d, cad: fn(d.cad) }), { merge });
}

export function CadLeft() {
  const cad = useApp((s) => s.doc.cad);
  const ui = useCadUi();
  const sn = ui.snaps;
  const setSnap = (p: Partial<typeof sn>) => useCadUi.setState({ snaps: { ...sn, ...p } });
  return (
    <div className="left-pane" style={{ overflowY: 'auto' }}>
      <div className="panel-head"><h2>Чертёж</h2>{ui.tool && <button className="btn small" onClick={cancelTool}>Отмена (Esc)</button>}</div>
      {GROUPS.map(([title, g]) => (
        <Section key={g} title={title}>
          <div className="tool-grid">
            {TOOLS.filter((t) => t.group === g).map((t) => (
              <button key={t.id} className={'tool-btn' + (ui.tool?.id === t.id ? ' on' : '')} onClick={() => startTool(t.id)} title={`${t.name} — команда ${t.alias[0]}`}>
                <span>{t.name}</span><kbd>{t.alias[0]}</kbd>
              </button>
            ))}
          </div>
        </Section>
      ))}
      <Section title="Новые объекты">
        <Sel<LineType> label="Тип линии (ГОСТ 2.303)" value={ui.lt} onChange={(v) => useCadUi.setState({ lt: v })} options={Object.entries(LINE_TYPES).map(([k, v]) => [k as LineType, v.name])} />
        <div className="grid2">
          <Sel label="Высота текста, мм" value={String(ui.textH)} onChange={(v) => useCadUi.setState({ textH: Number(v) })} options={TEXT_H.map((h) => [String(h), String(h).replace('.', ',')])} />
          <Num label="Штриховка: шаг, мм" value={ui.hatchStep} min={0.5} max={20} step={0.5} onChange={(v) => useCadUi.setState({ hatchStep: v })} />
          <Num label="Штриховка: угол, °" value={ui.hatchAngle} min={-90} max={180} step={15} onChange={(v) => useCadUi.setState({ hatchAngle: v })} />
          <Num label="Сетка, мм (0 — нет)" value={sn.grid} min={0} max={50} step={1} onChange={(v) => setSnap({ grid: v })} />
        </div>
      </Section>
      <Section title="Привязки">
        <div className="grid2">
          <Check label="Конечная точка" value={sn.end} onChange={(v) => setSnap({ end: v })} />
          <Check label="Середина" value={sn.mid} onChange={(v) => setSnap({ mid: v })} />
          <Check label="Центр" value={sn.center} onChange={(v) => setSnap({ center: v })} />
          <Check label="Квадрант" value={sn.quad} onChange={(v) => setSnap({ quad: v })} />
          <Check label="Пересечение" value={sn.int} onChange={(v) => setSnap({ int: v })} />
          <Check label="Нормаль" value={sn.perp} onChange={(v) => setSnap({ perp: v })} />
          <Check label="Ближайшая" value={sn.near} onChange={(v) => setSnap({ near: v })} />
        </div>
        <div className="hint">F3 — привязки вкл/выкл, F8 или Shift — орто. Правая кнопка мыши = Enter.</div>
      </Section>
      <Section title="Слои" right={<button className="btn small ghost" onClick={() => setCad((c) => ({ ...c, layers: [...c.layers, { id: 'L' + uid(), name: 'Слой ' + (c.layers.length + 1), color: '', visible: true, locked: false }] }))}><Plus />Слой</button>}>
        <div className="list">
          {cad.layers.map((l) => (
            <div key={l.id} className={'layer-row' + (cad.currentLayer === l.id ? ' on' : '')}>
              <input type="radio" checked={cad.currentLayer === l.id} onChange={() => setCad((c) => ({ ...c, currentLayer: l.id }))} title="Текущий слой" aria-label={`Сделать текущим: ${l.name}`} />
              <input type="text" value={l.name} onChange={(e) => { const v = e.target.value; setCad((c) => ({ ...c, layers: c.layers.map((x) => (x.id === l.id ? { ...x, name: v } : x)) }), true); }} aria-label="Название слоя" />
              <select value={l.color} onChange={(e) => { const v = e.target.value; setCad((c) => ({ ...c, layers: c.layers.map((x) => (x.id === l.id ? { ...x, color: v } : x)) })); }} title="Цвет = ручка" style={{ width: 92 }}>
                {PEN_COLORS.map((c) => <option key={c} value={c}>{COLOR_NAMES[c] ?? c}</option>)}
              </select>
              <button className="btn ghost icon small" onClick={() => setCad((c) => ({ ...c, layers: c.layers.map((x) => (x.id === l.id ? { ...x, visible: !x.visible } : x)) }))} title={l.visible ? 'Скрыть (не печатается)' : 'Показать'} aria-label="Видимость">{l.visible ? <Eye /> : <EyeOff />}</button>
              <button className="btn ghost icon small" onClick={() => setCad((c) => ({ ...c, layers: c.layers.map((x) => (x.id === l.id ? { ...x, locked: !x.locked } : x)) }))} title={l.locked ? 'Разблокировать' : 'Заблокировать (нельзя выбрать)'} aria-label="Блокировка">{l.locked ? <Lock /> : <Unlock />}</button>
              <button className="btn ghost icon small" disabled={cad.layers.length < 2 || cad.entities.some((e) => e.layer === l.id)} title="Удалить пустой слой" aria-label="Удалить слой"
                onClick={() => setCad((c) => { const layers = c.layers.filter((x) => x.id !== l.id); return { ...c, layers, currentLayer: c.currentLayer === l.id ? layers[0].id : c.currentLayer }; })}><Trash2 /></button>
            </div>
          ))}
        </div>
      </Section>
    </div>
  );
}

// ── Правая панель ─────────────────────────────────────────────────────

export function CadRight() {
  const doc = useApp((s) => s.doc);
  const notify = useApp((s) => s.notify);
  const prof = useProfile();
  const cad = doc.cad;
  const H = doc.sheet.h;
  const selIds = useCadUi((u) => u.sel);
  const sel = cad.entities.filter((e) => selIds.includes(e.id));
  const one = sel.length === 1 ? sel[0] : null;

  const upd = (id: string, fn: (e: Entity) => Entity) => setCad((c) => ({ ...c, entities: c.entities.map((e) => (e.id === id ? fn(e) : e)) }), true);
  const setAll = (p: Partial<Entity>) => setCad((c) => ({ ...c, entities: c.entities.map((e) => (selIds.includes(e.id) ? ({ ...e, ...p } as Entity) : e)) }));

  const importDxf = async () => {
    const f = await pickFile('.dxf');
    if (!f) return;
    try {
      const imp = parseDxf(await f.text(), cad.currentLayer);
      if (!imp.entities.length || !imp.bbox) throw new Error('в файле нет поддерживаемых объектов');
      const bb = imp.bbox;
      const w = bb.maxX - bb.minX, h = bb.maxY - bb.minY;
      const availW = Math.min(doc.sheet.w, prof.workW) - 45, availH = Math.min(doc.sheet.h, prof.workH) - 80;
      let k = 1;
      if (w > availW || h > availH) {
        const need = Math.min(availW / w, availH / h);
        k = SCALES.map(([, v]) => v).filter((v) => v <= need).sort((a, b) => b - a)[0] ?? need;
      }
      const placed = imp.entities.map((e) => scaleEnt(move(e, [-bb.minX, -bb.minY]), [0, 0], k)).map((e) => move(e, [25, 20]));
      setCad((c) => ({ ...c, entities: [...c.entities, ...placed], scale: c.entities.length ? c.scale : k }));
      const sk = Object.entries(imp.skipped).map(([t, n]) => `${t}×${n}`).join(', ');
      notify(`DXF: ${placed.length} объектов${k !== 1 ? `, уменьшено в масштабе ${SCALES.find(([, v]) => v === k)?.[0] ?? k.toFixed(2)}` : ''}${sk ? `. Пропущено: ${sk}` : ''}`, 'success');
    } catch (e) {
      notify('Не удалось открыть DXF: ' + (e as Error).message, 'error');
    }
  };
  const importSvg = async () => {
    const f = await pickFile('.svg,image/svg+xml');
    if (!f) return;
    try {
      const paths = svgToPaths(await f.text());
      if (!paths.length) throw new Error('нет линий');
      const ents: Entity[] = paths.map((p) => ({ id: newId(), layer: cad.currentLayer, lt: 'main', t: 'pline', pts: p.points.map(([x, y]) => [x + 25, y + 20] as Pt), closed: false }));
      setCad((c) => ({ ...c, entities: [...c.entities, ...ents] }));
      notify(`SVG: ${ents.length} линий`, 'success');
    } catch (e) { notify('Не удалось открыть SVG: ' + (e as Error).message, 'error'); }
  };
  const svgText = () => {
    const paths = cadToPaths(cad, annotate);
    const groups = new Map<string, typeof paths>();
    for (const p of paths) { const c = p.color ?? ''; if (!groups.has(c)) groups.set(c, []); groups.get(c)!.push(p); }
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${doc.sheet.w}mm" height="${H}mm" viewBox="0 0 ${doc.sheet.w} ${H}">` +
      `<rect width="100%" height="100%" fill="#fff"/>` +
      [...groups].map(([c, ps]) => `<path d="${toSvgD(ps)}" fill="none" stroke="${c || '#000'}" stroke-width="0.35" stroke-linecap="round" stroke-linejoin="round"/>`).join('') + '</svg>';
  };
  const exportPng = async () => {
    const img = new Image();
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgText());
    await img.decode();
    const s = 8; // ≈200 dpi
    const cv = document.createElement('canvas'); cv.width = doc.sheet.w * s; cv.height = H * s;
    cv.getContext('2d')!.drawImage(img, 0, 0, cv.width, cv.height);
    const a = document.createElement('a'); a.href = cv.toDataURL('image/png'); a.download = safeName(doc.name) + '.png'; a.click();
  };
  const printPdf = () => {
    const w = window.open('', '_blank');
    if (!w) return notify('Браузер заблокировал окно печати', 'error');
    w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${safeName(doc.name)}</title><style>@page{size:${doc.sheet.w}mm ${H}mm;margin:0}html,body{margin:0}svg{display:block}</style></head><body>${svgText()}<script>onload=()=>setTimeout(()=>print(),300)<\/script></body></html>`);
    w.document.close();
  };

  const scaleLabel = SCALES.find(([, v]) => Math.abs(v - cad.scale) < 1e-9)?.[0] ?? `${cad.scale}`;

  return (
    <div>
      <div className="panel-head"><h2>Свойства</h2>{sel.length > 0 && <span className="badge">выбрано: {sel.length}</span>}</div>
      {one ? <EntityProps e={one} H={H} cad={cad} upd={upd} /> : sel.length > 1 ? (
        <Section title="Несколько объектов">
          <Sel label="Слой" value={sel[0].layer} onChange={(v) => setAll({ layer: v })} options={cad.layers.map((l) => [l.id, l.name])} />
          <Sel<LineType> label="Тип линии" value={sel[0].lt} onChange={(v) => setAll({ lt: v })} options={Object.entries(LINE_TYPES).map(([k, v]) => [k as LineType, v.name])} />
        </Section>
      ) : (
        <Section>
          <div className="hint">Выберите объект щелчком или рамкой: слева направо — только целиком попавшие, справа налево — все задетые. Delete — удалить, Ctrl+Z — отменить.</div>
        </Section>
      )}
      {sel.length > 0 && (
        <Section>
          <button className="btn small" onClick={() => { const ids = new Set(selIds); setCad((c) => ({ ...c, entities: c.entities.filter((e) => !ids.has(e.id)) })); useCadUi.setState({ sel: [] }); }}><Trash2 />Удалить</button>
        </Section>
      )}
      <Section title="Чертёж">
        <div className="grid2">
          <Sel label="Масштаб чертежа" value={scaleLabel} onChange={(v) => setCad((c) => ({ ...c, scale: SCALES.find(([l]) => l === v)?.[1] ?? 1 }))} options={SCALES.map(([l]) => [l, l])} />
          <Sel label="Размерные числа, мм" value={String(cad.dimText)} onChange={(v) => setCad((c) => ({ ...c, dimText: Number(v) }))} options={TEXT_H.map((h) => [String(h), String(h).replace('.', ',')])} />
          <Num label="На листе №" value={cad.page + 1} min={1} max={99} onChange={(v) => setCad((c) => ({ ...c, page: v - 1 }))} />
        </div>
        <Check label="Основная линия — двойным проходом (толще)" value={cad.boldMain} onChange={(v) => setCad((c) => ({ ...c, boldMain: v }))} />
        <div className="hint">Масштаб влияет на размерные числа: при 1:2 отрезок 50 мм на листе подписывается «100». Рамку и штамп ГОСТ 2.104 добавьте в «Рисунках».</div>
      </Section>
      <Section title="Файлы">
        <div className="btn-row" style={{ marginBottom: 8 }}>
          <button className="btn small" onClick={importDxf} title="AutoCAD, КОМПАС-3D (сохранить как DXF), LibreCAD"><FileUp />DXF</button>
          <button className="btn small" onClick={importSvg} title="Inkscape, Figma"><FileUp />SVG</button>
        </div>
        <div className="btn-row">
          <button className="btn small" disabled={!cad.entities.length} onClick={() => downloadText(safeName(doc.name) + '.dxf', exportDxf(cad, H), 'application/dxf')}><Download />DXF</button>
          <button className="btn small" disabled={!cad.entities.length} onClick={() => downloadText(safeName(doc.name) + '.svg', svgText(), 'image/svg+xml')}><Download />SVG</button>
          <button className="btn small" disabled={!cad.entities.length} onClick={exportPng}><Download />PNG</button>
          <button className="btn small" disabled={!cad.entities.length} onClick={printPdf} title="Откроется печать — выберите «Сохранить как PDF»"><Download />PDF</button>
        </div>
        <button className="btn small ghost" style={{ marginTop: 10 }} disabled={!cad.entities.length} onClick={() => {
          if (!confirm('Удалить весь чертёж? Отменить можно через Ctrl+Z.')) return;
          setCad((c) => ({ ...defaultCad(), layers: c.layers, currentLayer: c.currentLayer, scale: c.scale, page: c.page }));
          useCadUi.setState({ sel: [] });
        }}><Trash2 />Очистить чертёж</button>
      </Section>
    </div>
  );
}

const TYPE_RU: Record<Entity['t'], string> = { line: 'Отрезок', pline: 'Полилиния', circle: 'Окружность', arc: 'Дуга', ellipse: 'Эллипс', spline: 'Сплайн', point: 'Точка', text: 'Текст', dim: 'Размер', hatch: 'Штриховка' };
const r2 = (n: number) => Math.round(n * 100) / 100;
const deg = (a: number) => r2((((-a * 180) / Math.PI) % 360 + 360) % 360);

function PtFields({ label, p, H, onChange }: { label: string; p: Pt; H: number; onChange(p: Pt): void }) {
  const u = toUser(p, H);
  return (
    <div className="grid2">
      <Num label={`${label} X`} value={r2(u[0])} step={0.5} onChange={(x) => onChange(fromUser([x, u[1]], H))} />
      <Num label={`${label} Y`} value={r2(u[1])} step={0.5} onChange={(y) => onChange(fromUser([u[0], y], H))} />
    </div>
  );
}

function EntityProps({ e, H, cad, upd }: { e: Entity; H: number; cad: CadDoc; upd(id: string, fn: (e: Entity) => Entity): void }) {
  const set = (p: Partial<Entity>) => upd(e.id, (x) => ({ ...x, ...p } as Entity));
  return (
    <Section title={TYPE_RU[e.t]}>
      <div className="grid2">
        <Sel label="Слой" value={e.layer} onChange={(v) => set({ layer: v })} options={cad.layers.map((l) => [l.id, l.name])} />
        {e.t !== 'dim' && e.t !== 'text' && e.t !== 'hatch' && <Sel<LineType> label="Тип линии" value={e.lt} onChange={(v) => set({ lt: v })} options={Object.entries(LINE_TYPES).map(([k, v]) => [k as LineType, v.name])} />}
      </div>
      {e.t === 'line' && <>
        <PtFields label="Начало" p={e.a} H={H} onChange={(a) => set({ a })} />
        <PtFields label="Конец" p={e.b} H={H} onChange={(b) => set({ b })} />
        <div className="hint">Длина: <b>{formatValue(Math.hypot(e.b[0] - e.a[0], e.b[1] - e.a[1]))}</b> мм · угол: <b>{formatValue(deg(Math.atan2(e.b[1] - e.a[1], e.b[0] - e.a[0])))}°</b></div>
      </>}
      {(e.t === 'circle' || e.t === 'arc') && <>
        <PtFields label="Центр" p={e.c} H={H} onChange={(c) => set({ c })} />
        <div className="grid2">
          <Num label="Радиус, мм" value={r2(e.r)} min={0.01} step={0.5} onChange={(r) => set({ r })} />
          <Num label="Диаметр, мм" value={r2(e.r * 2)} min={0.02} step={1} onChange={(d) => set({ r: d / 2 })} />
        </div>
        {e.t === 'arc' && <div className="hint">От {deg(e.a1)}° до {deg(e.a0)}° (против часовой)</div>}
      </>}
      {e.t === 'ellipse' && <>
        <PtFields label="Центр" p={e.c} H={H} onChange={(c) => set({ c })} />
        <div className="grid2">
          <Num label="Полуось 1, мм" value={r2(e.rx)} min={0.01} step={0.5} onChange={(rx) => set({ rx })} />
          <Num label="Полуось 2, мм" value={r2(e.ry)} min={0.01} step={0.5} onChange={(ry) => set({ ry })} />
        </div>
      </>}
      {(e.t === 'pline' || e.t === 'spline') && <>
        <div className="hint" style={{ marginBottom: 6 }}>Вершин: {e.pts.length}</div>
        <Check label="Замкнутая" value={e.closed} onChange={(closed) => set({ closed })} />
      </>}
      {e.t === 'point' && <PtFields label="" p={e.p} H={H} onChange={(p) => set({ p })} />}
      {e.t === 'text' && <>
        <label className="field"><span>Текст</span><input type="text" value={e.text} onChange={(x) => set({ text: x.target.value })} /></label>
        <PtFields label="Начало" p={e.p} H={H} onChange={(p) => set({ p })} />
        <div className="grid2">
          <Sel label="Высота, мм" value={String(e.h)} onChange={(v) => set({ h: Number(v) })} options={[...new Set([...TEXT_H, e.h])].map((h) => [String(h), String(h).replace('.', ',')])} />
          <Num label="Поворот, °" value={deg(e.rot)} step={15} onChange={(d) => set({ rot: (-d * Math.PI) / 180 })} />
        </div>
      </>}
      {e.t === 'dim' && <>
        <div className="hint" style={{ marginBottom: 6 }}>Измерено: <b>{formatValue(dimValue(e, cad))}{e.kind === 'angular' ? '°' : ' мм'}</b> (с учётом масштаба чертежа)</div>
        <label className="field"><span>Свой текст (пусто — автоматически)</span><input type="text" value={e.text ?? ''} placeholder="например ⌀20 H7" onChange={(x) => set({ text: x.target.value || undefined })} /></label>
        <div className="btn-row">{['⌀', '°', '±', 'R'].map((c) => <button key={c} className="btn small" onClick={() => set({ text: (e.text ?? '') + c })}>{c}</button>)}</div>
      </>}
      {e.t === 'hatch' && <div className="grid2">
        <Num label="Угол, °" value={e.angle} step={15} onChange={(angle) => set({ angle })} />
        <Num label="Шаг, мм" value={e.step} min={0.5} max={20} step={0.5} onChange={(step) => set({ step })} />
      </div>}
    </Section>
  );
}
