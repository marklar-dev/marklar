/* Marklar Core - lexer.js
   Dependencies: values
   Generated from the mono core bundle by tools/extract_core.py. */
/**
 * Marklar Core — expression lexer.
 *
 * Converts the text of an expression into tokens. Offsets are relative to the
 * expression text; callers add the base offset of the expression in the
 * Markdown source when reporting diagnostics.
 *
 * Token types:
 *   num   — 10, 3.14, .5, 1e3            (a following "%" is a separate op)
 *   str   — "text", “text”, ”text”, „text“, «text»
 *   name  — x, .x, this.x, Global.x, User.Age   { lead: true when it starts with "." }
 *   cell  — $A$1, A$1, $A1                (plain A1 is lexed as a name; the parser decides)
 *   op    — && || == != <> >= <= -> = + - * / ^ % ! < > ? : , ( ) [ ] .[
 *   eof
 */
const { LSError } = require('./values.js');

/** Closing quote characters accepted for each opening quote. */
const QUOTES = {
  '"': '"\u201d\u201c',
  '\u201c': '\u201d"\u201c',   // “ … ”
  '\u201d': '\u201d"',         // ” … ”  (common after autocorrect)
  '\u201e': '\u201c\u201d"',   // „ … “
  '\u00ab': '\u00bb'           // « … »
};

const OPS3 = [];
const OPS2 = ['&&', '||', '==', '!=', '<>', '>=', '<=', '->', '.['];
const OPS1 = '=+-*/^%!<>?:,()[]';

const isDigit = c => c >= '0' && c <= '9';
const isLatin = c => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
const isNameChar = c => isLatin(c) || isDigit(c) || c === '_';

/**
 * @param {string} src expression text
 * @returns {{type:string,value:any,start:number,end:number,lead?:boolean,spaceBefore:boolean}[]}
 */
function tokenize(src) {
  const toks = [];
  let i = 0, space = false;
  const push = (type, value, start, extra) => { toks.push({ type, value, start, end: i, spaceBefore: space, ...extra }); space = false; };

  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\u00a0') { i++; space = true; continue; }
    const start = i;

    // numbers: 10, 3.14, .5, 1e-3
    if (isDigit(c) || (c === '.' && isDigit(src[i + 1] || ''))) {
      while (isDigit(src[i] || '')) i++;
      if (src[i] === '.' && isDigit(src[i + 1] || '')) { i++; while (isDigit(src[i] || '')) i++; }
      if ((src[i] === 'e' || src[i] === 'E') && /[+-]?\d/.test(src.slice(i + 1, i + 3))) {
        i++; if (src[i] === '+' || src[i] === '-') i++;
        while (isDigit(src[i] || '')) i++;
      }
      if (isLatin(src[i] || '') || src[i] === '_') throw new LSError(`Invalid number "${src.slice(start, i + 1)}"`, { code: 'syntax', start, end: i + 1 });
      push('num', parseFloat(src.slice(start, i)), start);
      continue;
    }

    // strings
    if (QUOTES[c]) {
      const closers = QUOTES[c];
      let out = ''; i++;
      while (i < src.length && !closers.includes(src[i])) {
        if (src[i] === '\\' && i + 1 < src.length) {
          const n = src[i + 1];
          out += n === 'n' ? '\n' : n === 't' ? '\t' : n;
          i += 2; continue;
        }
        out += src[i++];
      }
      if (i >= src.length) throw new LSError('Unterminated string', { code: 'syntax', start, end: src.length });
      i++;
      push('str', out, start);
      continue;
    }

    // absolute cell references: $A$1, $A1, A$1
    const cell = src.slice(i).match(/^\$?[A-Za-z]{1,3}\$?\d+(?![A-Za-z0-9_])/);
    if (cell && cell[0].includes('$')) { i += cell[0].length; push('cell', cell[0], start); continue; }

    // names: x, .x, this.x, User.Age, NPC.Skeleton (a "." before "[" starts a selector)
    if (isLatin(c) || ((c === '.') && isLatin(src[i + 1] || '') && !prevEndsOperand(toks))) {
      const lead = c === '.';
      if (lead) i++;
      const segs = [];
      for (;;) {
        const s0 = i;
        while (isNameChar(src[i] || '')) i++;
        segs.push(src.slice(s0, i));
        if (src[i] === '.' && (isLatin(src[i + 1] || '') || src[i + 1] === '_')) { i++; continue; }
        break;
      }
      if (/[^\x00-\x7f]/.test(src[i] || '') && /\p{L}/u.test(src[i])) {
        while (i < src.length && /[\p{L}\p{N}_]/u.test(src[i])) i++;
        throw new LSError(`Invalid name "${src.slice(start, i)}": names use Latin letters, digits and "_"`, { code: 'syntax', start, end: i });
      }
      push('name', segs, start, { lead });
      continue;
    }
    // continuation after a selector: NPC.[a, b].Population
    if (c === '.' && isLatin(src[i + 1] || '') && prevEndsOperand(toks)) {
      i++;
      const segs = [];
      for (;;) {
        const s0 = i;
        while (isNameChar(src[i] || '')) i++;
        segs.push(src.slice(s0, i));
        if (src[i] === '.' && isLatin(src[i + 1] || '')) { i++; continue; }
        break;
      }
      push('member', segs, start);
      continue;
    }

    const two = src.substr(i, 2);
    if (OPS3.includes(src.substr(i, 3))) { i += 3; push('op', src.substr(start, 3), start); continue; }
    if (OPS2.includes(two)) { i += 2; push('op', two, start); continue; }
    if (OPS1.includes(c)) { i++; push('op', c, start); continue; }
    if (/\p{L}/u.test(c)) {
      while (i < src.length && /[\p{L}\p{N}_]/u.test(src[i])) i++;
      throw new LSError(`Invalid name "${src.slice(start, i)}": names use Latin letters, digits and "_"`, { code: 'syntax', start, end: i });
    }
    throw new LSError(`Unexpected character "${c}"`, { code: 'syntax', start, end: start + 1 });
  }
  toks.push({ type: 'eof', value: null, start: src.length, end: src.length, spaceBefore: space });
  return toks;
}

/** True when the previous token ends an operand (so a following "." is member access). */
function prevEndsOperand(toks) {
  const t = toks[toks.length - 1];
  return !!t && t.type === 'op' && (t.value === ']');
}

module.exports = { tokenize };
