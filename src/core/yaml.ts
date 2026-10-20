// A small, dependency-free YAML subset parser and emitter.
//
// Clearance keeps its runtime dependency count at zero, so policy files are
// parsed here instead of pulling in a YAML library. The subset covers what the
// .clearance/*.yml files and generated child pipelines need: block maps, block
// sequences (of scalars or maps), flow sequences/maps, comments, quoted strings,
// numbers, booleans and null. Anchors, tags and multi-document streams are not
// supported and raise a clear error instead of being silently misread.

export type YamlValue =
  | string
  | number
  | boolean
  | null
  | YamlValue[]
  | { [key: string]: YamlValue };

interface Line {
  indent: number;
  text: string; // content with indentation and trailing comment removed
  no: number; // 1-based line number for error messages
}

export class YamlError extends Error {
  constructor(message: string, line?: number) {
    super(line ? `YAML line ${line}: ${message}` : `YAML: ${message}`);
    this.name = 'YamlError';
  }
}

function stripComment(raw: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c === "'" && !inDouble) inSingle = !inSingle;
    else if (c === '"' && !inSingle && raw[i - 1] !== '\\') inDouble = !inDouble;
    else if (c === '#' && !inSingle && !inDouble && (i === 0 || /\s/.test(raw[i - 1]))) {
      return raw.slice(0, i);
    }
  }
  return raw;
}

function tokenize(src: string): Line[] {
  const out: Line[] = [];
  const rows = src.replace(/\r\n?/g, '\n').split('\n');
  rows.forEach((raw, idx) => {
    if (/^\s*(---|\.\.\.)\s*$/.test(raw)) {
      if (out.length > 0) throw new YamlError('multiple documents are not supported', idx + 1);
      return;
    }
    if (raw.includes('\t') && /^\s*\t/.test(raw)) throw new YamlError('tabs are not allowed for indentation', idx + 1);
    const text = stripComment(raw).replace(/\s+$/, '');
    if (text.trim() === '') return;
    const indent = text.length - text.trimStart().length;
    out.push({ indent, text: text.trim(), no: idx + 1 });
  });
  return out;
}

function splitFlow(body: string, line: number): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = '';
  let quote: string | null = null;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (quote) {
      cur += c;
      if (c === quote && body[i - 1] !== '\\') quote = null;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; cur += c; continue; }
    if (c === '[' || c === '{') depth++;
    if (c === ']' || c === '}') depth--;
    if (depth < 0) throw new YamlError('unbalanced brackets', line);
    if (c === ',' && depth === 0) { parts.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim() !== '') parts.push(cur.trim());
  return parts;
}

// Finds the ": " that separates a mapping key from its value. As in YAML,
// quotes only quote when they open the scalar; a plain scalar such as
// `echo "a: b"` is a mapping key, which is exactly what GitLab would do with it.
function findMapColon(text: string): number {
  let i = 0;
  if (text[0] === '"' || text[0] === "'") {
    const q = text[0];
    for (i = 1; i < text.length; i++) {
      if (text[i] === q && !(q === '"' && text[i - 1] === '\\')) {
        if (q === "'" && text[i + 1] === "'") { i++; continue; }
        break;
      }
    }
    i++;
  }
  const flow = text[0] === '[' || text[0] === '{';
  let depth = 0;
  for (; i < text.length; i++) {
    const c = text[i];
    if (flow && (c === '[' || c === '{')) depth++;
    if (flow && (c === ']' || c === '}')) depth--;
    if (c === ':' && depth === 0 && (i === text.length - 1 || text[i + 1] === ' ')) return i;
    if (c === ' ' && text[i + 1] === '#') return -1;
  }
  return -1;
}

function unquoteKey(k: string, line: number): string {
  const t = k.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return parseScalar(t, line) as string;
  }
  return t;
}

