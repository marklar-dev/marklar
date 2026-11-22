/* Marklar Core - edittime.js
   Dependencies: evaluator, scope, tables, dependency, diagnostics, functions, values, text
   Generated from the mono core bundle by tools/extract_core.py. */
/**
 * Marklar Core — Edit-time interpreter.
 *
 * Implements "The scope and the order of the execution → Edittime":
 *
 *   Pass 1 (top-down)
 *     1. runs imports;
 *     2. lays tables out into classes / objects;
 *     3. registers every declaration; its expression is kept unevaluated
 *        ("taken as a string") — the variable is `pending`.
 *   Pass 2 (top-down, once)
 *     executes statements in document order. When an expression reads a
 *     `pending` variable, the declaration of that variable is expanded in
 *     place ("expand all the recursions that were met"), recursively. A variable
 *     that is already being expanded contributes its current value (null → 0),
 *     which yields the spec example X = 601, Y = 1201, Z = 601.
 *   Then all table formulas and %inline% expressions are evaluated for display.
 *
 * What runs at edit-time (the editor simulates the first activation of every
 * node, so `.count` is 0):
 *   - nodes outside scenarios: all statements, including `?` conditionals and
 *     list items (conditions are evaluated, `? else` negates the last `?`);
 *   - scenario nodes (entry points `# -> Node`, their children and transition
 *     targets): only unconditional statements outside bullets. Bullet code and
 *     conditional blocks run only when a scenario is played (runtime);
 *   - transitions `->` and dialog log `::` are never executed at edit-time.
 *
 * Name resolution for a bare name `a.b` read at position p in node N:
 *   1. inside a table formula: the current table's cells / objects;
 *   2. a local of N or its ancestors declared before p (position-aware
 *      shadowing, spec example with "x ++" in a child node);
 *   3. the Global variable `a.b` (forward references allowed);
 *   4. a local declared later in N or its ancestors;
 *   5. structured access: `Node.x`, `Table.Obj.Prop`, `Alias.x`;
 *   otherwise "Unknown name" (warning) and null.
 */
const { evaluate } = require('./evaluator.js');
const { RuntimeState, Namespace } = require('./scope.js');
const { TableModel } = require('./tables.js');
const { DependencyGraph } = require('./dependency.js');
const { DiagnosticBag } = require('./diagnostics.js');
const { seededRandom, CONSTANTS } = require('./functions.js');
const { LSError, NULL, toNumber, toBool, format, normalize, isNull, isNumeric, isList } = require('./values.js');
const { nameKey, nodeKey } = require('./text.js');

const MISSING = Symbol('missing');

/**
 * Runs the edit-time interpreter.
 * @param {object} ast semantic AST (semantic.js)
 * @param {object} [opts]
 * @param {number} [opts.seed=1] seed of random() / chance()
 * @param {(file:string)=>({state:RuntimeState}|null)} [opts.importer] loads another document
 * @returns {EditTimeResult}
 */
function runEditTime(ast, opts = {}) {
  return new EditTimeInterpreter(ast, opts).run();
}

/**
 * @typedef {object} EditTimeResult
 * @property {RuntimeState} state     namespaces, variables, tables, aliases
 * @property {DependencyGraph} graph
 * @property {DiagnosticBag} diagnostics evaluation diagnostics
 * @property {Map<string,{value:*,error:string|null}>} inlines  inline unit uid → result
 * @property {Map<string,boolean>} conds  conditional unit uid → result (edit-time only)
 * @property {Set<string>} executed  uids of executed statements
 */

/* The names of an expression - WITHOUT computing it: the conditions of the
   scenario nodes are not executed at edit time (they run when the scenario is
   played), but the names in them must exist - otherwise the user gets no
   warning at all (the complaint of the owner, 20.11 17:40: «несуществующая
   переменная coffe не подсвечивалась в условном операторе»). */
function collectExprNames(n, out) {
  if (!n || typeof n !== 'object') return out;
  switch (n.type) {
    case 'name': out.push(n); return out;
    case 'list': (n.items || []).forEach(x => collectExprNames(x, out)); return out;
    case 'call': (n.args || []).forEach(x => collectExprNames(x, out)); return out;
    case 'percent': return collectExprNames(n.arg, out);
    case 'ternary':
      collectExprNames(n.cond, out);
      collectExprNames(n.then, out);
      collectExprNames(n.else, out);
      return out;
    case 'unary': return collectExprNames(n.arg, out);
    case 'binary':
      collectExprNames(n.left, out);
      collectExprNames(n.right, out);
      return out;
    case 'select': return collectExprNames(n.what, out);
    default: return out;
  }
}

