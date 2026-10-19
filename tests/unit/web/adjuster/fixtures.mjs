// Local fake AdjusterView payload (synthetic) so render tests need no server.
export const TS = '2026-09-16T10:00:00.000Z';
const ai = { provider: 'local', model: 'local-rules-v1', confidence: 0.82, tier: 0 };

export function fakeView(over = {}) {
  return {
    claim: {
      id: 'clm_00000000000000000001', claimNumber: 'ALP-26-000001', status: 'assigned', lob: 'personal_auto', policyNumber: 'PA-1001', riskState: 'WI',
      flags: ['siu', 'subrogation', 'timer_due', 'injury'], lossEvent: { lossDate: '2026-09-15', cause: 'collision', location: { description: 'Elm St and 3rd Ave, Springfield' } },
      parties: [{ id: 'p1', roles: ['insured', 'reporter'], firstName: 'Avery', lastName: 'Stone', phone: '555-0100', injured: true }, { id: 'p2', roles: ['third_party'], organizationName: 'Other Co <b>', atFault: true }],
      vehicles: [{ id: 'v1', role: 'insured', year: 2019, make: 'Ford', model: 'Focus', drivable: false, towed: true, licensePlate: 'ABC123', plateState: 'WI' }],
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
    summary: { text: 'Two-car collision with injury; fraud indicators present.\nFacts used: lossCause=collision', explanation: 'Built from claim facts.', ai },
    nextActions: [
      { code: 'refer_siu', label: 'Review SIU referral', reason: 'Fraud score 74', priority: 'high', source: 'rule' },
      { code: 'request_police_report', label: 'Request the police report', priority: 'medium', source: 'rule' },
      { code: 'ai_extra', label: 'Call the repair shop', priority: 30, source: 'ai', ai },
      { code: 'ai_unproven', label: 'Hidden AI action', source: 'ai' },
    ],
    timeline: [{ at: TS, type: 'claim.reported', label: 'Claim reported' }, { at: '2026-09-16T10:05:00.000Z', type: 'claim.triaged', label: 'Triaged: severity 62' }],
    timestamps: { reportedAt: TS },
    generatedAt: TS, ...over,
  };
}

export const fakeInbox = () => ({
  items: [
    { claimId: 'c1', claimNumber: 'ALP-26-000001', status: 'assigned', lob: 'personal_auto', queue: 'siu', severityScore: 80, flags: ['siu', 'timer_breached'], nextTimer: { kind: 'acknowledge', status: 'breached', dueAt: '2026-09-16T08:00:00.000Z' }, reportedAt: '2026-09-15T08:00:00.000Z', assignedAt: '2026-09-15T09:00:00.000Z' },
    { claimId: 'c2', claimNumber: 'ALP-26-000002', status: 'assigned', lob: 'homeowners', queue: 'std', severityScore: 20, flags: [], nextTimer: { kind: 'contact', status: 'running', dueAt: '2026-09-18T08:00:00.000Z' } },
    { claimId: 'c3', claimNumber: '<script>x</script>', status: 'fast_tracked', severityScore: 55, flags: ['weird_flag'] },
    { claimId: 'c4', claimNumber: 'ALP-26-000004', status: 'closed', lob: 'personal_auto', severityScore: 90, nextTimer: { kind: 'decide', status: 'running', dueAt: '2026-09-16T12:00:00.000Z' } },
  ],
  nextCursor: null,
});
