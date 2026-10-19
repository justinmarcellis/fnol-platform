// One strict checker for every tenant-authored regular expression (SEC2-013, SEC2-014, SEC3-003).
// Zero dependency. A small recursive-descent parser accepts a whitelist grammar; anything outside it is unsafe:
//   literals, '.', escapes (\d \w \s \D \W \S \b \B \n \r \t \f \v \xHH \uHHHH, escaped punctuation),
//   character classes, anchors ^ $, capturing and (?:...) groups, alternation, quantifiers * + ? {n} {n,} {n,m}
//   (counts <= 50). No backreferences, lookaround, named groups, \p classes or flags.
// Structural rules (these are what make backtracking polynomial and small):
//   - pattern length 1..200
//   - a repeated group (max > 1) holds a single fixed-width sequence: no alternation, no optional or variable body
//   - at most MAX_UNBOUNDED unbounded quantifiers per alternation-free run, never two with only nullable items between
//   - at most MAX_RANGES variable range quantifiers and MAX_OPTIONALS '?' items per run
// Evaluation (matchWithBudget) additionally caps the input at 200 chars and time-boxes the match.
import vm from 'node:vm';

export const MAX_PATTERN_LEN = 200;
export const MAX_PATTERN_INPUT = 200;
export const MAX_COUNT = 50;
export const PATTERN_TIMEOUT_MS = 50;
const MAX_UNBOUNDED = 2;
const MAX_RANGES = 3;
const MAX_OPTIONALS = 8;
const MAX_BRANCHES = 20;
const MAX_DEPTH = 8;

class Reject extends Error {}
const no = (why) => { throw new Reject(why); };

// ---------------------------------------------------------------- parser

const SIMPLE_ESC = new Set(['d', 'D', 'w', 'W', 's', 'S', 'b', 'B', 'n', 'r', 't', 'f', 'v']);
const COUNT_RE = /^\{(\d{1,3})(?:(,)(\d{0,3}))?\}/;

function parse(p) {
  let i = 0;

  function escape() { // at p[i] === '\\'; returns after consuming the escape
    const c = p[i + 1];
    if (c === undefined) no('dangling backslash');
    if (SIMPLE_ESC.has(c)) { i += 2; return; }
    if (c === 'x') { if (!/^[0-9a-fA-F]{2}$/.test(p.slice(i + 2, i + 4))) no('bad \\x'); i += 4; return; }
    if (c === 'u') { if (!/^[0-9a-fA-F]{4}$/.test(p.slice(i + 2, i + 6))) no('bad \\u'); i += 6; return; }
    if (/[A-Za-z0-9]/.test(c)) no('unsupported escape'); // backreferences, \k, \p, \0, \c ...
    i += 2; // escaped punctuation
  }

  function cls() { // at '['
    i += 1;
    if (p[i] === '^') i += 1;
    let first = true;
    while (i < p.length && (p[i] !== ']' || first)) {
      first = false;
      if (p[i] === '\\') { if (p[i + 1] === 'b') no('\\b in class'); escape(); } else if (p[i] === '[') no('nested class'); else i += 1;
    }
    if (p[i] !== ']') no('unterminated class');
    i += 1;
  }

  function quant(item) {
    const c = p[i];
    if (c === '*') { item.min = 0; item.max = Infinity; i += 1; } else if (c === '+') { item.min = 1; item.max = Infinity; i += 1; } else if (c === '?') { item.min = 0; item.max = 1; i += 1; } else if (c === '{') {
      const m = COUNT_RE.exec(p.slice(i));
      if (!m) no('malformed {} quantifier');
      item.min = Number(m[1]);
      item.max = m[2] === undefined ? item.min : (m[3] === '' ? Infinity : Number(m[3]));
      if (item.min > MAX_COUNT || (item.max !== Infinity && item.max > MAX_COUNT)) no(`count above ${MAX_COUNT}`);
      if (item.max < item.min) no('quantifier max below min');
      i += m[0].length;
    } else return;
    if (p[i] === '?') i += 1; // lazy modifier
    if (p[i] === '*' || p[i] === '+' || p[i] === '?' || p[i] === '{') no('stacked quantifiers');
    if (item.kind === 'anchor') no('quantified anchor');
  }

  function alt(depth) {
    if (depth > MAX_DEPTH) no('nested too deep');
    const branches = [[]];
    while (i < p.length) {
      const c = p[i];
      if (c === ')') { if (depth === 0) no('unbalanced )'); break; }
      if (c === '|') { branches.push([]); if (branches.length > MAX_BRANCHES) no('too many alternatives'); i += 1; continue; }
      const item = { kind: 'atom', min: 1, max: 1 };
      if (c === '(') {
        i += 1;
        if (p[i] === '?') { if (p[i + 1] === ':') i += 2; else no('lookaround or named group'); }
        item.kind = 'group';
        item.alt = alt(depth + 1);
        if (p[i] !== ')') no('unbalanced (');
        i += 1;
      } else if (c === '[') cls();
      else if (c === '\\') { item.kind = SIMPLE_ESC.has(p[i + 1]) && (p[i + 1] === 'b' || p[i + 1] === 'B') ? 'anchor' : 'atom'; escape(); } else if (c === '*' || c === '+' || c === '?' || c === '{') no('nothing to repeat');
      else if (c === '}' || c === ']') no('stray bracket');
      else { i += 1; if (c === '^' || c === '$') item.kind = 'anchor'; }
      quant(item);
      branches[branches.length - 1].push(item);
    }
    return branches;
  }

  const tree = alt(0);
  if (i < p.length) no('trailing input');
  return tree;
}

