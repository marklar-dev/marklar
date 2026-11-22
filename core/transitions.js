/* Marklar Core - transitions.js
   Dependencies: text
   Generated from the mono core bundle by tools/extract_core.py. */
/**
 * Marklar Core — transition operator "->" scanner.
 *
 * Spec ("The transition operator"):
 *   -> NodeId                          jump to a node
 *   -> ? (cond) NodeA : NodeB          choose the target with the ternary form
 *   "+ Option text -> NodeId"          the operator may also appear mid-line
 *
 * A node id is the heading text without spaces, compared case-insensitively,
 * so "-> Barmen Talk" and "-> BarmenTalk" both reach "## Barmen talk".
 *
 * The scanner works on plain line text (no Markdown escapes, no comment) and
 * returns exact spans, which the editor uses to make targets clickable.
 */
const { nodeKey } = require('./text.js');

/**
 * @typedef {{text:string,key:string,start:number,end:number}} TargetSpan
 * @typedef {{start:number,end:number,arrowStart:number,arrowEnd:number,
 *            targets:TargetSpan[], ternary:null|{condText:string,condStart:number,qStart:number,colon:number}}} Transition
 */

/** Characters that end a plain (non-ternary) target: dialog log "::", random "||", object marker. */
const STOP_RE = /::|\|\||->|\uFFFC/;
/** A mid-line target must look like a node name: letters, digits, "_" and spaces. */
const ID_LIKE = /^[\p{L}\p{N}_][\p{L}\p{N}_ \t]*$/u;
const MAX_WORDS = 3;

/**
 * Finds all "->" transitions in a line.
 * @param {string} line plain text of a line (comments already removed or masked)
 * @param {{skipLeading?:boolean}} [opts] skipLeading: ignore an arrow at the very
 *        start (used for headings, where "->" marks an entry point)
 * @returns {Transition[]}
 */
function scanTransitions(line, opts = {}) {
  const out = [];
  let inStr = null;
  for (let i = 0; i < line.length - 1; i++) {
    const c = line[i];
    if (inStr) { if (c === inStr || (inStr === '\u201d' && c === '"')) inStr = null; continue; }
    if (c === '"' || c === '\u201c' || c === '\u201d' || c === '\u00ab') { inStr = c === '\u201c' ? '\u201d' : c === '\u00ab' ? '\u00bb' : c; continue; }
    if (c !== '-' || line[i + 1] !== '>') continue;
    if (i > 0 && (line[i - 1] === '-' || line[i - 1] === '<' || line[i - 1] === '\\')) continue;   // "-->", "<->", escaped
    if (opts.skipLeading && !line.slice(0, i).trim()) { i++; continue; }
    const t = parseAfterArrow(line, i);
    // mid-line arrows in prose ("operator -> . Syntax") are not transitions:
    // only "text -> NodeId" with an id-like target (up to MAX_WORDS words) counts
    if (line.slice(0, i).trim() && !t.ternary && !(t.targets.length && ID_LIKE.test(t.targets[0].text) &&
        t.targets[0].text.trim().split(/\s+/).length <= MAX_WORDS)) { i++; continue; }
    out.push(t);
    i = Math.max(i + 1, t.end - 1);
  }
  return out;
}

function parseAfterArrow(line, at) {
  const arrowEnd = at + 2;
  let p = arrowEnd;
  while (p < line.length && /\s/.test(line[p])) p++;
  const tr = { start: at, end: line.length, arrowStart: at, arrowEnd, targets: [], ternary: null };

  if (line[p] === '?') {
    // -> ? (cond) A : B       — A and B are single identifiers
    const rest = line.slice(p);
    const m = rest.match(/^(\?\s*)([\s\S]*?)([^\s():?]+)\s*:\s*([^\s:]+)\s*$/);
    if (m) {
      const condStart = p + m[1].length;
      const aStart = p + m[1].length + m[2].length;
      const colon = line.indexOf(':', aStart + m[3].length);
      const bStart = line.indexOf(m[4], colon + 1);
      tr.ternary = { condText: m[2].trim(), condStart, qStart: p, colon };
      tr.targets.push(span(m[3], aStart), span(m[4], bStart));
      tr.end = bStart + m[4].length;
    } else {
      tr.ternary = { condText: rest.slice(1).trim(), condStart: p + 1, qStart: p, colon: -1 };
    }
    return tr;
  }

  // -> Target name   (spaces inside are allowed: they are ignored by the id rules)
  const tail = line.slice(p);
  const stop = tail.search(STOP_RE);
  const raw = (stop < 0 ? tail : tail.slice(0, stop)).replace(/\s+$/, '');
  if (raw) { tr.targets.push(span(raw, p)); tr.end = p + raw.length; }
  else tr.end = arrowEnd;
  return tr;
}

const span = (text, start) => ({ text, key: nodeKey(text), start, end: start + text.length });

module.exports = { scanTransitions };
