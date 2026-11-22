/* Marklar Core - semantic.js
   Dependencies: cst, text, parser, lexer, transitions, diagnostics, values
   Generated from the mono core bundle by tools/extract_core.py. */
/**
 * Marklar Core — Semantic AST.
 *
 * Built from the CST. It describes the meaning of the document:
 *
 *   nodes    — headings (spec "The idea of a node"): id = heading text without spaces,
 *              nested by heading level; `# -> Name` marks an entry point.
 *   units    — Marklar constructs in document order:
 *                assign      x = expr, x += expr, x -= expr, x++, x--
 *                cond        ? (expr) / ? else / lone ?
 *                transition  -> Node, -> ? (cond) A : B
 *                log         :: text
 *                import      import "file#Object" as Alias
 *                bullet      start of a list item (interactive block option)
 *                inline      %name% / %=expr% chips
 *                table       a table (class/objects declaration)
 *                text        plain text of a line (scenario text; used by the exporter)
 *   tables   — table declarations (see tables.js for the object model)
 *   refs     — the definitions of the labels of the reference links
 *              ("[label]: address"): the map "the label → the definition"
 *              (the first definition of a label wins, the rule of the
 *              CommonMark)
 *
 * Each unit knows its node, its governing conditional (`cond`), the bullet it
 * belongs to (`bullet`) and its execution `mode`:
 *   'edit'     executed by the edit-time interpreter
 *   'runtime'  only executed when a scenario runs (transitions, logs, bullet
 *              code and conditional blocks of scenario nodes)
 *   'display'  inline chips: evaluated for display at their position
 *   'text'     text units: never executed by the edit-time interpreter
 *
 * Plain line text is the *rendered* text (Markdown escapes removed), i.e.
 * exactly what the WYSIWYG editor shows: "what you see is what is executed".
 */
const { tokensOf } = require('./cst.js');
const { unescapeMd, parseHeadingText, nodeKey, matchText, stripInlineMarks, isValidName } = require('./text.js');
const { parseExpression } = require('./parser.js');
const { tokenize } = require('./lexer.js');
const { scanTransitions } = require('./transitions.js');
const { DiagnosticBag } = require('./diagnostics.js');
const { LSError } = require('./values.js');