class EditTimeInterpreter {
  constructor(ast, opts = {}) {
    this.ast = ast;
    this.opts = opts;
    // The incremental run: the state, the graph and the results of the
    // previous run are kept, and the units that are not recalculated are
    // skipped (their values did not change).
    this.state = opts.state || new RuntimeState(ast);
    this.graph = opts.graph || new DependencyGraph();
    this.diags = opts.diags || new DiagnosticBag();
    this.random = seededRandom(opts.seed ?? 1);
    this.inlines = opts.inlines || new Map();
    this.conds = opts.conds || new Map();
    this.executed = opts.executed || new Set();
    this.skip = null;                      // the ids of the units that are not counted again
    this.changedLines = opts.changedLines || null;   // the lines that the change has touched
    this.prevAst = opts.prevAst || null;             // the tree of the previous run
    this.diagUnits = opts.diagUnits || null;         // the units that have a diagnostic
    this.invalidVars = null;               // the variables that are counted again
    this.declared = new Set();             // the variables that this run declares
    this.expanding = new Set();      // variables whose declaration is being expanded
    // "Who uses me": the id of a variable -> the ids of the variables that read
    // it in their formulas.  The registry lives in the document and survives
    // the rebuilds of the tree.
    this.usedBy = opts.usedBy || new Map();
    this.frames = [];                // dependency recording stack
    ast.units.forEach((u, i) => { u.index = i; });
  }

  run() {
    this.pass1();
    this.computeSkip();
    this.pass2();
    this.finish();
    return {
      state: this.state, graph: this.graph, diagnostics: this.diags,
      inlines: this.inlines, conds: this.conds, executed: this.executed,
      usedBy: this.usedBy,
      skipped: this.skip ? this.skip.size : 0,      // the units that were not counted again
      invalidVars: this.invalidVars ? this.invalidVars.size : 0
    };
  }

  /* ================================================================ pass 1 */

  pass1() {
    const units = this.ast.units;
    // The place of a variable in the document is counted again, and so is its
    // declaration (the unit of the previous tree is not in this one).
    if (this.changedLines) {
      for (const v of this.state.allVariables()) {
        if (v.state === 'builtin') continue;
        v.line = -1;
        v.decl = null;
        v.declIndex = Infinity;
      }
    }
    // The tables of the previous run that are not tables of this run any more
    // are removed before the run: a formula must not read a table that is gone.
    // 1. imports (the aliases are already in the state of the previous run)
    for (const u of units) {
      if (u.kind !== 'import' || !this.isActiveStatic(u)) continue;
      if (this.skip && this.skip.has(u.uid)) continue;   // the import is not touched
      this.runImport(u);
    }
    // 2. tables → classes / objects
    for (const u of units) {
      if (u.kind !== 'table') continue;
      // the table is not touched: its model is taken from the previous tree
      const t = new TableModel(u.table);
      t.unit = u;
      t.evalFormula = (table, cell) => this.evalCell(table, cell);
      // the reading of a cell is recorded as the reading of the cell: the
      // variable that reads it depends on it, not on the whole table
      t.onRead = (row, col) => {
        for (const key of t.cellKeys(row, col)) this.read('cell:' + t.label + '!' + key);
      };
      u.model = t;
      if (!t.valid) continue;
      const prevT = this.state.tables.get(t.key);
      // the table of the previous run that stands in the same place is the
      // same table (its name may have changed with its header) - it is not a
      // duplicate, and its model is replaced by the new one
      const sameTable = !!this.prevTable(u);
      if (prevT && !sameTable && prevT.unit && prevT.unit.uid !== u.uid) {
        this.diags.warning('duplicate-table', `Table "${t.name}" is declared more than once; the first declaration is used`, { uid: u.uid, line: u.line, start: u.start, end: u.start + 1, node: u.node.uid });
        continue;
      }
      this.state.tables.set(t.key, t);
    }
    // 2a. The tables of the previous run that this run does not declare any
    // more are removed: a table is addressed by its name, and when its header
    // changes its name changes too - the old name does not exist any more.
    // (The tables of the aliases are kept: they come from another document.)
    {
      const live = new Set();
      for (const u of units) if (u.kind === 'table' && u.model && u.model.valid) live.add(u.model);
      for (const a of this.state.aliases.values()) {
        if (a.table) live.add(a.table);
        if (a.tables) for (const t of a.tables.values()) live.add(t);
      }
      for (const [k, t] of [...this.state.tables]) if (!live.has(t)) this.state.tables.delete(k);
    }
    // 3. declarations
    for (const u of units) {
      if (u.kind !== 'assign') continue;
      const v = this.writeTarget(u);
      u.var = v;
      if (v) this.declared.add(v);
      if (!v) continue;
      if (v.line < 0) v.line = u.line;
      if (u.mode !== 'edit') {                       // assigned by runtime code only
        if (v.state === 'pending' && !v.decl) { v.state = 'runtime'; v.declIndex = Math.min(v.declIndex, u.index); }
        continue;
      }
      if (v.decl || v.state === 'builtin') continue;   // a re-assignment
      if (this.isConditional(u)) {
        if (v.state === 'pending') { v.state = 'cond'; v.declIndex = Math.min(v.declIndex, u.index); }
        continue;
      }
      if (v.state === 'runtime' || v.state === 'cond') {
        // first unconditional declaration after runtime/conditional writes
        v.state = 'pending';
      }
      v.decl = u;
      v.declIndex = Math.min(v.declIndex, u.index);
    }
    // The variables of the previous run that this document does not declare
    // any more are removed (their declaration is gone).
    for (const v of [...this.state.allVariables()]) {
      if (v.state === 'builtin' || v.ns.kind === 'alias') continue;
      if (!this.declared.has(v)) v.ns.vars.delete(v.key);
    }
  }

