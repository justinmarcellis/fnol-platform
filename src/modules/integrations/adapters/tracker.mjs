// Field-usage tracker: mappers read the platform bundle through views, and every path that is read
// is recorded. Anything present in the bundle but never read is reported as `unmapped`.

const empty = (v) => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0)
  || (typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0);

/** Internal bookkeeping keys that are never sent to a core system. */
const INTERNAL = new Set(['tenantId', 'claimId', 'version', 'createdAt', 'updatedAt', 'provenance', 'fieldProvenance', 'id']);

const join = (prefix, path) => (prefix ? `${prefix}.${path}` : path);

function dig(obj, path) {
  let cur = obj;
  for (const key of path.split('.')) {
    if (cur === undefined || cur === null) return undefined;
    cur = cur[key];
  }
  return cur;
}

/** Leaf paths of a value. Arrays of objects use `name[]`; arrays of primitives are leaves. */
function leaves(value, prefix, out) {
  if (empty(value)) return;
  if (Array.isArray(value)) {
    if (value.some((x) => x && typeof x === 'object')) value.forEach((x) => leaves(x, `${prefix}[]`, out));
    else out.add(prefix);
    return;
  }
  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (INTERNAL.has(k)) continue;
      leaves(v, prefix ? `${prefix}.${k}` : k, out);
    }
    return;
  }
  out.add(prefix);
}

/**
 * @param {object} root the claim bundle `{ claim, parties, vehicles, properties }`
 * @returns {{ view: object, unmapped: () => string[] }}
 */
export function createTracker(root) {
  const consumed = new Set();
  function makeView(obj, prefix) {
    return {
      /** Read a path and mark it (and everything below it) as mapped. */
      get(path) {
        consumed.add(join(prefix, path));
        return dig(obj, path);
      },
      /** A view rooted at a sub-object; reading through it marks only the fields actually read. */
      sub(path) {
        return makeView(dig(obj, path) ?? {}, join(prefix, path));
      },
      /** Views over each item of an array path. */
      list(path) {
        const arr = dig(obj, path);
        const list = Array.isArray(arr) ? arr : [];
        return list.map((item) => makeView(item, `${join(prefix, path)}[]`));
      },
    };
  }
  return {
    view: makeView(root, ''),
    unmapped() {
      const all = new Set();
      leaves(root, '', all);
      const covered = (p) => [...consumed].some((c) => p === c || p.startsWith(`${c}.`) || p.startsWith(`${c}[]`));
      return [...all].filter((p) => !covered(p)).sort();
    },
  };
}
