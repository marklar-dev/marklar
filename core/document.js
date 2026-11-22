/* Marklar Core - document.js
   Dependencies: cst, semantic, edittime, parser, diagnostics, values, text, export
   Generated from the mono core bundle by tools/extract_core.py. */
/**
 * Marklar Core — Document API.
 *
 * The single entry point for UI, CLI and tests (spec "Document API"):
 *
 *   const doc = createDocument(markdown, { resolveFile, seed });
 *   doc.getText() / doc.setText(text) / doc.applyEdit({start, end, text})
 *   doc.transaction(() => { ...several edits... })        // one undo step
 *   doc.undo() / doc.redo()
 *   doc.getCST()  doc.getAST()  doc.evaluate()
 *   doc.getDiagnostics()  doc.getNodes()  doc.findNode(id)
 *   doc.getValue('Character.Health', { node: 'Tavern' })
 *   doc.evalExpression('NPC.Skeleton.Health * 2')
 *   doc.getTables()  doc.getTable('NPC')
 *   doc.on('change', fn)
 *   doc.snapshot()   // serializable summary used by the editor and the worker
 *
 * Markdown text is the only source of truth: every derived structure (CST,
 * semantic AST, evaluation) is rebuilt lazily from it and cached until the
 * next change. Parsed expressions are cached across rebuilds, so a full
 * recalculation on every keystroke stays cheap.
 */
const { parseCST, printCST, rebuildCST } = require('./cst.js');
const { DocumentIndex } = require('./elementindex.js');
const { buildSemantic } = require('./semantic.js');
const { EditTimeInterpreter } = require('./edittime.js');
const { parseExpression } = require('./parser.js');
const { DiagnosticBag } = require('./diagnostics.js');
const { LSError, format, typeOf } = require('./values.js');
const { nodeKey, splitLines } = require('./text.js');
const { exportScenario, exportTables, exportFiles } = require('./export.js');

const MAX_EXPR_CACHE = 5000;
const MAX_LINE_CACHE = 8000;

class MarklarDocument {
  /**
   * @param {string} text Markdown source
   * @param {object} [opts]
   * @param {(path:string)=>string|null} [opts.resolveFile] returns the text of a project file (imports)
   * @param {number} [opts.seed=1] random seed of edit-time random()/chance()
   */
  constructor(text = '', opts = {}) {
    this.opts = opts;
    this._text = String(text);
    this.version = 0;
    this._undo = [];
    this._redo = [];
    this._listeners = new Map();
    this._exprCache = new Map();
    this._usedBy = new Map();      // "who uses me": a variable -> the variables that read it
    this._comp = null;             // the state of the computation of the last run
    this._changedLines = null;     // the lines that the last change has touched
    this._lineCache = new Map();   // the data of the lines that were read
    this._tokCache = new Map();    // the tokens of the lines that were read
    this._prev = null;             // the values of the last snapshot (what has changed)
    this._cstInc = 0;              // the tree of the blocks was rebuilt after a change
    this._cstFull = 0;             // the tree of the blocks was built from scratch
    this._tx = null;
    this._invalidate();
  }

  /* ---------------- text & edits ---------------- */

  getText() { return this._text; }

  /** Replaces the whole text. */
  setText(text, { history = true, keep = false, edits = null } = {}) {
    text = String(text);
    if (text === this._text) return this;
    this._commit(text, history, keep, edits);
    return this;
  }

  /**
   * Applies one edit or a list of edits {start, end, text} (offsets in the
   * current text; a list is applied from the end so offsets stay valid).
   */
  applyEdit(edits) {
    const list = (Array.isArray(edits) ? edits : [edits]).slice().sort((a, b) => b.start - a.start);
    let t = this._text;
    for (const e of list) {
      if (e.start < 0 || e.end < e.start || e.end > t.length) throw new RangeError(`Invalid edit range ${e.start}..${e.end}`);
      t = t.slice(0, e.start) + (e.text || '') + t.slice(e.end);
    }
    // The elements that depend on the change: the index knows them exactly
    // (the readers of what the changed lines write and the units of the
    // subtree of the scope).  They are counted before the text changes.
    const idx = this._index();
    if (idx) {
      const lines = this.getCST().lines;
      let from = Infinity, to = -1;
      for (const e of list) {
        const a = lineAt(lines, e.start), b = lineAt(lines, e.end);
        if (a < from) from = a;
        if (b > to) to = b;
      }
      if (from !== Infinity) this._invalidated = idx.invalidate(from, to);
    }
    this._changedLines = changedLines(list, t);
    // the change is told to the tree of the blocks: only the changed block is
    // parsed again (the blocks that did not change are the same objects)
    return this.setText(t, { keep: true, edits: list });
  }

