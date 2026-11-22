/* Marklar Core - tables.js
   Dependencies: text, values, parser
   Generated from the mono core bundle by tools/extract_core.py. */
/**
 * Marklar Core — Table Engine.
 *
 * Spec ("The policy of the tables"): a table is a class declaration.
 *
 *   | NPC         | Speed | Weapon | Health           |
 *   | Old Warrior | 5     | sword  | =this.Speed*20   |
 *   | Skeleton    | 2     | bone   | =OldWarrior.Health/2 |
 *
 *   - A1 holds the table (class / namespace) name;
 *   - B1, C1, … are property names, A2, A3, … object ids;
 *   - whitespace is removed from ids ("Old Warrior" → OldWarrior);
 *   - rows/columns without a valid id are still computed and addressable
 *     Excel-style (A1, B2:C5), but excluded from object addressing;
 *   - a cell starting with "=" is a formula; everything else is a static value.
 *
 * Addressing implemented here (see `access` and `select`):
 *   NPC, NPC.NPC              → list of object ids
 *   NPC.Speed                 → column values (a property of every object)
 *   NPC.OldWarrior            → the object's property values
 *   NPC.OldWarrior.Speed      → one value (a list when several rows share the id;
 *                               a one-element list collapses to the element)
 *   NPC.B2                    → a cell from outside the table
 *   Country.[Russia, Moscow].Population → filter rows by the first columns
 *   NPC.Skeleton.[Speed:Health]         → property slice
 *   inside formulas: this.Speed, this.A, this.[A:B], A1, $A$1, A1:B5
 *
 * Formula evaluation itself is delegated to the interpreter through the
 * `evalFormula(table, cell)` hook, which keeps this module free of scope rules.
 */
const { nameKey, nodeKey, isValidName, joinWords } = require('./text.js');
const { LSError, NULL, valueFromText, format } = require('./values.js');
const { parseCellRef, columnName } = require('./parser.js');

/** One table cell with its lazily computed value. */
class Cell {
  constructor(decl, row, col) {
    this.decl = decl;                 // semantic cell (text, formula, expr, start, end, line, exprStart)
    this.row = row;                   // 0-based grid row (0 = header)
    this.col = col;                   // 0-based column (0 = A)
    this.ref = columnName(col) + (row + 1);
    this.formula = !!(decl && decl.formula);
    /** 'static' | 'pending' | 'evaluating' | 'done' | 'error' */
    this.state = this.formula ? 'pending' : 'static';
    this.value = this.formula ? NULL : valueFromText(decl ? decl.text : '');
    this.error = null;
  }
}

/** Object model of one table. */
class TableModel {
  /** @param {object} decl semantic table (semantic.js) */
  constructor(decl) {
    this.decl = decl;
    this.uid = decl.uid;
    this.node = decl.node;
    this.name = decl.name;
    this.key = nameKey(decl.name);
    this.valid = decl.valid;
    this.label = decl.valid ? decl.name : `Table@${decl.line + 1}`;
    const rowsDecl = [decl.header || [], ...decl.rows];
    this.width = Math.max(1, ...rowsDecl.map(r => r.length));
    /** @type {Cell[][]} grid[row][col], row 0 is the header */
    this.grid = rowsDecl.map((r, ri) => Array.from({ length: this.width }, (_, ci) => new Cell(r[ci] || null, ri, ci)));
    /** properties (columns B…) */
    this.props = [];
    for (let c = 1; c < this.width; c++) {
      const text = rowsDecl[0][c] ? rowsDecl[0][c].text : '';
      const id = joinWords(text);
      this.props.push({ col: c, id, key: nameKey(id), valid: isValidName(id) && !id.includes('.') });
    }
    /** objects (rows 2…) */
    this.objects = [];
    for (let r = 1; r < this.grid.length; r++) {
      const text = rowsDecl[r][0] ? rowsDecl[r][0].text : '';
      const id = joinWords(text);
      this.objects.push({ row: r, id, key: nameKey(id), valid: isValidName(id) && !id.includes('.') });
    }
    /** hook installed by the interpreter: (table, cell) → value */
    this.evalFormula = null;
  }

