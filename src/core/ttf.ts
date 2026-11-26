// Минимальный разбор TrueType (.ttf): cmap, glyf/loca (простые и составные глифы), hmtx, метрики.
// Нужен, чтобы превращать обычные рукописные шрифты в однолинейные для ручки.
// CFF/OTF-контуры (PostScript) не поддерживаются — для них понятная ошибка.

export type Contour = [number, number][];   // замкнутый контур, единицы шрифта, ось Y вверх

export interface TtfFont {
  name: string;
  unitsPerEm: number;
  capHeight: number;
  xHeight: number;
  glyphIndex(cp: number): number;
  advance(gid: number): number;
  contours(gid: number): Contour[];
  /** Все символы, которые есть в шрифте. */
  codepoints(): number[];
}

export function parseTtf(buf: ArrayBuffer): TtfFont {
  const v = new DataView(buf);
  const u8 = new Uint8Array(buf);
  const tag = (o: number) => String.fromCharCode(u8[o], u8[o + 1], u8[o + 2], u8[o + 3]);
  const sfnt = v.getUint32(0);
  if (tag(0) === 'OTTO') throw new Error('Это OTF со «сплайнами PostScript» (CFF) — нужен шрифт .ttf (TrueType).');
  if (sfnt !== 0x00010000 && tag(0) !== 'true') throw new Error('Файл не похож на шрифт TrueType (.ttf).');
  const numTables = v.getUint16(4);
  const tables: Record<string, number> = {};
  for (let i = 0; i < numTables; i++) tables[tag(12 + i * 16)] = v.getUint32(12 + i * 16 + 8);
  for (const t of ['head', 'cmap', 'loca', 'glyf', 'hmtx', 'hhea', 'maxp'])
    if (tables[t] === undefined) throw new Error(`В шрифте нет таблицы ${t}` + (t === 'glyf' ? ' — вероятно, это OTF/CFF, нужен .ttf' : ''));

  const head = tables.head;
  const unitsPerEm = v.getUint16(head + 18);
  const locaLong = v.getInt16(head + 50) === 1;
  const numGlyphs = v.getUint16(tables.maxp + 4);
  const numHMetrics = v.getUint16(tables.hhea + 34);

  // cmap: формат 4 (BMP) и 12 (полный Unicode)
  const map = new Map<number, number>();
  const cmap = tables.cmap;
  const nSub = v.getUint16(cmap + 2);
  const subs: { pid: number; eid: number; off: number }[] = [];
  for (let i = 0; i < nSub; i++) subs.push({ pid: v.getUint16(cmap + 4 + i * 8), eid: v.getUint16(cmap + 6 + i * 8), off: cmap + v.getUint32(cmap + 8 + i * 8) });
  subs.sort((a, b) => (a.pid === 3 ? 0 : 1) - (b.pid === 3 ? 0 : 1));
  for (const s of subs) {
    const fmt = v.getUint16(s.off);
    if (fmt === 4) {
      const segX2 = v.getUint16(s.off + 6), seg = segX2 / 2;
      const ends = s.off + 14, starts = ends + segX2 + 2, deltas = starts + segX2, ranges = deltas + segX2;
      for (let i = 0; i < seg; i++) {
        const end = v.getUint16(ends + i * 2), start = v.getUint16(starts + i * 2);
        const delta = v.getInt16(deltas + i * 2), ro = v.getUint16(ranges + i * 2);
        for (let c = start; c <= end && c !== 0xffff; c++) {
          let g: number;
          if (!ro) g = (c + delta) & 0xffff;
          else {
            const addr = ranges + i * 2 + ro + (c - start) * 2;
            g = v.getUint16(addr);
            if (g) g = (g + delta) & 0xffff;
          }
          if (g && !map.has(c)) map.set(c, g);
        }
      }
    } else if (fmt === 12) {
      const n = v.getUint32(s.off + 12);
      for (let i = 0; i < n; i++) {
        const o = s.off + 16 + i * 12;
        const a = v.getUint32(o), b = v.getUint32(o + 4), g0 = v.getUint32(o + 8);
        for (let c = a; c <= b && c - a < 70000; c++) if (!map.has(c)) map.set(c, g0 + (c - a));
      }
    }
  }

  const loca = (i: number) => (locaLong ? v.getUint32(tables.loca + i * 4) : v.getUint16(tables.loca + i * 2) * 2);
  const advance = (gid: number) => v.getUint16(tables.hmtx + Math.min(gid, numHMetrics - 1) * 4);

  /** Контуры глифа как точки TrueType (с признаком «на кривой»). */
  function rawGlyph(gid: number, depth = 0): { x: number; y: number; on: boolean }[][] {
    if (gid >= numGlyphs || depth > 8) return [];
    const start = loca(gid), end = loca(gid + 1);
    if (end <= start) return [];
    const g = tables.glyf + start;
    const nc = v.getInt16(g);
    if (nc >= 0) {
      const endPts: number[] = [];
      for (let i = 0; i < nc; i++) endPts.push(v.getUint16(g + 10 + i * 2));
      const nPts = nc ? endPts[nc - 1] + 1 : 0;
      let p = g + 10 + nc * 2;
      const insLen = v.getUint16(p); p += 2 + insLen;
      const flags: number[] = [];
      while (flags.length < nPts) {
        const f = u8[p++];
        flags.push(f);
        if (f & 8) { const r = u8[p++]; for (let k = 0; k < r; k++) flags.push(f); }
      }
      const xs: number[] = [], ys: number[] = [];
      let x = 0;
      for (const f of flags) {
        if (f & 2) { const d = u8[p++]; x += f & 16 ? d : -d; }
        else if (!(f & 16)) { x += v.getInt16(p); p += 2; }
        xs.push(x);
      }
      let y = 0;
      for (const f of flags) {
        if (f & 4) { const d = u8[p++]; y += f & 32 ? d : -d; }
        else if (!(f & 32)) { y += v.getInt16(p); p += 2; }
        ys.push(y);
      }
      const out: { x: number; y: number; on: boolean }[][] = [];
      let s = 0;
      for (const e of endPts) {
        const c = [];
        for (let i = s; i <= e; i++) c.push({ x: xs[i], y: ys[i], on: (flags[i] & 1) === 1 });
        out.push(c);
        s = e + 1;
      }
      return out;
    }
    // составной глиф
    const out: { x: number; y: number; on: boolean }[][] = [];
    let p = g + 10;
    for (;;) {
      const flags = v.getUint16(p), cg = v.getUint16(p + 2);
      p += 4;
      let dx: number, dy: number;
      if (flags & 1) { dx = v.getInt16(p); dy = v.getInt16(p + 2); p += 4; }
      else { dx = v.getInt8(p); dy = v.getInt8(p + 1); p += 2; }
      let a = 1, b = 0, c = 0, d = 1;
      const f2 = (o: number) => v.getInt16(o) / 16384;
      if (flags & 8) { a = d = f2(p); p += 2; }
      else if (flags & 0x40) { a = f2(p); d = f2(p + 2); p += 4; }
      else if (flags & 0x80) { a = f2(p); b = f2(p + 2); c = f2(p + 4); d = f2(p + 6); p += 8; }
      const useOffsets = (flags & 2) !== 0; // иначе — совмещение точек (редко), смещение не применяем
      for (const ct of rawGlyph(cg, depth + 1))
        out.push(ct.map((q) => ({ x: a * q.x + c * q.y + (useOffsets ? dx : 0), y: b * q.x + d * q.y + (useOffsets ? dy : 0), on: q.on })));
      if (!(flags & 0x20)) break;
    }
    return out;
  }

  /** Контур TrueType (квадратичные кривые) → ломаная. */
  function contours(gid: number): Contour[] {
    return rawGlyph(gid).filter((c) => c.length >= 2).map((pts) => {
      // восстановить пропущенные точки «на кривой» между двумя «вне кривой»
      const full: { x: number; y: number; on: boolean }[] = [];
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i], b = pts[(i + 1) % pts.length];
        full.push(a);
        if (!a.on && !b.on) full.push({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, on: true });
      }
      let s = full.findIndex((q) => q.on);
      if (s < 0) s = 0;
      const ring = [...full.slice(s), ...full.slice(0, s)];
      const out: Contour = [[ring[0].x, ring[0].y]];
      for (let i = 1; i <= ring.length; i++) {
        const q = ring[i % ring.length];
        if (q.on) { out.push([q.x, q.y]); continue; }
        const p0 = ring[i - 1], p2 = ring[(i + 1) % ring.length];
        const n = 6;
        for (let k = 1; k <= n; k++) {
          const t = k / n, it = 1 - t;
          out.push([it * it * p0.x + 2 * it * t * q.x + t * t * p2.x, it * it * p0.y + 2 * it * t * q.y + t * t * p2.y]);
        }
        i++;
      }
      return out;
    });
  }

  const glyphIndex = (cp: number) => map.get(cp) ?? 0;
  const heightOf = (chars: string) => {
    for (const ch of chars) {
      const cs = contours(glyphIndex(ch.codePointAt(0)!));
      if (cs.length) return Math.max(...cs.flat().map((q) => q[1]));
    }
    return 0;
  };
  // Высота заглавной и строчной: меряем по настоящим буквам (у рукописных шрифтов
  // таблица OS/2 часто врёт из-за росчерков), иначе берём из OS/2
  let os2Cap = 0, os2X = 0;
  if (tables['OS/2'] !== undefined && v.getUint16(tables['OS/2']) >= 2) {
    os2X = v.getInt16(tables['OS/2'] + 86);
    os2Cap = v.getInt16(tables['OS/2'] + 88);
  }
  const capHeight = heightOf('НHTЕ') || os2Cap || unitsPerEm * 0.7;
  const xHeight = heightOf('нxох') || os2X || capHeight * 0.7;

  let name = 'Шрифт';
  if (tables.name !== undefined) {
    const n = tables.name, cnt = v.getUint16(n + 2), so = n + v.getUint16(n + 4);
    for (let i = 0; i < cnt; i++) {
      const r = n + 6 + i * 12;
      const pid = v.getUint16(r), id = v.getUint16(r + 6), len = v.getUint16(r + 8), off = v.getUint16(r + 10);
      if (id !== 4 && id !== 1) continue;
      let s = '';
      if (pid === 3 || pid === 0) for (let k = 0; k < len; k += 2) s += String.fromCharCode(v.getUint16(so + off + k));
      else for (let k = 0; k < len; k++) s += String.fromCharCode(u8[so + off + k]);
      if (s.trim()) { name = s.trim(); if (id === 4) break; }
    }
  }

  return { name, unitsPerEm, capHeight, xHeight, glyphIndex, advance, contours, codepoints: () => [...map.keys()] };
}