  /** The index of the elements of the document (it needs the computation). */
  _index() {
    if (!this._c.index) { try { this.evaluate(); } catch (e) { /* the index is built with the computation */ } }
    return this._c.index || null;
  }

  /** The elements that depend on the last change (the units to recalculate). */
  getInvalidated() {
    return this._invalidated ? { ids: this._invalidated.ids, count: this._invalidated.ids.size } : null;
  }

  /** Groups several edits into one undo step and one change event. */
  transaction(fn) {
    if (this._tx) return fn(this);
    this._tx = { before: this._text };
    try { return fn(this); }
    finally {
      const before = this._tx.before;
      this._tx = null;
      if (before !== this._text) {
        this._undo.push(before); this._redo = [];
        this._emit('change', { version: this.version });
      }
    }
  }

  undo() {
    if (!this._undo.length) return false;
    this._redo.push(this._text);
    this._set(this._undo.pop());
    this._emit('change', { version: this.version, undo: true });
    return true;
  }
  redo() {
    if (!this._redo.length) return false;
    this._undo.push(this._text);
    this._set(this._redo.pop());
    this._emit('change', { version: this.version, redo: true });
    return true;
  }
  canUndo() { return this._undo.length > 0; }
  canRedo() { return this._redo.length > 0; }

  /** Subscribes to 'change'; returns an unsubscribe function. */
  on(type, fn) {
    if (!this._listeners.has(type)) this._listeners.set(type, new Set());
    this._listeners.get(type).add(fn);
    return () => this._listeners.get(type).delete(fn);
  }

  /* ---------------- derived structures ---------------- */

  /** Lossless syntax tree (printCST(getCST()) === getText()). */
  getCST() {
    if (!this._c.cst) {
      if (this._tokCache.size > MAX_LINE_CACHE) this._tokCache.clear();
      this._c.cst = parseCST(this._text, { cache: this._tokCache });
    }
    return this._c.cst;
  }

  /** Semantic AST: nodes, units, tables. */
  getAST() {
    if (!this._c.ast) {
      if (this._exprCache.size > MAX_EXPR_CACHE) this._exprCache.clear();
      if (this._lineCache.size > MAX_LINE_CACHE) this._lineCache.clear();
      // The tree of the previous run: the units of the blocks that have not
      // changed are taken from it (the tree survives the change).
      const prev = this._comp && this._comp.ast;
      this._c.ast = buildSemantic(this.getCST(), this._text, {
        exprCache: this._exprCache, lineCache: this._lineCache,
        chunks: prev ? prev.chunks : null,
        prevBlocks: prev ? prev.blocks : null
      });
    }
    return this._c.ast;
  }

  /** Runs the edit-time interpreter (cached until the next change). */
  evaluate() {
    if (!this._c.result) {
      const t0 = now();
      const ast = this.getAST();
      // The incremental run: the units that the change has not touched keep
      // their values.  It is possible when the document has no imports (the
      // aliases are not in the graph of the dependencies), no edit-time
      // condition (a condition decides whether the statements inside it run)
      // and the change does not touch a heading (the scope of the node moves).
      const prev = this._comp;
      const ch = this._changedLines;
      const canInc = !!(prev && ch &&
        !ast.units.some(u => u.kind === 'import') &&
        !ast.units.some(u => u.kind === 'cond' && u.mode === 'edit') &&
        !ast.nodes.some(n => n.line >= ch.from && n.line <= ch.to));
      const interp = new EditTimeInterpreter(ast, {
        seed: this.opts.seed ?? 1, importer: this._importer(),
        usedBy: this._usedBy,          // the registry of the readers lives in the document
        changedLines: canInc ? ch : null,
        prevAst: canInc ? prev.ast : null,
        diagUnits: canInc ? prev.diagUnits : undefined,
        state: canInc ? prev.state : undefined,
        inlines: canInc ? prev.inlines : undefined,
        conds: canInc ? prev.conds : undefined,
        executed: canInc ? prev.executed : undefined
      });
      this._c.interp = interp;
      this._c.result = interp.run();
      const diagUnits = new Set();
      for (const d of this._c.result.diagnostics.items) if (d.uid) diagUnits.add(d.uid);
      this._comp = { state: interp.state, inlines: interp.inlines, conds: interp.conds, executed: interp.executed, diagUnits, ast };
      // the index of the elements of the document and their links: the units
      // by their lines, the graph of the dependencies and the tree of the
      // scopes.  A change of the text is counted against it.
      this._c.index = new DocumentIndex(ast, this._c.result.graph);
      this._c.ms = now() - t0;
    }
    return this._c.result;
  }