const NAME = '[A-Za-z][A-Za-z0-9_]*(?:\\.[A-Za-z_][A-Za-z0-9_]*)*';
const RE_IMPORT = /^(\s*)import\s+(["\u201c\u201d\u00ab])([^"\u201c\u201d\u00bb]*)["\u201c\u201d\u00bb]\s*(?:as\s+([A-Za-z][A-Za-z0-9_]*))?\s*$/i;
const RE_IMPORT_LOOSE = /^\s*import\b/i;
const RE_COND = /^(\s*)\?(?=[\s(]|$)(.*)$/;
const RE_INC = new RegExp(`^(\\s*)((?:\\.)?${NAME})\\s*(\\+\\+|--)\\s*$`);
const RE_ASSIGN = new RegExp(`^(\\s*)((?:\\.)?${NAME})(\\s*)(\\+=|-=|=(?!=))(.*)$`);

/**
 * The identity of an element must survive the rebuild of the tree: otherwise
 * the index (which points at the elements of the previous tree) loses its
 * mark.  The identity is built from the content of the element and from the
 * number of the identical elements before it.
 */
function makeUidFactory() {
  const seen = new Map();
  const f = (p, key) => {
    const id = `${p}:${key}`;
    const n = (seen.get(id) || 0) + 1;
    seen.set(id, n);
    return n === 1 ? id : `${id}#${n}`;
  };
  f.seen = seen;          // the counter is visible: the reused units keep it
  return f;
}


/** The number of the first line of a subtree (the lines of the document). */
function firstLineOf(node) {
  if (node.line != null) return node.line;
  for (const c of (node.children || [])) { const l = firstLineOf(c); if (l != null) return l; }
  return null;
}

/**
 * Moves the places of the units of a block: the document has changed above it,
 * so the offsets in the text and the numbers of the lines move with it.
 */
function shiftChunk(chunk, dOff, dLine) {
  if (!dOff && !dLine) return;
  for (const u of chunk.units) {
    if (u.start != null) u.start += dOff;
    if (u.end != null) u.end += dOff;
    if (u.exprStart != null) u.exprStart += dOff;
    if (u.line != null) u.line += dLine;
    if (u.endLine != null) u.endLine += dLine;
    // the targets of a transition (their places in the text)
    if (u.targets) for (const t of u.targets) { if (t.start != null) t.start += dOff; if (t.end != null) t.end += dOff; }
    if (u.table) shiftTable(u.table, dOff, dLine);
  }
  for (const n of chunk.nodes) {
    if (n.start != null) n.start += dOff;
    if (n.end != null) n.end += dOff;
    if (n.line != null) n.line += dLine;
  }
  for (const d of chunk.diags) {
    if (d.start != null) d.start += dOff;
    if (d.end != null) d.end += dOff;
    if (d.line != null) d.line += dLine;
  }
}

/** Moves the places of a table (the cells of the table and the table itself). */
function shiftTable(t, dOff, dLine) {
  if (t.start != null) t.start += dOff;
  if (t.end != null) t.end += dOff;
  if (t.line != null) t.line += dLine;
  if (t.endLine != null) t.endLine += dLine;
  const cells = [];
  if (t.header) for (const c of t.header) cells.push(c);
  for (const r of (t.rows || [])) for (const c of r) cells.push(c);
  for (const c of cells) {
    if (c.start != null) c.start += dOff;
    if (c.end != null) c.end += dOff;
    if (c.exprStart != null) c.exprStart += dOff;
    if (c.line != null) c.line += dLine;
  }
}

/* The content that identifies a unit (its kind and what it says). */
function unitKey(u) {
  const t = u.lineText != null ? u.lineText : '';
  switch (u.kind) {
    case 'assign': return `${u.op || ''} ${u.target || ''} = ${u.exprText || ''}`;
    case 'inline': return `${u.isExpr ? '=' : ''}${u.raw || ''}`;
    case 'text': return `${t}`;
    case 'table': return `${(u.table && u.table.name) || ''}`;
    case 'cond': return `${u.form || ''} ${u.exprText || ''} ${t}`;
    case 'bullet': return `${u.marker || ''} ${t}`;
    case 'transition': return `${(u.targets || []).map(x => x.text || '').join('>')}`;
    case 'log': return `${t}`;
    case 'import': return `${u.file || ''} ${u.alias || ''}`;
    default: return `${u.kind || ''} ${t}`;
  }
}

/**
 * Builds the semantic AST.
 * @param {object} cst document CST (cst.js)
 * @param {string} text source text
 * @param {{exprCache?:Map}} [opts] exprCache: reuse parsed expressions between rebuilds
 */
function buildSemantic(cst, text, opts = {}) {
  const diags = new DiagnosticBag();
  const cache = opts.exprCache || new Map();
  // The cache of the data of the lines: it depends only on the content of the
  // line, so the lines that the change did not touch are not read again.
  const lineCache = opts.lineCache || null;
  const nextUid = makeUidFactory();
  const root = { uid: 'global', level: 0, name: 'Global', id: 'Global', key: 'global', entry: false, scenario: false, parent: null, children: [], line: -1, start: 0, end: text.length, isRoot: true };
  const nodes = [];
  const units = [];
  const tables = [];
  const refs = new Map();       // the definitions of the labels of the links
  const stack = [root];
  let node = root;
  let cond = null;            // open conditional unit in the current node
  let lastIf = null;          // last "? (expr)" for "? else"
  let pendingCond = null;     // a "?" on the line right before a bullet governs that bullet
  let bullet = null;          // current list item (bullet unit)
  // The inline expressions of the line that is being read: they are added
  // after the statement of that line (the comment of a line sees the value
  // that the assignment of the line sets - the order of the execution).
  let pendingInline = null;

  /** Parses an expression with caching; reports syntax errors. */
  const parse = (src, base, where) => {
    let r = cache.get(src);
    if (!r) {
      try { r = parseExpression(src); } catch (e) { r = { error: e }; }
      cache.set(src, r);
    }
    if (r.error) { report(r.error, base, where); return null; }
    r.errors.forEach(e => report(e, base, where, 'warning'));
    return r.ast;
  };
  const report = (e, base, where, sev = 'error') => {
    const start = base + (e.start ?? 0), end = base + (e.end ?? (e.start ?? 0) + 1);
    diags.add(sev, e.code || 'syntax', e.message, { ...where, start, end });
  };

  const addUnit = (u) => {
    u.ukey = unitKey(u);
    u.uid = nextUid('u', u.ukey);
    u.node = node;
    u.cond = u.cond === undefined ? cond : u.cond;
    u.bullet = u.bullet === undefined ? bullet : u.bullet;
    units.push(u);
    return u;
  };

  /* ---------- flatten the CST into a stream of lines with their context ---------- */
  const stream = [];
  for (const b of cst.children) {
    if (b.type === 'list') {
      for (const item of b.children) {
        item.children.forEach((ln, k) => stream.push({ kind: ln.children[0] && ln.children[0].kind === 'space' ? 'blank' : 'content', block: 'list', item, group: item, first: k === 0, ln, blk: b }));
      }
    } else if (b.type === 'paragraph') b.children.forEach(ln => stream.push({ kind: 'content', block: 'paragraph', group: b, ln, blk: b }));
    else if (b.type === 'blank') stream.push({ kind: 'blank', block: 'blank', ln: b.children[0], blk: b });
    else stream.push({ kind: b.type, block: b.type, b, blk: b });
  }
  // The blocks of the document: the range of the stream of every block.  The
  // units of the block that has not changed are taken from the previous run
  // (the tree of the document survives the change).
  const groups = [];
  for (let i = 0; i < stream.length;) {
    const b = stream[i].blk;
    let j = i;
    while (j < stream.length && stream[j].blk === b) j++;
    groups.push({ block: b, from: i, to: j, gi: groups.length });
    i = j;
  }
  const prevChunks = opts.chunks || null;   // the chunks of the previous run
  const chunks = new Map();                 // the chunks of this run
  // A block that has not changed (the same object of the CST) takes its units
  // from the previous run; the places of those units move with the document.

  /* ---------- the blocks: the units of the block that has not changed are
     taken from the previous run (the tree of the document survives a change) ---------- */
  const groupOf = new Map();
  for (const g of groups) groupOf.set(g.block, g);
  const ctxNow = () => ({ node, cond, lastIf, pendingCond, bullet, stack: stack.slice() });
  // the root of the tree is a new object in every run - it is the same scope
  const sameNode = (a, b) => a === b || (a && b && a.isRoot && b.isRoot);
  const sameCtx = (a, b) => sameNode(a.node, b.node) && a.cond === b.cond && a.lastIf === b.lastIf &&
    a.pendingCond === b.pendingCond && a.bullet === b.bullet &&
    a.stack.length === b.stack.length && a.stack.every((x, i) => sameNode(x, b.stack[i]));
  // the same context, without building an object (the blocks are many)
  const sameCtxLive = (a) => sameNode(a.node, node) && a.cond === cond && a.lastIf === lastIf &&
    a.pendingCond === pendingCond && a.bullet === bullet &&
    a.stack.length === stack.length && a.stack.every((x, i) => sameNode(x, stack[i]));
  let curBlock = null, curChunk = null, curGroup = null, prevOpen = false, reused = 0;
  let curUnitsStart = 0, curNodesStart = 0, curTablesStart = 0, curDiagsStart = 0;
  const beginBlock = (si, b, g) => {
    // the chunk of the previous block is closed
    if (curChunk) {
      if (!curChunk.reused) {                 // the reused chunk keeps its units
        curChunk.ctxOut = ctxNow();
        curChunk.open = si > curGroup.to;     // the string of the block continues
        curChunk.units = units.slice(curUnitsStart);
        curChunk.nodes = nodes.slice(curNodesStart);
        curChunk.tables = tables.slice(curTablesStart);
        curChunk.diags = diags.items.slice(curDiagsStart);
      }
      chunks.set(curChunk.block, curChunk);
      prevOpen = curChunk.open;
    }
    curBlock = b; curGroup = g;
    const prev = prevChunks ? prevChunks.get(b) : null;
    // The block has not changed and the context is the same: its units, its
    // nodes and its diagnostics are taken from the previous run.
    if (prev && !prev.open && !prevOpen && sameCtxLive(prev.ctxIn)) {
      // the block has not changed, but the document above it has: its units move
      const dOff = b.start - (prev.bStart != null ? prev.bStart : b.start);
      const dLine = (firstLineOf(b) != null ? firstLineOf(b) : 0) - (prev.bLine != null ? prev.bLine : 0);
      shiftChunk(prev, dOff, dLine);
      // the piece knows its new place (the shift must not be counted twice)
      prev.bStart = b.start; prev.bEnd = b.end; prev.bLine = firstLineOf(b);
      for (const u of prev.units) units.push(u);
      for (const n of prev.nodes) nodes.push(n);
      for (const t of prev.tables) tables.push(t);
      for (const dg of prev.diags) diags.items.push(dg);
      node = prev.ctxOut.node && prev.ctxOut.node.isRoot ? root : prev.ctxOut.node;
      cond = prev.ctxOut.cond; lastIf = prev.ctxOut.lastIf;
      pendingCond = prev.ctxOut.pendingCond; bullet = prev.ctxOut.bullet;
      stack.length = 0; for (const x of prev.ctxOut.stack) stack.push(x && x.isRoot ? root : x);
      curChunk = prev;
      prev.reused = true;
      reused++;
      return true;
    }
    curChunk = { block: b, units: [], nodes: [], tables: [], diags: [], ctxIn: ctxNow(), ctxOut: null, open: false,
      bStart: b.start, bEnd: b.end, bLine: firstLineOf(b) };
    curUnitsStart = units.length; curNodesStart = nodes.length;
    curTablesStart = tables.length; curDiagsStart = diags.items.length;
    prevOpen = false;
    return false;
  };

  for (let si = 0; si < stream.length; si++) {
    const s = stream[si];
    // the block of the line
    if (s.blk !== curBlock) {
      const g = groupOf.get(s.blk);
      if (beginBlock(si, s.blk, g)) { si = g.to - 1; continue; }   // the block has not changed
    }

    if (s.kind === 'heading') {
      const ln = s.b.children[0];
      const content = ln.children.filter(t => t.kind !== 'indent' && t.kind !== 'marker' && t.kind !== 'eol');
      const raw = content.map(t => t.text).join('');
      const h = parseHeadingText(raw);
      const level = s.b.level;
      while (stack.length > 1 && stack[stack.length - 1].level >= level) stack.pop();
      const parent = stack[stack.length - 1];
      const nd = { ukey: h.key || h.name || '', uid: nextUid('n', h.key || h.name || ''), level, name: h.name, id: h.id, key: h.key, entry: h.entry, scenario: false, parent, children: [], line: ln.line, start: s.b.start, end: s.b.end, isRoot: false };
      parent.children.push(nd);
      stack.push(nd);
      nodes.push(nd);
      node = nd; cond = null; lastIf = null; pendingCond = null; bullet = null;
      if (!h.key) diags.info('empty-node', 'Heading without text: the node has no id', { line: ln.line, start: s.b.start, end: s.b.end, node: nd.uid });
      inlineUnits(content, ln, 'heading');
      continue;
    }

    if (s.kind === 'table') { buildTable(s.b); continue; }
    if (s.kind === 'blockquote') { s.b.children.forEach(ln => inlineUnits(ln.children, ln, 'quote')); continue; }
    if (s.kind === 'fence' || s.kind === 'comment' || s.kind === 'hr') continue;
    // The definition of a footnote ("[^label]: text") is a note at the side of
    // the text, not a part of the scenario: it has no units of its own (the
    // reference to it is cut from the text of the line - see renderPlain).
    if (s.kind === 'footnoteDef') continue;
    if (s.kind === 'linkDef') {
      // The definitions of the labels of the reference links ("[label]: address"):
      // they are the service blocks of the document.  They are not a text of
      // the scenario, but they are the definitions of the document: they are
      // kept in the tree of the semantic AST.
      for (const d of (s.b.defs || [])) if (!refs.has(d.label)) refs.set(d.label, d);
      continue;
    }
    if (s.kind === 'blank') {
      // an empty line is not a border of the block of the operator "?": the
      // condition stands until the nearest bullet (the specification of
      // Marklar: the block of the operator goes "to the nearest bullet")
      // the end of a list closes its last bullet together with conditionals opened inside it
      if (s.block === 'blank' && bullet) { bullet = null; cond = null; lastIf = null; }
      continue;
    }

    // ---- content line (paragraph or list item) ----
    const ln = s.ln;
    const inBullet = s.block === 'list' && s.first;
    if (inBullet) {
      // a bullet interrupts an open conditional; a "?" right before it governs the bullet itself
      const bc = pendingCond;
      cond = null; lastIf = bc && bc.form === 'if' ? bc : null;
      bullet = null;
      bullet = addUnit({ kind: 'bullet', marker: s.item.marker, line: ln.line, start: s.item.start, end: s.item.end, cond: bc, bullet: null, lineText: '' });
      pendingCond = null;
    } else if (s.block === 'paragraph' && bullet) {
      bullet = null; cond = null;
    }
    const content = ln.children.filter(t => t.kind !== 'indent' && t.kind !== 'marker' && t.kind !== 'eol');
    pendingInline = [];
    try {
    inlineUnits(content, ln, s.block);
    const L = lineData(content, lineCache, ln.start);
    if (bullet && s.first) bullet.lineText = L.matched;
    const where = { line: ln.line, lineText: L.matched, node: node.uid };
    const code = L.code;
    if (!code.trim()) { pendingCond = null; continue; }
    let m;

    if (!inBullet && (m = code.match(RE_IMPORT))) {
      const [file, object] = m[3].split('#');
      addUnit({ kind: 'import', file: file.trim(), object: (object || '').trim(), alias: m[4] || null, line: ln.line, start: L.map(m[1].length), end: L.mapEnd(code.length), ...where });
      pendingCond = null; continue;
    }
    if (RE_IMPORT_LOOSE.test(code) && /["\u201c\u201d]/.test(code)) {
      diags.error('syntax', 'Invalid import. Use: import "file#Object" as Alias', { ...where, start: L.map(0), end: L.mapEnd(code.length) });
      pendingCond = null; continue;
    }

    if ((m = code.match(RE_COND))) {
      const rest = m[2].trim();
      const qAt = m[1].length;
      const u = { kind: 'cond', line: ln.line, start: L.map(qAt), end: L.mapEnd(code.length), cond: null, ...where };
      if (!rest) u.form = 'close';
      else if (/^else$/i.test(rest)) {
        u.form = 'else'; u.ifUnit = lastIf;
        if (!lastIf) diags.warning('else-without-if', '"? else" without a preceding "? (condition)"', { ...where, start: u.start, end: u.end });
      } else {
        u.form = 'if';
        const exprAt = m[2].indexOf(rest) + qAt + 1;
        u.exprText = rest;
        u.exprStart = L.map(exprAt);
        if (!rest.startsWith('(')) diags.error('syntax', 'Expected a condition in parentheses: ? (expression)', { ...where, start: L.map(exprAt), end: L.mapEnd(code.length) });
        u.expr = parse(rest, L.map(exprAt), where);
      }
      addUnit(u);
      if (u.form === 'if') lastIf = u;
      cond = u.form === 'close' ? null : u;
      if (u.form === 'close') lastIf = null;
      pendingCond = u.form === 'close' ? null : u;
      // a "?" on the last line of a bullet governs the *next* bullet (via pendingCond)
      continue;
    }
    pendingCond = null;

    if (!inBullet && (m = code.match(RE_INC))) {
      addUnit({ kind: 'assign', op: m[3], target: targetOf(m[2]), exprText: '', expr: null, line: ln.line, start: L.map(m[1].length), end: L.mapEnd(code.trimEnd().length), ...where });
      continue;
    }

    if (!inBullet && (m = code.match(RE_ASSIGN))) {
      let exprText = m[5];
      let exprAt = m[1].length + m[2].length + m[3].length + m[4].length;
      let end = L.mapEnd(code.length);
      let endLine = ln.line;   // the last line of the statement (a string may continue)
      // a string value may continue on the next lines (spec: manual line breaks become \n)
      if (unterminatedString(exprText)) {
        let k = si + 1, acc = exprText;
        while (k < stream.length && (stream[k].kind === 'content' || stream[k].kind === 'blank')) {
          const sk = stream[k];
          const ct = sk.kind === 'blank' ? '' : renderLine(sk.ln.children.filter(t => t.kind !== 'indent' && t.kind !== 'marker' && t.kind !== 'eol')).code;
          acc += '\n' + ct;
          if (!unterminatedString(acc)) { exprText = acc; end = sk.ln.end; endLine = sk.ln.line; si = k; break; }
          k++;
        }
      }
      const exprStart = L.map(exprAt + (exprText.length - exprText.trimStart().length));
      const u = { kind: 'assign', op: m[4], target: targetOf(m[2]), exprText: exprText.trim(), line: ln.line, endLine, start: L.map(m[1].length), end, exprStart, ...where };
      if (!u.exprText) diags.error('syntax', `Missing value after "${m[4]}"`, { ...where, start: u.start, end: u.end });
      else u.expr = parse(u.exprText, exprStart, where);
      addUnit(u);
      continue;
    }

    // plain text of the line (shown to the user when a scenario runs) and the "::" dialog log text,
    // both without "-> Target" parts; inline %expressions% stay in the text in source form.
    // Order inside a line: text, log, transitions.
    const plain = L.split;
    if (plain.text) addUnit({ kind: 'text', text: plain.text, group: s.group, first: !!s.first, line: ln.line, start: ln.start, end: ln.end, ...where });
    const lg = code.indexOf('::');
    if (lg >= 0) addUnit({ kind: 'log', text: plain.log ?? code.slice(lg + 2).trim(), line: ln.line, start: L.map(lg), end: L.mapEnd(code.length), ...where });

    // transitions anywhere in the line
    for (const t of L.transitions) {
      const u = { kind: 'transition', line: ln.line, start: L.map(t.arrowStart), end: L.mapEnd(t.end), targets: t.targets.map(x => ({ ...x, start: L.map(x.start), end: L.mapEnd(x.end) })), ternary: null, ...where };
      if (t.ternary) {
        let ct = t.ternary.condText;
        const opens = (ct.match(/\(/g) || []).length, closes = (ct.match(/\)/g) || []).length;
        if (opens > closes) { diags.warning('syntax', 'Missing ")" after the condition', { ...where, start: L.map(t.ternary.condStart), end: L.mapEnd(t.ternary.condStart + ct.length) }); ct += ')'.repeat(opens - closes); }
        if (t.targets.length < 2) diags.error('syntax', 'Expected "-> ? (condition) NodeA : NodeB"', { ...where, start: u.start, end: u.end });
        u.ternary = { condText: ct, expr: ct ? parse(ct, L.map(t.ternary.condStart), where) : null };
      } else if (!t.targets.length) diags.error('syntax', 'Missing node id after "->"', { ...where, start: u.start, end: u.end });
      addUnit(u);
    }
    } finally {
      // the inline expressions of the line go after its statement: the value
      // that the comment of the line shows is the value after the assignment
      // of that line (the order of the execution)
      const queue = pendingInline; pendingInline = null;
      for (const u of queue) addUnit(u);
    }
  }

  // the last block is closed
  if (curChunk) {
    curChunk.ctxOut = ctxNow();
    if (!curChunk.reused) {
      curChunk.units = units.slice(curUnitsStart);
      curChunk.nodes = nodes.slice(curNodesStart);
      curChunk.tables = tables.slice(curTablesStart);
      curChunk.diags = diags.items.slice(curDiagsStart);
    }
    chunks.set(curChunk.block, curChunk);
  }
  // The names of the units are counted again: the reused units keep their
  // place in the order of the document (the same names as in a full build).
  if (reused) {
    const f = makeUidFactory();
    for (const u of units) u.uid = f('u', u.ukey);
    for (const n of nodes) n.uid = f('n', n.ukey);
  }

  /* ---------- inline %expressions% in a line (including comments) ---------- */
  function inlineUnits(content, ln, container) {
    let lineText = null;   // display text of the line, computed on demand (for diagnostics)
    const lt = () => (lineText ??= lineData(content, lineCache, ln.start).matched);
    for (const t of content) {
      if (t.kind === 'inlineExpr') addInline(t.text, ln.start + t.start, ln, container, false, lt());
      else if (t.kind === 'comment') {
        const re = /(^|[^\\%\w])%(=[^%\n]+?|[A-Za-z][A-Za-z0-9_.]*)%/g;
        let m;
        while ((m = re.exec(t.text))) addInline(m[0].slice(m[1].length), ln.start + t.start + m.index + m[1].length, ln, container, true, lt());
      }
    }
  }
  function addInline(raw, start, ln, container, inComment, lineText) {
    const body = raw.slice(1, -1);
    const isExpr = body.startsWith('=');
    const exprText = isExpr ? unescapeMd(body.slice(1)).trim() : body;
    const where = { line: ln.line, lineText, node: node.uid };
    const u = { kind: 'inline', raw: body, exprText, isExpr, container, inComment, line: ln.line, start, end: start + raw.length, cond: null, bullet: null, ...where };
    u.cond = null;
    u.expr = exprText ? parse(exprText, start + 1 + (isExpr ? 1 : 0), where) : null;
    if (!exprText) diags.error('syntax', 'Empty inline expression', { ...where, start, end: u.end });
    // the unit of the line that is being read waits for the statement of that
    // line (the comment sees the value that the assignment of the line sets)
    if (pendingInline) pendingInline.push(u); else addUnit(u);
  }

  /* ---------- tables ---------- */
  function buildTable(b) {
    const rows = [];
    let header = null;
    for (const ln of b.children) {
      if (!ln.row) continue;
      const cells = ln.children.filter(c => c.type === 'cell');
      const row = cells.map((c, ci) => {
        const content = c.children;
        inlineUnits(content, ln, 'cell');
        const L = lineData(content.filter(t => t.kind !== 'comment'), lineCache, ln.start);
        const shown = L.code.trim();
        const lead = L.code.length - L.code.trimStart().length;
        const cell = { text: shown, line: ln.line, start: ln.start + c.start, end: ln.start + c.end, col: ci, formula: false, expr: null, exprText: '' };
        if (shown.startsWith('=') && header) {
          cell.formula = true;
          cell.exprText = shown.slice(1).trim();
          const where = { line: ln.line, lineText: L.matched, node: node.uid };
          if (!cell.exprText) diags.error('syntax', 'Empty formula', { ...where, start: c.start, end: c.end });
          else {
            cell.exprStart = L.map(lead + 1 + (shown.slice(1).length - shown.slice(1).trimStart().length));
            cell.lineText = where.lineText;
            cell.expr = parse(cell.exprText, cell.exprStart, where);
          }
        }
        return cell;
      });
      if (!header) header = row; else rows.push(row);
    }
    // strip the row of an empty leading/trailing pipe-only table edge
    const lastLine = b.children.length ? b.children[b.children.length - 1].line : b.children[0].line;
    const nameText = header[0] ? header[0].text : '';
    const name = nameText.replace(/\s+/g, '');
    // the identity of a table is built from its name: it survives the rebuild
    // of the tree and the removal of another table
    const table = { uid: nextUid('t', name), node, line: b.children[0].line, endLine: lastLine, start: b.start, end: b.end, header, rows };
    table.name = name;
    table.valid = isValidName(table.name) && !table.name.includes('.');
    if (nameText && !table.valid) diags.info('table-name', `Table name "${nameText}" is not a valid id: the table is addressable only from its own formulas`, { line: table.line, start: header[0].start, end: header[0].end, node: node.uid, lineText: '' });
    tables.push(table);
    addUnit({ kind: 'table', table, line: table.line, endLine: table.endLine, start: b.start, end: b.end, cond: null, bullet: null, lineText: '' });
  }

  /* ---------- scenario nodes and execution modes ---------- */
  const byKey = new Map();
  nodes.forEach(n => { if (!n.key) return; if (!byKey.has(n.key)) byKey.set(n.key, []); byKey.get(n.key).push(n); });
  for (const [k, list] of byKey) {
    if (list.length > 1) list.slice(1).forEach(n => diags.info('duplicate-node', `Node id "${list[0].id}" is used by several headings; transitions go to the first one`, { line: n.line, start: n.start, end: n.end, node: n.uid, lineText: n.name }));
  }
  const markScenario = n => { if (n.scenario) return; n.scenario = true; n.children.forEach(markScenario); };
  nodes.forEach(n => { if (n.entry) markScenario(n); });
  units.forEach(u => {
    if (u.kind !== 'transition') return;
    u.targets.forEach(t => {
      const hit = byKey.get(t.key);
      t.node = hit ? hit[0].uid : null;
      if (hit) hit[0].scenario = true;
      else diags.warning('unknown-node', `Node "${t.text}" not found`, { line: u.line, start: t.start, end: t.end, node: u.node.uid, lineText: u.lineText });
    });
  });
  for (const u of units) {
    if (u.kind === 'inline') u.mode = 'display';
    else if (u.kind === 'text') u.mode = 'text';
    else if (u.kind === 'transition' || u.kind === 'log') u.mode = 'runtime';
    else if (u.kind === 'import' || u.kind === 'table') u.mode = 'edit';
    else if (u.node.scenario && (u.bullet || u.cond || u.kind === 'cond' || u.kind === 'bullet')) u.mode = 'runtime';
    else u.mode = 'edit';
  }

  // The blocks of the CST are the blocks of the document: every unit lies in
  // one of them.  The block is what the editor paints, and what the index of
  // the elements needs (see elementindex.js).
  return { root, nodes, units, tables, byKey, refs, diagnostics: diags, blocks: cst.children || [], chunks, reused };
}

/* ------------------------------------------------------------------ helpers */

/**
 * Text of a line as the reader sees it: formatting marks, escapes, comments and
 * anchors removed, links reduced to their label; %expressions% kept verbatim.
 */
function renderPlain(tokens) {
  let s = '';
  for (const t of tokens) {
    if (t.kind === 'comment' || t.kind === 'anchor' || t.kind === 'eol' || t.kind === 'indent' || t.kind === 'marker') continue;
    if (t.kind === 'text') {
      s += unescapeMd(stripInlineMarks(t.text
        .replace(/!\[[^\]]*\]\([^)]*\)/g, '')                // images
        .replace(/(^|[^\\])\[([^\]]*)\]\([^)]*\)/g, '$1$2')));  // [label](url) → label
    } else if (t.kind === 'code') s += t.text.replace(/^`+|`+$/g, '');
    else if (t.kind === 'wiki') s += t.text.slice(2, -2).split('|').pop();
    else if (t.kind === 'footnoteRef') {
      // The reference to a footnote is not a text of the reader: the note
      // stands at the side of the text.  The space before it is cut with it.
      s = s.replace(/[ \t]$/, '');
    }
    else s += t.text;                                          // inlineExpr and others: verbatim
  }
  return s;
}
/** Splits plain line text into the shown text and the "::" log text, dropping "-> Target" parts. */
function splitPlain(plain) {
  const strip = str => {
    let out = '', at = 0;
    for (const t of scanTransitions(str)) { out += str.slice(at, t.start); at = t.end; }
    return (out + str.slice(at)).replace(/\s+/g, ' ').trim();
  };
  const lg = plain.indexOf('::');
  return lg < 0 ? { text: strip(plain), log: null } : { text: strip(plain.slice(0, lg)), log: strip(plain.slice(lg + 2)) };
}

