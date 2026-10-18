// Helpers shared by the Vertex providers: prompts, schema sanitising, envelope parsing.

const TASK_GUIDE = {
  extract_narrative: 'Read the claimant narrative and extract the loss facts. lossType is a short code such as collision, glass, theft, fire, hail, flood or wind. atFault is insured, other or unknown.',
  extract_document: 'Extract claim facts from the document text. Field names must come from: policeReportNumber, citedParty, atFaultParty, estimateTotal, repairShop, lossDate (YYYY-MM-DD), vin, damageAreas (array). Quote the supporting snippet in provenance.',
  classify_photo: 'Classify a claim photo from its filename and metadata. kind is always "photo".',
  severity: 'Score claim severity 0-100 from the facts. band is low, medium, high or severe. List the drivers.',
  fraud_signals: 'Assess fraud indicators from the facts. Use codes such as LOSS_NEAR_INCEPTION, LATE_REPORT, NO_POLICE_REPORT_THEFT, PRIOR_CLAIMS, NARRATIVE_EVIDENCE_MISMATCH, ROUND_NUMBER_ESTIMATE. Score 0-100.',
  subrogation: 'Decide whether the claim has subrogation potential (other party at fault, other driver cited, rear-end).',
  summarize: 'Write a short plain-English adjuster summary and bullet points from the facts.',
  next_best_actions: 'Suggest prioritised next best actions for the adjuster. Each has code, label, reason and priority (1 is highest).',
};

export const SYSTEM_PROMPT = 'You are an insurance first-notice-of-loss analyst. Use only the supplied input. Never invent facts. '
  + 'Respond with JSON only, as {"output": <task output>, "confidence": <0..1>, "explanation": <one sentence>}. '
  + 'Confidence is 0.9 for strong evidence, 0.5 for weak evidence and 0.2 when nothing supports the answer.';

export function buildPrompt(task, input) {
  return `Task: ${task}\n${TASK_GUIDE[task] ?? ''}\n\nInput JSON:\n${JSON.stringify(input ?? {})}`;
}

const ANY_VALUE = { anyOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }, { type: 'array', items: { type: 'string' } }] };

/** Strip keywords structured-output engines reject; close objects. */
export function sanitizeSchema(s) {
  if (Array.isArray(s)) return s.map(sanitizeSchema);
  if (!s || typeof s !== 'object') return s;
  if (Object.keys(s).length === 0) return structuredClone(ANY_VALUE);
  const out = {};
  for (const [k, v] of Object.entries(s)) {
    if (['minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems', 'default', '$schema'].includes(k)) continue;
    if (k === 'const') { out.enum = [v]; continue; }
    if (k === 'properties') out.properties = Object.fromEntries(Object.entries(v).map(([pk, pv]) => [pk, sanitizeSchema(pv)]));
    else if (k === 'items' || k === 'anyOf') out[k] = sanitizeSchema(v);
    else out[k] = v;
  }
  if (out.type === 'object' || out.properties) out.additionalProperties = false;
  return out;
}

/** Wrap the task output schema in the {output, confidence, explanation} envelope. */
export function envelopeSchema(schema) {
  return sanitizeSchema({
    type: 'object',
    required: ['output', 'confidence', 'explanation'],
    properties: {
      output: schema ?? { type: 'object' },
      confidence: { type: 'number' },
      explanation: { type: 'string' },
    },
  });
}

export function parseEnvelope(text) {
  let raw = String(text ?? '').trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)```$/.exec(raw);
  if (fence) raw = fence[1].trim();
  const j = JSON.parse(raw);
  if (!j || typeof j !== 'object' || !('output' in j)) throw new Error('model reply missing output');
  const c = Number(j.confidence);
  return { output: j.output, confidence: Number.isFinite(c) ? Math.max(0, Math.min(1, c)) : 0.5, explanation: String(j.explanation ?? '') };
}

export const projectFrom = (env, opts) => opts.projectId ?? env.GOOGLE_CLOUD_PROJECT ?? '';
export const locationFrom = (env, opts) => opts.location ?? env.GOOGLE_CLOUD_LOCATION ?? 'global';