  /** All diagnostics (syntax + evaluation), sorted, with line / column. */
  getDiagnostics() {
    if (this._c.diags) return this._c.diags;
    const bag = new DiagnosticBag();
    bag.merge(this.getAST().diagnostics);
    bag.merge(this.evaluate().diagnostics);
    const lines = this.getCST().lines;
    this._c.diags = bag.sorted().map(d => {
      let line = d.line;
      if (line == null && d.start != null) line = lineAt(lines, d.start);
      const L = line != null ? lines[line] : null;
      return { ...d, line, column: L && d.start != null ? Math.max(0, d.start - L.start) : null, source: L ? L.text : '' };
    });
    return this._c.diags;
  }

  /** Nodes (headings) in document order. */
  getNodes() {
    return this.getAST().nodes.map(n => ({
      id: n.id, name: n.name, key: n.key, level: n.level, line: n.line,
      entry: n.entry, scenario: n.scenario, parent: n.parent && !n.parent.isRoot ? n.parent.id : null
    }));
  }

  /** Finds a node by id; spaces and case are ignored ("Barmen Talk" == "barmentalk"). */
  findNode(id) {
    const hit = this.getAST().byKey.get(nodeKey(id));
    return hit ? hit[0] : null;
  }

  /** Value of a variable / property path as seen from the end of a node (or of the document). */
  getValue(name, opts = {}) {
    const r = this.evalExpression(String(name), opts);
    if (r.error) throw new LSError(r.error);
    return r.value;
  }

  /**
   * Evaluates an expression against the current edit-time state.
   * @returns {{value:*, display:string, type:string, error:string|null}}
   */
  evalExpression(src, { node = null } = {}) {
    this.evaluate();
    const interp = this._c.interp;
    const n = node ? (typeof node === 'string' ? this.findNode(node) : node) : this.getAST().root;
    if (!n) return { value: '', display: '', type: 'null', error: `Node "${node}" not found` };
    try {
      const { ast } = parseExpression(src);
      const quietDiags = interp.diags;
      interp.diags = new DiagnosticBag();             // do not pollute document diagnostics
      try {
        const value = interp.eval(ast, { node: n, pos: Infinity, base: 0 });
        const warn = interp.diags.items[0];
        return { value, display: format(value), type: typeOf(value), error: null, warning: warn ? warn.message : null };
      } finally { interp.diags = quietDiags; }
    } catch (e) {
      return { value: '', display: '', type: 'null', error: e.message };
    }
  }

  /** Table models (after evaluation). */
  getTables() { this.evaluate(); return this.getAST().units.filter(u => u.kind === 'table').map(u => u.model); }
  getTable(name) { this.evaluate(); return this._c.result.state.tables.get(String(name).toLowerCase()) || null; }

