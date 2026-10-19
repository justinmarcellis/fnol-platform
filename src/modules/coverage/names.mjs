// Name matching shared by policy search (blind-index keys) and the intake holder check.
// Person insureds are found by last name or full name; organisation insureds (fleets, businesses) by the
// leading words of the business name. Display labels such as "(fictional)" never count as a name.

const ORG_WORDS = /\b(co|company|inc|llc|ltd|corp|corporation|group|logistics|freight|delivery|services|transport|trucking|holdings|partners)\b/i;

/**
 * Normalize a name for comparison: lower case, accents folded, parenthesized labels and punctuation removed.
 * @param {*} name
 * @returns {string}
 */
export function normName(name) {
  return String(name ?? '')
    .replace(/\([^)]*\)/g, ' ')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * True when a named insured is an organisation rather than a person.
 * @param {{kind?:string, type?:string, name?:string, firstName?:string, lastName?:string}} insured
 */
export function isOrganization(insured) {
  if (!insured) return false;
  const k = insured.kind ?? insured.type;
  if (k === 'organization' || k === 'organisation' || k === 'business') return true;
  if (k === 'person' || insured.firstName || insured.lastName) return false;
  const name = String(insured.name ?? '');
  return ORG_WORDS.test(name.replace(/\([^)]*\)/g, ' '));
}

/** Last name of a person insured (explicit lastName, else the last word of the normalized name). */
export function lastNameOf(insured) {
  if (!insured) return '';
  if (insured.lastName) return normName(insured.lastName);
  return normName(insured.name).split(' ').pop() ?? '';
}

/**
 * Normalized keys a name search may match for one insured.
 * Person: last name and full name. Organisation: every leading word sequence of the business name
 * ("brightfield", "brightfield freight", "brightfield freight co").
 * @returns {string[]}
 */
export function nameKeys(insured) {
  if (!insured) return [];
  const full = normName(insured.name ?? [insured.firstName, insured.lastName].filter(Boolean).join(' '));
  if (isOrganization(insured)) {
    const words = full.split(' ').filter(Boolean);
    return words.map((_, i) => words.slice(0, i + 1).join(' '));
  }
  return [...new Set([lastNameOf(insured), full].filter(Boolean))];
}

/**
 * Holder check name rule. A person matches on the last name or the full name; an organisation only on its
 * full business name (a single word such as "Co" or "Freight" is not enough).
 * @param {object} insured named insured
 * @param {string} given name the caller typed
 */
export function holderNameMatches(insured, given) {
  const g = normName(given);
  if (!g || !insured) return false;
  const full = normName(insured.name ?? [insured.firstName, insured.lastName].filter(Boolean).join(' '));
  if (isOrganization(insured)) return g === full;
  return g === full || g === lastNameOf(insured);
}
