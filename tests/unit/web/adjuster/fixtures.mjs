// Local fake AdjusterView payload (synthetic) so render tests need no server.
export const TS = '2026-09-16T10:00:00.000Z';
const ai = { provider: 'local', model: 'local-rules-v1', confidence: 0.82, tier: 0 };

export function fakeView(over = {}) {
  return {
    claim: {
      id: 'clm_00000000000000000001', claimNumber: 'ALP-26-000001', status: 'assigned', lob: 'personal_auto', policyNumber: 'PA-1001', riskState: 'WI',
      flags: ['siu', 'subrogation', 'timer_due', 'injury'], lossEvent: { lossDate: '2026-09-15', cause: 'collision' },
    },
    coverage: { outcome: 'partial', checks: [{ code: 'policy_found', passed: true }, { code: 'driver_listed', passed: false, detail: 'Driver not listed' }], applicableDeductible: { amount: 500, currency: 'USD' }, reasons: ['Driver not listed'] },
    triage: {
      severityScore: 62, severityBand: 'major', complexity: 'high',
      fraud: { score: 74, referToSiu: true, indicators: [{ code: 'late_report', reason: 'Reported 20 days after loss' }] },
      subrogation: { flag: true, reasons: [{ code: 'rear_ended_by_other', reason: 'Other driver at fault <b>x</b>' }] },
      explanation: 'Injury and late report raised severity.', ai,
    },
    routing: { outcome: 'assigned', queue: 'siu', adjusterId: 'adj-1', fastTrack: false, ruleIds: ['r-siu'], reasons: ['Fraud score above threshold'] },
    documents: [{ id: 'doc1', filename: 'photo.jpg', kind: 'photo', extraction: { needsReview: true } }],
    timers: [
      { id: 'tm1', kind: 'acknowledge', status: 'due_soon', dueAt: '2026-09-16T12:00:00.000Z', warnAt: '2026-09-16T09:00:00.000Z', citation: 'Synthetic reg 1' },
      { id: 'tm2', kind: 'contact', status: 'running', dueAt: '2026-09-20T12:00:00.000Z' },
    ],
    tasks: [{ id: 'tsk1', type: 'siu_referral', title: 'SIU referral', status: 'open' }, { id: 'tsk2', type: 'subrogation_review', title: 'Review recovery', status: 'open' }],
    notes: [],
    summary: { text: 'Two-car collision with injury; fraud indicators present.', ai },
    nextActions: [
      { code: 'refer_siu', label: 'Review SIU referral', reason: 'Fraud score 74', priority: 'high', source: 'rule' },
      { code: 'request_police_report', label: 'Request the police report', priority: 'medium', source: 'rule' },
      { code: 'ai_extra', label: 'Call the repair shop', priority: 'low', source: 'ai' },
    ],
    timeline: [{ at: TS, type: 'claim.reported', label: 'Claim reported' }],
    generatedAt: TS, ...over,
  };
}

export const fakeInbox = () => ({
  items: [
    { claimId: 'c1', claimNumber: 'ALP-26-000001', status: 'assigned', lob: 'personal_auto', queue: 'siu', severityScore: 80, flags: ['siu', 'timer_breached'], nextTimer: { kind: 'acknowledge', status: 'breached', dueAt: '2026-09-16T08:00:00.000Z' } },
    { claimId: 'c2', claimNumber: 'ALP-26-000002', status: 'assigned', lob: 'homeowners', queue: 'std', severityScore: 20, flags: [], nextTimer: { kind: 'contact', status: 'running', dueAt: '2026-09-18T08:00:00.000Z' } },
    { claimId: 'c3', claimNumber: '<script>x</script>', severityScore: 55, flags: ['weird_flag'] },
  ],
  nextCursor: null,
});
