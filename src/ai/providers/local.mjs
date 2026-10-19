// Local provider: deterministic, offline rules for all 8 AI tasks. Pure; no I/O, no clock.
// Confidence: 0.9 strong pattern hit, 0.5 weak, 0.2 none.

const STRONG = 0.9;
const WEAK = 0.5;
const NONE = 0.2;
const MODEL = 'local-rules-v1';

const has = (re, s) => re.test(s ?? '');
const uniq = (a) => [...new Set(a)];
// ReDoS hardening: every provider regex runs on a length-capped window whose whitespace runs are
// squeezed to at most 8 chars, so no quantifier can backtrack over more than a few chars.
export const MAX_TEXT = 20000;
const squeeze = (s) => s.slice(0, MAX_TEXT).replace(/\s{9,}/g, (m) => m.slice(0, 8));
const toStr = (v) => squeeze(typeof v === 'string' ? v : v == null ? '' : String(v));
const snip = (text, m) => {
  if (!m) return '';
  const i = m.index ?? 0;
  return text.slice(Math.max(0, i - 20), Math.min(text.length, i + m[0].length + 40)).replace(/\s+/g, ' ').trim();
};
const money = (s) => Number(String(s).replace(/[$,\s]/g, ''));
const clamp = (n, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, n));

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const p2 = (n) => String(n).padStart(2, '0');

/** Find first date in text; returns {iso, match} or null. */
export function findDate(text, labelRe) {
  const dateRes = [
    [/\b(\d{4})-(\d{2})-(\d{2})\b/, (m) => `${m[1]}-${m[2]}-${m[3]}`],
    [/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/, (m) => `${m[3]}-${p2(m[1])}-${p2(m[2])}`],
    [/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/i,
      (m) => `${m[3]}-${p2(MONTHS[m[1].slice(0, 3).toLowerCase()])}-${p2(m[2])}`],
  ];
  const scopes = [];
  if (labelRe) {
    const lm = labelRe.exec(text);
    if (lm) scopes.push(text.slice(lm.index, lm.index + lm[0].length + 40));
  }
  scopes.push(text);
  for (const scope of scopes) {
    let best = null;
    for (const [re, fmt] of dateRes) {
      const m = re.exec(scope);
      if (m && (!best || m.index < best.m.index)) best = { m, fmt };
    }
    if (best) return { iso: best.fmt(best.m), match: best.m };
  }
  return null;
}

// ---------- shared cue detection ----------
const RE = {
  rearEnd: /\b(rear[- ]?end(?:ed)?|hit (?:me )?from behind|struck from behind|hit (?:me )?in the rear|backed into me|ran into the back)\b/i,
  injury: /\b(whiplash|er\b|emergency room|ambulance|hospital|paramedic|injur(?:y|ed|ies)|neck pain|back pain|broken|fracture|concussion|sore)\b/i,
  glass: /\b(windshield|wind shield|chip(?:ped)?|crack(?:ed)?|window glass|rock hit)\b/i,
  theft: /\b(stolen|theft|thief|break[- ]?in|broke into|carjack\w*|missing from)\b/i,
  fire: /\b(fire|burned|burnt|flames|smoke damage)\b/i,
  cat: /\b(hurricane|hail(?:storm)?|flood(?:ed|ing)?|tornado|wildfire|storm surge)\b/i,
  collision: /\b(collid\w*|collision|crash\w*|accident|hit|struck|rear[- ]?end\w*|t-boned|sideswip\w*)\b/i,
  atFaultOther: /\b(other (?:driver|party|vehicle)|he|she|they|driver of the other)\b.{0,40}\b(ran|rear[- ]?ended|hit|struck|failed to yield|cited|ticketed|at fault|backed)\b/i,
  atFaultSelf: /\b(i (?:hit|struck|rear[- ]?ended|backed into|ran into|slid into)|my fault|i was at fault|i failed to)\b/i,
  litigation: /\b(attorney|lawyer|lawsuit|sue|litigation)\b/i,
};

function lossTypeFromText(t) {
  if (has(RE.theft, t)) return 'theft';
  if (has(RE.fire, t) && !has(RE.glass, t)) return 'fire';
  if (/\bhail/i.test(t)) return 'hail';
  if (/\bflood|storm surge/i.test(t)) return 'flood';
  if (/\b(hurricane|tornado|high wind|windstorm)\b/i.test(t)) return 'wind';
  if (has(RE.glass, t) && !has(RE.rearEnd, t) && !/\b(collid|accident|crash)/i.test(t)) return 'glass';
  if (has(RE.collision, t)) return 'collision';
  return 'other';
}

