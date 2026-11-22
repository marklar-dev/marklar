/* Marklar Core - export.js
   Dependencies: values, formats, lexer, parser, text
   Generated from the mono core bundle by tools/extract_core.py. */
/**
 * Marklar Core — data export (spec "Data export").
 *
 *   1. Scenarios and tables are exported separately; all other text is ignored.
 *   2. All scenarios go to one file; every table goes to its own file.
 *   3. JSON, XML or YAML: the data structure does not depend on the format
 *      (see formats.js).
 *   4. Numbers stay numbers, text stays text, null is "", booleans are numbers.
 *   5. Tables contain computed values, not formulas.
 *   6. Scenarios keep code and expressions in source form.
 *   7. All scenario text goes to a separate localization table ("strings"):
 *      text blocks become string ids, and string literals inside code and
 *      expressions (also inside %=expr% of a text) become inline references
 *      @{Id} (see localizeExpr).
 *   8. Scenario nodes: headings marked "->" (and their children), and every
 *      node that is the target of a "->" transition (including ternaries).
 *
 * The full format is documented in docs/EXPORT.md. This module only builds
 * plain JS objects; serialization lives in formats.js, packaging in zip.js.
 */
const { NULL, isList } = require('./values.js');
const { serialize, toJSON, EXTENSIONS } = require('./formats.js');
const { tokenize } = require('./lexer.js');
const { columnName } = require('./parser.js');
const { unescapeMd, stripInlineMarks } = require('./text.js');


/* ================================================================ values */

/** Converts a Marklar value to an export value (numbers, strings, arrays). */
function exportValue(v) {
  if (isList(v)) return v.map(exportValue);
  if (v === null || v === undefined) return NULL;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number') return Number.isFinite(v) ? v : NULL;
  return String(v);
}

/* ================================================================ tables */

/**
 * Exports the tables of an evaluated document.
 * Only tables whose first cell (the class name) is a valid id are exported;
 * they are exported completely — every row and every column, whether or not
 * the row / column has a valid id. Repeated class names get "_2", "_3".
 * @param {import('./document.js').MarklarDocument} doc
 * @returns {{tables: Array<{name:string, data:object}>, warnings:string[]}}
 */
function exportTables(doc) {
  const warnings = [];
  const used = new Set();
  const tables = [];
  for (const t of doc.getTables()) {
    if (!t.valid) continue;
    const name = unique(t.name, used);
    tables.push({ name, data: tableData(t, name, warnings) });
  }
  return { tables, warnings };
}

/** `base`, or `base_2`, `base_3`… when already used (case-insensitive). */
function unique(base, used) {
  let name = base;
  for (let k = 2; used.has(name.toLowerCase()); k++) name = `${base}_${k}`;
  used.add(name.toLowerCase());
  return name;
}
/** Cell text as the reader sees it: formatting marks and escapes removed. */
function plainCell(t, row, col) {
  const d = t.grid[row][col].decl;
  return d ? unescapeMd(stripInlineMarks(d.text)).replace(/\s+/g, ' ').trim() : '';
}

/**
 * Object model of one table with computed values.
 *   property key: the property id ("Some information" → SomeInformation); when the
 *                 header is not a valid id — its text as written; empty — the column letter
 *   object key:   the object id; when not a valid id — the cell text as written;
 *                 empty — "Row<N>" (N is the table row number, header = 1)
 */
function tableData(t, name, warnings) {
  const value = (row, col) => {
    try { return t.cellValue(row, col); }
    catch (e) { warnings.push(`${name}: cell ${t.grid[row][col].ref} has an error (${t.grid[row][col].error || e.message}), exported as ""`); return NULL; }
  };
  const usedProps = new Set();
  const props = t.props.map(p => ({ col: p.col, key: unique(p.valid ? p.id : (plainCell(t, 0, p.col) || columnName(p.col)), usedProps) }));
  // rows with the same object id form one object (case-insensitive for valid ids)
  const groups = new Map();        // group key → { key, rows }
  const usedObjs = new Set();
  for (const o of t.objects) {
    const text = o.valid ? o.id : plainCell(t, o.row, 0);
    const g = text ? (o.valid ? 'id:' + o.key : 'text:' + text) : 'row:' + o.row;
    if (!groups.has(g)) groups.set(g, { key: unique(text || `Row${o.row + 1}`, usedObjs), rows: [] });
    groups.get(g).rows.push(o.row);
  }
  const objects = {};
  for (const { key, rows } of groups.values()) {
    const obj = {};
    for (const p of props) {
      // several rows with the same id: the property is a list (empty cells skipped);
      // a one-element list is the element itself — as in the table addressing rules
      let list = rows.map(r => value(r, p.col));
      if (list.length > 1) list = list.filter(v => v !== NULL);
      obj[p.key] = exportValue(list.length === 1 ? list[0] : list);
    }
    objects[key] = obj;
  }
  return { table: name, properties: props.map(p => p.key), objects };
}