  /** True when the statement depends on a `?` condition (directly or through its bullet). */
  isConditional(u) { return !!(u.cond || (u.bullet && u.bullet.cond)); }

  /** Imports are only skipped inside runtime-only code. */
  isActiveStatic(u) { return u.mode === 'edit'; }

  /**
   * Resolves the variable written by an assignment (pass 1, document order).
   *   .x / this.x → current node;  Global.x → Global;
   *   bare x      → an existing local of the node chain, else `Node.x` when the
   *                 first segment is a node id, else Global.
   */
  writeTarget(u) {
    const { prefix, path } = u.target;
    const where = { uid: u.uid, line: u.line, start: u.start, end: u.end, node: u.node.uid, lineText: u.lineText };
    if (!path.length || path.some(s => !s)) { this.diags.error('syntax', `Invalid variable name "${u.target.text}"`, where); return null; }
    const key = nameKey(path.join('.'));
    const state = this.state;
    if (!prefix && path.length === 1 && Object.prototype.hasOwnProperty.call(CONSTANTS, key)) {
      this.diags.error('constant', `"${path[0]}" is a constant and cannot be assigned`, where);
      return null;
    }
    if (prefix === 'this') return state.nsOf(u.node).declare(path.join('.'));
    if (prefix === 'global') return state.global.declare(path.join('.'));
    for (const ns of state.chain(u.node)) { const v = ns.vars.get(key); if (v) return v; }
    if (state.global.vars.has(key)) return state.global.vars.get(key);
    if (path.length > 1) {
      const first = path[0], rest = path.slice(1).join('.');
      const tk = nameKey(first);
      if (state.tables.has(tk) && !state.global.vars.has(key)) {
        this.diags.error('read-only', `Table values are read-only: edit the table "${state.tables.get(tk).name}" instead`, where);
        return null;
      }
      const alias = state.aliases.get(tk);
      if (alias && alias.ns) return alias.ns.declare(rest);
      const hit = this.ast.byKey.get(nodeKey(first));
      if (hit) return state.nsOf(hit[0]).declare(rest);
    }
    return state.global.declare(path.join('.'));
  }

  /* ================================================================ imports */

  runImport(u) {
    const where = { line: u.line, start: u.start, end: u.end, node: u.node.uid, lineText: u.lineText };
    const aliasKey = u.alias ? nameKey(u.alias) : null;
    const unresolved = () => { if (aliasKey) this.state.aliases.set(aliasKey, { ns: null, tables: null, unresolved: true, name: u.alias, unit: u }); };
    if (!this.opts.importer) {
      this.diags.warning('import-unavailable', `Cannot import "${u.file}": project files are not available in this editor`, where);
      return unresolved();
    }
    let sub;
    try { sub = this.opts.importer(u.file); } catch (e) {
      this.diags.error('import', `Import of "${u.file}" failed: ${e.message}`, where);
      return unresolved();
    }
    if (!sub) { this.diags.warning('import-missing', `File "${u.file}" not found`, where); return unresolved(); }
    const src = sub.state;
    const obj = u.object;
    let ns = null, tables = null;
    if (!obj || nameKey(obj) === 'global') { ns = src.global; tables = src.tables; }
    else {
      const ok = nameKey(obj);
      const node = sub.ast && sub.ast.byKey.get(nodeKey(obj));
      if (node) ns = src.nsOf(node[0]);
      else if (src.tables.has(ok)) tables = new Map([[ok, src.tables.get(ok)]]);
      else {
        // a Global prefix: "Character" → Character.Name, Character.Health …
        const pre = ok + '.';
        const sel = [...src.global.vars.values()].filter(v => v.key.startsWith(pre));
        if (!sel.length) { this.diags.warning('import-object', `Object "${obj}" not found in "${u.file}"`, where); return unresolved(); }
        ns = new Namespace('alias', u.alias || obj, null, null);
        sel.forEach(v => { const c = ns.declare(v.name.slice(pre.length)); c.value = v.value; c.state = 'done'; c.line = v.line; });
      }
    }
    if (aliasKey) {
      if (tables && tables.size === 1 && !ns) this.state.aliases.set(aliasKey, { ns: null, table: [...tables.values()][0], tables: null, name: u.alias, unit: u });
      else this.state.aliases.set(aliasKey, { ns, tables, name: u.alias, unit: u });
      return;
    }
    // no alias: merge into Global
    if (ns) for (const v of ns.vars.values()) {
      if (v.state === 'builtin') continue;
      const c = this.state.global.declare(v.name);
      if (c.decl) continue;
      c.value = v.value; c.state = 'done'; c.imported = u.file;
    }
    if (tables) for (const [k, t] of tables) if (!this.state.tables.has(k)) this.state.tables.set(k, t);
  }