  /**
   * The identity of a cell: the id of its row and the id of its column
   * (idRow.idHeader).  It is bound to the cell and moves with it when the
   * table changes - unlike the address by position (A2), which is a place in
   * the table and changes with it.
   */
  cellIdentity(row, col) {
    const obj = this.objects[row - 1];
    const prop = this.props[col - 1];
    if (obj && prop && obj.valid && prop.valid) return nameKey(obj.id) + '.' + nameKey(prop.id);
    return null;
  }

  /**
   * All the names of a cell: its place (A2) and its identity (Warrior.Armor).
   * A cell is read and invalidated under both of them - the place is what a
   * formula writes, the identity is what survives a change of the structure.
   */
  cellKeys(row, col) {
    const keys = [this.grid[row][col].ref];
    const id = this.cellIdentity(row, col);
    if (id) keys.push(id);
    return keys;
  }

  /* ---------------- lookup helpers ---------------- */

  /** Column index of a property name or a column letter ("Speed", "B"). */
  colOf(name, { letters = true } = {}) {
    const k = nameKey(name);
    const p = this.props.find(x => x.valid && x.key === k);
    if (p) return p.col;
    if (letters && /^[A-Za-z]{1,3}$/.test(name)) {
      const pos = parseCellRef(name + '1');
      if (pos && pos.col < this.width) return pos.col;
    }
    return -1;
  }
  /** Grid rows of the valid objects with the given id. */
  rowsOf(id) {
    const k = nameKey(id);
    return this.objects.filter(o => o.valid && o.key === k).map(o => o.row);
  }
  hasObject(id) { return this.rowsOf(id).length > 0; }
  hasProp(name) { return this.colOf(name, { letters: false }) >= 0; }

  /* ---------------- values ---------------- */