  /**
   * Serializable summary of the evaluated document. Consumers (the editor,
   * the worker protocol) only need this object.
   */
  snapshot() {
    const ast = this.getAST();
    const res = this.evaluate();
    // diagnostics raised inside %inline% chips are shown on the chips themselves
    const chips = ast.units.filter(u => u.kind === 'inline');
    const inChip = d => d.start != null && chips.some(u => d.start >= u.start && d.start < u.end);
    const diagnostics = this.getDiagnostics().map(d => ({
      severity: d.severity, code: d.code, message: d.message, line: d.line, column: d.column,
      start: d.start, end: d.end, lineText: d.lineText || '', source: d.source, inline: inChip(d)
    }));
    const inlines = ast.units.filter(u => u.kind === 'inline').map(u => {
      const r = res.inlines.get(u.uid) || { value: '', error: null };
      return { uid: u.uid, raw: u.raw, expr: u.exprText, isExpr: u.isExpr, line: u.line, start: u.start, end: u.end, container: u.container, inComment: u.inComment, value: format(r.value), type: typeOf(r.value), error: r.error };
    });
    const tables = ast.units.filter(u => u.kind === 'table' && u.model).map(u => {
      const t = u.model;
      return {
        name: t.name, valid: t.valid, line: u.line, start: u.start, end: u.end,
        rows: t.grid.map(row => row.map(c => ({
          text: c.decl ? c.decl.text : '', formula: c.formula,
          display: c.formula ? (c.state === 'error' ? '#ERROR' : format(c.value)) : (c.decl ? c.decl.text : ''),
          error: c.error
        })))
      };
    });
    const conds = ast.units.filter(u => u.kind === 'cond' && u.form !== 'close').map(u => ({
      uid: u.uid, line: u.line, start: u.start, end: u.end, form: u.form, mode: u.mode, value: u.mode === 'edit' ? res.conds.get(u.uid) ?? null : null
    }));
    // The order of the variables is the order of their declaration (the order
    // of the lines), so that it does not depend on what was counted before.
    const vars = res.state.allVariables().filter(v => v.state !== 'builtin')
      .sort((a, b) => (a.line - b.line) || (a.ns.label < b.ns.label ? -1 : a.ns.label > b.ns.label ? 1 : 0) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .map(v => ({
        ns: v.ns.label, name: v.name, value: format(v.value), type: typeOf(v.value), state: v.state, line: v.line,
        start: v.decl ? v.decl.start : null, end: v.decl ? v.decl.end : null, error: v.error
      }));
    // What has changed since the last snapshot: the editor paints only these
    // elements, the rest of the document is left as it is.
    const changes = this._changes({ inlines, tables, conds, vars });
    return {
      version: this.version,
      nodes: this.getNodes(),
      entryPoints: ast.nodes.filter(n => n.entry).map(n => n.id),
      inlines, tables, conds, vars, diagnostics, changes,
      stats: {
        nodes: ast.nodes.length, units: ast.units.length, vars: vars.length, tables: tables.length,
        errors: diagnostics.filter(d => d.severity === 'error').length,
        warnings: diagnostics.filter(d => d.severity === 'warning').length,
        ms: Math.round((this._c.ms || 0) * 10) / 10
      }
    };
  }

  /**
   * What has changed since the last snapshot: the elements whose value is not
   * the same as it was.  The first snapshot has nothing to compare with, so it
   * returns null (the editor paints everything then).
   * @param {object} now the values of this snapshot
   */
  _changes(now) {
    const prev = this._prev;
    this._prev = now;
    if (!prev) return null;
    const map = (list, key) => { const m = new Map(); list.forEach(x => m.set(key(x), x)); return m; };
    const pIn = map(prev.inlines, x => x.uid);
    const pCo = map(prev.conds, x => x.uid);
    const pVa = map(prev.vars, x => x.ns + '.' + x.name);
    const pTa = map(prev.tables, x => x.name);
    const changed = {
      inlines: now.inlines.filter(i => { const p = pIn.get(i.uid); return !p || p.value !== i.value || p.error !== i.error; }),
      conds: now.conds.filter(c => { const p = pCo.get(c.uid); return !p || p.value !== c.value; }),
      vars: now.vars.filter(v => { const p = pVa.get(v.ns + '.' + v.name); return !p || p.value !== v.value || p.error !== v.error; }),
      tables: now.tables.filter(t => {
        const p = pTa.get(t.name);
        if (!p || p.rows.length !== t.rows.length) return true;
        for (let r = 0; r < t.rows.length; r++) {
          if (p.rows[r].length !== t.rows[r].length) return true;
          for (let c = 0; c < t.rows[r].length; c++) {
            if (p.rows[r][c].display !== t.rows[r][c].display || p.rows[r][c].error !== t.rows[r][c].error) return true;
          }
        }
        return false;
      })
    };
    // the tables keep their place in the list of the snapshot
    changed.tableIndexes = now.tables.map((t, i) => (changed.tables.indexOf(t) >= 0 ? i : -1)).filter(i => i >= 0);
    // The ranges of the text that have changed: the editor finds by them the
    // blocks of the document that it has to paint again.
    const spans = [];
    for (const x of changed.inlines) if (x.start != null) spans.push([x.start, x.end]);
    for (const x of changed.conds) if (x.start != null) spans.push([x.start, x.end]);
    for (const x of changed.vars) if (x.start != null) spans.push([x.start, x.end]);
    for (const x of changed.tables) if (x.start != null) spans.push([x.start, x.end]);
    spans.sort((a, b) => a[0] - b[0]);
    const ranges = [];
    for (const sp of spans) {
      const last = ranges[ranges.length - 1];
      if (last && sp[0] <= last[1]) { if (sp[1] > last[1]) last[1] = sp[1]; }
      else ranges.push([sp[0], sp[1]]);
    }
    changed.ranges = ranges;
    // The blocks that have changed: the editor paints the blocks, not the
    // elements (the core knows which block holds which value).  The ranges are
    // the places of the blocks in the text.
    const blocks = [];
    for (const x of [...changed.inlines, ...changed.conds, ...changed.vars, ...changed.tables]) {
      if (x.start == null) continue;
      const b = this._c.index.blockAt(x.start);
      if (b && !blocks.includes(b)) blocks.push(b);
    }
    changed.blockRanges = blocks.map(b => [b.start, b.end]);
    // The blocks that have changed and the values in them: the editor paints
    // the blocks, the core knows the values.
    changed.blocks = blocks.map(b => {
      const values = this._c.index.valuesOfBlock(b);
      const uids = [];
      for (const x of [...changed.inlines, ...changed.conds, ...changed.vars, ...changed.tables]) {
        if (x.start == null) continue;
        const bb = this._c.index.blockAt(x.start);
        if (bb === b) uids.push(x.uid || (x.ns ? x.ns + '.' + x.name : x.name || ''));
      }
      return { start: b.start, end: b.end, uids, values: { chips: values.chips.length, conds: values.conds.length, vars: values.vars.length, tables: values.tables.length } };
    });
    return changed;
  }

  /* ---------------- export (export.js, docs/EXPORT.md) ---------------- */

  /** Scenario model + localization table: { scenario, strings, warnings }. */
  exportScenario(opts = {}) { this.evaluate(); return exportScenario(this, opts); }
  /** Tables with computed values: { tables: [{name, data}], warnings }. */
  exportTables() { this.evaluate(); return exportTables(this); }
  /** Export files: { files: [{name, data}], warnings, count } (see exportFiles). */
  exportFiles(opts) { this.evaluate(); return exportFiles(this, opts); }

  /** Round-trip check used by tests and debugging. */
  isLossless() { return printCST(this.getCST()) === this._text; }

  /* ---------------- internals ---------------- */

  _commit(text, history, keep, edits) {
    if (history && !this._tx) { this._undo.push(this._text); this._redo = []; }
    this._set(text, keep, edits);
    if (!this._tx) this._emit('change', { version: this.version });
  }
  _set(text, keep, edits) { const old = this._text; this._text = text; this.version++; this._invalidate(keep, edits, old); }
  _invalidate(keep, edits, oldText) {
    // The tree of the blocks survives the change: only the changed block is
    // parsed again, the other blocks are the same objects (their places move).
    const prev = (this._c && this._c.cst) || null;
    this._c = {};
    if (prev && edits && edits.length === 1) {
      if (this._tokCache.size > MAX_LINE_CACHE) this._tokCache.clear();
      const next = rebuildCST(prev, oldText || '', edits[0], this._text, this._tokCache);
      if (next) { this._c.cst = next; this._cstInc++; } else this._cstFull++;
    } else if (prev) this._cstFull++;
    // the whole document was replaced: the state of the computation is of no use
    if (!keep) { this._invalidated = null; this._comp = null; this._changedLines = null; }
  }
  _emit(type, ev) { const s = this._listeners.get(type); if (s) s.forEach(fn => fn(ev, this)); }

  /** Import loader: builds and evaluates the imported document (with cycle protection). */
  _importer() {
    const resolve = this.opts.resolveFile;
    if (!resolve) return null;
    const stack = this.opts._importStack || [];
    return file => {
      if (stack.includes(file)) throw new LSError(`Circular import of "${file}"`);
      const text = resolve(file);
      if (text == null) return null;
      const sub = new MarklarDocument(text, { ...this.opts, _importStack: [...stack, file] });
      sub.evaluate();
      return { state: sub._c.result.state, ast: sub.getAST() };
    };
  }
}

/** Creates a document. */
function createDocument(text = '', opts = {}) { return new MarklarDocument(text, opts); }

/** The lines of the new text that the edits have touched. */
function changedLines(edits, text) {
  const lines = splitLines(text);
  const sorted = edits.slice().sort((a, b) => a.start - b.start);
  let shift = 0, from = Infinity, to = -1;
  for (const e of sorted) {
    const at = e.start + shift;
    const a = lineAt(lines, at), b = lineAt(lines, at + (e.text || '').length);
    if (a < from) from = a;
    if (b > to) to = b;
    shift += (e.text || '').length - (e.end - e.start);
  }
  return from === Infinity ? null : { from, to };
}

function lineAt(lines, offset) {
  let lo = 0, hi = lines.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (lines[mid].start <= offset) lo = mid; else hi = mid - 1; }
  return lo;
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

module.exports = { MarklarDocument, createDocument };
