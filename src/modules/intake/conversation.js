// Conversational mode: turn a free-text narrative into suggested answers (never auto-accepted).
// Primary path is ctx.ai.run('extract_narrative'); on absence or failure a keyword fallback runs.
// Every suggestion carries provenance { provider, model, confidence, explanation } (standards.md).
import { validateAnswer } from './questions.js';

const KEYWORDS = [
  ['glass', /\b(windshield|windscreen|window glass|cracked glass|chip in the glass)\b/i],
  ['theft', /\b(stolen|theft|burglar\w*|break-?in|broke into)\b/i],
  ['vandalism', /\b(vandal\w*|keyed|graffiti)\b/i],
  ['fire', /\b(fire|burned|burnt|smoke damage)\b/i],
  ['hail', /\bhail\w*\b/i],
  ['wind', /\b(windstorm|high winds?|tornado)\b/i],
  ['flood', /\b(flood\w*)\b/i],
  ['water_plumbing', /\b(burst pipe|pipe burst|leak\w*|plumbing)\b/i],
  ['collision', /\b(collision|collided|crash\w*|rear-?ended|hit (?:me|my|a|the)|t-?boned|fender)\b/i],
];
const INJURY_RE = /\b(injur\w*|hurt\w*|ambulance|hospital|whiplash|bleeding|broken (?:arm|leg|bone))\b/i;
const NO_INJURY_RE = /\b(no|nobody|not)\b[^.]{0,25}\b(injur\w*|hurt)\b/i;
const ISO_DATE_RE = /\b(\d{4})-(\d{2})-(\d{2})\b/;
const MDY_RE = /\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/;
const MAX_NARRATIVE = 8000;

const pad = (n) => String(n).padStart(2, '0');
const addDays = (iso, d) => new Date(Date.parse(`${iso}T00:00:00Z`) + d * 86400000).toISOString().slice(0, 10);

/**
 * Deterministic extraction used when no AI is configured or the AI call fails.
 * @param {string} text narrative
 * @param {string} today ISO date, resolves "yesterday" / "today"
 */
export function keywordExtract(text, today) {
  const t = String(text ?? '').slice(0, MAX_NARRATIVE);
  const hit = KEYWORDS.find(([, re]) => re.test(t));
  let lossDate = '';
  const iso = ISO_DATE_RE.exec(t);
  const mdy = MDY_RE.exec(t);
  if (iso) lossDate = iso[0];
  else if (mdy) lossDate = `${mdy[3]}-${pad(mdy[1])}-${pad(mdy[2])}`;
  else if (/\byesterday\b/i.test(t)) lossDate = addDays(today, -1);
  else if (/\b(today|this morning|this afternoon)\b/i.test(t)) lossDate = today;
  const injuries = INJURY_RE.test(t) && !NO_INJURY_RE.test(t);
  const found = [hit, lossDate, INJURY_RE.test(t) || NO_INJURY_RE.test(t)].filter(Boolean).length;
  const confidence = found >= 3 ? 0.7 : found === 2 ? 0.55 : found === 1 ? 0.4 : 0.1;
  return {
    output: { lossType: hit ? hit[0] : '', lossDate, injuries, injuryMentioned: INJURY_RE.test(t) || NO_INJURY_RE.test(t) },
    provider: 'local', model: 'intake-keywords-v1', confidence,
    explanation: `Keyword match found ${found} of 3 cues (loss type, date, injury mention).`,
  };
}

async function extract(ctx, text, today, claimId) {
  // SEC2-010: the AI call is always attributed to the tenant; an unbound ctx uses the keyword fallback.
  if (ctx.ai?.run && ctx.tenant?.id) {
    try {
      const res = await ctx.ai.run('extract_narrative', { text }, { tenantId: ctx.tenant?.id, ...(claimId ? { claimId } : {}) });
      if (res?.output && typeof res.confidence === 'number') {
        const o = res.output;
        // Injuries are safety-relevant: a keyword hit also counts even if the model missed it.
        const kw = keywordExtract(text, today).output;
        return {
          output: {
            lossType: o.lossType && o.lossType !== 'other' ? o.lossType : '', lossDate: o.lossDate ?? '',
            injuries: !!o.injuries || kw.injuries,
            injuryMentioned: !!o.injuries || (o.injuryCues?.length ?? 0) > 0 || kw.injuryMentioned,
          },
          provider: res.provider ?? 'local', model: res.model ?? 'unknown', confidence: res.confidence,
          explanation: res.explanation ?? 'AI narrative extraction.',
        };
      }
    } catch (e) {
      ctx.log?.warn?.('intake narrative AI failed, using keyword fallback', { error: e?.code ?? e?.name });
    }
  }
  return keywordExtract(text, today);
}

const mapsKey = (q) => String(q.mapsTo ?? '').replace(/^lossEvent\./, 'loss.');

/**
 * Suggest answers for open questions from a narrative.
 * @param {object} ctx tenant-bound ctx
 * @param {string} text narrative (not logged, not stored here)
 * @param {{ questions: object[], answers: object, locale?: string, skipQuestionId?: string }} o
 * @returns {Promise<{ questionId: string, value: *, ai: object }[]>}
 */
export async function suggestFromNarrative(ctx, text, { questions, answers = {}, locale = 'en', skipQuestionId, claimId } = {}) {
  const today = ctx.clock.nowIso().slice(0, 10);
  const r = await extract(ctx, text, today, claimId);
  const ai = { provider: r.provider, model: r.model, confidence: r.confidence, explanation: r.explanation };
  const out = [];
  const push = (q, value) => {
    if (value === undefined || value === '' || value === null) return;
    if (validateAnswer(q, value, { locale, today })) return; // never suggest an invalid value
    out.push({ questionId: q.id, value, ai });
  };
  for (const q of questions) {
    if (q.id === skipQuestionId || answers[q.id]) continue;
    const key = mapsKey(q);
    if (key === 'loss.lossDate' || q.id === 'loss_date') push(q, r.output.lossDate);
    else if (key === 'loss.injuriesReported' || q.id === 'injuries') { if (r.output.injuryMentioned) push(q, r.output.injuries); }
    else if (key === 'lossType' || q.id === 'loss_type') push(q, r.output.lossType);
    else if ((key === 'loss.description' || q.id === 'loss_description') && q.aiAssist !== false) push(q, String(text).slice(0, MAX_NARRATIVE));
  }
  return out;
}
