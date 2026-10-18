// Minimal zero-dependency YAML reader, sufficient for architecture/contracts/openapi.yaml.
// Supported: block maps and sequences, flow maps/sequences (possibly multi-line), plain / single- / double-quoted
// scalars, block scalars (| and >), comments, null/bool/number scalars.
// Not supported: anchors, aliases, tags, multi-document streams, complex keys, multi-line plain scalars.
// Leniency: inside a flow mapping a comma-separated fragment without a colon is appended to the previous string value
// (the contract writes unquoted prose with commas in flow mappings, e.g. `{ type: string, description: See A, B. }`).

/** Strip a trailing ` # comment` that is outside quotes. */
function stripComment(s) {
  let q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '\\' && q === '"') i++;
      else if (c === q) {
        if (q === "'" && s[i + 1] === "'") i++;
        else q = null;
      }
    } else if (c === '"' || c === "'") {
      if (i === 0 || /[\s[{,:]/.test(s[i - 1])) q = c;
    } else if (c === '#' && (i === 0 || /\s/.test(s[i - 1]))) {
      return s.slice(0, i).trimEnd();
    }
  }
  return s.trimEnd();
}

function unquote(s) {
  if (s[0] === '"') return JSON.parse(s);
  return s.slice(1, -1).replace(/''/g, "'");
}

function scalar(raw) {
  const s = raw.trim();
  if (s === '' || s === '~' || s === 'null') return null;
  if (s === 'true') return true;
  if (s === 'false') return false;
  if ((s[0] === '"' && s.endsWith('"') && s.length > 1) || (s[0] === "'" && s.endsWith("'") && s.length > 1)) return unquote(s);
  if (/^-?\d+$/.test(s)) return Number(s);
  if (/^-?\d+\.\d+$/.test(s)) return Number(s);
  return s;
}

// ---------------------------------------------------------------- flow collections
function parseFlow(src) {
  let i = 0;
  const ws = () => { while (i < src.length && /\s/.test(src[i])) i++; };
  const quoted = () => {
    const q = src[i];
    let j = i + 1;
    while (j < src.length) {
      if (src[j] === '\\' && q === '"') j += 2;
      else if (src[j] === q) {
        if (q === "'" && src[j + 1] === "'") j += 2;
        else break;
      } else j++;
    }
    const lit = src.slice(i, j + 1);
    i = j + 1;
    return unquote(lit);
  };
  function plain(stops) {
    const start = i;
    while (i < src.length && !stops(src[i], src[i + 1])) i++;
    return src.slice(start, i).trim();
  }
  function value() {
    ws();
    if (src[i] === '{') return map();
    if (src[i] === '[') return seq();
    if (src[i] === '"' || src[i] === "'") return quoted();
    return scalar(plain((c) => c === ',' || c === ']' || c === '}'));
  }
  function seq() {
    i++;
    const out = [];
    for (;;) {
      ws();
      if (i >= src.length) throw new Error('Unterminated flow sequence');
      if (src[i] === ']') { i++; return out; }
      out.push(value());
      ws();
      if (src[i] === ',') i++;
    }
  }
  function map() {
    i++;
    const out = {};
    let last = null;
    for (;;) {
      ws();
      if (i >= src.length) throw new Error('Unterminated flow mapping');
      if (src[i] === '}') { i++; return out; }
      let key;
      if (src[i] === '"' || src[i] === "'") key = quoted();
      else key = plain((c, n) => c === ',' || c === '}' || (c === ':' && (n === undefined || /[\s,}]/.test(n))));
      ws();
      if (src[i] === ':') {
        i++;
        ws();
        out[key] = (src[i] === ',' || src[i] === '}') ? null : value();
        last = key;
      } else if (last !== null && typeof out[last] === 'string') {
        out[last] = `${out[last]}, ${key}`; // prose comma inside an unquoted value
      } else if (key !== '') {
        out[key] = null;
        last = key;
      }
      ws();
      if (src[i] === ',') i++;
    }
  }
  const v = value();
  ws();
  if (i < src.length) throw new Error(`Unexpected trailing text in flow value: ${src.slice(i, i + 20)}`);
  return v;
}

function flowBalanced(s) {
  let depth = 0;
  let q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '\\' && q === '"') i++;
      else if (c === q) q = null;
    } else if ((c === '"' || c === "'") && (i === 0 || /[\s[{,:]/.test(s[i - 1]))) q = c;
    else if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') depth--;
  }
  return depth <= 0;
}

