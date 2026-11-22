/* Marklar Core - index.js
   The public API of the core.
   Dependencies: cst, document, edittime, evaluator, export, formats, functions,
                 lexer, parser, semantic, text, transitions, values, worker, zip

   Module map (spec "Subsystems and the order of the implementation"):
     text.js         text helpers: lines, escapes, names, node ids
     values.js       Values & Types: numbers, text, null, collections, errors
     diagnostics.js  diagnostic collection
     cst.js          Lossless Syntax Tree (Markdown blocks + Marklar trivia)
     lexer.js        expression tokens
     parser.js       expression AST
     functions.js    built-in functions and constants
     evaluator.js    expression evaluation
     transitions.js  "->" transition scanning (also used by the editor)
     semantic.js     Semantic AST: nodes, statements, tables, scenario marking
     scope.js        Runtime State: namespaces and variables
     tables.js       Table Engine: classes, objects, formulas, selectors
     dependency.js   Dependency Engine
     edittime.js     edit-time interpreter (two passes)
     export.js       data export: scenarios, localization table, tables
     formats.js      JSON / YAML / XML serializers
     zip.js          ZIP packaging of multi-file exports
     document.js     Document API
     worker.js       Web Worker host and client
*/

const { createDocument, MarklarDocument } = require('./document.js');
const { CoreClient, serveWorker } = require('./worker.js');
const { parseCST, printCST, walkCST } = require('./cst.js');
const { DocumentIndex } = require('./elementindex.js');
const { buildSemantic } = require('./semantic.js');
const { runEditTime, EditTimeInterpreter } = require('./edittime.js');
const { parseExpression } = require('./parser.js');
const { evaluate } = require('./evaluator.js');
const { tokenize } = require('./lexer.js');
const { scanTransitions } = require('./transitions.js');
const { nodeKey, nameKey, parseHeadingText, matchText } = require('./text.js');
const { format, valueFromText, LSError } = require('./values.js');
const { FUNCTIONS, CONSTANTS } = require('./functions.js');
const { exportScenario, exportTables, exportFiles, exportValue } = require('./export.js');
const { toJSON, toYAML, toXML, serialize, EXTENSIONS } = require('./formats.js');
const { makeZip } = require('./zip.js');
const { VERSION } = require('./version.js');

module.exports = {
  VERSION,
  createDocument,
  MarklarDocument,
  CoreClient,
  serveWorker,
  parseCST,
  DocumentIndex,
  printCST,
  walkCST,
  buildSemantic,
  runEditTime,
  EditTimeInterpreter,
  parseExpression,
  evaluate,
  tokenize,
  scanTransitions,
  nodeKey,
  nameKey,
  parseHeadingText,
  matchText,
  format,
  valueFromText,
  LSError,
  FUNCTIONS,
  CONSTANTS,
  exportScenario,
  exportTables,
  exportFiles,
  exportValue,
  toJSON,
  toYAML,
  toXML,
  serialize,
  EXTENSIONS,
  makeZip,
};