  /* ================================================================ pass 2 */

  pass2() {
    // the names of the conditions of the scenario nodes are checked (the
    // conditions themselves are not computed - they run in the runtime)
    this.checkScenarioCondNames();
    for (const u of this.ast.units) {
      if (this.skip && this.skip.has(u.uid)) continue;   // the unit is not counted again
      if (u.mode === 'display') { this.evalInline(u); continue; }
      if (u.mode !== 'edit') continue;
      if (u.kind === 'cond') { this.execCond(u); continue; }
      if (u.kind === 'assign') { if (this.isActive(u)) this.execAssign(u); continue; }
    }
  }

  /**
   * Counts what the change has touched: the variables of the changed lines
   * and the variables that read them ("who uses me").  The units that are not
   * in this set keep their values.
   */
  computeSkip() {
    const ch = this.changedLines;
    if (!ch) return;
    const invalid = new Set();
    const queue = [];
    for (const u of this.ast.units) {
      if (u.line == null) continue;
      const last = u.endLine == null ? u.line : u.endLine;
      if (last < ch.from || u.line > ch.to) continue;   // the statement does not cover the change
      const v = u.var;
      if (v && !invalid.has('var:' + v.id)) { invalid.add('var:' + v.id); queue.push('var:' + v.id); }
      // a table whose line is touched: the table and its cells are touched
      if (u.kind === 'table' && u.model && u.model.grid) {
        const tkey = 'table:' + u.model.label;
        if (!invalid.has(tkey)) { invalid.add(tkey); queue.push(tkey); }
        for (const c of u.model.grid.flat()) {
          for (const key of this.cellKeys(u.model, c)) if (!invalid.has(key)) { invalid.add(key); queue.push(key); }
        }
        // The cells of the previous tree as well: when the columns of the
        // table moved, the readers of the old cells are the readers of the
        // new ones, and the links of the old cells are the ones we know.
        const old = this.prevTable(u);
        if (old) {
          // The structure of the table moved (a row split - the columns and
          // the addresses of the cells moved): the links of the old cells
          // describe cells that are not here any more.  Then the whole
          // document is counted again - the safe way.
          const a = old.grid.flat().map(c => c.ref).join(',');
          const b = u.model.grid.flat().map(c => c.ref).join(',');
          if (a !== b) { this.skip = null; this.resetVars(null); return; }
          for (const c of old.grid.flat()) {
            for (const key of this.cellKeys(old, c)) if (!invalid.has(key)) { invalid.add(key); queue.push(key); }
          }
        }
      }
    }
    // The units with a diagnostic are counted again (the diagnostic belongs to
    // the state of the document) - and the variables they write are touched,
    // so that the statements that follow them are counted again too.
    if (this.diagUnits) {
      for (const u of this.ast.units) {
        if (!this.diagUnits.has(u.uid)) continue;
        const v = u.var;
        if (v && !invalid.has('var:' + v.id)) { invalid.add('var:' + v.id); queue.push('var:' + v.id); }
      }
    }
    while (queue.length) {
      const id = queue.shift();
      for (const r of (this.usedBy.get(id) || [])) if (!invalid.has(r)) { invalid.add(r); queue.push(r); }
    }
    this.invalidVars = invalid;
    // The units that are counted again: the statements of the variables that
    // are touched, and always the conditions, the chips and the tables (their
    // value is cheap and depends on everything).
    const exec = new Set();
    for (const u of this.ast.units) {
      if (u.kind === 'cond' || u.kind === 'inline' || u.kind === 'table') { exec.add(u.uid); continue; }
      // a unit with a diagnostic is always counted again: the diagnostic
      // belongs to the state of the document
      if (this.diagUnits && this.diagUnits.has(u.uid)) { exec.add(u.uid); continue; }
      if (u.var && invalid.has('var:' + u.var.id)) exec.add(u.uid);
      // a table whose cell is touched is counted again
      if (u.kind === 'table' && u.model && u.model.formulaCells) {
        for (const c of u.model.formulaCells()) {
          if (invalid.has('cell:' + u.model.label + '!' + c.ref)) { exec.add(u.uid); break; }
        }
      }
    }
    // Nothing depends on the change: the values of the whole document are
    // counted again (the safe way).
    if (!invalid.size) { this.skip = null; this.resetVars(null); return; }
    this.skip = new Set();
    for (const u of this.ast.units) if (!exec.has(u.uid)) this.skip.add(u.uid);
    // The variables that are counted again are 'pending' again: the reader
    // that stands before the declaration of a variable (a forward reference)
    // must expand the new declaration - the value of the previous run is not
    // the value of the document any more.
    this.resetVars(invalid);
  }

