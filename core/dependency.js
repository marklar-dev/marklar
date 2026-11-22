/* Marklar Core - dependency.js
   Dependencies: none
   Generated from the mono core bundle by tools/extract_core.py. */
/**
 * Marklar Core — Dependency Engine.
 *
 * Records, for every evaluated unit (statement, inline expression, table
 * cell), which values it read and which it wrote. The graph answers:
 *   dependenciesOf(id)  — what a unit / variable depends on
 *   dependentsOf(key)   — everything that must be recomputed when `key` changes
 *                         (transitive), e.g. for incremental recalculation and
 *                         "who uses this variable" navigation.
 *
 * Keys are strings: "var:Global.x", "var:Tavern.beer", "cell:NPC!D2".
 */
class DependencyGraph {
  constructor() {
    /** @type {Map<string, Set<string>>} unit id → keys it read */
    this.reads = new Map();
    /** @type {Map<string, Set<string>>} unit id → keys it wrote */
    this.writes = new Map();
    /** @type {Map<string, Set<string>>} key → unit ids that read it */
    this.readers = new Map();
    /** @type {Map<string, Set<string>>} key → unit ids that write it */
    this.writers = new Map();
  }

  /** Adds (or extends) the record of a unit. */
  record(id, reads = [], writes = []) {
    const r = this._set(this.reads, id), w = this._set(this.writes, id);
    for (const k of reads) { r.add(k); this._set(this.readers, k).add(id); }
    for (const k of writes) { w.add(k); this._set(this.writers, k).add(id); }
  }

  /** Direct dependencies of a unit, or of a value key (through its writers). */
  dependenciesOf(idOrKey) {
    if (this.reads.has(idOrKey)) return [...this.reads.get(idOrKey)];
    const out = new Set();
    for (const u of this.writers.get(idOrKey) || []) for (const k of this.reads.get(u) || []) out.add(k);
    return [...out];
  }

  /** Transitive set of unit ids affected by a change of `key`. */
  dependentsOf(key) {
    const out = new Set(), queue = [key], seenKeys = new Set([key]);
    while (queue.length) {
      const k = queue.shift();
      for (const u of this.readers.get(k) || []) {
        if (out.has(u)) continue;
        out.add(u);
        for (const w of this.writes.get(u) || []) if (!seenKeys.has(w)) { seenKeys.add(w); queue.push(w); }
      }
    }
    return [...out];
  }

  /** Plain object form (for workers and debugging). */
  toJSON() {
    const obj = {};
    for (const [id, r] of this.reads) obj[id] = { reads: [...r], writes: [...(this.writes.get(id) || [])] };
    return obj;
  }

  _set(map, k) { let s = map.get(k); if (!s) { s = new Set(); map.set(k, s); } return s; }
}

module.exports = { DependencyGraph };