// ---------------------------------------------------------------- block structure
/** Split `key: rest` for a block line. Returns null when the line is not a mapping entry. */
function splitKey(text) {
  if (text[0] === '"' || text[0] === "'") {
    const q = text[0];
    let j = 1;
    while (j < text.length) {
      if (text[j] === '\\' && q === '"') j += 2;
      else if (text[j] === q) { if (q === "'" && text[j + 1] === "'") j += 2; else break; } else j++;
    }
    const rest = text.slice(j + 1);
    if (rest[0] !== ':') return null;
    return { key: unquote(text.slice(0, j + 1)), rest: rest.slice(1).trim() };
  }
  const m = /:(\s|$)/.exec(text);
  if (!m) return null;
  return { key: text.slice(0, m.index).trim(), rest: text.slice(m.index + 1).trim() };
}

/**
 * Parse YAML text into plain JS values.
 * @param {string} text
 * @returns {any}
 */
export function parseYaml(text) {
  const lines = text.split(/\r?\n/).map((raw) => ({ raw, indent: raw.length - raw.trimStart().length, text: raw.trim() }));
  let pos = 0;
  const skipBlank = () => { while (pos < lines.length && (lines[pos].text === '' || lines[pos].text.startsWith('#'))) pos++; };

  function blockScalar(header, parentIndent) {
    const fold = header[0] === '>';
    const chomp = header.includes('-') ? 'strip' : header.includes('+') ? 'keep' : 'clip';
    const body = [];
    while (pos < lines.length && (lines[pos].text === '' || lines[pos].indent > parentIndent)) body.push(lines[pos++]);
    while (body.length && body[body.length - 1].text === '') body.pop();
    const base = Math.min(...body.filter((l) => l.text !== '').map((l) => l.indent), Infinity);
    const rows = body.map((l) => (l.text === '' ? '' : l.raw.slice(base)));
    let out = fold ? rows.join('\n').replace(/([^\n])\n(?=[^\n])/g, '$1 ') : rows.join('\n');
    if (chomp !== 'strip' && out) out += '\n';
    return out;
  }

  /** Value after `key:` or `- ` on the same line; `indent` is the indent of the owning key / dash. */
  function inlineValue(rest, indent) {
    const r = stripComment(rest);
    if (r === '') {
      skipBlank();
      const next = lines[pos];
      if (!next) return null;
      if (next.indent > indent || (next.indent === indent && next.text.startsWith('- ') && indent >= 0)) return node(next.indent);
      return null;
    }
    if (/^[|>][+-]?\d*$/.test(r)) return blockScalar(r, indent);
    if (r[0] === '{' || r[0] === '[') {
      let buf = r;
      while (!flowBalanced(buf) && pos < lines.length) buf += ` ${stripComment(lines[pos++].text)}`;
      return parseFlow(buf);
    }
    return scalar(r);
  }

  function node(indent) {
    skipBlank();
    const line = lines[pos];
    if (!line || line.indent < indent) return null;
    if (line.text === '-' || line.text.startsWith('- ')) return sequence(line.indent);
    const body = stripComment(line.text);
    if (splitKey(body)) return mapping(line.indent);
    pos++;
    return inlineValue(body, line.indent - 1);
  }

  function sequence(indent) {
    const out = [];
    for (;;) {
      skipBlank();
      const line = lines[pos];
      if (!line || line.indent !== indent || !(line.text === '-' || line.text.startsWith('- '))) return out;
      const rest = line.text.slice(1).trimStart();
      const col = line.raw.indexOf(rest, line.indent + 1);
      if (rest === '' || stripComment(rest) === '') {
        pos++;
        out.push(inlineValue('', indent));
      } else if (splitKey(stripComment(rest)) && rest[0] !== '{' && rest[0] !== '[') {
        // "- key: value" opens a mapping whose column is where `key` starts
        lines[pos] = { raw: line.raw, indent: col, text: rest };
        out.push(mapping(col));
      } else {
        pos++;
        out.push(inlineValue(rest, indent));
      }
    }
  }

  function mapping(indent) {
    const out = {};
    for (;;) {
      skipBlank();
      const line = lines[pos];
      if (!line || line.indent !== indent) return out;
      const kv = splitKey(stripComment(line.text));
      if (!kv) return out;
      pos++;
      out[kv.key] = inlineValue(kv.rest, indent);
    }
  }

  skipBlank();
  return pos < lines.length ? node(0) : null;
}