  /**
   * The variables that are counted again are 'pending' again, and their value
   * is forgotten: the declaration is counted again, and the readers that come
   * before it in the document expand it in place.
   *
   * @param {Set<string>|null} invalid the ids of the variables that are
   *   counted again (null: every variable - the whole document is counted
   *   again from the start)
   */
  resetVars(invalid) {
    for (const v of this.state.allVariables()) {
      if (v.state !== 'done') continue;          // builtin, runtime, cond
      if (v.ns.kind === 'alias') continue;        // the variables of an import
      if (invalid && !invalid.has('var:' + v.id)) continue;
      v.state = 'pending';
      v.value = NULL;
      v.error = null;
    }
  }

  /**
   * All the keys of a cell of a table: its place (A2) and its identity
   * (Warrior.Armor).  A cell is invalidated under both of them: the reader
   * of the cell may have been registered under either name.
   */
  cellKeys(model, cell) {
    const out = [];
    for (const k of model.cellKeys(cell.row, cell.col)) {
      const key = 'cell:' + model.label + '!' + k;
      if (!out.includes(key)) out.push(key);
    }
    return out;
  }

  /**
   * The table of the previous run that stands in the same place (its cells
   * may have moved, and its name may have changed with the header).
   */
  prevTable(u) {
    if (!this.prevAst || !u.model) return null;
    const tables = this.ast.units.filter(x => x.kind === 'table');
    const i = tables.indexOf(u);
    if (i < 0) return null;
    const old = this.prevAst.units.filter(x => x.kind === 'table')[i];
    return old && old.model ? old.model : null;
  }

  /** Value of a conditional unit (edit-time). */
  condValue(c) {
    if (!c) return true;
    if (c.form === 'else') return c.ifUnit ? !this.condValue(c.ifUnit) : true;
    return this.conds.get(c.uid) ?? false;
  }
  /** True when the statement's condition and bullet condition hold. */
  isActive(u) {
    if (u.cond && !this.condValue(u.cond)) return false;
    if (u.bullet && u.bullet.cond && !this.condValue(u.bullet.cond)) return false;
    return true;
  }

  execCond(u) {
    if (u.form === 'if') {
      let r = false;
      if (u.expr && this.isActive(u)) {
        const res = this.evalUnit(u, u.expr, { uid: u.uid, node: u.node, pos: u.index, base: u.exprStart ?? u.start, line: u.line, lineText: u.lineText });
        r = res.ok ? toBool(res.value) : false;
        if (res.ok) u.value = res.value;
      }
      this.conds.set(u.uid, r);
    } else if (u.form === 'else') this.conds.set(u.uid, this.condValue(u));
  }
  execAssign(u) {
    const v = u.var;
    if (!v) return;
    this.executed.add(u.uid);
    const ctx = { uid: u.uid, node: u.node, pos: u.index, base: u.exprStart ?? u.start, line: u.line, lineText: u.lineText };
    this.frames.push({ reads: new Set(), vars: [] });
    let value, error = null;
    // while its own declaration runs, a pending variable counts as "being expanded":
    // a reference back to it (X = Y + 1, Y = … + X) uses the current value
    const own = v.state === 'pending' && v.decl === u && !this.expanding.has(v);
    if (own) this.expanding.add(v);
    try {
      value = this.computeAssign(u, v, ctx, true);
    } catch (e) {
      error = e;
    } finally {
      if (own) this.expanding.delete(v);
    }
    const frame = this.frames.pop();
    this.graph.record(u.uid, frame.reads, ['var:' + v.id]);
    // the readers of the variable: "who uses me in a formula"
    this.link('var:' + v.id, frame.reads);
    if (error) {
      this.report(error, ctx);
      v.value = NULL; v.error = error.message; v.state = 'done';
      return;
    }
    v.value = value; v.error = null; v.state = 'done';
    u.value = value;
  }

  /**
   * Computes the new value of an assignment.
   * @param {boolean} current use the current value for compound operators
   */
  computeAssign(u, v, ctx, current) {
    // the compound operators read the current value of the variable: the
    // dependency is recorded, so that a change of the variable moves this unit
    if (u.op !== '=') this.read('var:' + v.id, v);
    const cur = current ? (v.state === 'pending' && v.decl !== u ? this.readVar(v, ctx) : v.value) : NULL;
    switch (u.op) {
      case '=': return this.eval(u.expr, ctx);
      case '+=': return add(cur, this.eval(u.expr, ctx));
      case '-=': return normalize(toNumber(cur) - toNumber(this.eval(u.expr, ctx)));
      case '++': return normalize(toNumber(cur) + 1);
      case '--': return normalize(toNumber(cur) - 1);
      default: throw new LSError(`Unknown assignment operator "${u.op}"`, { code: 'internal' });
    }
  }

  /** %inline% chips: evaluated at their position, errors are shown on the chip. */
  evalInline(u) {
    if (!u.expr) { this.inlines.set(u.uid, { value: NULL, error: 'Syntax error' }); return; }
    const base = u.start + 1 + (u.isExpr ? 1 : 0);
    const res = this.evalUnit(u, u.expr, { uid: u.uid, node: u.node, pos: u.index, base, line: u.line, lineText: u.lineText, quiet: true });
    this.inlines.set(u.uid, res.ok ? { value: res.value, error: null } : { value: NULL, error: res.error.message });
  }

