/* Marklar Core - values.js
   Dependencies: none
   Generated from the mono core bundle by tools/extract_core.py. */
/**
 * Marklar Core — Values & Types.
 *
 * Spec ("Data types"): typing is nominal. Values are conceptually stored as
 * strings, but are treated as floating point numbers when they contain a
 * number. In JavaScript the engine uses three representations:
 *
 *   number  — 10, 3.14, 10.5% (= 0.105). Booleans are numbers: true = 1, false = 0.
 *             Numbers are kept with a precision of 0.000000 (6 decimals).
 *   string  — "text". null is the empty string "".
 *   list    — a collection: a JS array of values.
 *
 * Truthiness: numbers > 0 are true, <= 0 are false; "" is false; any other
 * text is true; a list is true when it is not empty.
 */

const NULL = '';
const TRUE = 1;
const FALSE = 0;

/** Number precision required by the spec (0.000000). */
const PRECISION = 1e6;

/** Thrown for any evaluation problem; carries an optional source span. */
class LSError extends Error {
  /**
   * @param {string} message
   * @param {{code?:string,start?:number,end?:number}} [info]
   */
  constructor(message, info = {}) {
    super(message);
    this.name = 'LSError';
    this.code = info.code || 'eval';
    this.start = info.start;
    this.end = info.end;
  }
}

const isList = v => Array.isArray(v);

/** Rounds to 6 decimals; -0 becomes 0. */
function roundNumber(n) {
  if (!Number.isFinite(n)) return n;
  if (Math.abs(n) >= 1e15) return n;
  const r = Math.round(n * PRECISION) / PRECISION;
  return Object.is(r, -0) ? 0 : r;
}

/**
 * Parses text that represents a number: "10", "-3.14", "1e3", "15%", "17 000 000".
 * Returns NaN when the text is not a number. The empty string is NaN here
 * (see toNumber for the arithmetic treatment of null).
 */
function parseNumberText(text) {
  let s = String(text).trim();
  if (!s) return NaN;
  let pct = false;
  if (s.endsWith('%')) { pct = true; s = s.slice(0, -1).trim(); }
  // thousands separated by spaces, as in the spec table: "17 000 000"
  if (/^[+-]?\d{1,3}(?:[ \u00a0\u202f]\d{3})+(?:\.\d+)?$/.test(s)) s = s.replace(/[ \u00a0\u202f]/g, '');
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(s)) return NaN;
  const n = parseFloat(s);
  return pct ? n / 100 : n;
}

/** True when a value can take part in arithmetic as a number. */
function isNumeric(v) {
  if (typeof v === 'number') return !Number.isNaN(v);
  if (typeof v === 'string') return !Number.isNaN(parseNumberText(v));
  if (isList(v)) return v.length === 1 && isNumeric(v[0]);
  return false;
}

/** True for null (the empty string). */
const isNull = v => v === NULL || v === undefined || v === null;

/**
 * Converts a value to a number. null ("") is 0, numeric text is parsed,
 * a single-item list is unwrapped. Anything else throws.
 */
function toNumber(v, what = 'value') {
  if (typeof v === 'number') return v;
  if (isNull(v)) return 0;
  if (typeof v === 'string') {
    const n = parseNumberText(v);
    if (!Number.isNaN(n)) return n;
    throw new LSError(`Expected a number, got text "${clip(v)}"`, { code: 'type' });
  }
  if (isList(v)) {
    if (v.length === 1) return toNumber(v[0], what);
    throw new LSError(`Expected a number, got a collection of ${v.length} items`, { code: 'type' });
  }
  throw new LSError(`Expected a number for ${what}`, { code: 'type' });
}

/** Truthiness rules of the spec. */
function toBool(v) {
  if (typeof v === 'number') return v > 0;
  if (isList(v)) return v.length > 0;
  if (isNull(v)) return false;
  const n = parseNumberText(v);
  return Number.isNaN(n) ? true : n > 0;
}

const fromBool = b => (b ? TRUE : FALSE);

/** Normalises a freshly computed value before it is stored. */
function normalize(v) {
  if (typeof v === 'boolean') return fromBool(v);
  if (typeof v === 'number') {
    if (Number.isNaN(v)) throw new LSError('Result is not a number', { code: 'nan' });
    if (!Number.isFinite(v)) throw new LSError('Result is infinite (division by zero?)', { code: 'inf' });
    return roundNumber(v);
  }
  if (isList(v)) return v.map(normalize);
  if (v === undefined || v === null) return NULL;
  return String(v);
}

/** Formats a number with up to 6 decimals and without trailing zeros. */
function formatNumber(n) {
  if (!Number.isFinite(n)) return String(n);
  const r = roundNumber(n);
  if (Math.abs(r) >= 1e15 || (r !== 0 && Math.abs(r) < 1e-6)) return String(r);
  return r.toFixed(6).replace(/\.?0+$/, '');
}

/** Text form of a value: what the editor shows in %chips% and table cells. */
function format(v) {
  if (typeof v === 'number') return formatNumber(v);
  if (isList(v)) return v.map(format).join(', ');
  if (isNull(v)) return '';
  return String(v);
}

/** Type name used in diagnostics and API results. */
function typeOf(v) {
  if (typeof v === 'number') return 'number';
  if (isList(v)) return 'list';
  if (isNull(v)) return 'null';
  return 'string';
}

/** Equality used by "=" / "==" inside expressions. */
function equals(a, b) {
  if (isList(a) || isList(b)) {
    const la = isList(a) ? a : [a], lb = isList(b) ? b : [b];
    return la.length === lb.length && la.every((x, i) => equals(x, lb[i]));
  }
  const an = isNumeric(a) || isNull(a), bn = isNumeric(b) || isNull(b);
  if (an && bn && !(isNull(a) && isNull(b))) return roundNumber(toNumber(a)) === roundNumber(toNumber(b));
  return format(a) === format(b);
}

/** Ordering for < > <= >=: numeric when both sides are numbers, text otherwise. */
function compare(a, b) {
  if ((isNumeric(a) || isNull(a)) && (isNumeric(b) || isNull(b))) {
    const x = toNumber(a), y = toNumber(b);
    return x < y ? -1 : x > y ? 1 : 0;
  }
  return format(a).localeCompare(format(b));
}

/** Flattens nested collections (aggregate functions accept lists and ranges). */
function flatten(args) {
  const out = [];
  const walk = v => { if (isList(v)) v.forEach(walk); else out.push(v); };
  args.forEach(walk);
  return out;
}

/**
 * Converts a static table cell or literal text to a value:
 * numbers (including "15%" and "17 000 000") become numbers, true/false
 * become 1/0, everything else stays text.
 */
function valueFromText(text) {
  const s = String(text).trim();
  if (!s) return NULL;
  const n = parseNumberText(s);
  if (!Number.isNaN(n)) return roundNumber(n);
  if (/^true$/i.test(s)) return TRUE;
  if (/^false$/i.test(s)) return FALSE;
  return s;
}

const clip = s => (s.length > 40 ? s.slice(0, 37) + '…' : s);

module.exports = { NULL, TRUE, FALSE, LSError, isList, roundNumber, parseNumberText, isNumeric, isNull, toNumber, toBool, fromBool, normalize, formatNumber, format, typeOf, equals, compare, flatten, valueFromText };
