// Безопасный разбор математических выражений (без eval): y = f(x).

type Node = (vars: Record<string, number>) => number;

const FUNCS: Record<string, (x: number) => number> = {
  sin: Math.sin, cos: Math.cos, tan: Math.tan, tg: Math.tan, asin: Math.asin, acos: Math.acos,
  atan: Math.atan, arctg: Math.atan, sqrt: Math.sqrt, abs: Math.abs, ln: Math.log, log: Math.log10,
  exp: Math.exp, floor: Math.floor, ceil: Math.ceil, sign: Math.sign, sinh: Math.sinh, cosh: Math.cosh,
};
const CONSTS: Record<string, number> = { pi: Math.PI, e: Math.E };

export function compileExpr(src: string, varNames: string[] = ['x']): (vars: Record<string, number>) => number {
  const s = src.replace(/\s+/g, '').replace(/,/g, '.').replace(/π/g, 'pi').toLowerCase();
  let i = 0;
  const peek = () => s[i];
  const fail = (msg: string): never => { throw new Error(`${msg} (позиция ${i + 1})`); };

  function parseExpr(): Node {
    let left = parseTerm();
    while (peek() === '+' || peek() === '-') {
      const op = s[i++];
      const right = parseTerm(), l = left;
      left = op === '+' ? (v) => l(v) + right(v) : (v) => l(v) - right(v);
    }
    return left;
  }
  function parseTerm(): Node {
    let left = parseUnary();
    for (;;) {
      const c = peek();
      if (c === '*' || c === '/') {
        i++;
        const right = parseUnary(), l = left;
        left = c === '*' ? (v) => l(v) * right(v) : (v) => l(v) / right(v);
      } else if (c && /[a-z(]/.test(c)) {
        // неявное умножение: 2x, 3sin(x), (x+1)(x-1)
        const right = parseUnary(), l = left;
        left = (v) => l(v) * right(v);
      } else break;
    }
    return left;
  }
  function parseUnary(): Node {
    if (peek() === '-') { i++; const a = parseUnary(); return (v) => -a(v); }
    if (peek() === '+') { i++; return parseUnary(); }
    return parsePow();
  }
  function parsePow(): Node {
    const base = parseAtom();
    if (peek() === '^') {
      i++;
      const exp = parseUnary();
      return (v) => Math.pow(base(v), exp(v));
    }
    return base;
  }
  function parseAtom(): Node {
    const c = peek();
    if (c === undefined) return fail('Неожиданный конец выражения');
    if (c === '(') {
      i++;
      const e = parseExpr();
      if (peek() !== ')') fail('Не хватает «)»');
      i++;
      return e;
    }
    if (/[0-9.]/.test(c)) {
      const m = /^\d*\.?\d+(e[+-]?\d+)?/.exec(s.slice(i));
      if (!m) return fail('Неверное число');
      i += m[0].length;
      const n = Number(m[0]);
      return () => n;
    }
    if (/[a-z]/.test(c)) {
      const m = /^[a-z]+/.exec(s.slice(i))!;
      let name = m[0];
      // «xx» или «xsin» — сначала берём имя переменной
      if (!(name in FUNCS) && !(name in CONSTS) && !varNames.includes(name)) {
        const known = [...varNames, ...Object.keys(FUNCS), ...Object.keys(CONSTS)]
          .filter((k) => name.startsWith(k))
          .sort((a, b) => b.length - a.length)[0];
        if (known) name = known;
      }
      i += name.length;
      if (name in FUNCS) {
        const f = FUNCS[name];
        const arg = parseAtomOrUnary();
        return (v) => f(arg(v));
      }
      if (name in CONSTS) { const k = CONSTS[name]; return () => k; }
      if (varNames.includes(name)) return (v) => v[name];
      return fail(`Неизвестное имя «${name}»`);
    }
    return fail(`Неожиданный символ «${c}»`);
  }
  function parseAtomOrUnary(): Node {
    if (peek() === '(') return parseAtom();
    return parseUnary();
  }

  const node = parseExpr();
  if (i < s.length) fail(`Лишний символ «${s[i]}»`);
  return node;
}