  /** Evaluates an expression for a unit, recording dependencies and reporting errors. */
  evalUnit(u, expr, ctx) {
    this.frames.push({ reads: new Set(), vars: [] });
    let res;
    try { res = { ok: true, value: this.eval(expr, ctx) }; }
    catch (e) { res = { ok: false, error: e }; this.report(e, ctx, ctx.quiet ? 'warning' : 'error'); }
    const frame = this.frames.pop();
    this.graph.record(u.uid, frame.reads, []);
    return res;
  }

  /** After pass 2: evaluate every table formula and settle leftovers. */
  finish() {
    for (const u of this.ast.units) {
      if (u.kind !== 'table' || !u.model) continue;
      for (const cell of u.model.formulaCells()) {
        try { u.model.cellValue(cell.row, cell.col); } catch (e) { /* stored on the cell and reported by evalCell */ }
      }
    }
    for (const v of this.state.allVariables()) if (v.state === 'pending') { v.state = 'done'; }
  }

  /* ================================================================ evaluation */

  /** Evaluates an AST in a context {node, pos, base, table?, row?}. */
  eval(ast, ctx) {
    if (!ast) throw new LSError('Invalid expression', { code: 'syntax' });
    const self = this;
    return evaluate(ast, {
      name: n => self.resolveName(n, ctx),
      cell: n => self.resolveCell(n, ctx),
      range: n => self.resolveRange(n, ctx),
      select: (n, evalKey) => self.resolveSelect(n, ctx, evalKey),
      random: () => self.random()
    });
  }

  /** Formula hook of TableModel. */
  evalCell(table, cell) {
    const d = cell.decl;
    const unit = table.unit;
    const ctx = { uid: unit ? unit.uid : null, node: table.node, pos: unit ? unit.index : Infinity, base: d.exprStart ?? d.start, line: d.line, lineText: d.lineText || '', table, row: cell.row };
    const id = `cell:${table.label}!${cell.ref}`;
    // the cell is written under both of its names: by its place (A2) and by
    // its identity (idRow.idHeader) - so that a reader finds it either way
    const keys = this.cellKeys(table, cell);
    for (const key of keys) this.read(key);
    this.frames.push({ reads: new Set(), vars: [] });
    try {
      if (!d.expr) throw new LSError('Invalid formula', { code: 'syntax' });
      return this.eval(d.expr, ctx);
    } catch (e) {
      // report at the cell, then fail the reader with a fresh error positioned at its reference
      this.report(e, ctx);
      throw new LSError(`Error in cell ${table.valid ? table.name + '.' : ''}${cell.ref}: ${e.message}`, { code: 'ref-error' });
    } finally {
      const frame = this.frames.pop();
      // the cell is written under both of its names: the graph knows it too
      this.graph.record(id, frame.reads, keys);
      for (const key of keys) this.link(key, frame.reads);
    }
  }

  /** Records a read in the current dependency frame. */
  read(key, v) { const f = this.frames[this.frames.length - 1]; if (!f) return; f.reads.add(key); if (v) f.vars.push(v); }

  /**
   * The link "the reader reads the key": the registry keeps, for every key
   * (a variable or a cell of a table), the keys that read it.
   */
  link(written, reads) {
    for (const key of reads) {
      if (!key.startsWith('var:') && !key.startsWith('cell:')) continue;
      let set = this.usedBy.get(key);
      if (!set) { set = new Set(); this.usedBy.set(key, set); }
      set.add(written);
    }
  }

  /** Reads a variable, expanding a pending declaration in place. */
  readVar(v, ctx) {
    this.read('var:' + v.id, v);
    if (v.state !== 'pending') return v.value;
    if (this.expanding.has(v)) {
      this.diags.info('cycle', `Circular reference: "${v.name}" uses its own value (taken as ${format(v.value) || 'null'})`, this.where(ctx));
      return v.value;
    }
    const u = v.decl;
    this.expanding.add(v);
    try {
      const dctx = { uid: u.uid, node: u.node, pos: u.index, base: u.exprStart ?? u.start, line: u.line, lineText: u.lineText };
      return this.computeAssign(u, v, dctx, false);
    } catch (e) {
      throw new LSError(`"${v.name}" cannot be computed: ${e.message}`, { code: 'dependency' });
    } finally {
      this.expanding.delete(v);
    }
  }

