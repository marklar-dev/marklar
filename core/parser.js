/* Marklar Core - parser.js
   Dependencies: lexer, values
   Generated from the mono core bundle by tools/extract_core.py. */
/**
 * Marklar Core — expression parser.
 *
 * Recursive-descent parser producing a small expression AST. Precedence,
 * lowest first:
 *
 *   ternary      ? (cond) a : b            (spec: "Ternary operator")
 *   or           a || b
 *   and          a && b
 *   equality     a = b, a == b, a != b, a <> b   ("=" inside expressions is "==")
 *   comparison   < > <= >=
 *   additive     + -
 *   multiplic.   * /
 *   unary        - + !
 *   power        a ^ b                     (right associative, -2^2 = -4)
 *   postfix      a%                        (divides by 100)
 *   primary      number, "string", [list], (expr), name, call(), cell, range,
 *                selectors: Table.[k1, k2].Prop, Obj.[From:To]
 *
 * AST node shapes (all carry start/end offsets in the expression text):
 *   {type:'num', value} {type:'str', value} {type:'list', items}
 *   {type:'name', prefix:'this'|'global'|null, path:[...], cellLike}
 *   {type:'cell', ref, col, row}  {type:'range', from, to}
 *   {type:'nameRange', from, to}  (inside selectors only)
 *   {type:'select', base, keys, member}
 *   {type:'call', name, args}
 *   {type:'unary', op, arg} {type:'binary', op, left, right}
 *   {type:'percent', arg} {type:'ternary', cond, then, else}
 */
const { tokenize } = require('./lexer.js');
const { LSError } = require('./values.js');

const CELL_RE = /^\$?([A-Za-z]{1,3})\$?(\d+)$/;

/**
 * Parses an expression.
 * @param {string} src
 * @returns {{ast:object, errors:LSError[]}} `errors` holds recoverable problems
 *          (the AST is still usable); fatal problems are thrown as LSError.
 */
function parseExpression(src) {
  const p = new Parser(src);
  const ast = p.parseTernary();
  if (p.peek().type !== 'eof') p.fail(`Unexpected "${tokText(p.peek(), src)}"`, p.peek());
  return { ast, errors: p.errors };
}

/** Collects every name referenced by an AST (used for static checks and dependency hints). */
function collectNames(ast, out = []) {
  if (!ast || typeof ast !== 'object') return out;
  if (ast.type === 'name') out.push(ast);
  for (const k of ['arg', 'left', 'right', 'cond', 'then', 'else', 'base', 'from', 'to']) if (ast[k]) collectNames(ast[k], out);
  for (const k of ['items', 'args', 'keys']) if (ast[k]) ast[k].forEach(x => collectNames(x, out));
  return out;
}

/** Parses an A1-style reference ("$B$12") into a 0-based column/row. */
function parseCellRef(ref) {
  const m = String(ref).match(CELL_RE);
  if (!m) return null;
  const letters = m[1].toUpperCase();
  let col = 0;
  for (const ch of letters) col = col * 26 + (ch.charCodeAt(0) - 64);
  return { col: col - 1, row: parseInt(m[2], 10) - 1 };
}

/** Column index → letters (0 → "A", 26 → "AA"). */
function columnName(i) {
  let s = ''; i += 1;
  while (i > 0) { const r = (i - 1) % 26; s = String.fromCharCode(65 + r) + s; i = Math.floor((i - 1) / 26); }
  return s;
}

const tokText = (t, src) => (t.type === 'eof' ? 'end of expression' : src.slice(t.start, t.end));

class Parser {
  constructor(src) {
    this.src = src;
    this.toks = tokenize(src);
    this.pos = 0;
    this.errors = [];
  }
  peek(o = 0) { return this.toks[Math.min(this.pos + o, this.toks.length - 1)]; }
  next() { return this.toks[this.pos++]; }
  isOp(v, o = 0) { const t = this.peek(o); return t.type === 'op' && t.value === v; }
  eat(v) { if (this.isOp(v)) return this.next(); return null; }
  expect(v) {
    const t = this.eat(v);
    if (!t) this.fail(`Expected "${v}" but found "${tokText(this.peek(), this.src)}"`, this.peek());
    return t;
  }
  fail(msg, t) { throw new LSError(msg, { code: 'syntax', start: t ? t.start : 0, end: t ? Math.max(t.end, t.start + 1) : 0 }); }

  parseTernary() {
    if (this.isOp('?')) {
      const q = this.next();
      if (!this.isOp('(')) this.fail('Expected "(" with a condition after "?"', this.peek());
      const open = this.next();
      const cond = this.parseTernary();
      if (!this.eat(')')) {
        // recoverable: "? (chance(50%) A : B" — the spec example itself misses a ")"
        this.errors.push(new LSError('Missing ")" after the condition', { code: 'syntax', start: open.start, end: this.peek().start }));
      }
      const then = this.parseTernary();
      this.expect(':');
      const els = this.parseTernary();
      return { type: 'ternary', cond, then, else: els, start: q.start, end: els.end };
    }
    return this.parseOr();
  }

  binaryLevel(ops, sub) {
    let left = sub();
    for (;;) {
      const t = this.peek();
      if (t.type !== 'op' || !ops.includes(t.value)) return left;
      this.next();
      const right = sub();
      let op = t.value;
      if (op === '=') op = '==';
      if (op === '<>') op = '!=';
      left = { type: 'binary', op, left, right, start: left.start, end: right.end };
    }
  }
  parseOr() { return this.binaryLevel(['||'], () => this.parseAnd()); }
  parseAnd() { return this.binaryLevel(['&&'], () => this.parseEquality()); }
  parseEquality() { return this.binaryLevel(['==', '=', '!=', '<>'], () => this.parseComparison()); }
  parseComparison() { return this.binaryLevel(['<', '>', '<=', '>='], () => this.parseAdditive()); }
  parseAdditive() { return this.binaryLevel(['+', '-'], () => this.parseMultiplicative()); }
  parseMultiplicative() { return this.binaryLevel(['*', '/'], () => this.parseUnary()); }