/* ================================================================ scenarios */

/**
 * The tags at the beginning of the text of the "::" operator ("#tag1 #tag2",
 * "#tag1, #tag2 #tag3"): they are cut out of the text — they are not a part
 * of the localisation text — and they go into the field "tags" of the string.
 * The tags can be listed through a comma or through a space.
 * @param {string} text
 * @returns {{text:string, tags:string[]}}
 */
function cutTags(text) {
  const tag = '#[A-Za-z][A-Za-z0-9_]*(?:\\.[A-Za-z_][A-Za-z0-9_]*)*';
  const first = new RegExp('^[ \\t]*(' + tag + ')');
  const next = new RegExp('^[ \\t]*,?[ \\t]*(' + tag + ')');
  const m = first.exec(String(text));
  if (!m) return { text: String(text), tags: [] };
  const tags = [m[1].slice(1)];
  let rest = String(text).slice(m[0].length);
  for (;;) {
    const t = next.exec(rest);
    if (!t) break;
    tags.push(t[1].slice(1));
    rest = rest.slice(t[0].length);
  }
  return { text: rest.replace(/^[ \\t]+/, ''), tags };
}

/**
 * Exports all scenario nodes of a document.
 * @param {import('./document.js').MarklarDocument} doc
 * @param {{source?:string, stringsFile?:string, tableNames?:string[]}} [opts]
 * @returns {{scenario:object, strings:object, warnings:string[]}}
 */