function extractNarrative({ text = '' } = {}) {
  const t = toStr(text);
  const lossType = lossTypeFromText(t);
  const injuryMatches = [...t.matchAll(new RegExp(RE.injury.source, 'gi'))].map((m) => m[0].toLowerCase());
  const negated = /\b(no|nobody|not)\b[^.]{0,25}\b(injur\w*|hurt)\b/i.test(t) && !has(/\b(whiplash|ambulance|hospital|emergency room)\b/i, t);
  const injuryCues = negated ? [] : uniq(injuryMatches);
  const cues = [];
  if (has(RE.rearEnd, t)) cues.push('rear_end');
  if (injuryCues.length) cues.push('injury');
  if (lossType === 'glass') cues.push('glass_only');
  if (lossType === 'theft') cues.push('theft');
  if (lossType === 'fire') cues.push('fire');
  if (has(RE.cat, t)) cues.push('cat');
  if (has(RE.litigation, t)) cues.push('litigation');
  let atFault = 'unknown';
  if (has(RE.rearEnd, t) && !has(RE.atFaultSelf, t)) atFault = 'other';
  else if (has(RE.atFaultSelf, t)) atFault = 'insured';
  else if (has(RE.atFaultOther, t)) atFault = 'other';
  const d = findDate(t, /\b(on|date of loss|happened|occurred)\b/i);
  const locM = /\b(?:at|on|near|in)\s{1,8}((?:the\s{1,8})?(?:intersection of\s{1,8})?\d{0,6}\s{0,8}[A-Z][\w.]{0,30}(?:\s{1,8}[A-Z][\w.]{0,30}){0,6}\s{1,8}(?:St|Street|Ave|Avenue|Rd|Road|Blvd|Dr|Drive|Hwy|Highway|Way|Lane|Ln)\b[^.,;]{0,100})/.exec(t);
  const location = locM ? locM[1].trim() : '';
  const strong = lossType !== 'other' || cues.length > 0;
  const confidence = strong && (d || location || cues.length) ? STRONG : strong ? WEAK : NONE;
  return {
    output: { lossType, lossDate: d?.iso ?? '', location, injuries: injuryCues.length > 0, injuryCues, atFault, cues },
    confidence,
    explanation: `Matched ${cues.length} narrative cue(s); loss type '${lossType}'.`,
  };
}