export function parseScalar(token: string, line = 0): YamlValue {
  const t = token.trim();
  if (t === '' || t === '~' || t === 'null' || t === 'Null' || t === 'NULL') return null;
  // GitLab CI's !reference tag is kept as a marker object so CI files can be linted.
  if (t.startsWith('!reference ')) return { '!reference': parseScalar(t.slice('!reference '.length), line) };
  if (t.startsWith('&') || t.startsWith('*') || t.startsWith('!')) {
    throw new YamlError(`anchors, aliases and tags are not supported ("${t}")`, line);
  }
  if (t.startsWith('[')) {
    if (!t.endsWith(']')) throw new YamlError('unterminated flow sequence', line);
    return splitFlow(t.slice(1, -1), line).map((p) => parseScalar(p, line));
  }
  if (t.startsWith('{')) {
    if (!t.endsWith('}')) throw new YamlError('unterminated flow map', line);
    const obj: { [k: string]: YamlValue } = {};
    for (const part of splitFlow(t.slice(1, -1), line)) {
      const ci = findMapColon(part);
      if (ci < 0) throw new YamlError(`expected "key: value" in flow map, got "${part}"`, line);
      obj[unquoteKey(part.slice(0, ci), line)] = parseScalar(part.slice(ci + 1), line);
    }
    return obj;
  }
  if (t.startsWith('"')) {
    if (!t.endsWith('"') || t.length < 2) throw new YamlError('unterminated double-quoted string', line);
    return t
      .slice(1, -1)
      .replace(/\\n/g, '\n')
      .replace(/\\t/g, '\t')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\');
  }
  if (t.startsWith("'")) {
    if (!t.endsWith("'") || t.length < 2) throw new YamlError('unterminated single-quoted string', line);
    return t.slice(1, -1).replace(/''/g, "'");
  }
  if (/^(true|True|TRUE)$/.test(t)) return true;
  if (/^(false|False|FALSE)$/.test(t)) return false;
  if (/^[-+]?(\d[\d_]*)?(\.\d+)?([eE][-+]?\d+)?$/.test(t) && /\d/.test(t)) return Number(t.replace(/_/g, ''));
  if (/^0x[0-9a-fA-F]+$/.test(t)) return parseInt(t, 16);
  return t;
}

class Parser {
  private i = 0;
  private lines: Line[];
  constructor(lines: Line[]) {
    this.lines = lines;
  }

  parse(): YamlValue {
    if (this.lines.length === 0) return null;
    const v = this.parseBlock(this.lines[0].indent);
    if (this.i < this.lines.length) {
      const l = this.lines[this.i];
      throw new YamlError(`unexpected content "${l.text}"`, l.no);
    }
    return v;
  }

  private parseBlock(indent: number): YamlValue {
    const first = this.lines[this.i];
    if (first.text.startsWith('- ') || first.text === '-') return this.parseSeq(indent);
    return this.parseMap(indent);
  }

  private parseBlockScalar(parentIndent: number, style: string): string {
    const folded = style.startsWith('>');
    const keep = style.includes('+');
    const strip = style.includes('-');
    const collected: string[] = [];
    let blockIndent = -1;
    while (this.i < this.lines.length && this.lines[this.i].indent > parentIndent) {
      const l = this.lines[this.i];
      if (blockIndent < 0) blockIndent = l.indent;
      collected.push(' '.repeat(Math.max(0, l.indent - blockIndent)) + l.text);
      this.i++;
    }
    let body = folded ? collected.join(' ') : collected.join('\n');
    if (!strip) body += '\n';
    if (keep) return body;
    return body;
  }

  private parseValueAfterKey(rest: string, indent: number, line: number): YamlValue {
    if (rest === '' ) {
      const next = this.lines[this.i];
      if (next && next.indent > indent) return this.parseBlock(next.indent);
      if (next && next.indent === indent && (next.text.startsWith('- ') || next.text === '-')) {
        return this.parseSeq(indent);
      }
      return null;
    }
    if (/^[|>][-+]?$/.test(rest)) return this.parseBlockScalar(indent, rest);
    return parseScalar(rest, line);
  }

  private parseMap(indent: number): YamlValue {
    const obj: { [k: string]: YamlValue } = {};
    while (this.i < this.lines.length) {
      const l = this.lines[this.i];
      if (l.indent < indent) break;
      if (l.indent > indent) throw new YamlError(`unexpected indentation`, l.no);
      if (l.text.startsWith('- ')) break;
      const ci = findMapColon(l.text);
      if (ci < 0) throw new YamlError(`expected "key: value", got "${l.text}"`, l.no);
      const key = unquoteKey(l.text.slice(0, ci), l.no);
      const rest = l.text.slice(ci + 1).trim();
      this.i++;
      if (key in obj) throw new YamlError(`duplicate key "${key}"`, l.no);
      obj[key] = this.parseValueAfterKey(rest, indent, l.no);
    }
    return obj;
  }