/** "x" / ".x" / "this.x" / "Global.x" → { prefix, path, text } */
function targetOf(text) {
  let path = text.split('.');
  let prefix = null;
  if (path[0] === '') { prefix = 'this'; path = path.slice(1); }
  else if (path.length > 1 && path[0].toLowerCase() === 'this') { prefix = 'this'; path = path.slice(1); }
  else if (path.length > 1 && path[0].toLowerCase() === 'global') { prefix = 'global'; path = path.slice(1); }
  return { prefix, path, text };
}

function unterminatedString(src) {
  try { tokenize(src); return false; } catch (e) { return e instanceof LSError && /Unterminated string/.test(e.message); }
}

/**
 * Renders the content tokens of a line:
 *   code    — text used for Marklar statements: escapes removed, comment and anchor dropped,
 *             inline expressions and code spans kept verbatim
 *   display — text as shown by the editor (formatting marks removed), for matching
 *   map(i)  — source offset of character i of `code`
 */
function renderLine(tokens) {
  let code = '';
  const offs = [];
  let display = '';
  for (const t of tokens) {
    if (t.kind === 'comment' || t.kind === 'anchor' || t.kind === 'eol' || t.kind === 'indent' || t.kind === 'marker') continue;
    if (t.kind === 'text') {
      const s = t.text;
      for (let i = 0; i < s.length; i++) {
        if (s[i] === '\\' && i + 1 < s.length && /[!-/:-@[-`{-~]/.test(s[i + 1])) { code += s[i + 1]; offs.push(t.start + i + 1); i++; continue; }
        code += s[i]; offs.push(t.start + i);
      }
      display += stripInlineMarks(t.text);
    } else if (t.kind === 'footnoteRef') {
      // The reference to a footnote is not a part of the statement of Marklar:
      // it is cut with the space before it (the places of the code keep their
      // meaning: the last place belongs to the space that is cut).
      if (code.endsWith(' ')) { code = code.slice(0, -1); offs.pop(); }
      if (display.endsWith(' ')) display = display.slice(0, -1);
    } else {
      for (let i = 0; i < t.text.length; i++) { code += t.text[i]; offs.push(t.start + i); }
      if (t.kind === 'code') display += t.text.replace(/^`+|`+$/g, '');
      else if (t.kind === 'wiki') display += t.text.slice(2, -2).split('|').pop();
    }
  }
  const last = tokens.length ? tokens[tokens.length - 1] : null;
  const endOff = offs.length ? offs[offs.length - 1] + 1 : (last ? last.start : 0);
  return {
    code,
    display: unescapeMd(display),
    offs,
    endOff,
    map: i => (i < offs.length ? offs[i] : endOff),
    mapEnd: i => (i <= 0 ? (offs[0] ?? endOff) : (offs[i - 1] ?? endOff - 1) + 1)
  };
}

/**
 * The key of the content of a line: the text of the content.  The kinds of the
 * tokens are a function of the text (the tokenizer is deterministic), so the
 * text alone is enough — with one exception: a comment is only a token when
 * the tokenizer was asked for comments, and the text of a line with a comment
 * and the text of the same line without it are read differently.
 */
function contentKey(content) {
  let key = '';
  let comment = false;
  for (const t of content) {
    key += t.text;
    if (t.kind === 'comment') comment = true;
  }
  return comment ? key + '\u0001c' : key;
}

/**
 * Binds the data of a line to the place of the line in the text: the offsets
 * are kept relative to the beginning of the content, so the data of a line
 * that was moved (the text above it grew) is still good.
 */
function bindLine(rel, base) {
  const offs = rel.offs;
  const endRel = rel.endRel;
  return {
    code: rel.code,
    display: rel.display,
    matched: rel.matched,
    plain: rel.plain,
    split: rel.split,
    transitions: rel.transitions,
    map: i => (i < offs.length ? base + offs[i] : base + endRel),
    mapEnd: i => (i <= 0 ? (offs.length ? base + offs[0] : base + endRel) : base + (offs[i - 1] ?? endRel - 1) + 1)
  };
}

/**
 * The data of the content of a line: the code of the statement, the text as
 * shown, the plain text, the transitions and the map of the offsets.  It
 * depends only on the content of the line, so it is kept in the cache of the
 * document: after a change the lines that were not touched are not read again.
 *
 * The places of the tokens are relative to their line: the data is bound to
 * the place of the line (`lineStart` — absolute) and to the place of the
 * content inside it.
 *
 * @param {object[]} content the tokens of the line
 * @param {Map|null} cache the cache of the document (null: no cache)
 * @param {number} lineStart the place of the line in the text (absolute)
 */
function lineData(content, cache, lineStart) {
  const base = content.length ? content[0].start : 0;
  let rel = null;
  if (cache) {
    const key = contentKey(content);
    rel = cache.get(key) || null;
    if (!rel) {
      rel = buildLineData(content, base);
      cache.set(key, rel);
    }
  } else rel = buildLineData(content, base);
  return bindLine(rel, (lineStart || 0) + base);
}

/** Reads the data of a line (the offsets are relative to the beginning). */
function buildLineData(content, base) {
  const L = renderLine(content);
  const rel = {
    code: L.code,
    display: L.display,
    offs: L.offs.map(o => o - base),
    endRel: L.endOff - base,
    matched: matchText(L.display)
  };
  rel.plain = renderPlain(content);
  rel.split = splitPlain(rel.plain);
  rel.transitions = scanTransitions(rel.code);
  return rel;
}

module.exports = { nodeKey, buildSemantic, renderLine };