function exportScenario(doc, opts = {}) {
  const ast = doc.getAST();
  const warnings = [];
  const strings = [];
  const ids = assignNodeIds(ast.nodes);
  const counters = new Map();
  /** Adds a string to the localization table and returns its id. */
  const str = (node, kind, text) => {
    const nid = ids.get(node.uid) || 'Global';
    const n = (counters.get(nid) || 0) + 1;
    counters.set(nid, n);
    const id = `${nid}.${n}`;
    // "original" — the text as written in the document; translations are added
    // next to it under language codes ("en", "ru", …) when the locale is edited
    strings.push({ id, node: nid, kind, original: text });
    return id;
  };
  /** Expression source with every non-empty string literal replaced by @{Id}. */
  const loc = (node, expr) => localizeExpr(expr, lit => str(node, 'literal', lit));
  /** Text string: registered first, then literals of its %=expr% parts (document order). */
  const textStr = (node, kind, text, tags) => {
    const id = str(node, kind, '');
    strings[strings.length - 1].original = localizeInline(text, e => loc(node, e));
    // the tags of the text of the "::" operator ("#tag1 #tag2")
    if (tags && tags.length) strings[strings.length - 1].tags = tags.join(', ');
    return id;
  };
  /** Text with "||" alternatives → { id } or { variants: [ids] }; null when empty. */
  const textRef = (node, kind, text) => {
    // the tags are cut out before the randomisation of the alternatives ("||")
    let tags = null;
    if (kind === 'log') { const c = cutTags(text); text = c.text; tags = c.tags; }
    const parts = variantsOf(text);
    if (!parts.length) {
      // the text can be empty: only the tags are written
      if (!tags || !tags.length) return null;
      return { id: textStr(node, kind, '', tags) };
    }
    if (parts.length === 1) return { id: textStr(node, kind, parts[0], tags) };
    return { variants: parts.map(p => textStr(node, kind, p, tags)) };
  };
  const targetId = t => {
    if (t.node && ids.has(t.node)) return ids.get(t.node);
    warnings.push(`Transition target "${t.text}" not found`);
    return t.text.replace(/\s+/g, '');
  };

  const byNode = new Map();
  for (const u of ast.units) {
    if (!byNode.has(u.node.uid)) byNode.set(u.node.uid, []);
    byNode.get(u.node.uid).push(u);
  }
  const ctx = { str, loc, textRef, targetId };

  // initialization code: statements of non-scenario nodes (runtime step 1–2:
  // the global namespace is computed before a scenario is entered)
  const init = [];
  for (const n of [ast.root, ...ast.nodes]) {
    if (n.scenario) continue;
    const units = (byNode.get(n.uid) || []).filter(u => u.kind === 'assign' || u.kind === 'cond' || u.kind === 'import');
    const steps = buildSteps(units, ctx, { code: true, node: n });
    if (steps.length) init.push({ node: n.isRoot ? null : ids.get(n.uid), do: steps });
  }

  const nodes = {};
  for (const n of ast.nodes) {
    if (!n.scenario) continue;
    const units = byNode.get(n.uid) || [];
    // body first, then options: string ids follow the document order
    const body = buildSteps(units.filter(u => !u.bullet && u.kind !== 'bullet'), ctx, { node: n });
    const options = units.filter(u => u.kind === 'bullet').map(b => buildOption(b, units.filter(u => u.bullet === b), n, ctx));
    const parent = n.parent && !n.parent.isRoot && n.parent.scenario ? ids.get(n.parent.uid) : null;
    const out = { name: n.name, level: n.level };
    if (n.entry) out.entry = true;
    if (parent) out.parent = parent;
    const kids = n.children.filter(c => c.scenario).map(c => ids.get(c.uid));
    if (kids.length) out.children = kids;
    out.body = body;
    out.options = options;
    nodes[ids.get(n.uid)] = out;
  }

  // entry points: marked "->" headings without a marked ancestor
  const entryPoints = ast.nodes.filter(n => n.entry && !hasEntryAncestor(n)).map(n => ids.get(n.uid));
  const scenario = {
    source: opts.source || null,
    strings: opts.stringsFile || null,
    tables: opts.tableNames || [],
    entryPoints, init, nodes
  };
  return { scenario, strings: { source: opts.source || null, strings }, warnings };
}

/** Unique export id of every node: the heading id ("Barmen Talk" → BarmenTalk); duplicates get "_2", "_3". */
function assignNodeIds(nodes) {
  const ids = new Map(), used = new Set();
  for (const n of nodes) {
    let id = n.id || `Node${n.line + 1}`;
    const base = id;
    for (let k = 2; used.has(id.toLowerCase()); k++) id = `${base}_${k}`;
    used.add(id.toLowerCase());
    ids.set(n.uid, id);
  }
  return ids;
}
function hasEntryAncestor(n) { for (let p = n.parent; p && !p.isRoot; p = p.parent) if (p.entry) return true; return false; }

/**
 * Replaces string literals of an expression with inline string references:
 *   Character.name = "Vasya"        →  Character.name = @{Tavern.3}
 *   (Weapon == "sword")            →  (Weapon == @{Tavern.4})
 * `register(text)` adds the literal to the localization table and returns its id.
 * Literals without letters ("", " ", "5", "-") are not text and stay as they are. An expression that
 * cannot be tokenized is returned unchanged (it is reported by diagnostics).
 */
function localizeExpr(expr, register) {
  if (!expr) return expr;
  let toks;
  try { toks = tokenize(expr); } catch (e) { return expr; }
  let out = '', at = 0;
  for (const t of toks) {
    if (t.type !== 'str' || !/\p{L}/u.test(t.value)) continue;   // "", " ", "5": not text
    out += expr.slice(at, t.start) + `@{${register(t.value)}}`;
    at = t.end;
  }
  return out + expr.slice(at);
}
/** Applies `fn` to the expression of every %=expr% inside a text ("%name%" has no literals). */
function localizeInline(text, fn) {
  return text.replace(/%=([^%\n]+?)%/g, (m, e, i) => (i > 0 && /[%\w]/.test(text[i - 1]) ? m : `%=${fn(e)}%`));
}