  /** Is the name resolvable?  The lookup is the same as in resolveName, but the
   *  variable is NOT read (the conditions of the scenario nodes are not
   *  executed at edit time - only the resolvability of their names is checked). */
  nameResolvable(n, ctx) {
    const path = n.path;
    if (!n.prefix && path.length === 1) {
      const k = path[0].toLowerCase();
      if (Object.prototype.hasOwnProperty.call(CONSTANTS, k)) return true;
    }
    const key = nameKey(path.join('.'));
    const st = this.state;
    if (n.prefix === 'global') {
      if (st.global.vars.get(key)) return true;
      return this.structured(path, ctx) !== MISSING;
    }
    if (n.prefix === 'this') {
      if (ctx.table) return true;
      for (const ns of st.chain(ctx.node)) if (ns.vars.get(key)) return true;
      if (st.global.vars.get(key)) return true;
      return false;
    }
    if (ctx.table) return true;
    for (const ns of st.chain(ctx.node)) if (ns.vars.get(key)) return true;
    if (st.global.vars.get(key)) return true;
    return this.structured(path, ctx) !== MISSING;
  }

  /** The names of the conditions of the scenario nodes are checked for
   *  resolvability: the condition itself is NOT computed (it runs in the
   *  runtime), but a name that does not exist in the document is reported -
   *  the user sees the warning and the word is underlined (the complaint of
   *  the owner, 20.11 17:40). */
  checkScenarioCondNames() {
    for (const u of this.ast.units) {
      if (u.mode !== 'runtime') continue;
      if (u.kind !== 'cond' && u.kind !== 'bullet' && !u.cond) continue;
      if (!u.node || !u.node.scenario) continue;
      const ctx = { uid: u.uid, node: u.node, pos: u.index, base: u.exprStart ?? u.start, line: u.line, lineText: u.lineText };
      const names = [];
      if (u.kind === 'cond') collectExprNames(u.expr, names);
      else if (u.cond) collectExprNames(u.cond.expr, names);
      for (const n of names) {
        if (!this.nameResolvable(n, ctx)) this.unknown(n, ctx);
      }
    }
  }

  /** Resolves a name node (see the module comment for the order). */
  resolveName(n, ctx) {
    const path = n.path;
    const key = nameKey(path.join('.'));
    const st = this.state;

    if (n.prefix === 'global') {
      const v = st.global.vars.get(key);
      if (v) return this.readVar(v, ctx);
      const r = this.structured(path, ctx);
      if (r !== MISSING) return r;
      return this.unknown(n, ctx);
    }

    if (n.prefix === 'this') {
      if (ctx.table) return this.tableThis(path, ctx, n);
      const chain = st.chain(ctx.node);
      for (const ns of chain) { const v = ns.vars.get(key); if (v) return this.readVar(v, ctx); }
      if (!chain.length) { const v = st.global.vars.get(key); if (v) return this.readVar(v, ctx); }
      return this.unknown(n, ctx);
    }

    // inside a table formula: the cells of the table come first, then the
    // variables of the document. The data of the table is reached by the name
    // of the table (Table.Object.Property) — a bare name is a variable.
    if (ctx.table) {
      const t = ctx.table;
      if (n.cellLike) { this.read(`cell:${t.label}!${path[0].toUpperCase()}`); return t.refValue(path[0]); }
      if (path.length > 1 && t.hasObject(path[0])) return t.access(path);
      if (path.length > 1 && t.valid && nameKey(path[0]) === t.key) return t.access(path.slice(1));
    }

    let later = null;
    for (const ns of st.chain(ctx.node)) {
      const v = ns.vars.get(key);
      if (!v) continue;
      if (v.declIndex < ctx.pos || v.state === 'builtin') return this.readVar(v, ctx);
      if (!later) later = v;
    }
    const g = st.global.vars.get(key);
    if (g) return this.readVar(g, ctx);
    if (later) return this.readVar(later, ctx);

    const r = this.structured(path, ctx);
    if (r !== MISSING) return r;
    if (n.cellLike) throw new LSError(`Cell references like ${path[0]} work inside tables; use TableName.${path[0]} outside`, { code: 'ref' });
    return this.unknown(n, ctx);
  }

  /** Node.x, Table.Obj.Prop, Alias.x */
  structured(path, ctx) {
    const st = this.state;
    const first = nameKey(path[0]);
    const rest = path.slice(1);
    const alias = st.aliases.get(first);
    if (alias) {
      if (alias.unresolved) return NULL;
      if (alias.table) return alias.table.access(rest);
      if (rest.length && alias.ns) {
        const v = alias.ns.vars.get(nameKey(rest.join('.')));
        if (v) return this.readVar(v, ctx);
      }
      if (rest.length && alias.tables && alias.tables.has(nameKey(rest[0]))) return alias.tables.get(nameKey(rest[0])).access(rest.slice(1));
      throw new LSError(`"${path.join('.')}" not found in import ${alias.name}`, { code: 'unknown-name' });
    }
    if (rest.length) {
      const hit = this.ast.byKey.get(nodeKey(path[0]));
      if (hit) {
        const v = st.nsOf(hit[0]).vars.get(nameKey(rest.join('.')));
        if (v) return this.readVar(v, ctx);
      }
    }
    const t = st.tables.get(first);
    // the table is read and the cell of it: the value of the cell is what is
    // really needed, and the cell keeps its identity when the table moves
    if (t) { this.read(`table:${t.label}`); return t.access(rest); }
    return MISSING;
  }

