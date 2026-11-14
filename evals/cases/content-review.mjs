// Second eval benchmark (W4-5): the loom "content recheck" vertical.
//
// A publishable content candidate passes a panel of independent checks
// (factual corroboration, evidence citation, compliance). Each check is a
// scripted execution agent returning approve/reject with a rationale; the
// intent settles through the same runtime governance primitives the first
// benchmark covers (decision/escalation/evidence/data-policy/selection/budget),
// but the cases are chained into one product narrative — loom never publishes
// on a bare assertion, a failed check, or an unresolvable split.
//
// The suite deliberately reuses RunnerCase (no second world builder) and pins
// its own baseline; it is an independent gate (scripts/eval-run.mjs
// --suite-file). It must NOT be imported by evals/cases/index.mjs.

const APPROVE = { stance: 'approve', rationale: 'verified against brief.md: the content claim is present and in scope' };
const REJECT = { stance: 'reject', rationale: 'brief.md contains no supporting evidence for the content claim' };
// A compliance veto is still a scripted reject — its rationale cites the
// frozen condition package rather than a fact source.
const VETO = { stance: 'reject', rationale: 'PWC condition failed: banned expression in the candidate body' };

/** @type {Array<import('../../scripts/eval-run.mjs').RunnerCase>} */
export const evalCases = [
  // 1. Every check approves with a cited rationale -> the candidate is cleared.
  {
    id: 'content-review/all-checks-approve',
    skill: 'research',
    agents: [
      { name: 'fact', ...APPROVE },
      { name: 'compliance', ...APPROVE },
      { name: 'scope', ...APPROVE },
    ],
    request: { realm: 'personal', aggregation: { kind: 'unanimous' }, params: { subject: 'content-candidate', predicate: 'publishable' } },
    expect: [
      { decision: o => o.status === 'completed' && o.decision.conclusion === 'approve', severity: 'block' },
      { evidence: { forbidBareAssertions: true }, severity: 'block' },
      { escalation: { expected: false }, severity: 'block' },
    ],
  },

  // 2. One check rejects under a unanimous publish gate -> no publish, the
  // split is surfaced for an editor (L1), never majority-guessed.
  {
    id: 'content-review/single-veto-blocks-publish',
    skill: 'research',
    agents: [
      { name: 'fact', ...APPROVE },
      { name: 'compliance', ...VETO },
      { name: 'scope', ...APPROVE },
    ],
    request: { realm: 'personal', aggregation: { kind: 'unanimous' }, params: { subject: 'content-candidate', predicate: 'contested' } },
    expect: [
      { decision: o => o.status === 'needs-operator' && o.conflicts.length >= 1, severity: 'block' },
      { escalation: { expected: true, level: 1 }, severity: 'block' },
    ],
  },

  // 3. Editorial majority rule settles a non-compliance factual disagreement
  // without interrupting an operator (compliance veto is reserved for case 2's
  // unanimous gate; here two fact checks outvote one).
  {
    id: 'content-review/factual-majority-settles',
    skill: 'research',
    agents: [
      { name: 'fact-a', ...APPROVE },
      { name: 'fact-b', ...APPROVE },
      { name: 'fact-c', ...REJECT },
    ],
    request: { realm: 'personal', aggregation: { kind: 'majority' }, params: { subject: 'content-candidate', predicate: 'majority-rule' } },
    expect: [
      { decision: o => o.status === 'completed' && o.decision.conclusion === 'approve', severity: 'block' },
      { escalation: { expected: false }, severity: 'block' },
    ],
  },

  // 4. The review dispatches to exactly the registered check panel: an
  // available check that is not selected must never be silently pulled in
  // (target fidelity for the content pipeline).
  {
    id: 'content-review/panel-targets-respected',
    skill: 'research',
    agents: [
      { name: 'fact', ...APPROVE },
      { name: 'compliance', ...APPROVE },
      { name: 'scope', ...APPROVE },
    ],
    request: { realm: 'personal', executors: ['fact', 'compliance'], aggregation: { kind: 'unanimous' }, params: { subject: 'content-candidate', predicate: 'scoped-panel' } },
    expect: [
      { decision: o => o.status === 'completed' && o.decision.conclusion === 'approve', severity: 'block' },
      { selection: { mustInclude: ['fact', 'compliance'], mustExclude: ['scope'] }, severity: 'block' },
      { evidence: { forbidBareAssertions: true }, severity: 'block' },
    ],
  },

  // 5. A check whose task settles failed must fail the review rather than
  // silently publishing — the failure is a tool failure, not an editor vote.
  {
    id: 'content-review/check-failure-fails-review',
    skill: 'research',
    agents: [
      { name: 'fact', fail: true },
      { name: 'compliance', ...APPROVE },
    ],
    request: { realm: 'personal', executors: ['fact'], aggregation: { kind: 'unanimous' }, params: { subject: 'content-candidate', predicate: 'fails' } },
    expect: [
      { decision: o => o.status === 'failed' && o.branches.some(b => b.state === 'failed'), severity: 'block' },
      { escalation: { expected: false }, severity: 'block' },
    ],
  },

  // 6. Product facts may only reach a check when the runtime resolved them:
  // caller-asserted realm hits are refused before dispatch (no phantom evidence).
  {
    id: 'content-review/self-asserted-product-facts-refused',
    skill: 'research',
    agents: [
      { name: 'fact', ...APPROVE, dataPolicy: 'read-task-scope' },
      { name: 'compliance', ...APPROVE, dataPolicy: 'read-task-scope' },
    ],
    request: {
      realm: 'personal',
      executors: ['fact', 'compliance'],
      aggregation: { kind: 'unanimous' },
      realmHits: [{ itemId: 'product-fact-1', tags: [], modifiedAt: '2026-10-10T00:00:00.000Z', snippet: 'caller claimed spec' }],
      realmHitsOrigin: 'caller-asserted',
      params: { subject: 'content-candidate', predicate: 'refused' },
    },
    expect: [
      { decision: o => o.status === 'failed' && o.branches.length === 2 && o.branches.every(b => (b.reason ?? '').includes('dataPolicy')), severity: 'block' },
      { escalation: { expected: false }, severity: 'block' },
    ],
  },

  // 7. Runtime-resolved product facts are injected and cited — the evidence
  // path the content panel is actually allowed to rely on.
  {
    id: 'content-review/runtime-resolved-facts-cited',
    skill: 'research',
    agents: [
      { name: 'fact', stance: 'approve', rationale: 'verified against brief.md: runtime-resolved product spec matches', dataPolicy: 'read-task-scope' },
    ],
    request: {
      realm: 'personal',
      executors: ['fact'],
      aggregation: { kind: 'unanimous' },
      realmHits: [{ itemId: 'resolved-spec', tags: [], modifiedAt: '2026-10-10T00:00:00.000Z', snippet: 'runtime-resolved product spec' }],
      realmHitsOrigin: 'runtime-resolved',
      params: { subject: 'content-candidate', predicate: 'injected' },
    },
    expect: [
      { decision: o => o.status === 'completed', severity: 'block' },
      { evidence: { mustCite: ['brief.md'] }, severity: 'block' },
    ],
  },

  // 8. An oversized review fan-out is refused by the machine cost gate before
  // dispatch — the review budget is bounded; no operator interruption.
  {
    id: 'content-review/oversized-panel-refused',
    skill: 'research',
    agents: [
      { name: 'fact', ...APPROVE },
    ],
    costLimit: { maxWindowCost: 3, circuitWindowMs: 60_000 },
    request: {
      realm: 'personal',
      executors: ['fact'],
      aggregation: { kind: 'unanimous' },
      costEstimate: { tokens: 5 },
      params: { subject: 'content-candidate', predicate: 'refused' },
    },
    expect: [
      { decision: o => o.status === 'failed' && o.refused?.reason === 'cost-budget-exceeded', severity: 'block' },
      { escalation: { expected: false }, severity: 'block' },
    ],
  },
];