/** "a || b" → ["a", "b"]; text before the first "||" is dropped when empty. */
function variantsOf(text) {
  return String(text).split('||').map(cleanText).filter(Boolean);
}
/** Scenario text rules: plain line breaks are spaces, "\n" and <br> are explicit line breaks. */
function cleanText(s) {
  return s.replace(/\s+/g, ' ').replace(/ *(\\n|<br\s*\/?>) */gi, '\n').replace(/^ +| +$/g, '');
}

/**
 * Turns units of one scope (a node body, an option, init code) into steps.
 * "? (cond)" groups are rebuilt from the units' governing conditionals.
 */
function buildSteps(units, ctx, opts = {}) {
  const top = [];
  const groups = new Map();        // if-unit uid → { step, else branch? }
  const listFor = u => {
    const c = u.cond;
    if (!c) return top;
    if (c.form === 'if') return groups.get(c.uid)?.step.then || top;
    if (c.form === 'else') { const g = c.ifUnit && groups.get(c.ifUnit.uid); return g ? (g.step.else ||= []) : top; }
    return top;
  };
  let text = null;                 // text step being extended by the following lines
  for (const u of units) {
    if (u.kind !== 'text') text = null;
    if (u.kind === 'cond') {
      if (u.form === 'if') {
        const step = { op: 'if', cond: u.exprText, then: [] };
        groups.set(u.uid, { step, unit: u });
        top.push(step);
      }
      continue;
    }
    const list = listFor(u);
    if (u.kind === 'text') {
      if (opts.code) continue;
      // consecutive lines of one paragraph form one text block
      if (text && text.group === u.group && text.cond === u.cond && text.list === list) { text.raw += ' ' + u.text; continue; }
      text = { group: u.group, cond: u.cond, list, raw: u.text, kind: 'text', node: u.node };
      list.push(text);
      continue;
    }
    if (u.kind === 'log') { if (!opts.code) list.push({ raw: u.text, kind: 'log', node: u.node }); continue; }
    const step = unitStep(u, ctx, opts);
    if (step) list.push(step);
  }
  // finalize text blocks (register strings in document order) and drop empty conditionals
  const finish = list => {
    const out = [];
    for (const s of list) {
      if (s.raw !== undefined) {            // text / log placeholder → string ids
        const ref = ctx.textRef(s.node, s.kind, s.raw);
        if (ref) out.push({ op: s.kind, ...ref });
        continue;
      }
      // a "?" that only governs a bullet leaves an empty conditional: dropped
      if (s.op === 'if' && !hasContent([s])) continue;
      // string literals of code → localization table, in document order
      if (s.op === 'set' && s.expr !== undefined) s.expr = ctx.loc(opts.node, s.expr);
      if ((s.op === 'if' || s.op === 'goto') && s.cond) s.cond = ctx.loc(opts.node, s.cond);
      if (s.op === 'if') {
        s.then = finish(s.then);
        if (s.else) s.else = finish(s.else);
        if (!s.then.length && !(s.else && s.else.length)) continue;   // e.g. a "?" that only governs a bullet
        if (s.else && !s.else.length) delete s.else;
      }
      out.push(s);
    }
    return out;
  };
  return finish(top);
}

/** True when a step list produces anything (non-empty text or any statement). */
function hasContent(list) {
  return list.some(s => s.raw !== undefined ? variantsOf(s.raw).length > 0
    : s.op === 'if' ? hasContent(s.then) || hasContent(s.else || []) : true);
}

/** One statement → step (source form). */
function unitStep(u, ctx) {
  switch (u.kind) {
    case 'assign': {
      const s = { op: 'set', target: u.target.text, operator: u.op };
      if (u.op !== '++' && u.op !== '--') s.expr = u.exprText;
      return s;
    }
    case 'transition': {
      if (u.ternary) return { op: 'goto', cond: u.ternary.condText, then: ctx.targetId(u.targets[0]), else: u.targets[1] ? ctx.targetId(u.targets[1]) : null };
      return u.targets.length ? { op: 'goto', node: ctx.targetId(u.targets[0]) } : null;
    }
    case 'import': return { op: 'import', file: u.file, object: u.object || null, alias: u.alias };
    default: return null;          // inline chips, tables: not part of the scenario code
  }
}