// ---------- documents ----------
const FIELD_SPECS = {
  policeReportNumber: (t) => {
    const m = /(?:report|case|incident|complaint)\s{0,8}(?:no\.?|number|#)[\s:#]{0,9}([A-Z0-9][A-Z0-9-]{4,60})/i.exec(t) ?? /\bPR[- ]?\d{4,}[\w-]*/i.exec(t);
    return m ? { value: (m[1] ?? m[0]).toUpperCase(), conf: STRONG, m } : null;
  },
  citedParty: (t) => {
    const m = /(?:cited|citation issued to|ticketed|cited party)[\s:\-]{0,9}(?:driver[\s#]{0,9})?(Unit\s{0,8}\d{1,6}|Driver\s{0,8}\d{1,6}|Party\s{0,8}[A-Z0-9]|[A-Z][a-z]{1,40}\s{1,8}[A-Z][a-z]{1,40})/i.exec(t);
    return m ? { value: m[1], conf: STRONG, m } : null;
  },
  atFaultParty: (t) => {
    const m = /(?:at[- ]fault(?: party| driver)?|contributing factor(?:s)?|primary fault|fault)\s{0,8}[:\-]\s{0,8}(Unit\s{0,8}\d{1,6}|Driver\s{0,8}\d{1,6}|Party\s{0,8}[A-Z0-9]|[A-Z][a-z]{1,40}\s{1,8}[A-Z][a-z]{1,40}|insured|other(?: party| driver)?)/i.exec(t);
    return m ? { value: m[1], conf: STRONG, m } : null;
  },
  estimateTotal: (t) => {
    const m = /(?:grand total|total (?: ?(?:estimate|repair|cost|due))?|estimate total|net total|total)[\s:\-$]{0,10}([\d,]{1,20}(?:\.\d{2})?)/i.exec(t);
    if (m) return { value: money(m[1]), conf: STRONG, m };
    const w = /\$\s{0,8}([\d,]{1,20}\.\d{2})/.exec(t);
    return w ? { value: money(w[1]), conf: WEAK, m: w } : null;
  },
  repairShop: (t) => {
    const m = /(?:repair (?:shop|facility)|shop|body shop|facility|repairer)\s*[:\-]\s*([^\n\r]{1,200}?)(?=\s{2,}|\s+(?:Phone|Tel|Address|Estimate|Date)\b|[\n\r]|$)/i.exec(t);
    return m ? { value: m[1].trim(), conf: STRONG, m } : null;
  },
  lossDate: (t) => {
    const label = /(?:date of (?:loss|accident|incident)|loss date|accident date|incident date|date of occurrence)[\s:\-]{0,9}/i;
    const lm = label.exec(t);
    const d = findDate(t, label);
    if (!d) return null;
    return { value: d.iso, conf: lm ? STRONG : WEAK, m: d.match };
  },
  vin: (t) => {
    const m = /\b([A-HJ-NPR-Z0-9]{17})\b/.exec(t.toUpperCase());
    return m && /\d/.test(m[1]) && /[A-Z]/.test(m[1]) ? { value: m[1], conf: STRONG, m } : null;
  },
  damageAreas: (t) => {
    const areas = ['front', 'rear', 'left side', 'right side', 'driver side', 'passenger side', 'hood', 'trunk', 'roof', 'windshield', 'bumper', 'quarter panel', 'door', 'fender', 'headlight', 'taillight', 'undercarriage'];
    const found = areas.filter((a) => new RegExp(`\\b${a}\\b`, 'i').test(t));
    if (!found.length) return null;
    const m = new RegExp(`\\b${found[0]}\\b`, 'i').exec(t);
    return { value: found, conf: found.length >= 2 ? STRONG : WEAK, m };
  },
};

function classifyKind(text, hint) {
  if (hint && hint !== 'other') return hint;
  if (/police|incident report|crash report|officer|citation/i.test(text)) return 'police_report';
  if (/estimate|labor|parts|repair|body shop/i.test(text) && /\$/.test(text)) return 'estimate';
  if (/invoice|amount due/i.test(text)) return 'invoice';
  return hint ?? 'other';
}

function extractDocument({ kind, text = '', filename = '' } = {}) {
  const t = toStr(text);
  const k = classifyKind(`${t} ${filename}`, kind);
  const fields = [];
  for (const [name, fn] of Object.entries(FIELD_SPECS)) {
    const r = fn(t);
    if (r) fields.push({ name, value: r.value, confidence: r.conf, provenance: { snippet: snip(t, r.m) } });
  }
  const strongCount = fields.filter((f) => f.confidence >= STRONG).length;
  const confidence = strongCount >= 2 ? STRONG : fields.length ? WEAK : NONE;
  const expected = k === 'police_report' ? ['policeReportNumber', 'lossDate'] : k === 'estimate' ? ['estimateTotal', 'repairShop'] : [];
  const missing = expected.filter((n) => !fields.some((f) => f.name === n));
  return {
    output: { kind: k, fields, needsReview: confidence < STRONG || missing.length > 0 || fields.some((f) => f.confidence < STRONG) },
    confidence,
    explanation: `Extracted ${fields.length} field(s) from ${k}${missing.length ? `; missing ${missing.join(', ')}` : ''}.`,
  };
}

const PHOTO_AREAS = [['front', /front|hood|grille/i], ['rear', /rear|back|trunk/i], ['driver side', /driver|left/i], ['passenger side', /passenger|right/i], ['windshield', /windshield|glass/i], ['roof', /roof|hail/i], ['bumper', /bumper/i]];
const COLORS = ['black', 'white', 'silver', 'gray', 'grey', 'red', 'blue', 'green', 'yellow', 'orange', 'brown', 'tan', 'gold'];

function classifyPhoto({ filename = '', metadata = {} } = {}) {
  const meta = metadata ?? {};
  const hay = `${filename} ${toStr(meta.description)} ${toStr(meta.caption)} ${toStr(meta.tags)}`;
  const damageAreas = uniq(PHOTO_AREAS.filter(([, re]) => re.test(hay)).map(([a]) => a));
  const color = meta.color ?? COLORS.find((c) => new RegExp(`\\b${c}\\b`, 'i').test(hay)) ?? '';
  const vehicle = { make: toStr(meta.make), model: toStr(meta.model), color: toStr(color) };
  const fields = [];
  if (damageAreas.length) fields.push({ name: 'damageAreas', value: damageAreas, confidence: WEAK, provenance: { snippet: filename } });
  if (meta.vin) fields.push({ name: 'vin', value: toStr(meta.vin).toUpperCase(), confidence: STRONG, provenance: { snippet: 'metadata.vin' } });
  const confidence = damageAreas.length || vehicle.make ? WEAK : NONE;
  return {
    output: { kind: 'photo', damageAreas, vehicle, fields, needsReview: true },
    confidence,
    explanation: 'Photos are classified from filename and metadata only; image content is not analysed locally.',
  };
}

// ---------- facts helpers ----------
function norm(input) {
  const f = (input && (input.facts ?? input)) || {};
  const loss = f.loss ?? f.lossEvent ?? f.claim?.lossEvent ?? {};
  const get = (...keys) => {
    for (const src of [f, loss, f.claim ?? {}, f.answers ?? {}, f.triage ?? {}]) for (const k of keys) if (src[k] !== undefined && src[k] !== null) return src[k];
    return undefined;
  };
  const text = toStr(get('narrative', 'lossDescription', 'description', 'text'));
  const type = toStr(get('lossType', 'cause', 'lossCause')) || (text ? lossTypeFromText(text) : '');
  const areas = get('damageAreas') ?? [];
  return {
    raw: f,
    text,
    type: type.toLowerCase(),
    injuries: !!(get('injuries', 'injuriesReported', 'injury') ?? (text && !/\bno injur/i.test(text) && has(RE.injury, text))),
    fatality: !!get('fatality', 'fatal'),
    drivable: get('drivable'),
    glassOnly: !!get('glassOnly'),
    areas: Array.isArray(areas) ? areas : [areas],
    estimate: Number(get('estimateTotal', 'estimate')) || 0,
    policeReport: get('policeReportNumber') ?? (loss.policeReport?.filed ? loss.policeReport.number ?? 'filed' : undefined) ?? (f.policeReport?.filed ? 'filed' : undefined),
    citedParty: get('citedParty'),
    atFaultParty: get('atFaultParty', 'atFault'),
    cat: !!get('cat', 'isCat', 'catCode', 'catastrophe') || ['hail', 'flood', 'hurricane', 'wind'].includes(toStr(get('lossType', 'cause')).toLowerCase()),
    litigation: !!get('litigation', 'attorneyInvolved'),
    lossDate: toStr(get('lossDate')),
    reportedDate: toStr(get('reportedDate', 'reportedAt', 'reportDate')),
    inceptionDate: toStr(get('inceptionDate', 'policyInceptionDate', 'policyEffectiveDate') ?? f.policy?.inceptionDate ?? f.policy?.effectiveDate),
    priorClaims: Number(get('priorClaims', 'priorClaimCount') ?? f.policy?.priorClaims) || 0,
    insuredAtFault: get('insuredAtFault'),
    claimId: get('claimId', 'id'),
    policyNumber: get('policyNumber'),
  };
}

const daysBetween = (a, b) => {
  const x = Date.parse(a); const y = Date.parse(b);
  return Number.isFinite(x) && Number.isFinite(y) ? Math.round((y - x) / 86400000) : null;
};

function severity({ facts, ...rest } = {}) {
  const n = norm(facts ? { facts } : rest);
  const drivers = [];
  let score = 10;
  const add = (pts, why) => { score += pts; drivers.push(why); };
  if (n.fatality) add(60, 'fatality reported');
  if (n.injuries) add(35, 'injuries reported');
  const t = n.type;
  if (t === 'glass' || n.glassOnly) add(-5, 'glass-only loss');
  else if (t === 'fire') add(40, 'fire loss');
  else if (['hail', 'flood', 'wind', 'hurricane'].includes(t) || n.cat) add(30, 'catastrophe-type loss');
  else if (t === 'theft') add(20, 'theft loss');
  else if (/collision|liability|hit_and_run|single_vehicle/.test(t)) add(15, 'collision loss');
  if (n.drivable === false || n.drivable === 'false') add(15, 'vehicle not drivable');
  if (n.areas.length >= 3) add(10, `${n.areas.length} damage areas`);
  else if (n.areas.length > 0) add(n.areas.length * 3, `${n.areas.length} damage area(s)`);
  if (n.estimate >= 15000) add(25, 'estimate at or above $15,000');
  else if (n.estimate >= 7500) add(15, 'estimate at or above $7,500');
  else if (n.estimate >= 2500) add(8, 'estimate at or above $2,500');
  if (n.litigation) add(15, 'litigation indicated');
  score = clamp(Math.round(score));
  const band = score >= 75 ? 'severe' : score >= 50 ? 'high' : score >= 25 ? 'medium' : 'low';
  const known = [n.type, n.injuries, n.drivable, n.areas.length, n.estimate].filter((v) => v).length;
  return { output: { score, band, drivers: drivers.length ? drivers : ['no severity drivers found'] }, confidence: known >= 3 ? STRONG : known >= 1 ? WEAK : NONE, explanation: `Severity ${score} (${band}) from ${drivers.length} driver(s).` };
}

function fraudSignals({ facts, ...rest } = {}) {
  const n = norm(facts ? { facts } : rest);
  const indicators = [];
  const push = (code, weight, reason) => indicators.push({ code, weight, reason });
  const sinceInception = daysBetween(n.inceptionDate, n.lossDate);
  if (sinceInception !== null && sinceInception >= 0 && sinceInception <= 30) push('LOSS_NEAR_INCEPTION', 25, `Loss occurred ${sinceInception} day(s) after policy inception.`);
  const lag = daysBetween(n.lossDate, n.reportedDate);
  if (lag !== null && lag > 14) push('LATE_REPORT', 15, `Reported ${lag} days after the loss.`);
  if (n.type === 'theft' && !n.policeReport) push('NO_POLICE_REPORT_THEFT', 30, 'Theft reported without a police report.');
  if (n.priorClaims >= 2) push('PRIOR_CLAIMS', 10 + Math.min(10, (n.priorClaims - 2) * 5), `${n.priorClaims} prior claims on record.`);
  if (n.text) {
    const nl = lossTypeFromText(n.text);
    const declared = n.type;
    const mismatch = declared && nl !== 'other' && declared !== nl && !(declared.includes('collision') && nl === 'collision');
    const glassMismatch = (n.glassOnly || declared === 'glass') && n.areas.some((a) => /rear|door|quarter|front end|hood|roof/i.test(a));
    if (mismatch || glassMismatch) push('NARRATIVE_EVIDENCE_MISMATCH', 20, mismatch ? `Narrative reads as '${nl}' but the claim is typed '${declared}'.` : 'Glass-only claim lists body damage areas.');
  }
  if (n.estimate >= 1000 && n.estimate % 500 === 0) push('ROUND_NUMBER_ESTIMATE', 10, `Estimate total ${n.estimate} is a round number.`);
  const score = clamp(indicators.reduce((s, i) => s + i.weight, 0));
  return { output: { score, indicators }, confidence: n.lossDate || n.type ? STRONG : WEAK, explanation: indicators.length ? `${indicators.length} fraud indicator(s) fired.` : 'No fraud indicators fired.' };
}

function subrogation({ facts, ...rest } = {}) {
  const n = norm(facts ? { facts } : rest);
  const reasons = [];
  const atf = toStr(n.atFaultParty).toLowerCase();
  if (/^(other|third)/.test(atf) || n.insuredAtFault === false) reasons.push('Other party identified as at fault.');
  if (n.citedParty && !/insured|^(me|my)/i.test(toStr(n.citedParty)) && n.raw.insuredParty !== n.citedParty) reasons.push(`Other driver cited (${toStr(n.citedParty)}).`);
  if (n.text && has(RE.rearEnd, n.text) && !has(RE.atFaultSelf, n.text)) reasons.push('Rear-end collision: following driver is presumptively at fault.');
  else if (n.text && has(RE.atFaultOther, n.text) && !has(RE.atFaultSelf, n.text)) reasons.push('Narrative places fault on the other party.');
  const flag = reasons.length > 0;
  const confidence = reasons.length >= 2 ? STRONG : flag ? WEAK + 0.1 : NONE;
  return { output: { flag, reasons, confidence }, confidence: flag ? (reasons.length >= 2 ? STRONG : WEAK) : (n.text || n.atFaultParty ? WEAK : NONE), explanation: flag ? `${reasons.length} subrogation cue(s).` : 'No subrogation cues.' };
}

function summarize({ facts, ...rest } = {}) {
  const n = norm(facts ? { facts } : rest);
  const type = (n.type || 'unspecified').replace(/_/g, ' ');
  const bullets = [];
  if (n.lossDate) bullets.push(`Date of loss: ${n.lossDate}`);
  bullets.push(`Loss type: ${type}`);
  bullets.push(n.injuries ? 'Injuries reported' : 'No injuries reported');
  if (n.drivable !== undefined) bullets.push(`Vehicle ${n.drivable === false || n.drivable === 'false' ? 'not drivable' : 'drivable'}`);
  if (n.areas.length) bullets.push(`Damage areas: ${n.areas.join(', ')}`);
  if (n.estimate) bullets.push(`Estimate: $${n.estimate.toLocaleString('en-US')}`);
  bullets.push(n.policeReport ? `Police report: ${n.policeReport === 'filed' ? 'filed' : n.policeReport}` : 'No police report on file');
  const sentence = [
    `A ${type} loss${n.lossDate ? ` occurred on ${n.lossDate}` : ' was reported'}.`,
    n.injuries ? 'Injuries were reported.' : 'No injuries were reported.',
    n.estimate ? `The current repair estimate is $${n.estimate.toLocaleString('en-US')}.` : '',
  ].filter(Boolean).join(' ');
  return { output: { summary: sentence, bullets }, confidence: n.type || n.lossDate ? STRONG : WEAK, explanation: 'Templated summary from claim facts.' };
}

function nextBestActions({ facts, ...rest } = {}) {
  const n = norm(facts ? { facts } : rest);
  const actions = [];
  const add = (code, label, reason, priority) => actions.push({ code, label, reason, priority });
  const raw = n.raw;
  if (n.fatality || n.injuries) add('CONTACT_CLAIMANT_INJURY', 'Contact claimant about injuries', 'Injuries reported on the claim.', 1);
  if (n.type === 'theft' && !n.policeReport) add('REQUEST_POLICE_REPORT', 'Request police report', 'Theft claims require a police report number.', 1);
  else if (/collision|hit_and_run/.test(n.type) && !n.policeReport && !n.glassOnly) add('REQUEST_POLICE_REPORT', 'Request police report if one exists', 'Collision with no report number on file.', 3);
  if (raw.coverageVerified === false || raw.coverage?.verified === false) add('VERIFY_COVERAGE', 'Verify coverage', 'Coverage is not yet verified.', 1);
  if (n.type === 'glass' || n.glassOnly) add('REFER_GLASS_VENDOR', 'Refer to glass vendor', 'Glass-only loss can be fast-tracked.', 2);
  if (n.cat) add('LINK_CAT_EVENT', 'Link to catastrophe event', 'Loss type indicates a catastrophe.', 2);
  if (n.fatality || n.litigation) add('ESCALATE_SUPERVISOR', 'Escalate to supervisor', 'Fatality or litigation indicated.', 1);
  if (n.drivable === false) add('ARRANGE_TOWING_RENTAL', 'Arrange towing and rental', 'Vehicle is not drivable.', 2);
  if (n.estimate === 0 && /collision|hail|wind|fire/.test(n.type)) add('REQUEST_ESTIMATE', 'Request repair estimate', 'No estimate on file.', 3);
  const fraud = fraudSignals({ facts: raw }).output;
  if (fraud.score >= 40) add('REFER_SIU', 'Refer to special investigations', `Fraud score ${fraud.score}.`, 1);
  if (subrogation({ facts: raw }).output.flag) add('PURSUE_SUBROGATION', 'Open subrogation review', 'Other party appears at fault.', 3);
  if (!actions.length) add('REVIEW_CLAIM', 'Review claim details', 'No specific actions triggered.', 4);
  actions.sort((a, b) => a.priority - b.priority || a.code.localeCompare(b.code));
  return { output: { actions }, confidence: STRONG, explanation: `${actions.length} rule-based action(s).` };
}

const HANDLERS = {
  extract_narrative: extractNarrative, extract_document: extractDocument, classify_photo: classifyPhoto,
  severity, fraud_signals: fraudSignals, subrogation, summarize, next_best_actions: nextBestActions,
};

export default function createLocalProvider(_ctx, _opts = {}) {
  return {
    name: 'local',
    async available() { return true; },
    async run(task, input) {
      const h = HANDLERS[task];
      if (!h) throw new Error(`local provider: unknown task '${task}'`);
      const r = h(input ?? {});
      return { output: r.output, confidence: r.confidence, explanation: r.explanation, usage: { inputTokens: 0, outputTokens: 0, local: true }, model: MODEL };
    },
  };
}
