/* Marklar Core - diagnostics.js
   Dependencies: none
   Generated from the mono core bundle by tools/extract_core.py. */
/**
 * Marklar Core — Diagnostics Engine.
 *
 * Every stage of the core (CST, semantic analysis, evaluation, tables)
 * reports problems through a DiagnosticBag instead of throwing, so a broken
 * line never stops the processing of the rest of the document.
 *
 * A diagnostic is a plain serialisable object:
 *   { severity, code, message, uid, start, end, line, column, lineText, node }
 * where offsets are positions in the Markdown source and `line` is 0-based.
 */

const Severity = Object.freeze({ ERROR: 'error', WARNING: 'warning', INFO: 'info' });

class DiagnosticBag {
  constructor() {
    /** @type {object[]} */
    this.items = [];
    this._seen = new Set();
  }

  /**
   * Adds a diagnostic. Duplicates (same code, message and position) are ignored.
   * @param {'error'|'warning'|'info'} severity
   * @param {string} code      stable machine-readable id, e.g. "unknown-name"
   * @param {string} message   human-readable text (English)
   * @param {object} [where]   { start, end, line, column, lineText, node }
   */
  add(severity, code, message, where = {}) {
    const d = {
      severity, code, message,
      uid: where.uid ?? null,
      start: where.start ?? null,
      end: where.end ?? null,
      line: where.line ?? null,
      column: where.column ?? null,
      lineText: where.lineText ?? '',
      node: where.node ?? null
    };
    const key = `${code}|${message}|${d.start}|${d.line}`;
    if (this._seen.has(key)) return d;
    this._seen.add(key);
    this.items.push(d);
    return d;
  }

  error(code, message, where) { return this.add(Severity.ERROR, code, message, where); }
  warning(code, message, where) { return this.add(Severity.WARNING, code, message, where); }
  info(code, message, where) { return this.add(Severity.INFO, code, message, where); }

  /** Appends all diagnostics of another bag. */
  merge(other) { other.items.forEach(d => this.add(d.severity, d.code, d.message, d)); }

  /** Diagnostics sorted by position, errors first within the same line. */
  sorted() {
    const rank = { error: 0, warning: 1, info: 2 };
    return this.items.slice().sort((a, b) =>
      (a.line ?? 1e9) - (b.line ?? 1e9) || rank[a.severity] - rank[b.severity] || (a.start ?? 0) - (b.start ?? 0));
  }

  count(severity) { return this.items.filter(d => d.severity === severity).length; }
}

module.exports = { Severity, DiagnosticBag };