/**
 * One interactive-block option (a bullet):
 *   marker "*" — one-time, disabled when its condition is false
 *   marker "-" — one-time, hidden when its condition is false
 *   marker "+" — permanent
 * The option text is the bullet's first text block; "::" on the bullet level
 * gives the dialog log text (when absent the runtime logs the option text).
 */
function buildOption(b, units, node, ctx) {
  const opt = { marker: b.marker, once: b.marker !== '+', hide: b.marker === '-' };
  const c = b.cond;
  if (c && c.form === 'if') opt.cond = ctx.loc(node, c.exprText);
  else if (c && c.form === 'else' && c.ifUnit) opt.cond = `!(${ctx.loc(node, c.ifUnit.exprText)})`;
  // label: the text lines the bullet starts with, up to the first statement
  let k = 0;
  const label = [];
  while (k < units.length && units[k].kind === 'text' && !units[k].cond) { label.push(units[k].text); k++; }
  const rest = units.slice(k);
  const ref = label.length ? ctx.textRef(node, 'option', label.join(' ')) : null;
  if (ref) Object.assign(opt, ref.id ? { text: ref.id } : { textVariants: ref.variants });
  // the first "::" outside inner conditionals is the option's log text
  const li = rest.findIndex(u => u.kind === 'log' && !u.cond);
  if (li >= 0) {
    const lr = ctx.textRef(node, 'log', rest[li].text);
    if (lr) Object.assign(opt, lr.id ? { log: lr.id } : { logVariants: lr.variants });
    rest.splice(li, 1);
  }
  opt.do = buildSteps(rest, ctx, { node });
  return opt;
}

/* ================================================================ files */

/**
 * Builds the files of an export.
 *   kind "scenario": <base>.scenario.json + <base>.strings.json (always JSON)
 *   kind "data":     <Table>.json|.yaml|.xml for every table
 *   kind "bundle":   everything in one archive — the scenarios, the data of
 *                    the tables and the localization table (a file of its own)
 * @param {import('./document.js').MarklarDocument} doc
 * @param {{kind:'scenario'|'data'|'bundle', format?:'json'|'yaml'|'xml', base?:string, source?:string}} opts
 * @returns {{files:Array<{name:string,data:string}>, warnings:string[], count:number}}
 *          count — exported scenario nodes, tables or files of the bundle
 */
function exportFiles(doc, { kind, format = 'json', base = 'document', source = null }) {
  if (kind === 'bundle') {
    const stringsFile = `${base}.strings.json`;
    const tables = exportTables(doc);
    const tableNames = tables.tables.map(t => t.name);
    const r = exportScenario(doc, { source, stringsFile, tableNames });
    const files = [];
    const nodes = Object.keys(r.scenario.nodes).length;
    if (nodes) files.push({ name: `${base}.scenario.json`, data: toJSON(r.scenario) });
    for (const t of tables.tables) files.push({ name: t.name + '.json', data: toJSON(t.data) });
    // the localization table is a file of its own
    files.push({ name: stringsFile, data: toJSON(r.strings) });
    return { files, warnings: [...r.warnings, ...tables.warnings], count: files.length, nodes, tables: tables.tables.length };
  }
  if (kind === 'scenario') {
    const stringsFile = `${base}.strings.json`;
    const tableNames = exportTables(doc).tables.map(t => t.name);
    const r = exportScenario(doc, { source, stringsFile, tableNames });
    const count = Object.keys(r.scenario.nodes).length;
    const files = count ? [{ name: `${base}.scenario.json`, data: toJSON(r.scenario) }, { name: stringsFile, data: toJSON(r.strings) }] : [];
    return { files, warnings: r.warnings, count };
  }
  if (kind === 'data') {
    const r = exportTables(doc);
    const ext = EXTENSIONS[format];
    if (!ext) throw new Error(`Unknown export format "${format}"`);
    const files = r.tables.map(t => ({ name: t.name + ext, data: serialize(t.data, format, t.name) }));
    return { files, warnings: r.warnings, count: files.length };
  }
  throw new Error(`Unknown export kind "${kind}"`);
}

module.exports = { exportValue, exportTables, exportScenario, localizeExpr, exportFiles };
