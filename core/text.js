/* Marklar Core - text.js
   Dependencies: none
   Generated from the mono core bundle by tools/extract_core.py. */
/**
 * Marklar Core — text helpers.
 *
 * Small, dependency-free utilities shared by all modules: line splitting with
 * source offsets, Markdown escape handling and identifier normalisation.
 *
 * Identifier rules (spec: "Syntax rules for the names of variables and objects"):
 *   - names are case-insensitive;
 *   - a name starts with a Latin letter and contains Latin letters, digits and "_";
 *   - dots separate the parts of a long (object-like) name.
 * Node ids are derived from heading text: spaces are removed, case is ignored
 * (spec: "Old tavern" → "OldTavern").
 */

/** ASCII punctuation that Markdown allows to be backslash-escaped. */
const MD_ESCAPABLE = /\\([!-/:-@[-`{-~])/g;

/** A single valid name segment (no dots). */
const NAME_SEGMENT_RE = /^[A-Za-z][A-Za-z0-9_]*$/;

/** A full (possibly dotted) name, without the "." / "this." prefix. */
const NAME_RE = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;

/**
 * Splits text into lines and keeps exact offsets and line terminators, so the
 * original text can always be rebuilt as `lines.map(l => l.text + l.eol).join('')`.
 * @param {string} text
 * @returns {{index:number,start:number,end:number,text:string,eol:string}[]}
 */
function splitLines(text) {
  const out = [];
  let pos = 0, index = 0;
  while (pos <= text.length) {
    const nl = text.indexOf('\n', pos);
    if (nl < 0) {
      out.push({ index, start: pos, end: text.length, text: text.slice(pos), eol: '' });
      break;
    }
    const cr = nl > pos && text[nl - 1] === '\r';
    const end = cr ? nl - 1 : nl;
    out.push({ index, start: pos, end, text: text.slice(pos, end), eol: cr ? '\r\n' : '\n' });
    pos = nl + 1; index++;
  }
  return out;
}

/** Removes Markdown backslash escapes: `\*` → `*`. Other backslashes are kept. */
function unescapeMd(s) {
  return s.replace(MD_ESCAPABLE, '$1');
}

/** Lower-cased lookup key of a variable/object name. */
function nameKey(name) {
  return String(name).toLowerCase();
}

/** True when `s` is a valid (possibly dotted) Marklar name. */
function isValidName(s) {
  return NAME_RE.test(s);
}

/**
 * Id of a table property / object written with spaces (spec "Autoformatting"):
 * "Some information" → "SomeInformation", "Old Warrior" → "OldWarrior".
 * The first word keeps its case; the following words start with a capital letter.
 */
function joinWords(s) {
  const w = String(s).trim().split(/\s+/).filter(Boolean);
  return w.map((x, i) => (i ? x.charAt(0).toUpperCase() + x.slice(1) : x)).join('');
}

/** "Old tavern" → "OldTavern" (display form of an id built from free text). */
function pascalCase(s) {
  return String(s).trim().split(/\s+/).filter(Boolean)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1)).join('');
}

/**
 * Lookup key of a node id or a transition target: whitespace removed, case
 * ignored. "Barmen Talk", "barmentalk" and "BarmenTalk" share the same key.
 */
function nodeKey(s) {
  return String(s).replace(/[\s\u00a0\u200b\ufeff]+/g, '').toLowerCase();
}

/**
 * Turns the raw Markdown text of a heading into its display name and id.
 * Removes the scenario marker "->", a trailing `{#custom-id}`, an Obsidian
 * anchor `^Id`, a `// comment`, inline `%expressions%` and inline formatting.
 * @param {string} raw heading text after the "#" marker
 * @returns {{name:string,id:string,key:string,entry:boolean}}
 */
function parseHeadingText(raw) {
  let s = raw;
  // an escaped arrow ("\-\>" / "\->") is literal text, not the scenario marker
  const literalArrow = /^\s*(\\-\\>|\\->|-\\>)/.test(s);
  s = s.replace(/\s+#+\s*$/, '');                         // closing hashes "## Title ##"
  s = s.replace(/\s*\{#[^}]*\}\s*$/, '');                 // {#custom-id}
  s = stripComment(s);
  s = s.replace(/(?:^|[ \t])\^[A-Za-z][\w-]*\s*$/, '');   // ^anchor
  let entry = false;
  if (!literalArrow) {
    const m = s.match(/^\s*->\s*/);
    if (m) { entry = true; s = s.slice(m[0].length); }
  }
  s = s.replace(/(^|[^\\])%(=[^%\n]+?|[A-Za-z][A-Za-z0-9_.]*)%/g, '$1');
  s = stripInlineMarks(s);
  s = unescapeMd(s).replace(/\s+/g, ' ').trim();
  return { name: s, id: pascalCase(s), key: nodeKey(s), entry };
}

/**
 * Removes a `// comment` from a line. Like the editor, a comment starts at
 * "//" placed at the start of the line or after whitespace.
 */
function stripComment(s) {
  const m = s.match(/(^|[ \t])\/\//);
  return m ? s.slice(0, m.index + m[1].length).replace(/[ \t]+$/, '') : s;
}

/** Position of a `// comment` in a line, or -1. */
function commentStart(s) {
  const m = s.match(/(^|[ \t])\/\//);
  return m ? m.index + m[1].length : -1;
}

/** Removes unescaped emphasis delimiters (**, __, ~~, ==, `) used for display only. */
function stripInlineMarks(s) {
  return s.replace(/(^|[^\\])(\*\*|__|~~|==|`)/g, '$1').replace(/(^|[^\\])(\*\*|__|~~|==|`)/g, '$1');
}

/** Collapses whitespace; used to compare a source line with the text the editor shows. */
function matchText(s) {
  return String(s).replace(/[\u200b\ufeff\ufffc]/g, '').replace(/\s+/g, ' ').trim();
}

module.exports = { NAME_SEGMENT_RE, NAME_RE, splitLines, unescapeMd, nameKey, isValidName, joinWords, pascalCase, nodeKey, parseHeadingText, stripComment, commentStart, stripInlineMarks, matchText };
