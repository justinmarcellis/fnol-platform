// JSON schemas for each AI task output (JSON Schema 2020-12 subset). Vertex providers use
// them for structured output; the cascade uses `required` for a light shape check.

// Length caps: every string and array a model returns is bounded (SEC2-009). `str` is a short label or
// code, `longStr` is prose (summaries, reasons). The cascade and guard() enforce them via validateAgainst.
const str = { type: 'string', maxLength: 500 };
const longStr = { type: 'string', maxLength: 4000 };
const num = { type: 'number' };
const bool = { type: 'boolean' };
const strArr = { type: 'array', items: str, maxItems: 50 };
const longArr = { type: 'array', items: longStr, maxItems: 50 };

const field = {
  type: 'object',
  required: ['name', 'value', 'confidence'],
  properties: {
    name: str,
    value: {},
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    provenance: { type: 'object', properties: { snippet: longStr } },
  },
};

/** Fact names used by extract_document / classify_photo. */
export const FIELD_NAMES = ['policeReportNumber', 'citedParty', 'atFaultParty', 'estimateTotal', 'repairShop', 'lossDate', 'vin', 'damageAreas'];

/** Per-task cap on the total string characters of an input (SEC2-011). Cheap tasks get less. */
export const INPUT_CAPS = Object.freeze({
  extract_narrative: 8000, extract_document: 20000, classify_photo: 2000, severity: 6000,
  fraud_signals: 6000, subrogation: 6000, summarize: 8000, next_best_actions: 6000,
});
export const DEFAULT_INPUT_CAP = 20000;
export const inputCapFor = (task) => INPUT_CAPS[task] ?? DEFAULT_INPUT_CAP;

export const TASKS = Object.freeze([
  'extract_narrative', 'extract_document', 'classify_photo', 'severity',
  'fraud_signals', 'subrogation', 'summarize', 'next_best_actions',
]);

export const outputSchemas = {
  extract_narrative: {
    type: 'object',
    required: ['lossType', 'lossDate', 'location', 'injuries', 'injuryCues', 'atFault', 'cues'],
    properties: {
      lossType: str, lossDate: str, location: str, injuries: bool, injuryCues: longArr,
      atFault: { type: 'string', enum: ['insured', 'other', 'unknown'] }, cues: strArr,
    },
  },
  extract_document: {
    type: 'object',
    required: ['kind', 'fields', 'needsReview'],
    properties: { kind: str, fields: { type: 'array', items: field, maxItems: 100 }, needsReview: bool },
  },
  classify_photo: {
    type: 'object',
    required: ['kind', 'damageAreas', 'vehicle', 'fields', 'needsReview'],
    properties: {
      kind: { const: 'photo' }, damageAreas: strArr,
      vehicle: { type: 'object', properties: { make: str, model: str, color: str } },
      fields: { type: 'array', items: field, maxItems: 100 }, needsReview: bool,
    },
  },
  severity: {
    type: 'object',
    required: ['score', 'band', 'drivers'],
    properties: { score: { type: 'number', minimum: 0, maximum: 100 }, band: { type: 'string', maxLength: 40 }, drivers: strArr },
  },
  fraud_signals: {
    type: 'object',
    required: ['score', 'indicators'],
    properties: {
      score: { type: 'number', minimum: 0, maximum: 100 },
      indicators: { type: 'array', maxItems: 50, items: { type: 'object', required: ['code'], properties: { code: str, weight: num, reason: longStr } } },
    },
  },
  subrogation: {
    type: 'object',
    required: ['flag', 'reasons', 'confidence'],
    properties: { flag: bool, reasons: longArr, confidence: { type: 'number', minimum: 0, maximum: 1 } },
  },
  summarize: {
    type: 'object',
    required: ['summary', 'bullets'],
    properties: { summary: longStr, bullets: longArr },
  },
  next_best_actions: {
    type: 'object',
    required: ['actions'],
    properties: {
      actions: { type: 'array', maxItems: 50, items: { type: 'object', required: ['code', 'label'], properties: { code: str, label: str, reason: longStr, priority: { type: ['number', 'string'] } } } },
    },
  },
};

/** @param {string} task @returns {object|undefined} */
export const schemaFor = (task) => outputSchemas[task];

/**
 * Light shape check: output is an object carrying every top-level required key.
 * Not sufficient on its own: the cascade validates with validateOutput (types, enums, ranges, lengths).
 * @returns {boolean}
 */
export function hasRequiredShape(task, output) {
  const s = outputSchemas[task];
  if (!s) return false;
  if (!output || typeof output !== 'object' || Array.isArray(output)) return false;
  return s.required.every((k) => k in output);
}