  parseUnary() {
    const t = this.peek();
    if (t.type === 'op' && (t.value === '-' || t.value === '+' || t.value === '!')) {
      this.next();
      const arg = this.parseUnary();
      return { type: 'unary', op: t.value, arg, start: t.start, end: arg.end };
    }
    return this.parsePower();
  }

  parsePower() {
    const base = this.parsePostfix();
    if (this.isOp('^')) {
      this.next();
      const exp = this.parseUnary();
      return { type: 'binary', op: '^', left: base, right: exp, start: base.start, end: exp.end };
    }
    return base;
  }

  parsePostfix() {
    let e = this.parsePrimary();
    while (this.isOp('%')) {
      const t = this.next();
      e = { type: 'percent', arg: e, start: e.start, end: t.end };
    }
    return e;
  }

  parsePrimary() {
    const t = this.peek();
    if (t.type === 'num') { this.next(); return { type: 'num', value: t.value, start: t.start, end: t.end }; }
    if (t.type === 'str') { this.next(); return { type: 'str', value: t.value, start: t.start, end: t.end }; }
    if (t.type === 'cell') { this.next(); return this.maybeRange(cellNode(t)); }
    if (t.type === 'op' && t.value === '(') {
      this.next();
      const e = this.parseTernary();
      this.expect(')');
      return e;
    }
    if (t.type === 'op' && t.value === '[') {
      const open = this.next();
      const items = [];
      if (!this.isOp(']')) {
        do { items.push(this.parseTernary()); } while (this.eat(','));
      }
      const close = this.expect(']');
      return { type: 'list', items, start: open.start, end: close.end };
    }
    if (t.type === 'name') {
      this.next();
      // function call: name(...)
      if (this.isOp('(') && t.segs === undefined && t.value.length === 1 && !t.lead) {
        this.next();
        const args = [];
        if (!this.isOp(')')) {
          do { args.push(this.parseArg()); } while (this.eat(','));
        }
        const close = this.expect(')');
        return { type: 'call', name: t.value[0].toLowerCase(), args, start: t.start, end: close.end };
      }
      let node = nameNode(t);
      if (node.cellLike) node = this.maybeRange(node);
      if (this.isOp('.[')) node = this.parseSelector(node);
      return node;
    }
    if (t.type === 'eof') this.fail('Unexpected end of expression', t);
    this.fail(`Unexpected "${tokText(t, this.src)}"`, t);
  }

  /** Function arguments may be ranges (A1:B5) — handled by maybeRange in primary. */
  parseArg() { return this.parseTernary(); }

  /** A1:B5 — a range is two cell references joined by ":" without spaces. */
  maybeRange(from) {
    const colon = this.peek(), nxt = this.peek(1);
    if (colon.type === 'op' && colon.value === ':' && !colon.spaceBefore && !nxt.spaceBefore &&
        (nxt.type === 'cell' || (nxt.type === 'name' && nxt.value.length === 1 && !nxt.lead && CELL_RE.test(nxt.value[0])))) {
      this.next(); this.next();
      const to = nxt.type === 'cell' ? cellNode(nxt) : cellNode({ value: nxt.value[0], start: nxt.start, end: nxt.end });
      const f = from.type === 'cell' ? from : cellNode({ value: from.path[0], start: from.start, end: from.end });
      return { type: 'range', from: f, to, start: f.start, end: to.end };
    }
    return from;
  }

  /** Base.[k1, k2].Member or Base.[From:To] */
  parseSelector(base) {
    this.expect('.[');
    const keys = [];
    if (!this.isOp(']')) {
      do {
        const a = this.peek(), colon = this.peek(1), b = this.peek(2);
        if (a.type === 'name' && colon.type === 'op' && colon.value === ':' && b.type === 'name') {
          this.pos += 3;
          keys.push({ type: 'nameRange', from: a.value.join('.'), to: b.value.join('.'), start: a.start, end: b.end });
        } else if (a.type === 'name' && a.value.length === 1 && !a.lead && (this.isOp(',', 1) || this.isOp(']', 1))) {
          // bare words inside a selector are key values: Country.[Russia, Moscow]
          this.next();
          keys.push({ type: 'key', value: a.value[0], start: a.start, end: a.end });
        } else keys.push(this.parseTernary());
      } while (this.eat(','));
    }
    const close = this.expect(']');
    let member = null, end = close.end;
    if (this.peek().type === 'member') { const m = this.next(); member = m.value; end = m.end; }
    return { type: 'select', base, keys, member, start: base.start, end };
  }
}

function nameNode(t) {
  let path = t.value.slice();
  let prefix = null;
  if (t.lead) prefix = 'this';
  else if (path.length > 1 && path[0].toLowerCase() === 'this') { prefix = 'this'; path = path.slice(1); }
  else if (path.length > 1 && path[0].toLowerCase() === 'global') { prefix = 'global'; path = path.slice(1); }
  const cellLike = !prefix && path.length === 1 && CELL_RE.test(path[0]);
  return { type: 'name', prefix, path, cellLike, start: t.start, end: t.end };
}

function cellNode(t) {
  const ref = String(t.value);
  const pos = parseCellRef(ref);
  return { type: 'cell', ref: ref.toUpperCase(), col: pos.col, row: pos.row, start: t.start, end: t.end };
}

module.exports = { parseExpression, collectNames, parseCellRef, columnName };
