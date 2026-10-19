// Subrogation: flag when another party appears at fault. Deterministic cues merged with the AI pass.
const c2 = (n) => Math.round(n * 100) / 100;

/** @returns {{code: string, reason: string, weight: number}[]} */
export function deterministicSubrogation(f) {
  const out = [];
  if (f.atFaultParty === 'other' || (f.narrative?.otherAtFaultCue && !f.narrative?.rearEndedByOther && f.atFaultParty !== 'insured')) {
    out.push({ code: 'other_party_at_fault', reason: 'Evidence or narrative places fault on another party.', weight: f.atFaultParty === 'other' ? 0.8 : 0.5 });
  }
  if (f.citedParty === 'other') {
    out.push({ code: 'other_driver_cited', reason: 'A citation was issued to the other driver.', weight: 0.85 });
  }
  if (f.narrative?.rearEndedByOther && f.atFaultParty !== 'insured' && f.citedParty !== 'insured') {
    out.push({ code: 'rear_ended_by_other', reason: 'The insured vehicle was struck from behind.', weight: 0.7 });
  }
  return out;
}

/**
 * @param {object} f facts
 * @param {{flag?: boolean, reasons?: string[], confidence?: number}|null} ai subrogation output
 * @returns {{flag: boolean, reasons: object[], confidence: number}}
 */
export function computeSubrogation(f, ai) {
  const reasons = deterministicSubrogation(f);
  const blocked = f.atFaultParty === 'insured' || f.citedParty === 'insured';
  let aiConf = 0;
  if (ai?.flag && !blocked) {
    for (const r of ai.reasons ?? []) {
      const text = typeof r === 'string' ? r : r?.reason;
      if (text) reasons.push({ code: 'ai_signal', reason: String(text).slice(0, 300), weight: c2(Math.min(1, Number(ai.confidence) || 0.5)) });
    }
    aiConf = Number(ai.confidence) || 0;
  }
  const flag = reasons.length > 0 && !(blocked && reasons.every((r) => r.code === 'ai_signal'));
  const detConf = reasons.length ? Math.min(0.95, Math.max(...reasons.map((r) => r.weight)) + (reasons.length > 1 ? 0.05 : 0)) : 0;
  const confidence = flag ? c2(Math.max(detConf, aiConf)) : c2(blocked ? 0.9 : ai ? Math.max(0.5, 1 - aiConf) : 0.5);
  return { flag, reasons, confidence };
}