// ---------------------------------------------------------------- structural analysis

const isFixed = (it) => it.min === it.max && (it.kind !== 'group' || (it.alt.length === 1 && it.alt[0].every(isFixed)));

/** Returns { unb, ranges, opts } maxed across branches; throws Reject on violations. */
function analyse(branches) {
  let worst = { unb: 0, ranges: 0, opts: 0 };
  for (const seq of branches) {
    let unb = 0; let ranges = 0; let opts = 0;
    let afterUnbounded = false; let separated = true; // separated: a required item sits between two unbounded ones
    for (const it of seq) {
      if (it.kind === 'anchor') continue;
      let sub = { unb: 0, ranges: 0, opts: 0 };
      if (it.kind === 'group') {
        if (it.max > 1 && !(it.alt.length === 1 && it.alt[0].every(isFixed))) no('repeated group must be a fixed-width sequence without alternation');
        sub = analyse(it.alt);
      }
      const itUnb = (it.max === Infinity ? 1 : 0) + sub.unb;
      if (itUnb > 0) {
        if (afterUnbounded && !separated) no('adjacent unbounded quantifiers');
        afterUnbounded = true; separated = false;
      } else if (it.min > 0) separated = true;
      unb += itUnb;
      if (it.max === 1 && it.min === 0) opts += 1;
      else if (it.min !== it.max && it.max > 1) ranges += 1;
      ranges += sub.ranges; opts += sub.opts;
    }
    worst = { unb: Math.max(worst.unb, unb), ranges: Math.max(worst.ranges, ranges), opts: Math.max(worst.opts, opts) };
  }
  if (worst.unb > MAX_UNBOUNDED) no('too many unbounded quantifiers');
  if (worst.ranges > MAX_RANGES) no('too many variable quantifiers');
  if (worst.opts > MAX_OPTIONALS) no('too many optional items');
  return worst;
}

/** True when `src` is inside the whitelist grammar and its structure bounds backtracking. */
export function isSafePattern(src) {
  if (typeof src !== 'string' || src.length === 0 || src.length > MAX_PATTERN_LEN) return false;
  try {
    analyse(parse(src));
    new RegExp(src); // belt and braces: must also be a valid JS regex
    return true;
  } catch { return false; }
}

// ---------------------------------------------------------------- evaluation

const cache = new Map();

/** Compile a tenant pattern once; returns a RegExp, or null when unsafe/invalid (the pattern must then be ignored). */
export function compileSafePattern(src) {
  if (cache.has(src)) return cache.get(src);
  let re = null;
  try { if (isSafePattern(src)) re = new RegExp(src); } catch { re = null; }
  if (cache.size > 500) cache.clear();
  cache.set(src, re);
  return re;
}

const script = new vm.Script('re.test(s)');

/**
 * Run a pattern against an input within a budget: input longer than maxInput (default 200) never matches, an unsafe
 * pattern never matches, and the match itself is time-boxed in a throwaway vm context.
 * @param {string|RegExp} pattern tenant pattern source (checked) or a RegExp the caller already vetted
 * @returns {true|false|null} null when the time box expired
 */
export function matchWithBudget(pattern, input, { maxInput = MAX_PATTERN_INPUT, timeoutMs = PATTERN_TIMEOUT_MS } = {}) {
  if (typeof input !== 'string' || input.length > maxInput) return false;
  const re = typeof pattern === 'string' ? compileSafePattern(pattern) : pattern;
  if (!(re instanceof RegExp)) return false;
  try {
    return script.runInNewContext({ re, s: input }, { timeout: timeoutMs }) === true;
  } catch { return null; }
}
