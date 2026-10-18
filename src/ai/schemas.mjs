// JSON schemas for each AI task output (JSON Schema 2020-12 subset). Vertex providers use
// them for structured output; the cascade uses `required` for a light shape check.

const str = { type: 'string' };
const num = { type: 'number' };
const bool = { type: 'boolean' };
const strArr = { type: 'array', items: str };

const field = {
  type: 'object',
  required: ['name', 'value', 'confidence'],
  properties: {
    name: str,
    value: {},
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    provenance: { type: 'object', properties: { snippet: str } },
  },
};

/** Fact names used by extract_document / classify_photo. */
export const FIELD_NAMES = ['policeReportNumber', 'citedParty', 'atFaultParty', 'estimateTotal', 'repairShop', 'lossDate', 'vin', 'damageAreas'];

export const TASKS = Object.freeze([
  'extract_narrative', 'extract_document', 'classify_photo', 'severity',
  'fraud_signals', 'subrogation', 'summarize', 'next_best_actions',
]);

export const outputSchemas = {
  extract_narrative: {
    type: 'object',
    required: ['lossType', 'lossDate', 'location', 'injuries', 'injuryCues', 'atFault', 'cues'],
    properties: {
      lossType: str, lossDate: str, location: str, injuries: bool, injuryCues: strArr,
      atFault: { type: 'string', enum: ['insured', 'other', 'unknown'] }, cues: strArr,
    },
  },
  extract_document: {
    type: 'object',
    required: ['kind', 'fields', 'needsReview'],
    properties: { kind: str, fields: { type: 'array', items: field }, needsReview: bool },
  },
  classify_photo: {
    type: 'object',
    required: ['kind', 'damageAreas', 'vehicle', 'fields', 'needsReview'],
    properties: {
      kind: { const: 'photo' }, damageAreas: strArr,
      vehicle: { type: 'object', properties: { make: str, model: str, color: str } },
      fields: { type: 'array', items: field }, needsReview: bool,
    },
  },
  severity: {
    type: 'object',
    required: ['score', 'band', 'drivers'],
    properties: { score: { type: 'number', minimum: 0, maximum: 100 }, band: str, drivers: strArr },
  },
  fraud_signals: {
    type: 'object',
    required: ['score', 'indicators'],
    properties: {
      score: { type: 'number', minimum: 0, maximum: 100 },
      indicators: { type: 'array', items: { type: 'object', required: ['code'], properties: { code: str, weight: num, reason: str } } },
    },
  },
  subrogation: {
    type: 'object',
    required: ['flag', 'reasons', 'confidence'],
    properties: { flag: bool, reasons: strArr, confidence: num },
  },
  summarize: {
    type: 'object',
    required: ['summary', 'bullets'],
    properties: { summary: str, bullets: strArr },
  },
  next_best_actions: {
    type: 'object',
    required: ['actions'],
    properties: {
      actions: { type: 'array', items: { type: 'object', required: ['code', 'label'], properties: { code: str, label: str, reason: str, priority: { type: ['number', 'string'] } } } },
    },
  },
};

/** @param {string} task @returns {object|undefined} */
export const schemaFor = (task) => outputSchemas[task];

/**
 * Light shape check: output is an object carrying every top-level required key.
 * @returns {boolean}
 */
export function hasRequiredShape(task, output) {
  const s = outputSchemas[task];
  if (!s) return false;
  if (!output || typeof output !== 'object' || Array.isArray(output)) return false;
  return s.required.every((k) => k in output);
}
