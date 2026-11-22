/* Marklar Core - elementindex.js
   Dependencies: none
   The index of the elements of the document and their links. */
/**
 * Marklar Core — the index of the document.
 *
 * The document is a tree of elements: the nodes of the scenario (the
 * headings) are the tree of the scopes of visibility, the units (the
 * statements, the formulas, the cells) are the elements with the values.
 * Every unit knows its line, so a range of the text is found by a binary
 * search.
 *
 * The links between the elements are two:
 *   - the graph of the dependencies (`dependency.js`): who reads what;
 *   - the tree of the scopes: the unit belongs to a node, the variables of
 *     the node and of its parents are visible in it.
 *
 * When an element changes, the elements that depend on it are known
 * exactly: they are the readers of the keys it writes (the graph) and the
 * units of the subtree of its scope (the tree).  Nothing else is touched.
 */
class DocumentIndex {
  /**
   * @param {object} ast the semantic tree (the units and the nodes)
   * @param {object} graph the graph of the dependencies
   */
  constructor(ast, graph) {
    this.ast = ast;
    this.graph = graph || { reads: new Map(), writes: new Map(), readers: new Map(), writers: new Map(), dependentsOf: () => [] };
    this.units = (ast && ast.units) || [];
    this.nodes = (ast && ast.nodes) || [];
    // the lines of the units (the units are in the order of the document, so
    // the lines do not go back)
    this._lines = this.units.map(u => u.line);
    // the units of every node of the tree of the scopes
    this._byNode = new Map();
    this._byUid = new Map();
    // the tables of the document: the cells of a table belong to it, so a
    // change of a cell moves the table and everything that reads it
    this._tables = new Map();
    // The blocks of the document (the blocks of the CST): every unit lies in
    // one of them.  The block is the unit of the painting: the editor paints
    // the block, not the element; and it is the unit of the rebuild of the
    // tree: the tree of the block that has not changed is not built again.
    this.blocks = (ast && ast.blocks) || [];
    this._blockUnits = null;      // the units of the blocks: counted on demand
    this._blockOfUid = null;
    this._blockNo = new Map();
    this.blocks.forEach((b, i) => this._blockNo.set(b, i));
    for (const u of this.units) {
      this._byUid.set(u.uid, u);
      if (u.kind === 'table' && u.table && u.table.name) this._tables.set(u.table.name, u);
      if (!u.node) continue;
      let list = this._byNode.get(u.node.uid);
      if (!list) { list = []; this._byNode.set(u.node.uid, list); }
      list.push(u);
    }
  }

  /** Every unit belongs to the block of the CST that holds it (counted on demand). */
  _indexBlocks() {
    if (this._blockUnits) return;
    this._blockUnits = this.blocks.map(() => []);
    this._blockOfUid = new Map();
    if (!this.blocks.length) return;
    let bi = 0;
    for (const u of this.units) {
      if (u.start == null) continue;
      while (bi + 1 < this.blocks.length && this.blocks[bi].end <= u.start) bi++;
      const b = this.blocks[bi];
      if (!b || u.start < b.start || u.start >= b.end) continue;
      this._blockUnits[bi].push(u);
      this._blockOfUid.set(u.uid, bi);
    }
  }

