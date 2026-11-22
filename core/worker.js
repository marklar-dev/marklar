/* Marklar Core - worker.js
   Dependencies: document
   Generated from the mono core bundle by tools/extract_core.py. */
/**
 * Marklar Core — background evaluation.
 *
 * The editor sends the whole Markdown text after each (debounced) change and
 * receives a serializable snapshot (Document API `snapshot()`). Running the
 * core in a Web Worker keeps typing responsive on large documents; when
 * workers are unavailable the client falls back to the main thread.
 *
 * Protocol
 *   → { id, type: 'update', text, seed? }
 *   ← { id, type: 'snapshot', snapshot }
 *   ← { id, type: 'error', message }
 */
const { createDocument } = require('./document.js');

/** Installs the message handler inside a worker global scope. */
function serveWorker(scope) {
  const doc = createDocument('');
  scope.onmessage = (e) => {
    const msg = e.data || {};
    if (msg.type !== 'update' && msg.type !== 'edit') return;
    try {
      if (msg.type === 'edit') doc.applyEdit(msg.edits || []);
      else doc.setText(msg.text, { history: false });
      scope.postMessage({ id: msg.id, type: 'snapshot', snapshot: doc.snapshot() });
    } catch (err) {
      scope.postMessage({ id: msg.id, type: 'error', message: String(err && err.stack || err) });
    }
  };
}

/**
 * Client used by the editor.
 *   const core = new CoreClient({ source });   // source: text of the core bundle
 *   core.onSnapshot = snap => …;               // only the newest result is delivered
 *   core.update(markdown);
 */
class CoreClient {
  /** @param {{source?:string}} opts bundle source used to start the worker */
  constructor(opts = {}) {
    this.seq = 0;
    this.latest = 0;
    this.onSnapshot = null;
    this.onError = null;
    this.worker = null;
    this.doc = null;
    if (opts.source && typeof Worker !== 'undefined' && typeof Blob !== 'undefined') {
      try {
        const blob = new Blob([opts.source, '\n;MarklarCore.serveWorker(self);'], { type: 'text/javascript' });
        this.worker = new Worker(URL.createObjectURL(blob));
        this.worker.onmessage = (e) => this._receive(e.data);
        this.worker.onerror = (e) => { e.preventDefault && e.preventDefault(); this._fallback(); };
      } catch (err) { this.worker = null; }
    }
    if (!this.worker) this._fallback();
  }

  /** Sends a change of a block of the document: the place of the block in the
   *  text and its new text.  The core counts what depends on the change. */
  updateEdit(edits) {
    const id = ++this.seq;
    this.latest = id;
    if (this.worker) { this.worker.postMessage({ id, type: 'edit', edits }); return; }
    Promise.resolve().then(() => {
      if (id !== this.latest) return;
      try {
        this.doc.applyEdit(edits || []);
        this._receive({ id, type: 'snapshot', snapshot: this.doc.snapshot() });
      } catch (err) { this._receive({ id, type: 'error', message: String(err && err.stack || err) }); }
    });
  }

  /** Sends a new text; older pending results are ignored when they arrive. */
  update(text) {
    const id = ++this.seq;
    this.latest = id;
    this._lastText = text;
    if (this.worker) { this.worker.postMessage({ id, type: 'update', text }); return; }
    // main-thread fallback: compute asynchronously to keep the call cheap
    Promise.resolve().then(() => {
      if (id !== this.latest) return;
      try {
        this.doc.setText(text, { history: false });
        this._receive({ id, type: 'snapshot', snapshot: this.doc.snapshot() });
      } catch (err) { this._receive({ id, type: 'error', message: String(err && err.stack || err) }); }
    });
  }

  _receive(msg) {
    if (msg.id !== this.latest) return;           // stale
    if (msg.type === 'snapshot' && this.onSnapshot) this.onSnapshot(msg.snapshot);
    if (msg.type === 'error' && this.onError) this.onError(msg.message);
  }

  _fallback() {
    if (this.worker) { try { this.worker.terminate(); } catch (e) { /* ignore */ } }
    this.worker = null;
    if (!this.doc) this.doc = createDocument('');
    if (this._lastText != null) this.update(this._lastText);
  }
}

module.exports = { serveWorker, CoreClient };
