/* Marklar Core - scope.js
   Dependencies: text, values
   Generated from the mono core bundle by tools/extract_core.py. */
/**
 * Marklar Core — Runtime State: namespaces and variables.
 *
 * Spec ("The namespace and the addressing, the prefix this."):
 *   - every variable is a property of a higher level object: a node, a table
 *     (class) or the hidden global object Global;
 *   - "x" declares a Global property, ".x" / "this.x" a property of the
 *     current node; locals of a node are visible in its child nodes and
 *     shadow the same names of parents and Global;
 *   - "Character.Health" is just a long name (a property of Global);
 *   - "NodeName.x" addresses a property of another node;
 *   - every node has an automatic ".count" (activation counter, 0 at edit-time).
 *
 * This module only stores state. Resolution rules that depend on the
 * evaluation order live in edittime.js.
 */
const { nameKey } = require('./text.js');
const { NULL } = require('./values.js');

/** A single variable (a property of a namespace). */
class Variable {
  constructor(ns, name) {
    this.ns = ns;
    this.name = name;           // spelling of the first declaration
    this.key = nameKey(name);
    this.value = NULL;
    /**
     * 'pending'  declared with an expression that is not evaluated yet (pass 1)
     * 'done'     has a value
     * 'runtime'  assigned only by runtime code (scenario bullets / conditions)
     * 'builtin'  automatic property (count)
     */
    this.state = 'pending';
    this.decl = null;           // declaring unit (first unconditional assignment)
    this.declIndex = Infinity;  // position of the declaration in the unit list
    this.error = null;
    this.line = -1;
  }
  /** Stable id used by the dependency graph and the API. */
  get id() { return `${this.ns.label}.${this.name}`; }
}

/** Global, node or import-alias namespace. */
class Namespace {
  /**
   * @param {'global'|'node'|'alias'} kind
   * @param {string} label  display name ("Global", node id, alias)
   * @param {object|null} node semantic node for kind 'node'
   * @param {Namespace|null} parent enclosing node namespace (null for top-level nodes)
   */
  constructor(kind, label, node = null, parent = null) {
    this.kind = kind;
    this.label = label;
    this.node = node;
    this.parent = parent;
    /** @type {Map<string, Variable>} */
    this.vars = new Map();
  }
  get(name) { return this.vars.get(nameKey(name)); }
  /** Returns the variable, creating it when missing. */
  declare(name) {
    const k = nameKey(name);
    let v = this.vars.get(k);
    if (!v) { v = new Variable(this, name); this.vars.set(k, v); }
    return v;
  }
}

/** All namespaces of one evaluation. */
class RuntimeState {
  /** @param {object} ast semantic AST */
  constructor(ast) {
    this.ast = ast;
    this.global = new Namespace('global', 'Global', ast.root, null);
    /** @type {Map<string, Namespace>} node uid → namespace */
    this.nodeNs = new Map();
    this.nodeNs.set(ast.root.uid, this.global);
    for (const n of ast.nodes) {
      const parent = n.parent && !n.parent.isRoot ? this.nodeNs.get(n.parent.uid) : null;
      const ns = new Namespace('node', n.id || n.name || n.uid, n, parent);
      const c = ns.declare('count');           // automatic activation counter
      c.value = 0; c.state = 'builtin';
      this.nodeNs.set(n.uid, ns);
    }
    /** @type {Map<string, {ns:Namespace|null, table:object|null, unresolved:boolean}>} */
    this.aliases = new Map();
    /** the chains of the scopes (they do not change while the state lives) */
    this._chains = new Map();
    /** @type {Map<string, object>} table name key → TableModel */
    this.tables = new Map();
  }

  /** Namespace of a semantic node (the root node maps to Global). */
  nsOf(node) { return this.nodeNs.get(node.uid) || this.global; }

  /** Node namespaces from `node` up to its top-level ancestor (Global excluded). */
  chain(node) {
    // the chain of the scopes of a node: it does not change while the state lives
    const hit = this._chains.get(node.uid);
    if (hit) return hit;
    const out = [];
    let ns = this.nsOf(node);
    if (ns === this.global) { this._chains.set(node.uid, out); return out; }
    while (ns) { out.push(ns); ns = ns.parent; }
    this._chains.set(node.uid, out);
    return out;
  }

  /** Every variable, for API listings. */
  allVariables() {
    const out = [];
    for (const ns of new Set(this.nodeNs.values())) for (const v of ns.vars.values()) out.push(v);
    for (const a of this.aliases.values()) if (a.ns) for (const v of a.ns.vars.values()) out.push(v);
    return out;
  }
}

module.exports = { Variable, Namespace, RuntimeState };