  private parseSeq(indent: number): YamlValue {
    const arr: YamlValue[] = [];
    while (this.i < this.lines.length) {
      const l = this.lines[this.i];
      if (l.indent < indent) break;
      if (l.indent > indent) throw new YamlError('unexpected indentation in sequence', l.no);
      if (!(l.text.startsWith('- ') || l.text === '-')) break;
      const rest = l.text === '-' ? '' : l.text.slice(2).trim();
      this.i++;
      if (/^[|>][-+]?$/.test(rest)) {
        arr.push(this.parseBlockScalar(indent, rest));
        continue;
      }
      if (rest === '') {
        const next = this.lines[this.i];
        arr.push(next && next.indent > indent ? this.parseBlock(next.indent) : null);
        continue;
      }
      const ci = findMapColon(rest);
      const isFlow = rest.startsWith('[') || rest.startsWith('{') || rest.startsWith('"') || rest.startsWith("'");
      if (ci >= 0 && !isFlow) {
        // "- key: value" starts an inline map whose further keys sit at indent+2
        const childIndent = indent + (l.text.length - rest.length);
        const obj: { [k: string]: YamlValue } = {};
        const key = unquoteKey(rest.slice(0, ci), l.no);
        const after = rest.slice(ci + 1).trim();
        obj[key] = this.parseValueAfterKey(after, childIndent, l.no);
        while (this.i < this.lines.length && this.lines[this.i].indent === childIndent && !this.lines[this.i].text.startsWith('- ')) {
          const m = this.lines[this.i];
          const mci = findMapColon(m.text);
          if (mci < 0) throw new YamlError(`expected "key: value", got "${m.text}"`, m.no);
          const k2 = unquoteKey(m.text.slice(0, mci), m.no);
          this.i++;
          if (k2 in obj) throw new YamlError(`duplicate key "${k2}"`, m.no);
          obj[k2] = this.parseValueAfterKey(m.text.slice(mci + 1).trim(), childIndent, m.no);
        }
        arr.push(obj);
      } else {
        arr.push(parseScalar(rest, l.no));
      }
    }
    return arr;
  }
}

export function parseYaml(src: string): YamlValue {
  return new Parser(tokenize(src)).parse();
}

// ---------------------------------------------------------------- emitter

const PLAIN_SAFE = /^[A-Za-z0-9_./$@-][A-Za-z0-9_ ./$@:=+()-]*$/;
const RESERVED = /^(true|false|null|yes|no|on|off|~|[-+]?\d+(\.\d+)?)$/i;

function emitScalar(v: string | number | boolean | null): string {
  if (v === null) return 'null';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (v === '') return "''";
  if (PLAIN_SAFE.test(v) && !RESERVED.test(v) && !v.includes(': ') && !v.endsWith(':') && !v.endsWith(' ')) return v;
  return JSON.stringify(v);
}

function isScalar(v: YamlValue): v is string | number | boolean | null {
  return v === null || typeof v !== 'object';
}

export function stringifyYaml(value: YamlValue, indent = 0): string {
  const pad = ' '.repeat(indent);
  if (isScalar(value)) return pad + emitScalar(value) + '\n';
  if (Array.isArray(value)) {
    if (value.length === 0) return pad + '[]\n';
    let out = '';
    for (const item of value) {
      if (isScalar(item)) out += `${pad}- ${emitScalar(item)}\n`;
      else if (typeof item === 'string' && (item as string).includes('\n')) out += `${pad}- ${JSON.stringify(item)}\n`;
      else {
        const inner = stringifyYaml(item, indent + 2);
        out += `${pad}- ${inner.slice(indent + 2)}`;
      }
    }
    return out;
  }
  const entries = Object.entries(value);
  if (entries.length === 0) return pad + '{}\n';
  let out = '';
  for (const [k, v] of entries) {
    const key = emitScalar(k);
    if (isScalar(v)) {
      if (typeof v === 'string' && v.includes('\n')) {
        const body = v.replace(/\n$/, '').split('\n').map((l) => `${pad}  ${l}`).join('\n');
        out += `${pad}${key}: |\n${body}\n`;
      } else out += `${pad}${key}: ${emitScalar(v)}\n`;
    } else if (Array.isArray(v) && v.length === 0) out += `${pad}${key}: []\n`;
    else if (!Array.isArray(v) && Object.keys(v).length === 0) out += `${pad}${key}: {}\n`;
    else out += `${pad}${key}:\n${stringifyYaml(v, indent + 2)}`;
  }
  return out;
}
