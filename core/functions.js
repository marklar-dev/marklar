/* Marklar Core - functions.js
   Dependencies: values
   Generated from the mono core bundle by tools/extract_core.py. */
/**
 * Marklar Core — built-in functions and constants.
 *
 * Spec sections "Literals", "Mathematics", "Collections", "Minimum, maximum and
 * random numbers", "Trigonometry and logarithms". Names are case-insensitive.
 *
 * Every function receives already evaluated arguments and a context object
 * `{ random: () => number }`, so the evaluator can supply a deterministic
 * generator at edit-time.
 */
const { LSError, toNumber, flatten, format, isNumeric, isNull, roundNumber, isList } = require('./values.js');

/** Constants (spec: pi, e, sqrt2, ln10, true = 1, false = 0, null = ""). */
const CONSTANTS = Object.freeze({
  pi: Math.PI,
  e: Math.E,
  sqrt2: Math.SQRT2,
  ln10: Math.LN10,
  true: 1,
  false: 0,
  null: ''
});

const num = (v, fn) => toNumber(v, `${fn}()`);

function arity(name, args, min, max = min) {
  if (args.length < min || args.length > max) {
    const want = min === max ? `${min}` : max === Infinity ? `at least ${min}` : `${min}–${max}`;
    throw new LSError(`${name}() expects ${want} argument${min === 1 && max === 1 ? '' : 's'}, got ${args.length}`, { code: 'arity' });
  }
}

/** Numeric items of the flattened arguments; empty cells (null) are skipped like in spreadsheets. */
function numbers(name, args) {
  return flatten(args).filter(v => !isNull(v)).map(v => {
    if (!isNumeric(v)) throw new LSError(`${name}() expects numbers, got "${format(v)}"`, { code: 'type' });
    return toNumber(v);
  });
}

const unary = (name, f) => (args) => { arity(name, args, 1); return f(num(args[0], name)); };

/** name → implementation(args, ctx) */
const FUNCTIONS = {
  // rounding
  round: (a) => { arity('round', a, 1, 2); const d = a[1] === undefined ? 0 : num(a[1], 'round'); const k = 10 ** d; return Math.round(num(a[0], 'round') * k) / k; },
  ceil: unary('ceil', Math.ceil),
  floor: unary('floor', Math.floor),
  trunc: unary('trunc', Math.trunc),

  // powers, roots, sign
  pow: (a) => { arity('pow', a, 2); return num(a[0], 'pow') ** num(a[1], 'pow'); },
  sqrt: unary('sqrt', x => { if (x < 0) throw new LSError('sqrt() of a negative number', { code: 'domain' }); return Math.sqrt(x); }),
  cbrt: unary('cbrt', Math.cbrt),
  abs: unary('abs', Math.abs),
  sign: unary('sign', Math.sign),

  // integer division
  mod: (a) => { arity('mod', a, 2); const y = num(a[1], 'mod'); if (y === 0) throw new LSError('mod() by zero', { code: 'div0' }); const x = num(a[0], 'mod'); return x - y * Math.floor(x / y); },
  div: (a) => { arity('div', a, 2); const y = num(a[1], 'div'); if (y === 0) throw new LSError('div() by zero', { code: 'div0' }); return Math.floor(num(a[0], 'div') / y); },

  // collections
  sum: (a) => numbers('sum', a).reduce((s, x) => s + x, 0),
  avg: (a) => { const n = numbers('avg', a); if (!n.length) throw new LSError('avg() of an empty collection', { code: 'empty' }); return n.reduce((s, x) => s + x, 0) / n.length; },
  median: (a) => {
    const n = numbers('median', a).sort((x, y) => x - y);
    if (!n.length) throw new LSError('median() of an empty collection', { code: 'empty' });
    const m = n.length >> 1;
    return n.length % 2 ? n[m] : (n[m - 1] + n[m]) / 2;
  },
  count: (a) => flatten(a).filter(v => !isNull(v)).length,
  unique: (a) => {
    const seen = new Set(), out = [];
    for (const v of flatten(a)) { const k = format(v); if (!seen.has(k)) { seen.add(k); out.push(v); } }
    return out;
  },

  // min / max / random
  min: (a) => { const n = numbers('min', a); if (!n.length) throw new LSError('min() of an empty collection', { code: 'empty' }); return Math.min(...n); },
  max: (a) => { const n = numbers('max', a); if (!n.length) throw new LSError('max() of an empty collection', { code: 'empty' }); return Math.max(...n); },
  random: (a, ctx) => { arity('random', a, 0); return ctx.random(); },
  chance: (a, ctx) => { arity('chance', a, 1); return num(a[0], 'chance') > ctx.random() ? 1 : 0; },

  // trigonometry (radians) and logarithms
  rad: unary('rad', x => x * Math.PI / 180),
  deg: unary('deg', x => x * 180 / Math.PI),
  sin: unary('sin', Math.sin),
  cos: unary('cos', Math.cos),
  tan: unary('tan', Math.tan),
  asin: unary('asin', Math.asin),
  acos: unary('acos', Math.acos),
  atan: unary('atan', Math.atan),
  log: unary('log', x => { if (x <= 0) throw new LSError('log() of a non-positive number', { code: 'domain' }); return Math.log(x); }),
  exp: unary('exp', Math.exp)
};

/** Functions whose result is not deterministic (marked in dependency info). */
const VOLATILE = new Set(['random', 'chance']);

/** True when `name` is a known function. */
const isFunction = name => Object.prototype.hasOwnProperty.call(FUNCTIONS, String(name).toLowerCase());

/**
 * Small deterministic PRNG (mulberry32). Edit-time uses a fixed seed so that
 * random() / chance() do not make values flicker on every keystroke.
 */
function seededRandom(seed = 1) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Calls a built-in function by name. */
function callFunction(name, args, ctx) {
  const f = FUNCTIONS[String(name).toLowerCase()];
  if (!f) throw new LSError(`Unknown function "${name}()"`, { code: 'unknown-function' });
  const r = f(args, ctx);
  return isList(r) ? r : typeof r === 'number' ? roundNumber(r) : r;
}

module.exports = { CONSTANTS, FUNCTIONS, VOLATILE, isFunction, seededRandom, callFunction };
