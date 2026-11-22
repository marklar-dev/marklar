/* Marklar Core - cst.js
   Dependencies: text
   Generated from the mono core bundle by tools/extract_core.py. */
/**
 * Marklar Core — Lossless Concrete Syntax Tree (CST) of a Markdown document.
 *
 * The CST keeps every character of the source: indentation, markers, trivia,
 * line terminators, unknown constructs. Printing the tree gives back exactly
 * the original text (the key test of the spec: parse → print === source).
 *
 * Tree shape
 *   document
 *     heading | paragraph | list | table | fence | blockquote | comment | hr | blank
 *       (list → listItem*)   every block / item contains `line` nodes
 *         line → token*      tokens cover the whole line including its "eol"
 *
 * Token kinds
 *   indent, marker (#, -, *, +, 1., >), eol, text, code (`x`), inlineExpr (%x%),
 *   wiki ([[x]]), comment (// x), anchor (^Id), pipe, cell, delimiterRow,
 *   fenceOpen, fenceClose, codeText, comment, hr, space
 *
 * The reference links of the Markdown are the inline nodes "refLink" and
 * "refImage" (the three forms of the CommonMark: "[text][label]", "[text][]"
 * and "[text]"); their address is in the definitions of the labels, which are
 * the blocks "linkDef" ("[label]: address").
 *
 * Offsets (`start`, `end`): the blocks, the lines and the list items — absolute
 * positions in the source text; the tokens of a line (and the cells of a table
 * row) — relative to the beginning of their line: the line gives the base.
 * The tokens do not move when the text above them grows, so the tree of the
 * blocks survives a change without touching them (see shiftBlock).
 * The block grammar intentionally mirrors the WYSIWYG editor's Markdown parser
 * (GitHub Flavored Markdown subset) so both sides see the same structure.
 */
const { splitLines } = require('./text.js');

