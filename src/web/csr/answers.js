// Answer input mapping for the CSR intake form. Pure logic: no kit imports, no DOM.

/** Question types rendered as a native required checkbox (acknowledgements). */
export function isDisclosure(q) {
  return q?.type === 'disclosure';
}

/** The fx-field `type` attribute for a (non-disclosure) question type. */
export function fieldType(type) {
  return { number: 'number', currency: 'number', date: 'date', time: 'time', phone: 'tel', email: 'email', datetime: 'datetime-local', longtext: 'textarea', select: 'select', boolean: 'select' }[type] ?? 'text';
}

/**
 * Coerce the raw control value to the type the API expects.
 * Disclosure: the boolean true when acknowledged (checked, true or 'true'), otherwise false (never a string).
 * @param {{type?: string}} q
 * @param {unknown} v checkbox `checked` boolean, or an input's string value
 */
export function coerceAnswer(q, v) {
  if (isDisclosure(q)) return v === true || v === 'true' || v === 'on';
  if (q?.type === 'boolean') return v === true || v === 'true';
  if (q?.type === 'number' || q?.type === 'currency') return v === '' ? v : Number(v);
  return v;
}

/** True when the answer may be sent: a required disclosure must be acknowledged. */
export function disclosureAccepted(q, v) {
  return coerceAnswer(q, v) === true;
}