  /** The block that holds the place of the text (the blocks are in the order of the document). */
  blockAt(offset) {
    const bs = this.blocks;
    if (!bs.length || offset == null) return null;
    let lo = 0, hi = bs.length - 1, k = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (bs[mid].start <= offset) { k = mid; lo = mid + 1; } else hi = mid - 1; }
    if (k < 0) return null;
    const b = bs[k];
    return offset < b.end ? b : null;
  }

  /** The block of the unit (null when the unit does not lie in a block). */
  blockOf(unit) {
    if (!unit) return null;
    this._indexBlocks();
    const bi = this._blockOfUid.get(unit.uid);
    return bi === undefined ? null : this.blocks[bi];
  }

  /** The units of the block (the values that lie in it). */
  unitsOfBlock(block) {
    const bi = this._blockNo.get(block);
    if (bi === undefined) return [];
    this._indexBlocks();
    return this._blockUnits[bi] || [];
  }

  /**
   * The values of the block, by kind: the chips (%expr%), the conditions (?),
   * the variables (the statements) and the tables.  The block is what the
   * editor paints - the block holds the values.
   */
  valuesOfBlock(block) {
    const out = { chips: [], conds: [], vars: [], tables: [] };
    for (const u of this.unitsOfBlock(block)) {
      if (u.kind === 'inline') out.chips.push(u);
      else if (u.kind === 'cond') out.conds.push(u);
      else if (u.kind === 'table') out.tables.push(u);
      else if (u.kind === 'assign' || u.kind === 'text' || u.kind === 'log' || u.kind === 'transition') out.vars.push(u);
    }
    return out;
  }

  /** The blocks of the lines [from, to] (the lines of the document). */
  blocksInLines(from, to) {
    const out = [];
    for (const b of this.blocks) {
      const l = this._lineOf(b);
      if (l == null) continue;
      if (l.to < from || l.from > to) continue;
      out.push(b);
    }
    return out;
  }

  /** The lines of the block (its first and its last line). */
  _lineOf(block) {
    if (block.__lines) return block.__lines;
    let from = null, to = null;
    const walk = n => {
      if (n.line != null) { if (from === null || n.line < from) from = n.line; if (to === null || n.line > to) to = n.line; }
      for (const c of (n.children || [])) walk(c);
    };
    walk(block);
    const out = from === null ? null : { from, to };
    try { Object.defineProperty(block, '__lines', { value: out, enumerable: false }); } catch (e) { /* the block is frozen */ }
    return out;
  }

  /** The units of the lines [from, to] (the lines of the document). */
  unitsInLines(from, to) {
    const lo = this._lowerBound(from);
    const hi = this._lowerBound(to + 1);
    return this.units.slice(lo, hi);
  }

  /** The first unit of a line (the units are in the order of the document). */
  _lowerBound(line) {
    let lo = 0, hi = this._lines.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this._lines[mid] < line) lo = mid + 1; else hi = mid;
    }
    return lo;
  }

  /** The units of the subtree of a node (the node and its children). */
  unitsOfSubtree(node) {
    const out = [];
    const stack = [node];
    while (stack.length) {
      const n = stack.pop();
      for (const u of this._byNode.get(n.uid) || []) out.push(u);
      for (const c of (n.children || [])) stack.push(c);
    }
    return out;
  }

  /** The table a cell belongs to (the key of a cell: "cell:NAME!R,C"). */
  _tableOfCell(key) {
    const m = /^cell:([^!]+)!/.exec(key);
    return m ? (this._tables.get(m[1]) || null) : null;
  }

  /**
   * What has to be recalculated after a change of the lines [from, to]:
   * the units of these lines, the units that read what they write, and the
   * units of the subtree of the scope, if the change moved the scope.
   *
   * @param {number} from the first line of the change
   * @param {number} to the last line of the change
   * @returns {{units: object[], ids: Set<string>}}
   */
  invalidate(from, to) {
    const direct = this.unitsInLines(from, to);
    const ids = new Set();
    const add = u => { if (u && !ids.has(u.uid)) { ids.add(u.uid); return true; } return false; };

    for (const u of direct) add(u);

    // the units that depend on these units: the readers of the keys they
    // write, then everything that depends on them (the graph and the tree
    // of the scopes).  The walk follows the links of the document, it does
    // not walk the document itself.
    const queue = [];
    const seenKeys = new Set();
    for (const u of direct) {
      for (const k of this.graph.writes.get(u.uid) || []) {
        if (!seenKeys.has(k)) { seenKeys.add(k); queue.push(k); }
      }
    }
    while (queue.length) {
      const k = queue.shift();
      for (const id of this.graph.readers.get(k) || []) {
        const u = this._byUid.get(id);
        const isNew = add(u);
        // a cell belongs to its table: the table is moved by the cell, and
        // everything that reads the table depends on it
        const table = this._tableOfCell(id);
        if (table) {
          add(table);
          const tk = 'table:' + table.table.name;
          if (!seenKeys.has(tk)) { seenKeys.add(tk); queue.push(tk); }
        }
        if (!isNew) continue;
        for (const w of this.graph.writes.get(id) || []) {
          if (!seenKeys.has(w)) { seenKeys.add(w); queue.push(w); }
        }
      }
    }

    // a table: a change in any of its lines moves the table (its formulas and
    // everything that reads it)
    for (const u of this.units) {
      if (u.kind !== 'table' || !u.table) continue;
      if (from > u.table.endLine || to < u.table.line) continue;
      add(u);
    }

    // the scope: a changed heading moves the scope of the units under it
    for (const n of this.nodes) {
      if (n.line < from || n.line > to) continue;
      for (const x of this.unitsOfSubtree(n)) add(x);
    }

    return { units: direct, ids };
  }
}

module.exports = { DocumentIndex };