  /** this.Prop / this.A / this.x inside a table formula. */
  tableThis(path, ctx, n) {
    const t = ctx.table;
    if (path.length === 1) {
      const col = t.colOf(path[0]);
      if (col >= 0) return t.cellValue(ctx.row, col);
    }
    throw new LSError(`Unknown property "this.${path.join('.')}" in table ${t.label}`, { code: 'unknown-name', start: n.start, end: n.end });
  }

  resolveCell(n, ctx) {
    if (!ctx.table) throw new LSError(`Cell references like ${n.ref} work inside tables; use TableName.${n.ref.replace(/\$/g, '')} outside`, { code: 'ref' });
    this.read(`cell:${ctx.table.label}!${n.ref.replace(/\$/g, '')}`);
    return ctx.table.cellValue(n.row, n.col);
  }

  resolveRange(n, ctx) {
    if (!ctx.table) throw new LSError('Ranges like A1:B5 work inside tables', { code: 'ref' });
    return ctx.table.rangeValues(n.from, n.to);
  }

  /** Base.[keys].Member and Base.[From:To] */
  resolveSelect(n, ctx, evalKey) {
    const base = n.base;
    const member = n.member ? n.member.join('.') : null;
    const slice = n.keys.length === 1 && n.keys[0].type === 'nameRange' ? n.keys[0] : null;
    if (base.type !== 'name') throw new LSError('Selectors apply to tables and table objects', { code: 'selector' });
    const path = base.path;
    const isThis = (base.prefix === null && path.length === 1 && nameKey(path[0]) === 'this');
    // this.[A:B] inside a table
    if (isThis) {
      if (!ctx.table) throw new LSError('"this.[…]" works inside tables', { code: 'selector' });
      if (!slice) throw new LSError('Use this.[From:To] to select a range of properties', { code: 'selector' });
      return ctx.table.slice(ctx.row, slice.from, slice.to);
    }
    const ref = this.tableRef(base, ctx);
    if (!ref) throw new LSError(`"${path.join('.')}" is not a table or a table object`, { code: 'selector', start: base.start, end: base.end });
    const { table, rows } = ref;
    if (rows) {
      if (!slice) throw new LSError('Use Object.[From:To] to select a range of properties', { code: 'selector' });
      const lists = rows.map(r => table.slice(r, slice.from, slice.to));
      return lists.length === 1 ? lists[0] : lists;
    }
    if (slice) throw new LSError('A property range needs an object: Table.Object.[From:To]', { code: 'selector' });
    return table.selectRows(n.keys.map(evalKey), member);
  }

  /** Resolves a selector base to a table, or to rows of a table. */
  tableRef(base, ctx) {
    const path = base.path;
    const st = this.state;
    const tableOf = k => {
      const a = st.aliases.get(k);
      if (a && a.table) return a.table;
      return st.tables.get(k) || null;
    };
    if (ctx.table) {
      const t = ctx.table;
      if (path.length === 1 && t.hasObject(path[0])) return { table: t, rows: t.rowsOf(path[0]) };
      if (path.length === 1 && t.valid && nameKey(path[0]) === t.key) return { table: t, rows: null };
    }
    const t = tableOf(nameKey(path[0]));
    if (t) {
      if (path.length === 1) return { table: t, rows: null };
      if (path.length === 2 && t.hasObject(path[1])) return { table: t, rows: t.rowsOf(path[1]) };
    }
    return null;
  }

  /* ================================================================ diagnostics */

  unknown(n, ctx) {
    const name = (n.prefix === 'this' ? 'this.' : n.prefix === 'global' ? 'Global.' : '') + n.path.join('.');
    this.diags.warning('unknown-name', `Unknown name "${name}" (taken as null)`, { ...this.where(ctx), start: ctx.base + n.start, end: ctx.base + n.end });
    return NULL;
  }

  where(ctx) {
    return { uid: ctx.uid ?? null, line: ctx.line ?? null, lineText: ctx.lineText || '', node: ctx.node ? ctx.node.uid : null, start: ctx.base ?? null, end: ctx.base ?? null };
  }

  report(e, ctx, severity = 'error') {
    if (e.reported) return;
    const start = ctx.base + (e.start ?? 0), end = ctx.base + (e.end ?? (e.start ?? 0) + 1);
    this.diags.add(severity, e.code || 'eval', e.message, { ...this.where(ctx), start, end });
    e.reported = true;
  }
}

/* ------------------------------------------------------------------ helpers */

/** "+=": numeric addition, or text concatenation for strings. */
function add(a, b) {
  if (isNull(a) && isNull(b)) return NULL;
  if ((isNumeric(a) || isNull(a)) && (isNumeric(b) || isNull(b)) && !isList(a) && !isList(b)) return normalize(toNumber(a) + toNumber(b));
  if (isList(a)) return a.concat(isList(b) ? b : [b]);
  return format(a) + format(b);
}

module.exports = { runEditTime, EditTimeInterpreter };
