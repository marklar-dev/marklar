/* Marklar Core - formats.js
   Dependencies: none
   Generated from the mono core bundle by tools/extract_core.py. */
/**
 * Marklar Core — export serializers.
 *
 * The exported data is a tree of objects, arrays, numbers and strings
 * (export.js). The same tree is written as JSON, YAML or XML, so the
 * structure does not depend on the format (spec "Data export", rule 4).
 *
 *   JSON  standard JSON, 2-space indentation
 *   YAML  YAML 1.2 block style; strings are double-quoted (JSON escapes),
 *         numbers are plain, empty collections are [] / {}
 *   XML   every object key is an element; array items are <item> elements;
 *         keys that are not valid XML names become <entry key="…">;
 *         numbers carry type="number" so they can be told from text
 */

/** JSON text. */
function toJSON(data) { return JSON.stringify(data, null, 2) + '\n'; }

/* ---------------------------------------------------------------- YAML */

const YAML_PLAIN_KEY = /^[\p{L}_][\p{L}\p{N}_.-]*$/u;
const YAML_RESERVED = /^(?:true|false|null|yes|no|on|off|y|n|~)$/i;
const yamlKey = k => (YAML_PLAIN_KEY.test(k) && !YAML_RESERVED.test(k) ? k : JSON.stringify(k));
const yamlScalar = v => (v === null || v === undefined ? '""' : typeof v === 'number' ? String(v) : JSON.stringify(String(v)));
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);

/** YAML text. */
function toYAML(data) {
  return yamlNode(data, 0).replace(/^\n/, '') + '\n';
}
function yamlNode(v, indent) {
  const pad = ' '.repeat(indent);
  if (Array.isArray(v)) {
    if (!v.length) return ' []';
    return v.map(x => {
      if (isObj(x) && Object.keys(x).length) {
        // "- key: value" with the following keys aligned under the first one
        const body = yamlNode(x, indent + 2);
        return '\n' + pad + '- ' + body.replace(/^\n\s*/, '');
      }
      if (Array.isArray(x) && x.length) return '\n' + pad + '-' + yamlNode(x, indent + 2);
      return '\n' + pad + '-' + yamlInline(x);
    }).join('');
  }
  if (isObj(v)) {
    const keys = Object.keys(v);
    if (!keys.length) return ' {}';
    return keys.map(k => '\n' + pad + yamlKey(k) + ':' + yamlChild(v[k], indent + 2)).join('');
  }
  return ' ' + yamlScalar(v);
}
function yamlChild(v, indent) { return (Array.isArray(v) || isObj(v)) ? yamlNode(v, indent) : ' ' + yamlScalar(v); }
function yamlInline(v) {
  if (Array.isArray(v)) return ' []';
  if (isObj(v)) return ' {}';
  return ' ' + yamlScalar(v);
}

/* ---------------------------------------------------------------- XML */

const XML_NAME = /^[\p{L}_][\p{L}\p{N}_.-]*$/u;
const xmlEsc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  // characters not allowed in XML 1.0
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');

/**
 * XML text.
 * @param {*} data
 * @param {string} [root] name of the root element
 */
function toXML(data, root = 'data') {
  return '<?xml version="1.0" encoding="UTF-8"?>\n' + xmlElement(root, data, 0) + '\n';
}
function xmlElement(key, v, indent, attrs = '') {
  const pad = '  '.repeat(indent);
  let name = key, extra = attrs;
  if (!XML_NAME.test(key) || /^xml/i.test(key)) { name = 'entry'; extra += ` key="${xmlEsc(key)}"`; }
  if (Array.isArray(v)) {
    if (!v.length) return `${pad}<${name}${extra} type="list"/>`;
    return `${pad}<${name}${extra} type="list">\n${v.map(x => xmlElement('item', x, indent + 1)).join('\n')}\n${pad}</${name}>`;
  }
  if (isObj(v)) {
    const keys = Object.keys(v);
    if (!keys.length) return `${pad}<${name}${extra}/>`;
    return `${pad}<${name}${extra}>\n${keys.map(k => xmlElement(k, v[k], indent + 1)).join('\n')}\n${pad}</${name}>`;
  }
  if (typeof v === 'number') return `${pad}<${name}${extra} type="number">${v}</${name}>`;
  const s = v === null || v === undefined ? '' : String(v);
  return s ? `${pad}<${name}${extra}>${xmlEsc(s)}</${name}>` : `${pad}<${name}${extra}/>`;
}

/** Serializer by format name ("json" | "yaml" | "xml"). */
function serialize(data, format, root) {
  if (format === 'json') return toJSON(data);
  if (format === 'yaml') return toYAML(data);
  if (format === 'xml') return toXML(data, root);
  throw new Error(`Unknown export format "${format}"`);
}
const EXTENSIONS = { json: '.json', yaml: '.yaml', xml: '.xml' };

module.exports = { toJSON, toYAML, toXML, serialize, EXTENSIONS };
