/** Synthetic evidence documents: police report, repair estimate, photo placeholder. All fictional. */
import { AGENCIES, REPAIR_SHOPS } from './names.mjs';

/** 1x1 transparent PNG. */
export const TINY_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

const fmt = (cents) => (cents / 100).toFixed(2);

/**
 * Build a police report document.
 * @param {ReturnType<import('./prng.mjs').createRng>} rng
 * @param {object} i {reportNumber, lossDate, lossTime, location, narrative, parties:[{role,name,vehicle,insurer}], citations:[string], injuries, agency?}
 */
export function policeReport(rng, i) {
  const agency = i.agency || rng.pick(AGENCIES);
  const lines = [
    agency.toUpperCase(),
    'TRAFFIC / INCIDENT REPORT',
    `Report No.: ${i.reportNumber}`,
    `Date of incident: ${i.lossDate}   Time: ${i.lossTime}`,
    `Location: ${i.location}`,
    `Reporting officer: Ofc. ${i.officer || 'R. Whitlock'}, Badge ${rng.int(1000, 9999)}`,
    '',
    'PARTIES AND VEHICLES'
  ];
  i.parties.forEach((p, n) => {
    lines.push(`  Unit ${n + 1} - ${p.role}: ${p.name}`);
    if (p.vehicle) lines.push(`    Vehicle: ${p.vehicle}`);
    if (p.insurer) lines.push(`    Insurer: ${p.insurer}`);
  });
  lines.push('', `INJURIES: ${i.injuries ? 'Yes - transported for evaluation' : 'None reported'}`, '', 'NARRATIVE', i.narrative, '', 'CITATIONS');
  if (i.citations.length) i.citations.forEach((c) => lines.push(`  - ${c}`));
  else lines.push('  - None issued');
  lines.push('', 'This is a synthetic test document. All persons and entities are fictional.');
  return {
    kind: 'police_report',
    filename: `police-report-${i.reportNumber}.txt`,
    contentType: 'text/plain',
    text: lines.join('\n'),
    metadata: { reportNumber: i.reportNumber, agency, synthetic: true }
  };
}

/**
 * Build a repair estimate whose line items sum to the total.
 * @param {ReturnType<import('./prng.mjs').createRng>} rng
 * @param {object} i {vehicle, claimRef, lossDate, parts:[{desc, price}], laborHours:[{desc,hours}], laborRate, taxRate, shop?, dollars?}
 * Prices are in whole dollars; math is done in cents.
 */
export function repairEstimate(rng, i) {
  const shop = i.shop || rng.pick(REPAIR_SHOPS);
  const laborRate = i.laborRate ?? 62;
  const taxRate = i.taxRate ?? 0.055;
  const items = [];
  let partsCents = 0;
  let laborCents = 0;
  for (const p of i.parts || []) {
    const c = Math.round(p.price * 100);
    partsCents += c;
    items.push({ type: 'part', description: p.desc, qty: 1, amountCents: c });
  }
  for (const l of i.laborHours || []) {
    const c = Math.round(l.hours * laborRate * 100);
    laborCents += c;
    items.push({ type: 'labor', description: `${l.desc} (${l.hours.toFixed(1)} h @ ${laborRate}/h)`, qty: l.hours, amountCents: c });
  }
  const taxCents = Math.round(partsCents * taxRate);
  const totalCents = partsCents + laborCents + taxCents;
  const lines = [
    shop.toUpperCase(),
    'REPAIR ESTIMATE',
    `Estimate ID: EST-${rng.int(100000, 999999)}`,
    `Reference: ${i.claimRef || 'n/a'}   Date of loss: ${i.lossDate}`,
    `Vehicle: ${i.vehicle}`,
    '',
    'LINE ITEMS'
  ];
  items.forEach((it, n) => lines.push(`${String(n + 1).padStart(2, '0')}  ${it.type.toUpperCase().padEnd(5)} ${it.description.padEnd(52)} ${fmt(it.amountCents).padStart(10)}`));
  lines.push('', `Parts subtotal:  ${fmt(partsCents).padStart(10)}`, `Labor subtotal:  ${fmt(laborCents).padStart(10)}`, `Sales tax (${(taxRate * 100).toFixed(1)}% on parts): ${fmt(taxCents).padStart(10)}`, `TOTAL:           ${fmt(totalCents).padStart(10)}`, '', 'Synthetic test document. Shop and figures are fictional.');
  return {
    kind: 'estimate',
    filename: `estimate-${i.claimRef || 'draft'}.txt`.replace(/\s+/g, '-'),
    contentType: 'text/plain',
    text: lines.join('\n'),
    metadata: {
      shop,
      lineItems: items,
      partsTotal: partsCents / 100,
      laborTotal: laborCents / 100,
      tax: taxCents / 100,
      total: totalCents / 100,
      currency: 'USD',
      synthetic: true
    }
  };
}

/** Tiny base64 image placeholder as a photo document. */
export function photoPlaceholder(name = 'damage-photo-1.png', caption = 'Damage photo') {
  return {
    kind: 'photo',
    filename: name,
    contentType: 'image/png',
    contentBase64: TINY_PNG_BASE64,
    text: caption,
    metadata: { placeholder: true, synthetic: true }
  };
}