const FENCE_RE = /^( {0,3})(`{3,}|~{3,})(.*)$/;
const HEADING_RE = /^( {0,3})(#{1,6})(?=[ \t]|$)([ \t]*)(.*)$/;
/* The divider of Marklar: a line of dashes, stars, underscores or equals. */
const HR_RE = /^ {0,3}([-*_=])([ \t]*\1){2,}[ \t]*$/;
/* The underline of a heading of the standard Markdown: "===" or "---". */
const SETEXT_RE = /^ {0,3}(={3,}|-{3,})([ \t]*)$/;
const STMT_NAME = '[A-Za-z][A-Za-z0-9_]*(?:\\.[A-Za-z_][A-Za-z0-9_]*)*';
const RE_STMT_INC = new RegExp(`^(\\s*)((?:\\.)?${STMT_NAME})\\s*(\\+\\+|--)\\s*$`);
const RE_STMT_ASSIGN = new RegExp(`^(\\s*)((?:\\.)?${STMT_NAME})(\\s*)(\\+=|-=|=(?!=))`);
/* The comment with the widths of the columns of a table. */
const WIDTHS_RE = /^\s*(?:<!--\s*)?widths\s*:\s*\[([\d.,\s]*)\]\s*(?:-->)?\s*$/;
const RE_COND_LINE = /^[\s ]*\?(?=[\s (]|$)/;
/* A line with a statement of Marklar: a paragraph with a statement is not
   a heading (the rule of the editor). */
const isStatement = l => RE_STMT_ASSIGN.test(l) || RE_STMT_INC.test(l) || RE_COND_LINE.test(l);
const QUOTE_RE = /^( {0,3})((?:>[ \t]?)+)(.*)$/;
const LIST_RE = /^( *)([-*+]|\d{1,9}[.)])( +|$)(.*)$/;
/* The footnote of the GFM: the definition "[^label]: text" is a block of its
   own, the reference "[^label]" in the text is an inline mark.  The label is
   the key of the footnote (the name of the user): the number of the footnote
   is counted by the editor - the core does not number them (the tokens of a
   line must not depend on the whole document, see the cache of the tokens). */
const FOOTNOTE_DEF_RE = /^( {0,3})\[\^([^\]\s]+)\]:(.*)$/;
/* A definition of a label of the reference links: "[label]: address". */
const LINKDEF_RE = /^ {0,3}\[((?:[^\[\]\\]|\\.)+)\]:[ \t]*(.*)$/;
const HTML_OPEN_RE = /^ {0,3}<!--/;
const isBlank = l => /^[ \t]*$/.test(l);
const isSepRow = l => /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/.test(l) && l.includes('-');

/** Builds a leaf token. */
const tok = (kind, start, text) => ({ type: 'token', kind, start, end: start + text.length, text });

/**
 * Parses Markdown into a lossless CST.
 * @param {string} text
 * @returns {{type:'document',start:number,end:number,children:object[],lines:object[]}}
 */
/**
 * The model of a list: the lists with their nesting (the view of the editor
 * is built on it).  The rules are the rules of the editor: the indent of an
 * item is the number of the spaces before it, an empty line inside the list
 * makes the list loose, two empty lines end the list.
 *
 * The model keeps the number of the line of every part: the tokens of the
 * line are taken from the flat items of the list.
 *
 * @param {Array} lines the lines of the document
 * @param {number} from the first line of the list
 * @param {number} to the line after the last line of the list
 * @returns {Array} the lists of the first level (every one with its items)
 */
function buildListModel(lines, from, to) {
  const top = [];
  const stack = [];                 // {indent, list}
  const lastItem = list => list.items[list.items.length - 1];
  const indentOf = l => l.match(/^ */)[0].length;
  let i = from;
  while (i < to) {
    const line = lines[i].text;
    if (isBlank(line)) {
      let j = i + 1;
      while (j < to && isBlank(lines[j].text)) j++;
      if (j >= to || !stack.length) { i = j; break; }
      const nl = lines[j].text, ind = indentOf(nl), lm = nl.match(LIST_RE);
      if (lm) {
        if (j - i > 1) break;       // two empty lines end the list
        const L0 = stack[stack.length - 1].list;
        L0.loose = true;
        // the empty line is a part of the list (in the source mode it ends
        // the list: the line is a block of its own)
        const it0 = lastItem(L0);
        it0.content.push({ blank: i, line: j });
        i = j; continue;
      }
      let k = stack.length - 1;
      while (k >= 0 && ind < lastItem(stack[k].list).contentIndent) k--;
      if (k >= 0) {
        lastItem(stack[k].list).content.push({ para: [nl.replace(/^\s+/, '')], lines: [j] });
        i = j + 1; continue;
      }
      break;
    }
    const m = line.match(LIST_RE);
    if (m) {
      const ind = m[1].length, mk = m[2];
      const type = /\d/.test(mk) ? 'ol' : 'ul';
      const marker = type === 'ul' ? mk : '.';
      const contentIndent = ind + mk.length + Math.max(1, Math.min(4, m[3].length || 1));
      let parent = null;
      while (stack.length) {
        const t = stack[stack.length - 1];
        const it = lastItem(t.list);
        if (ind >= Math.min(it.contentIndent, t.indent + 2)) { parent = t; break; }
        if (ind >= t.indent) break;
        stack.pop();
      }
      let entry;
      if (parent) {
        const L = { type, marker, start: parseInt(mk) || 1, items: [] };
        lastItem(parent.list).content.push({ list: L });
        entry = { indent: ind, list: L }; stack.push(entry);
      } else if (stack.length) {
        entry = stack[stack.length - 1];
        if (entry.list.type !== type || entry.list.marker !== marker) {
          const L = { type, marker, start: parseInt(mk) || 1, items: [] };
          if (stack.length === 1) top.push(L);
          else lastItem(stack[stack.length - 2].list).content.push({ list: L });
          entry.list = L; entry.indent = ind;
        }
      } else {
        const L = { type, marker, start: parseInt(mk) || 1, items: [] };
        top.push(L); entry = { indent: ind, list: L }; stack.push(entry);
      }
      entry.list.items.push({ content: [{ para: [m[4]], lines: [i] }], contentIndent, ind, mark: mk, line: i });
      i++; continue;
    }
    // a continuation line of the item
    if (!stack.length) break;
    const it = lastItem(stack[stack.length - 1].list);
    const last = it.content[it.content.length - 1];
    if (last && last.para) { last.para.push(line.replace(/^\s+/, '')); last.lines.push(i); }
    else it.content.push({ para: [line.replace(/^\s+/, '')], lines: [i] });
    i++;
  }
  return top;
}

function parseCST(text, opts = {}) {
  const cache = opts.cache || null;   // the cache of the tokens of the lines
  // The definitions of the labels of the whole document: they are given when
  // a piece of the document is parsed on its own (the text of a quote is a
  // document of its own - the links inside it are the links of the document).
  const outer = opts.refs || null;
  const lines = splitLines(text);
  const blocks = [];
  let i = 0;
  const n = lines.length;
  // the last split line is an empty string when the text ends with "\n": keep it as trivia only
  const last = n - 1;

  const isBlockStart = (k) => {
    const l = lines[k].text;
    return FENCE_RE.test(l) || HEADING_RE.test(l) || QUOTE_RE.test(l) || HR_RE.test(l) ||
      LIST_RE.test(l) || HTML_OPEN_RE.test(l) || FOOTNOTE_DEF_RE.test(l) || isTableStart(k);
  };
  const isTableStart = (k) => lines[k].text.includes('|') && k + 1 < n && isSepRow(lines[k + 1].text);

  while (i < n) {
    const L = lines[i], t = L.text;
    if (i === last && t === '' ) { if (L.start < text.length || n === 1) blocks.push(block('blank', [plainLine(L, 'space')])); break; }

    let m;
    if (isBlank(t)) { blocks.push(block('blank', [plainLine(L, 'space')])); i++; continue; }

    if ((m = t.match(FENCE_RE))) {
      const fence = m[2], info = m[3].trim();
      const out = [fenceLine(L, 'fenceOpen')];
      let j = i + 1, closed = false;
      for (; j < n; j++) {
        const c = lines[j].text;
        const cm = c.match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/);
        if (cm && cm[1][0] === fence[0] && cm[1].length >= fence.length) { out.push(fenceLine(lines[j], 'fenceClose')); closed = true; j++; break; }
        if (j === last && c === '') break;
        out.push(fenceLine(lines[j], 'codeText'));
      }
      blocks.push(block('fence', out, { info, closed }));
      i = j; continue;
    }

    if (HTML_OPEN_RE.test(t)) {
      const out = [];
      let j = i;
      for (; j < n; j++) {
        out.push(fenceLine(lines[j], 'comment'));
        if ((j === i ? lines[j].text.slice(lines[j].text.indexOf('<!--') + 4) : lines[j].text).includes('-->')) { j++; break; }
      }
      const blk = block('comment', out);
      // The comment with the widths of the columns belongs to the table that
      // stands under it (in the visual mode the comment is hidden).
      if (j < n && isTableStart(j)) {
        const texts = out.map((_, k) => lines[i + k].text);
        const wi = texts.findIndex(l => WIDTHS_RE.test(l));
        if (wi >= 0) {
          blk.widths = (texts[wi].match(WIDTHS_RE)[1] || '').split(',').map(x => Math.max(0, Math.round(+x) || 0));
          const rest = texts.filter((_, k) => k !== wi);
          blk.meta = rest.length > 2 ? rest.join('\n') : '';
        }
      }
      blocks.push(blk);
      i = j; continue;
    }

    if ((m = t.match(HEADING_RE))) {
      const level = m[2].length;
      const toks = [];
      let p = 0;                    // the offsets of the tokens are relative to the line
      if (m[1]) { toks.push(tok('indent', p, m[1])); p += m[1].length; }
      toks.push(tok('marker', p, m[2] + m[3])); p += m[2].length + m[3].length;
      // The closing sequence of the ATX heading ("# title #") is not a part of
      // the text of the heading (the rule of the CommonMark), but it is a part
      // of the text of the user: it is a token of its own (the editor hides it
      // in the visual mode and writes it back as it was written).
      const content = cutAtxClose(m[4]);
      toks.push(...inlineTokens(content, p, { comments: true, cache }));
      p += content.length;
      if (content.length < m[4].length) toks.push(tok('headingClose', p, m[4].slice(content.length)));
      toks.push(tok('eol', t.length, L.eol));
      blocks.push(block('heading', [lineNode(L, toks)], { level }));
      i++; continue;
    }

    if (HR_RE.test(t)) {
      blocks.push(block('hr', [lineNode(L, [tok('hr', 0, t), tok('eol', t.length, L.eol)])]));
      i++; continue;
    }

    if ((m = t.match(QUOTE_RE))) {
      const out = [];
      let j = i;
      while (j < n && (m = lines[j].text.match(QUOTE_RE))) {
        const Lj = lines[j];
        const toks = [];
        let p = 0;
        if (m[1]) { toks.push(tok('indent', p, m[1])); p += m[1].length; }
        toks.push(tok('marker', p, m[2])); p += m[2].length;
        toks.push(...inlineTokens(m[3], p, { comments: false, cache }));   // quoting beats comments
        toks.push(tok('eol', Lj.text.length, Lj.eol));
        out.push(lineNode(Lj, toks, { depth: (m[2].match(/>/g) || []).length }));
        j++;
      }
      blocks.push(block('blockquote', out));
      i = j; continue;
    }

    if (isTableStart(i)) {
      const sep = lines[i + 1];
      const out = [tableRow(lines[i], cache), lineNode(sep, [tok('delimiterRow', 0, sep.text), tok('eol', sep.text.length, sep.eol)])];
      let j = i + 2;
      while (j < n && !isBlank(lines[j].text) && lines[j].text.includes('|') && !(j === last && lines[j].text === '')) { out.push(tableRow(lines[j], cache)); j++; }
      const tb = block('table', out);
      // the comment with the widths (the one right above the table) is a part
      // of the block of the table
      const prev = blocks[blocks.length - 1];
      if (prev && prev.type === 'comment' && prev.widths) {
        tb.widths = prev.widths; tb.meta = prev.meta;
        tb.comment = { start: prev.start, end: prev.end };
      }
      blocks.push(tb);
      i = j; continue;
    }

    if (LIST_RE.test(t)) {
      const items = [];
      let item = null, j = i;
      while (j < n) {
        const Lj = lines[j], lt = Lj.text;
        if (j === last && lt === '') break;
        if (isBlank(lt)) {
          // a blank line continues the list only if the next content is indented or another item
          let k = j + 1; while (k < n && isBlank(lines[k].text) && !(k === last && lines[k].text === '')) k++;
          if (k < n && !(k === last && lines[k].text === '') && (LIST_RE.test(lines[k].text) || /^ {2,}\S/.test(lines[k].text)) &&
              !HEADING_RE.test(lines[k].text) && !FENCE_RE.test(lines[k].text)) {
            // two empty lines end the list (the rule of the Markdown): the
            // lines are the blocks of their own, the list is not swallowed
            if (k - j > 1) break;
            item.children.push(plainLine(Lj, 'space')); j++; continue;
          }
          break;
        }
        const lm = lt.match(LIST_RE);
        if (lm && !HR_RE.test(lt)) {
          const toks = [];
          let p = 0;
          if (lm[1]) { toks.push(tok('indent', p, lm[1])); p += lm[1].length; }
          toks.push(tok('marker', p, lm[2] + lm[3])); p += lm[2].length + lm[3].length;
          toks.push(...inlineTokens(lm[4], p, { comments: true, cache }));
          toks.push(tok('eol', lt.length, Lj.eol));
          item = { type: 'listItem', start: Lj.start, end: Lj.end + Lj.eol.length, marker: lm[2], indent: lm[1].length, children: [lineNode(Lj, toks)] };
          items.push(item); j++; continue;
        }
        if (j > i && (HEADING_RE.test(lt) || FENCE_RE.test(lt) || QUOTE_RE.test(lt) || HR_RE.test(lt) || HTML_OPEN_RE.test(lt) || FOOTNOTE_DEF_RE.test(lt) || isTableStart(j))) break;
        // continuation (indented or lazy) line of the current item
        item.children.push(contentLine(Lj, cache));
        j++;
      }
      items.forEach(it => { const lastLine = it.children[it.children.length - 1]; it.end = lastLine.end; });
      const model = buildListModel(lines, i, j);
      blocks.push({ type: 'list', start: items[0].start, end: items[items.length - 1].end, children: items, model });
      i = j; continue;
    }

    // The footnote of the GFM: the definition "[^label]: text".  It is a block
    // of its own: the paragraph above it ends before it and the text below it
    // is a paragraph of its own.  The label is the key of the footnote (the
    // name of the user): the number of the footnote is counted by the editor.
    if ((m = t.match(FOOTNOTE_DEF_RE))) {
      const label = m[2];
      const toks = [];
      let p = 0;
      if (m[1]) { toks.push(tok('indent', p, m[1])); p += m[1].length; }
      const marker = `[^${label}]:`;
      toks.push(tok('marker', p, marker)); p += marker.length;
      toks.push(...inlineTokens(m[3], p, { comments: true, cache }));
      toks.push(tok('eol', t.length, L.eol));
      blocks.push(block('footnoteDef', [lineNode(L, toks)], { label }));
      i++; continue;
    }

    // The definitions of the labels of the reference links ("[label]: address"):
    // they are the blocks of the document.  A definition cannot interrupt a
    // paragraph (the rule of the CommonMark), so a definition that stands in
    // the middle of a paragraph stays a part of it.
    if (LINKDEF_RE.test(t) && readLinkDef(t)) {
      const out = [], defs = [];
      let j = i;
      while (j < n) {
        const d = readLinkDef(lines[j].text);
        if (!d) break;
        let title = d.title;
        let titleLine = -1;
        if (title == null && j + 1 < n && !(j + 1 === last && lines[j + 1].text === '')) {
          // the title of the definition may stand on the next line
          const nm = lines[j + 1].text.match(/^[ \t]{0,3}(?:"([^"]*)"|'([^']*)'|\(([^)]*)\))[ \t]*$/);
          if (nm) {
            title = nm[1] != null ? nm[1] : nm[2] != null ? nm[2] : nm[3];
            titleLine = j + 1;
          }
        }
        d.title = title;
        d.line = lines[j].line;
        defs.push(d);
        out.push(plainLine(lines[j], 'linkDef'));
        j++;
        if (titleLine >= 0) { out.push(plainLine(lines[titleLine], 'linkDef')); j = titleLine + 1; }
      }
      blocks.push(block('linkDef', out, { defs }));
      i = j; continue;
    }

    // paragraph: consecutive lines until a blank line or another block
    const out = [contentLine(L, cache)];
    let j = i + 1;
    while (j < n && !isBlank(lines[j].text) && !isBlockStart(j) && !(j === last && lines[j].text === '')) { out.push(contentLine(lines[j], cache)); j++; }
    // The heading of the standard Markdown: the text under a line of "===" or
    // "---".  The underline is a divider: a block of its own (the text of the
    // user is not changed).  A paragraph with a statement of Marklar stays a
    // paragraph.
    if (j < n) {
      const set = lines[j].text.match(SETEXT_RE);
      if (set && !lines.slice(i, j).some(l => isStatement(l.text))) {
        blocks.push(block('heading', out, { level: set[1][0] === '=' ? 1 : 2, setext: true }));
        i = j; continue;          // the divider is the next block
      }
    }
    // Marklar: a line with the "?" operator begins its own group: the groups
    // are the blocks of their own (the text of the user is not changed).
    let gs = [[]];
    out.forEach((ln, k) => { if (k && RE_COND_LINE.test(lines[i + k].text)) gs.push([]); gs[gs.length - 1].push(ln); });
    for (const g of gs) blocks.push(block('paragraph', g));
    i = j;
  }

  // The reference links of the document are resolved: the address of a link is
  // the address of the definition of its label.
  const refs = collectRefs(blocks, outer);
  resolveRefBlocks(blocks, refs.map);

  return { type: 'document', start: 0, end: text.length, children: blocks, lines, refs: refs.map, refsKey: refs.key };
}


/** The number of the first line of a subtree (the lines of the document). */
function firstLineOf(node) {
  if (node.line != null) return node.line;
  for (const c of (node.children || [])) { const l = firstLineOf(c); if (l != null) return l; }
  return null;
}

/**
 * Moves the places of a subtree: the offsets in the text and the numbers of
 * the lines (the document has changed above it).  The blocks that did not
 * change are the same objects - only their places move.
 *
 * The tokens of a line are relative to the line and do not move: the walk
 * stops at the line (only the lines, the blocks and the list items are
 * touched).
 */
function shiftBlock(node, dOff, dLine) {
  if (node.start != null) node.start += dOff;
  if (node.end != null) node.end += dOff;
  if (node.line != null) node.line += dLine;
  if (node.comment) {                       // the comment of a table (the widths)
    if (node.comment.start != null) node.comment.start += dOff;
    if (node.comment.end != null) node.comment.end += dOff;
  }
  if (node.type === 'line') return;         // the tokens are relative to the line
  for (const c of (node.children || [])) shiftBlock(c, dOff, dLine);
  if (node.model) shiftModel(node.model, dLine);
}

/** The numbers of the lines of the model of a list move with the list. */
function shiftModel(model, dLine) {
  for (const L of (model || [])) {
    for (const it of (L.items || [])) {
      if (it.line != null) it.line += dLine;
      for (const c of (it.content || [])) {
        if (c.lines) for (let i = 0; i < c.lines.length; i++) c.lines[i] += dLine;
        if (c.blank != null) c.blank += dLine;
        if (c.line != null) c.line += dLine;
        if (c.list) shiftModel([c.list], dLine);
      }
    }
  }
}

/**
 * The tree of the blocks after a change inside one block: the changed block is
 * parsed again, the other blocks are the same objects (their places are moved).
 *
 * Returns null when the change cannot be done this way - the safe way is the
 * full parse.  It cannot be done when the change covers several blocks, when
 * the changed block parses into another number of blocks (the structure of the
 * document moved) or into a block of another kind.
 *
 * @param {object} prev the tree of the blocks before the change
 * @param {string} oldText the text before the change
 * @param {{start:number,end:number,text:string}} edit the change
 * @param {string} newText the text after the change
 * @param {Map|null} cache the cache of the tokens of the lines
 */
function rebuildCST(prev, oldText, edit, newText, cache) {
  const blocks = prev.children || [];
  const start = edit.start, end = edit.end;
  // the block that holds the change
  let bi = -1;
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.start <= start && end <= b.end) { bi = i; break; }
    if (b.start > start) break;
  }
  if (bi < 0) return null;
  const old = blocks[bi];
  const oldBlockText = oldText.slice(old.start, old.end);
  const newBlockText = oldBlockText.slice(0, start - old.start) + (edit.text || '') + oldBlockText.slice(end - old.start);
  // the changed block is parsed again (its own text: the block is whole)
  let parsed = null;
  try { parsed = parseCST(newBlockText, { cache }); } catch (e) { return null; }
  const fresh = (parsed.children || [])[0];
  if (!fresh || (parsed.children || []).length !== 1) return null;
  if (fresh.type !== old.type) return null;
  if (old.level != null && fresh.level !== old.level) return null;
  if (old.setext != null && fresh.setext !== old.setext) return null;
  // The block must not merge with the next one: the end of the text of the
  // block is the end of its line (the next block begins in a new line).
  const next = blocks[bi + 1] || null;
  if (next) {
    if (!/\n$/.test(newBlockText)) return null;
    // the next block is the underline of a heading: it belongs to the
    // paragraph above it - if that paragraph is this block, they are one
    if (next.type === 'paragraph' && /^=+\s*$/.test(newBlockText)) return null;
  }
  // the places of the new block are relative to its text: they are moved to its place
  const firstLine = firstLineOf(old) || 0;
  shiftBlock(fresh, old.start, firstLine);
  // The last empty line of the document is a trivia, not a block of its own
  // (the full parse keeps it as the trivia): if the changed block was that
  // line, it goes away with the change.
  if (bi === blocks.length - 1 && fresh.type === 'blank' && !newBlockText && newText.endsWith('\n')) {
    const without = blocks.slice(0, bi).concat(blocks.slice(bi + 1));
    const refs0 = collectRefs(without);
    return { type: 'document', start: 0, end: newText.length, children: without, lines: splitLines(newText), refs: refs0.map, refsKey: refs0.key };
  }
  // the blocks after the changed one move with the text
  const dOff = newBlockText.length - oldBlockText.length;
  const dLine = countLines(newBlockText) - countLines(oldBlockText);
  if (dOff || dLine) for (let i = bi + 1; i < blocks.length; i++) shiftBlock(blocks[i], dOff, dLine);
  // the tree of the blocks: the changed block is a new one, the others are the same objects
  const children = blocks.slice(0, bi).concat([fresh], blocks.slice(bi + 1));
  // The reference links are resolved again: the changed block was parsed on its
  // own, and the definitions of the labels may have changed with it.
  const refs = collectRefs(children);
  if (refs.key !== (prev.refsKey || '')) resolveRefBlocks(children, refs.map);
  else resolveRefBlocks([fresh], refs.map);
  return { type: 'document', start: 0, end: newText.length, children, lines: splitLines(newText), refs: refs.map, refsKey: refs.key };
}

/** The number of the lines of a text (the last empty line counts). */
function countLines(text) {
  let n = 1;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

/** Prints a CST (or any subtree) back to text. */
function printCST(node) {
  if (node.type === 'token') return node.text;
  let s = '';
  for (const c of node.children) s += printCST(c);
  return s;
}

/** Depth-first iteration over the nodes of a CST. */
function* walkCST(node, parent = null) {
  yield { node, parent };
  if (node.children) for (const c of node.children) yield* walkCST(c, node);
}

/** Leaf tokens of a subtree, in order. */
function tokensOf(node, out = []) {
  if (node.type === 'token') out.push(node);
  else node.children.forEach(c => tokensOf(c, out));
  return out;
}

/* ---------------------------------------------------------------- helpers */

/* ---------------- the reference links of the Markdown ----------------
   The CommonMark (and the GFM) knows three forms of a reference link:
     [text][label]  - the full form
     [text][]       - the collapsed form (the label is the text of the link)
     [text]         - the shortcut form (the label is the text of the link)
   The labels are defined by the blocks of the document:
     [label]: https://example.com
   The definitions are the blocks of the document: they are the service blocks
   of the Markdown (in the visual mode of the editor they are not drawn, in the
   source mode they are seen and they are edited).

   The text of a link is the text of the user: the address of the link is in
   the definition of its label.  A link whose label is not defined is not a
   link: it is the text of the user (the rule of the CommonMark). */

/**
 * The label of a reference: the spaces are collapsed and the case is ignored
 * (the rule of the CommonMark).  The escapes of the user are resolved.
 * @param {string} label
 * @returns {string}
 */
function normLabel(label) {
  return String(label == null ? '' : label)
    .replace(/\\(.)/g, '$1').trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Reads a definition of a label ("[label]: address "title"").  The title is
 * optional; the address may be written in the angle brackets.
 * @param {string} text the text of the line
 * @returns {{label:string,url:string,title:string,raw:string}|null} null: the
 *   line is not a definition
 */
function readLinkDef(text) {
  const m = String(text || '').match(LINKDEF_RE);
  if (!m) return null;
  const label = normLabel(m[1]);
  if (!label) return null;
  let rest = m[2].trim();
  if (!rest) return null;
  let url = '', title = null;
  if (rest[0] === '<') {
    const close = rest.indexOf('>');
    if (close < 0) return null;
    url = rest.slice(1, close).trim();
    rest = rest.slice(close + 1).trim();
  } else {
    const sp = rest.search(/[ \t]/);
    if (sp < 0) { url = rest; rest = ''; }
    else { url = rest.slice(0, sp); rest = rest.slice(sp).trim(); }
  }
  if (!url) return null;
  const tm = rest.match(/^(?:"([^"]*)"|'([^']*)'|\(([^)]*)\))$/);
  if (tm) title = tm[1] != null ? tm[1] : tm[2] != null ? tm[2] : tm[3];
  else if (rest) return null;         // the rest of the line is not a title
  return { label, url, title, raw: m[1] };
}

/**
 * The form of a reference link: it stands after the closing bracket of the
 * text of the link.
 * @param {string} s the text of the line
 * @param {number} close the place of the closing bracket of the text
 * @param {number} open the place of the opening bracket of the text
 * @returns {{form:string,label:string,end:number}|null} null: there is no
 *   reference link here
 */
function readRefForm(s, close, open) {
  const text = s.slice(open, close);
  if (s[close + 1] === '[') {
    const close2 = s.indexOf(']', close + 2);
    if (close2 < 0) return null;
    const label = s.slice(close + 2, close2);
    if (!label.trim()) {
      if (!text.trim()) return null;   // the collapsed form needs a text
      return { form: 'collapsed', label: text, end: close2 + 1 };
    }
    return { form: 'full', label, end: close2 + 1 };
  }
  if (!text.trim()) return null;       // the shortcut form needs a text
  return { form: 'shortcut', label: text, end: close + 1 };
}

/**
 * A reference link of the Markdown ("[text][label]", "[text][]", "[text]").
 * The address of the link is in the definitions of the document: the node
 * holds the label, the address is put into it when the document is resolved
 * (see resolveRefTokens).
 * @param {string} s the text of the line
 * @param {number} i the place of the opening bracket
 * @param {number} close the place of the closing bracket of the text
 * @param {{form:string,label:string,end:number}} ref the form of the link
 */
function refLinkNode(s, i, close, ref, base) {
  const open = i + 1;
  const text = s.slice(open, close);
  const kids = [
    tok('mark', base + i, '['),
    ...buildInlineTokens(text, base + open, { comments: false }),
    tok('mark', base + close, ']'),
  ];
  if (ref.form === 'full') {
    const len = ref.end - 1 - (close + 2);
    kids.push(tok('mark', base + close + 1, '['));
    kids.push(tok('text', base + close + 2, s.slice(close + 2, close + 2 + len)));
    kids.push(tok('mark', base + ref.end - 1, ']'));
  } else if (ref.form === 'collapsed') {
    kids.push(tok('mark', base + close + 1, '['));
    kids.push(tok('mark', base + ref.end - 1, ']'));
  }
  return inlineNode('refLink', base + i, base + ref.end, kids, {
    form: ref.form, label: ref.label, linkText: text,
    href: null, title: '', resolved: false, text: s.slice(i, ref.end),
  });
}

/**
 * A reference image of the Markdown ("![alt][label]", "![alt][]", "![alt]").
 */
function refImageNode(s, i, close, ref, base) {
  const open = i + 2;
  const alt = s.slice(open, close);
  const kids = [
    tok('mark', base + i, '!['),
    ...buildInlineTokens(alt, base + open, { comments: false }),
    tok('mark', base + close, ']'),
  ];
  if (ref.form === 'full') {
    const len = ref.end - 1 - (close + 2);
    kids.push(tok('mark', base + close + 1, '['));
    kids.push(tok('text', base + close + 2, s.slice(close + 2, close + 2 + len)));
    kids.push(tok('mark', base + ref.end - 1, ']'));
  } else if (ref.form === 'collapsed') {
    kids.push(tok('mark', base + close + 1, '['));
    kids.push(tok('mark', base + ref.end - 1, ']'));
  }
  return inlineNode('refImage', base + i, base + ref.end, kids, {
    form: ref.form, label: ref.label, linkText: alt, alt,
    href: null, title: '', resolved: false, text: s.slice(i, ref.end),
  });
}

/**
 * The definitions of the labels of the document: the map "the label → the
 * definition" and the signature of the map (it changes when a definition
 * changes).  The first definition of a label wins (the rule of the CommonMark).
 *
 * The definitions of the whole document can be given (outer): they are the
 * definitions of the document, in which a piece of it is parsed (the text of
 * a quote is a document of its own).  They win: the definitions of the piece
 * itself are used only for the labels that the document does not know.
 *
 * @param {Array} blocks the blocks of the document
 * @param {Map|null} outer the definitions of the whole document
 */
function collectRefs(blocks, outer = null) {
  const map = new Map();
  let key = '';
  if (outer) {
    for (const [k, d] of outer) {
      if (!map.has(k)) map.set(k, d);
      key += k + '\u0001' + d.url + '\u0002' + (d.title || '') + '\u0003';
    }
  }
  for (const b of blocks) {
    if (b.type !== 'linkDef') continue;
    for (const d of (b.defs || [])) {
      if (!map.has(d.label)) map.set(d.label, d);
      key += d.label + '\u0001' + d.url + '\u0002' + (d.title || '') + '\u0003';
    }
  }
  return { map, key };
}

/**
 * Resolves a reference link: the address of the link is the address of the
 * definition of its label.  A link whose label is not defined is not a link:
 * it is the text of the user (the rule of the CommonMark).
 *
 * The tokens of the lines are kept in the cache of the document and are never
 * changed: the resolved node is a new object.
 */
function resolveRefNode(t, refs) {
  const d = refs.get(normLabel(t.label));
  const href = d ? d.url : null;
  const title = d ? (d.title || '') : '';
  if (t.href === href && t.title === title) return null;
  return Object.assign({}, t, { href, title, resolved: !!d });
}

/** Resolves a token: an inline node with the reference links inside it. */
function resolveRefToken(t, refs) {
  if (!t || t.type !== 'inline') return null;
  if (t.kind === 'refLink' || t.kind === 'refImage') return resolveRefNode(t, refs);
  if (!t.children || !t.children.length) return null;
  const kids = resolveRefTokens(t.children, refs);
  return kids ? Object.assign({}, t, { children: kids }) : null;
}

/** Resolves the reference links in a list of tokens (a line or a cell). */
function resolveRefTokens(tokens, refs) {
  let out = null;
  for (let k = 0; k < tokens.length; k++) {
    const n = resolveRefToken(tokens[k], refs);
    if (n) { if (!out) out = tokens.slice(); out[k] = n; }
  }
  return out;
}

/** Resolves the reference links of a line (the cells of a table hold tokens). */
function resolveRefLine(ln, refs) {
  const list = ln.children || [];
  let out = null;
  for (let k = 0; k < list.length; k++) {
    const c = list[k];
    if (c.type === 'cell') {
      const kids = resolveRefTokens(c.children || [], refs);
      if (kids) { if (!out) out = list.slice(); out[k] = Object.assign({}, c, { children: kids }); }
      continue;
    }
    const n = resolveRefToken(c, refs);
    if (n) { if (!out) out = list.slice(); out[k] = n; }
  }
  if (out) ln.children = out;
}

/** Resolves the reference links of the blocks of the document. */
function resolveRefBlocks(blocks, refs) {
  for (const b of blocks) {
    const walk = node => {
      if (!node) return;
      if (node.type === 'line') { resolveRefLine(node, refs); return; }
      for (const c of (node.children || [])) walk(c);
    };
    walk(b);
  }
}

function block(type, children, extra = {}) {
  return { type, start: children[0].start, end: children[children.length - 1].end, children, ...extra };
}

function lineNode(L, toks, extra = {}) {
  return { type: 'line', line: L.index, start: L.start, end: L.end + L.eol.length, children: toks.filter(t => t.text.length || t.kind === 'eol'), ...extra };
}

function plainLine(L, kind) {
  return lineNode(L, [tok(kind, 0, L.text), tok('eol', L.text.length, L.eol)]);
}

function fenceLine(L, kind) {
  return lineNode(L, [tok(kind, 0, L.text), tok('eol', L.text.length, L.eol)]);
}

function contentLine(L, cache) {
  const m = L.text.match(/^[ \t]*/)[0];
  const toks = [];
  if (m) toks.push(tok('indent', 0, m));
  toks.push(...inlineTokens(L.text.slice(m.length), m.length, { comments: true, cache }));
  toks.push(tok('eol', L.text.length, L.eol));
  return lineNode(L, toks);
}

/**
 * Splits a table row into pipe and cell nodes (an escaped "\|" stays inside a cell).
 * Whitespace before the first pipe / after the last pipe is kept as trivia;
 * every segment between two pipes is a cell, even an empty one.
 * The places of the cells and the pipes are relative to the line.
 */
function tableRow(L, cache) {
  const t = L.text, toks = [], pipes = [];
  for (let p = 0; p < t.length; p++) {
    if (t[p] === '\\' && p + 1 < t.length) { p++; continue; }
    if (t[p] === '`') { const close = t.indexOf('`', p + 1); if (close > 0) { p = close; continue; } }
    if (t[p] === '|') pipes.push(p);
  }
  const cell = (a, b) => {
    const raw = t.slice(a, b);
    toks.push({ type: 'cell', start: a, end: a + raw.length, children: raw ? inlineTokens(raw, a, { comments: true, cache }) : [] });
  };
  const leadBlank = pipes.length && !t.slice(0, pipes[0]).trim();
  const tailBlank = pipes.length && !t.slice(pipes[pipes.length - 1] + 1).trim();
  let from = 0;
  if (leadBlank) { if (pipes[0]) toks.push(tok('indent', 0, t.slice(0, pipes[0]))); }
  pipes.forEach((p, k) => {
    if (!(k === 0 && leadBlank)) cell(from, p);
    toks.push(tok('pipe', p, '|'));
    from = p + 1;
  });
  if (tailBlank) { if (from < t.length) toks.push(tok('space', from, t.slice(from))); }
  else cell(from, t.length);
  toks.push(tok('eol', t.length, L.eol));
  return { type: 'line', line: L.index, start: L.start, end: L.end + L.eol.length, children: toks, row: true };
}

/**
 * Inline tokenizer for the content of a line. Recognises code spans, Marklar
 * inline expressions (%name% / %=expr%), wiki links, comments and a trailing
 * Obsidian anchor. Everything else is "text" (escapes are kept verbatim).
 *
 * The tokens of a line depend only on its text and on the place of the content
 * inside the line, so they are kept in the cache of the document: the lines
 * that the change did not touch are not read again.  The places of the tokens
 * are relative to the line — the same tokens can be shared by several lines
 * (the cache keeps the original: the tokens are never changed).
 *
 * @param {string} s the text of the content
 * @param {number} base the place of the content inside its line
 */
function inlineTokens(s, base, opts = {}) {
  const cache = opts.cache;
  if (!cache) return buildInlineTokens(s, base, opts);
  const key = (opts.comments ? '1' : '0') + '\u0001' + base + '\u0001' + s;
  let tpl = cache.get(key);
  if (!tpl) { tpl = buildInlineTokens(s, base, opts); cache.set(key, tpl); }
  return tpl;
}

/* The inline markup of the Markdown and the operators of Marklar: they are
   the inline nodes of the tree, so that the model of the editor can be built
   on the structures of the core.  The rules are the rules of the editor:
   the text of the markup does not begin or end with a space, the "_" opens a
   markup only at the edge of a word, the text of the "*" and of the "_" holds
   no marker of its kind. */
const OPS = ['::', '->', '%%', '?'];

/**
 * An inline node: the markup with the tokens of its content.
 * @param {string} kind
 * @param {number} start
 * @param {number} end
 * @param {object[]} children
 * @param {object} [extra]
 */
function inlineNode(kind, start, end, children, extra = {}) {
  return { type: 'inline', kind, start, end, children, text: extra.text || '', ...extra };
}

/**
 * The closing marker of the markup: the first one that closes it and whose
 * text does not end with a space.
 * @param {string} s the text of the line
 * @param {number} i the place of the opening marker
 * @param {string} mark the marker ("**", "__", "*", "_", "~~", "==")
 * @param {{word?:boolean, mark2?:boolean}} opts the rules of the markup
 * @returns {{end:number, body:string}|null}
 */
function closeMark(s, i, mark, opts = {}) {
  const start = i + mark.length;
  const first = s[start];
  if (first === undefined || /\s/.test(first)) return null;   // the text begins with a space
  const word = /[\p{L}\p{N}]/u;
  if (opts.word) {
    const before = i > 0 ? s[i - 1] : '';
    if (before && word.test(before)) return null;             // the "_" inside a word is a text
  }
  const single = mark.length === 1;
  for (let p = start + (single ? 1 : 0); p < s.length; p++) {
    if (!s.startsWith(mark, p)) continue;
    const body = s.slice(start, p);
    if (!body.length) continue;
    if (/\s$/.test(body)) continue;                           // the text ends with a space
    if (opts.mark2 && !markValid(body)) continue;             // the "==" needs a text of its own
    if (opts.word) {
      const after = s[p + mark.length];
      if (after !== undefined && word.test(after)) return null;
    }
    return { end: p + mark.length, body };
  }
  return null;
}

/** The text of the "==" markup: it is not empty and holds no "=" at the edges. */
function markValid(body) {
  const t = body.trim();
  return !!t && !t.startsWith('=') && !t.endsWith('=');
}

/* ---------------- the runs of the markers of the emphasis ----------------
   The CommonMark knows the runs of the markers: "***text***" is a bold text
   inside a cursive one, and the run that closes a markup is not shorter than
   the run that opens it.  The rule of three holds too: the sum of the lengths
   of the two runs must not be a multiple of three (unless both of them are
   multiples of three).  The rules of the editor before it (the text of the
   markup does not begin or end with a space, the "_" opens a markup only at
   the edge of a word) are kept. */

/** The length of the run of the markers at the place: "***" is a run of three. */
function runLen(s, i, c) {
  let n = 0;
  while (s[i + n] === c) n++;
  return n;
}

/** The rule of three (the CommonMark). */
function ruleOfThree(open, close) {
  const sum = open + close;
  if (sum % 3 !== 0) return true;
  return open % 3 === 0 && close % 3 === 0;
}

/**
 * The closing run of the emphasis: the run of the markers that closes the
 * opening run.  The rules of the CommonMark: the text of the markup does not
 * begin or end with a space, the "_" opens a markup only at the edge of a
 * word, the closing run is not shorter than the opening one and the rule of
 * three holds.
 * @param {string} s the text of the line
 * @param {number} i the place of the opening run
 * @param {string} c the marker ("*" or "_")
 * @param {number} open the length of the opening run
 * @returns {{closeStart:number, closeLen:number, bodyStart:number, body:string}|null}
 */
function findCloser(s, i, c, open) {
  const word = /[\p{L}\p{N}]/u;
  if (c === '_') {
    const before = i > 0 ? s[i - 1] : '';
    if (before && word.test(before)) return null;         // the "_" inside a word is a text
  }
  const bodyStart = i + open;
  if (bodyStart >= s.length || /\s/.test(s[bodyStart])) return null;   // the text begins with a space
  let p = bodyStart;
  while (p < s.length) {
    if (s[p] !== c) { p++; continue; }
    const len = runLen(s, p, c);
    if (len < open || !ruleOfThree(open, len)) { p += len; continue; }
    const body = s.slice(bodyStart, p);
    if (!body.length || /\s$/.test(body)) { p += len; continue; }   // the text is empty or ends with a space
    if (c === '_') {
      const after = s[p + len];
      if (after !== undefined && word.test(after)) { p += len; continue; }
    }
    return { closeStart: p, closeLen: len, bodyStart, body };
  }
  return null;
}

/**
 * The inline markup at the position: the marker and the text that it closes.
 * For the "*" and the "_" the run of the markers is known: the markup can be
 * a stack of them ("***text***" is a bold text inside a cursive one).
 * @param {string} s
 * @param {number} i
 * @returns {object|null}
 */
function inlineMark(s, i) {
  const c = s[i];
  if (c === '*' || c === '_') {
    // the marker is a part of a run that has begun before it: the run is read
    // at its beginning
    if (i > 0 && s[i - 1] === c) return null;
    const open = runLen(s, i, c);
    const r = findCloser(s, i, c, open);
    if (!r) return null;
    // the pairs of the markers: two markers make a bold text, one makes a
    // cursive text; the rest of the run wraps them ("***text***")
    const layers = [];
    let o = open, cl = r.closeLen;
    while (o > 0 && cl > 0) {
      const use = (o >= 2 && cl >= 2) ? 2 : 1;
      layers.push({ kind: use === 2 ? 'strong' : 'em', mark: c.repeat(use), len: use });
      o -= use; cl -= use;
    }
    const outer = layers[layers.length - 1];
    return {
      kind: outer.kind, mark: outer.mark, layers,
      openLen: open, closeStart: r.closeStart, closeLen: r.closeLen,
      bodyStart: r.bodyStart, body: r.body, end: r.closeStart + r.closeLen,
    };
  }
  if (c === '~' && s[i + 1] === '~') {
    const r = closeMark(s, i, '~~');
    return r ? { kind: 'strike', mark: '~~', ...r } : null;
  }
  if (c === '=' && s[i + 1] === '=') {
    const r = closeMark(s, i, '==', { mark2: true });
    return r ? { kind: 'mark', mark: '==', ...r } : null;
  }
  return null;
}

/**
 * The node of the emphasis: the markers of the run with the text between
 * them.  The run can hold several marks: "***text***" is a bold text inside a
 * cursive one - the layers are built from the inner one to the outer one.
 * @param {string} s the text of the line
 * @param {number} i the place of the opening run
 * @param {object} mk the markup (inlineMark)
 * @param {number} base the place of the line
 */
function emphasisNode(s, i, mk, base) {
  const layers = mk.layers;
  const openAt = [], closeAt = [];
  let acc = 0;
  // the inner layer takes the markers that stand next to the text, the outer
  // layer takes the ones that stand before them
  for (let j = 0; j < layers.length; j++) { acc += layers[j].len; openAt[j] = i + mk.openLen - acc; }
  acc = 0;
  for (let j = 0; j < layers.length; j++) { closeAt[j] = mk.closeStart + acc; acc += layers[j].len; }
  let inner = buildInlineTokens(mk.body, base + mk.bodyStart, { comments: false });
  for (let j = 0; j < layers.length; j++) {
    const l = layers[j];
    const kids = [
      tok('mark', base + openAt[j], l.mark),
      ...inner,
      tok('mark', base + closeAt[j], l.mark),
    ];
    inner = [inlineNode(l.kind, base + openAt[j], base + closeAt[j] + l.len, kids,
      { text: s.slice(openAt[j], closeAt[j] + l.len) })];
  }
  return inner[0];
}

/* ---------------- the target of a link and of a picture ----------------
   The CommonMark: "[text](address "title")" and "![alt](address "title")".  The
   address may be in the angle brackets ("<address>"), the title may be in the
   double quotes, in the single quotes or in the round brackets.  The spaces
   around the address are not a part of it (they are cut off).  When the target
   is not the target of the Markdown, the text is the text of the user. */
function readTarget(s, start) {
  let p = start;
  while (p < s.length && /[ \t]/.test(s[p])) p++;
  const destStart = p;
  let dest = '';
  if (s[p] === '<') {
    const close = s.indexOf('>', p + 1);
    if (close < 0) return null;
    dest = s.slice(p + 1, close);
    p = close + 1;
  } else {
    while (p < s.length && !/[\s()]/.test(s[p])) p++;
    dest = s.slice(destStart, p);
  }
  const destEnd = p;
  while (p < s.length && /[ \t]/.test(s[p])) p++;
  let title = null, titleStart = -1, titleEnd = -1;
  if (s[p] === '"' || s[p] === "'" || s[p] === '(') {
    const q = s[p];
    // the title in the round brackets is closed by the round bracket
    const close = s.indexOf(q === '(' ? ')' : q, p + 1);
    if (close < 0) return null;
    title = s.slice(p + 1, close);
    titleStart = p; titleEnd = close + 1;
    p = close + 1;
    while (p < s.length && /[ \t]/.test(s[p])) p++;
  }
  if (s[p] !== ')') return null;
  return {
    dest, title, titleStart, titleEnd, destStart, end: p + 1,
    // the address as the user wrote it (with the angle brackets)
    destRaw: s.slice(destStart, destEnd),
    // the title as the user wrote it (with the quotes)
    titleRaw: titleStart < 0 ? '' : s.slice(titleStart, titleEnd),
  };
}

/* ---------------- the entities of the HTML and the autolinks ----------------
   The core knows the rules of the Markdown and of the GFM:
     * the entity of the HTML ("&amp;", "&#35;", "&#x41;") is the character it
       stands for (the editor draws the character as a text - nothing of it is
       executed);
     * the autolink: the link of the CommonMark in the angle brackets
       ("<https://example.com>", "<user@example.com>") and the extended
       autolinks of the GFM ("www.example.com", "user@example.com").
   The core says what is a link and what is its text; the editor draws it. */

/* The named entities of the HTML: the common ones.  The numeric entities
   ("&#35;", "&#x41;") are read as they are (the core has no table for them). */
const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  nbsp: '\u00a0', iexcl: '\u00a1', cent: '\u00a2', pound: '\u00a3', curren: '\u00a4',
  yen: '\u00a5', brvbar: '\u00a6', sect: '\u00a7', uml: '\u00a8', copy: '\u00a9',
  ordf: '\u00aa', laquo: '\u00ab', not: '\u00ac', shy: '\u00ad', reg: '\u00ae',
  macr: '\u00af', deg: '\u00b0', plusmn: '\u00b1', sup2: '\u00b2', sup3: '\u00b3',
  acute: '\u00b4', micro: '\u00b5', para: '\u00b6', middot: '\u00b7', cedil: '\u00b8',
  sup1: '\u00b9', ordm: '\u00ba', raquo: '\u00bb', frac14: '\u00bc', frac12: '\u00bd',
  frac34: '\u00be', iquest: '\u00bf', Agrave: '\u00c0', Aacute: '\u00c1', Acirc: '\u00c2',
  Atilde: '\u00c3', Auml: '\u00c4', Aring: '\u00c5', AElig: '\u00c6', Ccedil: '\u00c7',
  Egrave: '\u00c8', Eacute: '\u00c9', Ecirc: '\u00ca', Euml: '\u00cb', Igrave: '\u00cc',
  Iacute: '\u00cd', Icirc: '\u00ce', Iuml: '\u00cf', ETH: '\u00d0', Ntilde: '\u00d1',
  Ograve: '\u00d2', Oacute: '\u00d3', Ocirc: '\u00d4', Otilde: '\u00d5', Ouml: '\u00d6',
  times: '\u00d7', Oslash: '\u00d8', Ugrave: '\u00d9', Uacute: '\u00da', Ucirc: '\u00db',
  Uuml: '\u00dc', Yacute: '\u00dd', THORN: '\u00de', szlig: '\u00df', agrave: '\u00e0',
  aacute: '\u00e1', acirc: '\u00e2', atilde: '\u00e3', auml: '\u00e4', aring: '\u00e5',
  aelig: '\u00e6', ccedil: '\u00e7', egrave: '\u00e8', eacute: '\u00e9', ecirc: '\u00ea',
  euml: '\u00eb', igrave: '\u00ec', iacute: '\u00ed', icirc: '\u00ee', iuml: '\u00ef',
  eth: '\u00f0', ntilde: '\u00f1', ograve: '\u00f2', oacute: '\u00f3', ocirc: '\u00f4',
  otilde: '\u00f5', ouml: '\u00f6', divide: '\u00f7', oslash: '\u00f8', ugrave: '\u00f9',
  uacute: '\u00fa', ucirc: '\u00fb', uuml: '\u00fc', yacute: '\u00fd', thorn: '\u00fe',
  yuml: '\u00ff', OElig: '\u0152', oelig: '\u0153', Scaron: '\u0160', scaron: '\u0161',
  Yuml: '\u0178', fnof: '\u0192', circ: '\u02c6', tilde: '\u02dc',
  Alpha: '\u0391', Beta: '\u0392', Gamma: '\u0393', Delta: '\u0394', Epsilon: '\u0395',
  Zeta: '\u0396', Eta: '\u0397', Theta: '\u0398', Iota: '\u0399', Kappa: '\u039a',
  Lambda: '\u039b', Mu: '\u039c', Nu: '\u039d', Xi: '\u039e', Omicron: '\u039f',
  Pi: '\u03a0', Rho: '\u03a1', Sigma: '\u03a3', Tau: '\u03a4', Upsilon: '\u03a5',
  Phi: '\u03a6', Chi: '\u03a7', Psi: '\u03a8', Omega: '\u03a9', alpha: '\u03b1',
  beta: '\u03b2', gamma: '\u03b3', delta: '\u03b4', epsilon: '\u03b5', zeta: '\u03b6',
  eta: '\u03b7', theta: '\u03b8', iota: '\u03b9', kappa: '\u03ba', lambda: '\u03bb',
  mu: '\u03bc', nu: '\u03bd', xi: '\u03be', omicron: '\u03bf', pi: '\u03c0',
  rho: '\u03c1', sigmaf: '\u03c2', sigma: '\u03c3', tau: '\u03c4', upsilon: '\u03c5',
  phi: '\u03c6', chi: '\u03c7', psi: '\u03c8', omega: '\u03c9',
  ensp: '\u2002', emsp: '\u2003', thinsp: '\u2009', zwnj: '\u200c', zwj: '\u200d',
  lrm: '\u200e', rlm: '\u200f', ndash: '\u2013', mdash: '\u2014', lsquo: '\u2018',
  rsquo: '\u2019', sbquo: '\u201a', ldquo: '\u201c', rdquo: '\u201d', bdquo: '\u201e',
  dagger: '\u2020', Dagger: '\u2021', bull: '\u2022', hellip: '\u2026', permil: '\u2030',
  prime: '\u2032', Prime: '\u2033', lsaquo: '\u2039', rsaquo: '\u203a', oline: '\u203e',
  frasl: '\u2044', euro: '\u20ac', trade: '\u2122', larr: '\u2190', uarr: '\u2191',
  rarr: '\u2192', darr: '\u2193', harr: '\u2194', crarr: '\u21b5', lArr: '\u21d0',
  uArr: '\u21d1', rArr: '\u21d2', dArr: '\u21d3', hArr: '\u21d4', forall: '\u2200',
  part: '\u2202', exist: '\u2203', empty: '\u2205', nabla: '\u2207', isin: '\u2208',
  notin: '\u2209', ni: '\u220b', prod: '\u220f', sum: '\u2211', minus: '\u2212',
  lowast: '\u2217', radic: '\u221a', prop: '\u221d', infin: '\u221e', ang: '\u2220',
  and: '\u2227', or: '\u2228', cap: '\u2229', cup: '\u222a', int: '\u222b',
  there4: '\u2234', sim: '\u223c', cong: '\u2245', asymp: '\u2248', ne: '\u2260',
  equiv: '\u2261', le: '\u2264', ge: '\u2265', sub: '\u2282', sup: '\u2283',
  nsub: '\u2284', sube: '\u2286', supe: '\u2287', oplus: '\u2295', otimes: '\u2297',
  perp: '\u22a5', sdot: '\u22c5', lceil: '\u2308', rceil: '\u2309', lfloor: '\u230a',
  rfloor: '\u230b', lang: '\u2329', rang: '\u232a', loz: '\u25ca', spades: '\u2660',
  clubs: '\u2663', hearts: '\u2665', diams: '\u2666',
};

/* The entity of the HTML: the named ones are in the table, the numeric ones
   are the code point.  The invalid ones (the zero, the surrogates, the codes
   above the last one) are not entities. */
function entityChar(name) {
  if (name[0] === '#') {
    const hex = name[1] === 'x' || name[1] === 'X';
    const code = parseInt(hex ? name.slice(2) : name.slice(1), hex ? 16 : 10);
    if (!isFinite(code) || code <= 0 || code > 0x10FFFF) return null;
    if (code >= 0xD800 && code <= 0xDFFF) return null;      // the surrogates are not characters
    return String.fromCodePoint(code);
  }
  const ch = ENTITIES[name];
  return ch === undefined ? null : ch;
}

/* The entity at the place i: the text of the user and the character it stands
   for (null - there is no entity here). */
const ENTITY_RE = /&(#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z][a-zA-Z0-9]{1,31});/y;
function entityAt(s, i) {
  ENTITY_RE.lastIndex = i;
  const m = ENTITY_RE.exec(s);
  if (!m) return null;
  const ch = entityChar(m[1]);
  return ch == null ? null : { text: m[0], char: ch };
}

/* The domain of the GFM: the segments of the letters, the digits, the "-" and
   the "_", separated by the periods.  There must be at least one period.
   mode "www": the "_" is not allowed in the last two segments; mode "mail":
   the "_" is not allowed at all. */
function gfmDomain(s, i, mode) {
  let p = i, dots = 0;
  const segs = [];
  let start = i;
  while (p < s.length) {
    const ch = s[p];
    if (ch === '.') { segs.push(s.slice(start, p)); dots++; start = p + 1; p++; continue; }
    if (/[A-Za-z0-9_-]/.test(ch)) { p++; continue; }
    break;
  }
  segs.push(s.slice(start, p));
  if (!segs[segs.length - 1].length) { segs.pop(); p--; dots--; }   // the domain does not end with a period
  if (dots < 1) return 0;
  const tail = mode === 'www' ? segs.slice(-2) : segs;
  if (tail.some(seg => seg.indexOf('_') >= 0)) return 0;
  return p - i;
}

/* The end of the autolink: the trailing punctuation is not a part of it (the
   rule of the CommonMark), the closing parenthesis that has no opening one
   too. */
function trimUrlEnd(s) {
  let end = s.length;
  for (;;) {
    const m = s.slice(0, end).match(/[?!.,:*_~]+$/);
    if (m) { end -= m[0].length; continue; }
    if (s[end - 1] === ')') {
      const t = s.slice(0, end);
      if ((t.match(/\)/g) || []).length > (t.match(/\(/g) || []).length) { end--; continue; }
    }
    break;
  }
  return end;
}

/* The autolink of the mail of the GFM: "user@example.com".  The local part:
   the letters, the digits and the ".", "-", "_", "+"; the domain: the letters,
   the digits and the "-", separated by the periods (at least one).  The last
   character of the domain is not the "-" (the rule of the GFM). */
const MAIL_CHAR_RE = /[A-Za-z0-9._+-]/;
const MAIL_RE = /^([A-Za-z0-9._+-]+)@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/;
function mailAutolink(s, i) {
  const m = MAIL_RE.exec(s.slice(i));
  if (!m) return null;
  let dom = m[2];
  while (dom.endsWith('-')) dom = dom.slice(0, -1);
  if (!dom) return null;
  return m[1] + '@' + dom;
}

/* The closing sequence of the ATX heading ("# title #"): the "#"s at the end
   of the text, which are preceded by a space.  They are not a part of the text
   of the heading (the rule of the CommonMark), but they are a part of the text
   of the user (they are written back as they were written). */
function cutAtxClose(text) {
  const m = text.match(/^(.*?)[ \t]+#+[ \t]*$/);
  return m ? m[1] : text;
}

/* The bare URL is not a link inside the target of a link or of a picture
   ("[text](https://example.com)"): the target is a part of the link, not a
   link of its own.  While the user is typing, the target is not closed yet -
   the rule looks for the label ("["..."]") and for the "(" after it. */
function inLinkTarget(s, i) {
  const open = s.lastIndexOf('[', i - 1);
  if (open < 0) return false;                        // there is no label before the place
  const close = s.indexOf(']', open + 1);
  if (close < 0 || close >= i) return false;         // the label is not closed (or it is closed after the place)
  if (s[close + 1] !== '(') return false;            // it is not a link ("[text] (url)")
  const end = s.indexOf(')', close + 2);
  return end < 0 || end >= i;                        // the target is not closed before the place
}

function buildInlineTokens(s, base, opts = {}) {
  const out = [];
  if (!s) return out;
  // a trailing ^anchor (checked on the whole line, like the editor)
  let anchor = null;
  const am = s.match(/(^|[ \t])\^[A-Za-z][\w-]*[ \t]*$/);
  if (am) { const a0 = am.index + am[1].length; anchor = tok('anchor', base + a0, s.slice(a0)); s = s.slice(0, a0); }

  let text = '', textStart = 0, i = 0;
  const flush = (end) => { if (text) out.push(tok('text', base + textStart, text)); text = ''; textStart = end; };
  const EXPR = /%(=[^%\n]+?|[A-Za-z][A-Za-z0-9_.]*)%/y;
  while (i < s.length) {
    const c = s[i];
    // the backslash escapes: the character after the backslash is a text
    if (c === '\\' && i + 1 < s.length && /[!-\/:-@\[-`{-~]/.test(s[i + 1])) {
      flush(i); out.push(tok('escape', base + i, s.slice(i, i + 2))); i += 2; textStart = i; continue;
    }
    if (c === '`') {
      const run = s.slice(i).match(/^`+/)[0];
      const close = s.indexOf(run, i + run.length);
      if (close > 0) { flush(i); out.push(tok('code', base + i, s.slice(i, close + run.length))); i = close + run.length; textStart = i; continue; }
    }
    // The entity of the HTML: "&amp;", "&#35;", "&#x41;".  The token holds
    // the text of the user (it is written back as it was written) and the
    // character the entity stands for (the editor draws it as a text).
    if (c === '&') {
      const ent = entityAt(s, i);
      if (ent) {
        flush(i);
        const t = tok('entity', base + i, ent.text);
        t.char = ent.char;
        out.push(t);
        i += ent.text.length; textStart = i; continue;
      }
    }
    if (c === '%') {
      EXPR.lastIndex = i;
      const m = EXPR.exec(s);
      if (m && (i === 0 || !/[%\w]/.test(s[i - 1]))) { flush(i); out.push(tok('inlineExpr', base + i, m[0])); i += m[0].length; textStart = i; continue; }
    }
    if (c === '[' && s[i + 1] === '[') {
      const close = s.indexOf(']]', i + 2);
      if (close > 0) { flush(i); out.push(tok('wiki', base + i, s.slice(i, close + 2))); i = close + 2; textStart = i; continue; }
    }
    // the image of the Markdown: "![text](url)"
    if (c === '!' && s[i + 1] === '[') {
      const close = s.indexOf(']', i + 2);
      const nl = s.indexOf('\n', i + 2);
      if (close > 0 && (nl < 0 || close < nl)) {
        if (s[close + 1] === '(') {
          const tg = readTarget(s, close + 2);
          if (tg && tg.dest) {
            flush(i);
            const alt = s.slice(i + 2, close);
            const inner = s.slice(close + 2, tg.end - 1);
            out.push(inlineNode('image', base + i, base + tg.end, [
              tok('mark', base + i, '!['),
              ...buildInlineTokens(alt, base + i + 2, { comments: false }),
              tok('mark', base + close, ']'),
              tok('mark', base + close + 1, '('),
              tok('text', base + close + 2, inner),
              tok('mark', base + tg.end - 1, ')'),
            ], {
              href: tg.dest, title: tg.title == null ? '' : tg.title,
              titleRaw: tg.titleRaw, alt, dest: tg.dest, destRaw: tg.destRaw,
              target: inner, text: s.slice(i, tg.end),
            }));
            i = tg.end; textStart = i; continue;
          }
        } else {
          // the reference image: "![alt][label]", "![alt][]" and "![alt]"
          const ref = readRefForm(s, close, i + 2);
          if (ref) {
            flush(i);
            out.push(refImageNode(s, i, close, ref, base));
            i = ref.end; textStart = i; continue;
          }
        }
      }
    }
    // The comment of the user: the rest of the line.  The mark stands at the
    // beginning of the line or after a space (a space is needed for the links:
    // "http://example.com" is a link, not a comment).  After a value (a digit
    // or a bracket) the mark is a comment too: "x = 350// a comment".
    if (opts.comments && c === '/' && s[i + 1] === '/' &&
        (i === 0 || /[ \t0-9)]/.test(s[i - 1]))) {
      flush(i);
      const rest = s.slice(i + 2);
      out.push({ type: 'token', kind: 'comment', start: base + i, end: base + s.length, text: s.slice(i),
        children: buildInlineTokens(rest, base + i + 2, { comments: false }) });
      i = s.length; textStart = i; break;
    }
    // the inline markup of the Markdown: "**bold**", "__bold__", "*italic*",
    // "_italic_", "~~strike~~", "==mark=="
    if (c === '*' || c === '_') {
      const mk = inlineMark(s, i);
      if (mk) {
        flush(i);
        out.push(emphasisNode(s, i, mk, base));
        i = mk.end; textStart = i; continue;
      }
    }
    if (c === '~' || c === '=') {
      const mk = inlineMark(s, i);
      if (mk) {
        flush(i);
        const start = base + i, end = base + mk.end;
        out.push(inlineNode(mk.kind, start, end, [
          tok('mark', start, mk.mark),
          ...buildInlineTokens(mk.body, base + i + mk.mark.length, { comments: false }),
          tok('mark', end - mk.mark.length, mk.mark),
        ], { text: s.slice(i, mk.end) }));
        i = mk.end; textStart = i; continue;
      }
    }
    // The footnote of the GFM: the reference "[^label]" in the text.  It is a
    // link without a target: the definition of it is a block of its own
    // ("[^label]: text").  The mark knows only the label - the number of the
    // footnote is counted by the editor (the tokens of a line must not depend
    // on the whole document: the cache of the tokens is built on the text of
    // the line alone).
    if (c === '[' && s[i + 1] === '^') {
      const close = s.indexOf(']', i + 2);
      const nl = s.indexOf('\n', i + 2);
      if (close > 0 && (nl < 0 || close < nl)) {
        const label = s.slice(i + 2, close);
        // "[^label](url)" is a link of the Markdown (the label of it is
        // "^label") - the footnote wins only when there is no url behind it.
        if (label && !/\s/.test(label) && s[close + 1] !== '(') {
          flush(i);
          out.push(inlineNode('footnoteRef', base + i, base + close + 1, [
            tok('mark', base + i, '[^'),
            tok('text', base + i + 2, label),
            tok('mark', base + close, ']'),
          ], { label, text: s.slice(i, close + 1) }));
          i = close + 1; textStart = i; continue;
        }
      }
    }
    // the link of the Markdown: "[text](url)"
    if (c === '[') {
      const close = s.indexOf(']', i + 1);
      const nl = s.indexOf('\n', i + 1);
      if (close > 0 && (nl < 0 || close < nl)) {
        if (s[close + 1] === '(') {
          const tg = readTarget(s, close + 2);
          if (tg) {
            flush(i);
            const label = s.slice(i + 1, close);
            const inner = s.slice(close + 2, tg.end - 1);
            out.push(inlineNode('link', base + i, base + tg.end, [
              tok('mark', base + i, '['),
              ...buildInlineTokens(label, base + i + 1, { comments: false }),
              tok('mark', base + close, ']'),
              tok('mark', base + close + 1, '('),
              tok('text', base + close + 2, inner),
              tok('mark', base + tg.end - 1, ')'),
            ], {
              href: tg.dest, title: tg.title == null ? '' : tg.title,
              titleRaw: tg.titleRaw, dest: tg.dest, destRaw: tg.destRaw,
              target: inner, text: s.slice(i, tg.end),
            }));
            i = tg.end; textStart = i; continue;
          }
        } else {
          // the reference link: "[text][label]", "[text][]" and "[text]"
          const ref = readRefForm(s, close, i + 1);
          if (ref) {
            flush(i);
            out.push(refLinkNode(s, i, close, ref, base));
            i = ref.end; textStart = i; continue;
          }
        }
      }
    }
    // The link without a markup: "https://example.com".  The address of a link
    // or of a picture is not a link of its own ("[text](https://example.com)").
    if ((c === 'h') && (i === 0 || !/[\w]/.test(s[i - 1])) && (s.startsWith('http://', i) || s.startsWith('https://', i))
        && !inLinkTarget(s, i)) {
      let p = i;
      while (p < s.length && !/[\s<>()]/.test(s[p])) p++;
      let url = s.slice(i, p);
      url = url.replace(/[.,;:!?"'»]+$/, '');
      if (url.length > 'https://'.length) {
        flush(i);
        out.push(inlineNode('url', base + i, base + i + url.length, [tok('text', base + i, url)], { href: url, text: url }));
        i += url.length; textStart = i; continue;
      }
    }
    // The autolink of the CommonMark: "<https://example.com>" and
    // "<user@example.com>".  The angle brackets are not a part of the text of
    // the link (in the visual mode they are not shown).
    if (c === '<') {
      const close = s.indexOf('>', i + 1);
      if (close > 0) {
        const inner = s.slice(i + 1, close);
        if (inner && !/[\s<>]/.test(inner)) {
          const um = inner.match(/^([A-Za-z][A-Za-z0-9+.-]{1,31}):[^\s<>]*$/);
          const mail = um ? null : mailAutolink(inner, 0);
          if (um || mail) {
            flush(i);
            out.push(inlineNode('url', base + i, base + close + 1, [
              tok('mark', base + i, '<'),
              tok('text', base + i + 1, inner),
              tok('mark', base + close, '>'),
            ], { href: inner, label: inner, text: s.slice(i, close + 1),
                 auto: 'angle', mailto: !!mail }));
            i = close + 1; textStart = i; continue;
          }
        }
      }
    }
    // The extended autolink of the GFM: "www.example.com" (the address of the
    // link is "http://" + the text of the user).
    if (c === 'w' && s.startsWith('www.', i) && (i === 0 || !/[\w]/.test(s[i - 1]))) {
      const dom = gfmDomain(s, i + 4, 'www');
      if (dom > 0) {
        let end = i + 4 + dom;
        if (s[end] === '/') {                    // the path of the link (it may be empty)
          let p = end;
          while (p < s.length && !/[\s<>]/.test(s[p])) p++;
          end = p;
        }
        const cut = trimUrlEnd(s.slice(i, end));
        if (cut > 4) {
          const url = s.slice(i, i + cut);
          flush(i);
          out.push(inlineNode('url', base + i, base + i + cut, [tok('text', base + i, url)],
            { href: url, label: url, text: url, auto: 'www' }));
          i += cut; textStart = i; continue;
        }
      }
    }
    // The extended autolink of the GFM: "user@example.com" (the address of the
    // link is "mailto:" + the text of the user).
    if (MAIL_CHAR_RE.test(c) && (i === 0 || !MAIL_CHAR_RE.test(s[i - 1]))) {
      const mail = mailAutolink(s, i);
      if (mail) {
        flush(i);
        out.push(inlineNode('url', base + i, base + i + mail.length, [tok('text', base + i, mail)],
          { href: mail, label: mail, text: mail, auto: 'mail', mailto: true }));
        i += mail.length; textStart = i; continue;
      }
    }
    // the operators of Marklar: "::", "->", "%%" and "?"
    if (c === ':' || c === '-' || c === '%' || c === '?') {
      const op = OPS.find(o => o[0] === c && s.startsWith(o, i));
      if (op) {
        flush(i);
        // the inline insert ("%%text%%") is one node: the markers and the text
        let end = i + op.length, body = '';
        if (op === '%%') {
          const close = s.indexOf('%%', i + 2);
          if (close > 0) { end = close + 2; body = s.slice(i + 2, close); }
        }
        out.push(inlineNode('op', base + i, base + end, [
          tok('op', base + i, op),
          ...(body ? buildInlineTokens(body, base + i + 2, { comments: false }) : []),
          ...(body ? [tok('op', base + end - 2, '%%')] : []),
        ], { op, text: s.slice(i, end) }));
        i = end; textStart = i; continue;
      }
    }
    if (!text) textStart = i;
    text += c; i++;
  }
  flush(i);
  if (anchor) out.push(anchor);
  return out;
}

module.exports = { parseCST, printCST, walkCST, tokensOf, inlineTokens, rebuildCST };
