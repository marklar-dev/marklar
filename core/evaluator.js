/* Marklar Core - evaluator.js
   Dependencies: values, functions
   Generated from the mono core bundle by tools/extract_core.py. */
/**
 * Marklar Core — expression evaluator.
 *
 * Evaluates an expression AST (see parser.js). Name lookup is delegated to a
 * resolver supplied by the caller, which keeps the evaluator independent from
 * scopes, tables and the edit-time / runtime strategies:
 *
 *   resolver = {
 *     name(node)      → value      // variables, node properties, table selectors
 *     cell(node)      → value      // A1 references (inside tables)
 *     range(node)     → value[]    // A1:B5
 *     select(node, evalKey) → value
 *     random()        → number in [0, 1)
 *   }
 *
 * Operator semantics follow "Values & Types" (values.js):
 *   "+" adds numbers and concatenates text; "=" and "==" compare;
 *   && / || / ! use truthiness and return 1 or 0; "%" divides by 100.
 */
const { LSError, toNumber, toBool, fromBool, equals, compare, isNumeric, isNull, format, normalize, isList } = require('./values.js');
const { CONSTANTS, callFunction } = require('./functions.js');

/**
 * @param {object} ast
 * @param {object} resolver
 * @returns {*} a normalised value
 */
function evaluate(ast, resolver) {
  return normalize(ev(ast, resolver));
}

function ev(n, r) {
  try {
    return evNode(n, r);
  } catch (e) {
    // attach the position of the innermost failing node
    if (e instanceof LSError && e.start === undefined) { e.start = n.start; e.end = n.end; }
    throw e;
  }
}

function evNode(n, r) {
  switch (n.type) {
    case 'num': return n.value;
    case 'str': return n.value;
    case 'list': return n.items.map(x => ev(x, r));
    case 'name': {
      if (!n.prefix && n.path.length === 1) {
        const k = n.path[0].toLowerCase();
        if (Object.prototype.hasOwnProperty.call(CONSTANTS, k)) return CONSTANTS[k];
      }
      return r.name(n);
    }
    case 'cell': return r.cell(n);
    case 'range': return r.range(n);
    case 'select': return r.select(n, k => (k.type === 'key' ? k.value : ev(k, r)));
    case 'call': return callFunction(n.name, n.args.map(a => ev(a, r)), r);
    case 'percent': return toNumber(ev(n.arg, r)) / 100;
    case 'ternary': return toBool(ev(n.cond, r)) ? ev(n.then, r) : ev(n.else, r);
    case 'unary': {
      const v = ev(n.arg, r);
      if (n.op === '!') return fromBool(!toBool(v));
      if (n.op === '-') return -toNumber(v);
      return toNumber(v);
    }
    case 'binary': return binary(n, r);
    default: throw new LSError(`Unsupported expression node "${n.type}"`, { code: 'internal' });
  }
}

function binary(n, r) {
  const op = n.op;
  if (op === '&&') return fromBool(toBool(ev(n.left, r)) && toBool(ev(n.right, r)));
  if (op === '||') return fromBool(toBool(ev(n.left, r)) || toBool(ev(n.right, r)));
  const a = ev(n.left, r), b = ev(n.right, r);
  switch (op) {
    case '+': return add(a, b);
    case '-': return toNumber(a) - toNumber(b);
    case '*': return toNumber(a) * toNumber(b);
    case '/': {
      const d = toNumber(b);
      if (d === 0) throw new LSError('Division by zero', { code: 'div0', start: n.right.start, end: n.right.end });
      return toNumber(a) / d;
    }
    case '^': return toNumber(a) ** toNumber(b);
    case '==': return fromBool(equals(a, b));
    case '!=': return fromBool(!equals(a, b));
    case '<': return fromBool(compare(a, b) < 0);
    case '>': return fromBool(compare(a, b) > 0);
    case '<=': return fromBool(compare(a, b) <= 0);
    case '>=': return fromBool(compare(a, b) >= 0);
    default: throw new LSError(`Unknown operator "${op}"`, { code: 'internal' });
  }
}

/** "+" — numeric addition when both sides are numbers (null counts as 0), text concatenation otherwise. */
function add(a, b) {
  if (isNull(a) && isNull(b)) return '';
  const an = isNumeric(a) || isNull(a), bn = isNumeric(b) || isNull(b);
  if (an && bn && !isList(a) && !isList(b)) return toNumber(a) + toNumber(b);
  return format(a) + format(b);
}

module.exports = { evaluate };
