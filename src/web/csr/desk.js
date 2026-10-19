// Desk view models for the two-pane CSR layout. Pure logic: inject { t, fmt }; no kit imports, no DOM.
// fmt = { date(v), money(v), enum(v) } (the browser passes shared/format.js functions; tests pass fakes).

/** Progress bar numbers from IntakeStep.progress. Pure. */
export function progressModel(progress, done = false) {
  const answered = Math.max(0, Number(progress?.answered) || 0);
  const remaining = Math.max(0, Number(progress?.requiredRemaining) || 0);
  const total = answered + remaining;
  const percent = done || (total > 0 && remaining === 0) ? 100 : total ? Math.round((answered / total) * 100) : 0;
  return { answered, remaining, percent };
}

/** Chip tone for a policy status token. Pure. */
export function policyTone(status) {
  const s = String(status ?? '').toLowerCase();
  if (s === 'in_force' || s === 'active') return 'success';
  if (s.startsWith('pending') || s === 'renewal' || s === 'suspended') return 'warning';
  if (s === 'cancelled' || s === 'canceled' || s === 'lapsed' || s === 'expired') return 'danger';
  return 'neutral';
}

/** One-line limit/deductible text for a coverage, e.g. "$100,000 per person, $300,000 per occurrence". Pure. */
export function coverageDetail(cov, { t, fmt }) {
  const parts = [];
  if (cov?.limitPerPerson || cov?.limitPerOccurrence) {
    if (cov.limitPerPerson) parts.push(t('csr.cov.perPerson', { amount: fmt.money(cov.limitPerPerson) }));
    if (cov.limitPerOccurrence) parts.push(t('csr.cov.perOccurrence', { amount: fmt.money(cov.limitPerOccurrence) }));
  } else if (cov?.limit) parts.push(t('csr.cov.limit', { amount: fmt.money(cov.limit) }));
  if (cov?.deductible) {
    const zero = Number(cov.deductible.amount) === 0;
    parts.push(zero ? t('csr.cov.noDeductible') : t('csr.cov.deductible', { amount: fmt.money(cov.deductible) }));
  }
  return parts.join(', ');
}

const vehicleTitle = (v) => [v?.year, v?.make, v?.model].filter(Boolean).join(' ') || v?.unitId || '';

/**
 * Left-panel model: policy identity, named insured(s), drivers, vehicles and coverages as cards with a status chip.
 * @param {{ summary?: any, snapshot?: any, vehicleOptions?: {unitId:string,label:string}[] }} src
 *   summary = the selected search row's PolicySummary; snapshot = GET /policies/{n}/snapshot (may be null); vehicleOptions = fallback
 */
export function contextModel({ summary, snapshot, vehicleOptions = [] } = {}, { t, fmt }) {
  const base = snapshot ?? summary ?? {};
  const status = base.status ?? summary?.status ?? '';
  const tone = policyTone(status);
  const period = base.period ?? summary?.period ?? {};
  const term = period.effectiveDate && period.expirationDate ? t('csr.ctx.termValue', { from: fmt.date(period.effectiveDate), to: fmt.date(period.expirationDate) }) : '';
  const inForce = tone === 'success';
  const chip = { tone, label: fmt.enum(status || 'unknown') };
  const covStatus = { tone: inForce ? 'success' : tone, label: inForce ? t('csr.cov.status.active') : chip.label };
  const toCoverage = (c) => ({ code: c.code ?? '', title: c.description || c.code || '', detail: coverageDetail(c, { t, fmt }), status: covStatus });

  const vehicles = (snapshot?.vehicles ?? []).map((v) => ({
    id: v.unitId ?? '',
    title: vehicleTitle(v),
    sub: v.vin ? t('csr.ctx.vin', { last4: String(v.vin).slice(-4) }) : '',
    coverages: (v.coverages ?? []).map((c) => ({ code: c.code ?? '', title: c.description || c.code || '', detail: coverageDetail(c, { t, fmt }) })),
  }));
  if (!vehicles.length) for (const o of vehicleOptions) vehicles.push({ id: o.unitId, title: o.label, sub: '', coverages: [] });

  return {
    number: base.policyNumber ?? summary?.policyNumber ?? '',
    status: chip,
    lob: fmt.enum(base.lob ?? summary?.lob ?? ''),
    term,
    insureds: ((base.namedInsureds ?? []).length ? base.namedInsureds : (summary?.insuredName ? [{ name: summary.insuredName }] : []))
      .map((n) => ({ name: n?.name ?? '', relation: n?.relation ? fmt.enum(n.relation) : '' })).filter((n) => n.name),
    drivers: (snapshot?.drivers ?? []).map((d) => ({ name: d.name ?? '', excluded: !!d.excluded })).filter((d) => d.name),
    vehicles,
    coverages: (snapshot?.coverages ?? []).map(toCoverage),
    detailed: !!snapshot,
  };
}