  /** Value of a cell, evaluating its formula on first access. */
  cellValue(row, col) {
    if (row < 0 || col < 0 || row >= this.grid.length || col >= this.width) {
      throw new LSError(`Cell ${columnName(Math.max(col, 0))}${row + 1} is outside the table`, { code: 'ref' });
    }
    const cell = this.grid[row][col];
    // the cell is read: the core knows now who reads it
    if (this.onRead) this.onRead(row, col);
    if (cell.state === 'static' || cell.state === 'done') return cell.value;
    if (cell.state === 'error') throw new LSError(`${cell.ref}: ${cell.error}`, { code: 'ref-error' });
    if (cell.state === 'evaluating') throw new LSError(`Circular reference through cell ${cell.ref}`, { code: 'cycle' });
    cell.state = 'evaluating';
    try {
      cell.value = this.evalFormula ? this.evalFormula(this, cell) : NULL;
      cell.state = 'done';
      return cell.value;
    } catch (e) {
      cell.state = 'error';
      cell.error = e.message.replace(/^Error in cell [^:]+: /, '');
      cell.value = NULL;
      throw e;
    }
  }
  /** "B2" → value. */
  refValue(ref) {
    const pos = parseCellRef(ref);
    if (!pos) throw new LSError(`Invalid cell reference "${ref}"`, { code: 'ref' });
    return this.cellValue(pos.row, pos.col);
  }
  /** A1:B5 → values in row-major order. */
  rangeValues(from, to) {
    const r0 = Math.min(from.row, to.row), r1 = Math.max(from.row, to.row);
    const c0 = Math.min(from.col, to.col), c1 = Math.max(from.col, to.col);
    const out = [];
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) out.push(this.cellValue(r, c));
    return out;
  }
  /** Ids of all valid objects (spec: "NPC.NPC"). */
  ids() { return this.objects.filter(o => o.valid).map(o => o.id); }
  /** Values of a column for every valid object (spec: "Country.Population"). */
  column(col) { return this.objects.filter(o => o.valid).map(o => this.cellValue(o.row, col)); }
  /** Property values of one row (valid properties only). */
  rowValues(row) { return this.props.filter(p => p.valid).map(p => this.cellValue(row, p.col)); }
  /** Property slice of one row: [From:To] by property names or column letters. */
  slice(row, from, to) {
    const a = this.colOf(from), b = this.colOf(to);
    if (a < 0) throw new LSError(`Unknown property "${from}" in table ${this.label}`, { code: 'unknown-name' });
    if (b < 0) throw new LSError(`Unknown property "${to}" in table ${this.label}`, { code: 'unknown-name' });
    const out = [];
    for (let c = Math.min(a, b); c <= Math.max(a, b); c++) out.push(this.cellValue(row, c));
    return out;
  }

  /* ---------------- addressing ---------------- */

  /**
   * Resolves a dotted path relative to the table namespace.
   * @param {string[]} rest path after the table name ([] → list of ids)
   */
  access(rest) {
    if (!rest.length) return this.ids();
    const [first, ...more] = rest;
    if (nameKey(first) === this.key && !more.length) return this.ids();          // NPC.NPC
    const rows = this.rowsOf(first);
    if (rows.length) {                                                           // NPC.OldWarrior[.Speed]
      if (!more.length) return collapse(rows.map(r => this.rowValues(r)));
      if (more.length > 1) throw new LSError(`Unknown member "${rest.join('.')}" of table ${this.label}`, { code: 'unknown-name' });
      const col = this.colOf(more[0]);
      if (col < 0) throw new LSError(`Object ${first} of table ${this.label} has no property "${more[0]}"`, { code: 'unknown-name' });
      return collapse(dropEmpty(rows.map(r => this.cellValue(r, col))));
    }
    if (!more.length) {
      const col = this.colOf(first, { letters: false });
      if (col >= 0) return this.column(col);                                     // Country.Population
      const pos = parseCellRef(first);
      if (pos) return this.cellValue(pos.row, pos.col);                          // NPC.B2
    }
    throw new LSError(`Unknown member "${rest.join('.')}" of table ${this.label}`, { code: 'unknown-name' });
  }

  /**
   * Composite-key selector: rows whose first columns match `keys`
   * (case- and whitespace-insensitive text comparison).
   * @returns {number[]} grid rows
   */
  filterRows(keys) {
    const want = keys.map(k => nodeKey(format(k)));
    const out = [];
    for (let r = 1; r < this.grid.length; r++) {
      let ok = true;
      for (let i = 0; i < want.length && ok; i++) {
        if (i >= this.width) { ok = false; break; }
        ok = nodeKey(format(this.cellValue(r, i))) === want[i];
      }
      if (ok) out.push(r);
    }
    return out;
  }

  /** Table.[k1, k2].Member — returns the member values of the matching rows. */
  selectRows(keys, member) {
    const rows = this.filterRows(keys);
    if (!member) return collapse(rows.map(r => format(this.cellValue(r, 0))));
    const col = this.colOf(member);
    if (col < 0) throw new LSError(`Table ${this.label} has no property "${member}"`, { code: 'unknown-name' });
    return collapse(dropEmpty(rows.map(r => this.cellValue(r, col))));
  }

  /** Every formula cell (for display after evaluation). */
  formulaCells() { return this.grid.flat().filter(c => c.formula); }
}

/**
 * Empty cells are skipped when several objects share an id: in the spec,
 * Country.Russia.SomeInformation is a single string although "Russia" has two rows.
 */
function dropEmpty(list) { return list.length > 1 ? list.filter(v => v !== NULL) : list; }

/** A one-element collection is returned as the element itself (spec example "SomeInformation"). */
function collapse(list) { return list.length === 1 ? list[0] : list; }

module.exports = { Cell, TableModel, collapse };
