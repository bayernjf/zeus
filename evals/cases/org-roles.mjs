// Third eval benchmark (D9-1): the Tier0 organization-role scenarios.
//
// The core suite (index.mjs) asserts governance primitives; content-review.mjs
// narrates the loom content vertical. This suite narrates the three organization
// SOP roles from the catalog — content production (D0 auto), listing publish
// (D3 external, human stop), after-sales support (D2) — as one product story:
// a role only clears when its panel corroborates, a single veto holds the
// publish, a failure fails the task instead of silently publishing, and an
// oversized panel is refused by the machine cost gate before dispatch.
//
// It reuses RunnerCase (no second world builder) and pins its own baseline via
// `scripts/eval-run.mjs --suite-file evals/cases/org-roles.mjs
// --baseline-file evals/baseline-org-roles.json`. It must NOT be imported by
// evals/cases/index.mjs (the primary gate stays byte-identical).

const APPROVE = { stance: 'approve', rationale: 'verified against brief.md: the requested outcome is supported and in scope' };
const REJECT = { stance: 'reject', rationale: 'brief.md contains no supporting evidence for the claim' };
// A compliance veto is still a scripted reject — its rationale cites the frozen
// condition package rather than a fact source.
const VETO = { stance: 'reject', rationale: 'PWC condition failed: banned expression in the candidate body' };

/** @type {Array<import('../../scripts/eval-run.mjs').RunnerCase>} */
export const evalCases = [
  // 1. content-production (D0): every panel check approves -> the task clears
  //    with no operator interruption.
  {
    id: 'org/content-d0-panel-clears',
    skill: 'research',
    agents: [
      { name: 'fact', ...APPROVE },
      { name: 'compliance', ...APPROVE },
      { name: 'scope', ...APPROVE },
    ],
    request: { dataDomain: 'personal', aggregation: { kind: 'unanimous' }, params: { subject: 'content-task', predicate: 'd0-cleared' } },
    expect: [
      { decision: o => o.status === 'completed' && o.decision.conclusion === 'approve', severity: 'block' },
      { evidence: { forbidBareAssertions: true }, severity: 'block' },
      { escalation: { expected: false }, severity: 'block' },
    ],
  },

  // 2. listing-publish (D3): a single compliance veto under the unanimous
  //    publish gate surfaces the split to an editor (L1) — never majority-guessed,
  //    never auto-published.
  {
    id: 'org/listing-d3-single-veto-holds',
    skill: 'research',
    agents: [
      { name: 'fact', ...APPROVE },
      { name: 'compliance', ...VETO },
      { name: 'scope', ...APPROVE },
    ],
    request: { dataDomain: 'personal', aggregation: { kind: 'unanimous' }, params: { subject: 'listing-task', predicate: 'd3-contested' } },
    expect: [
      { decision: o => o.status === 'needs-operator' && o.conflicts.length >= 1, severity: 'block' },
      { escalation: { expected: true, level: 1 }, severity: 'block' },
    ],
  },

  // 3. listing-publish (D3): a non-compliance factual disagreement settles by
  //    editorial majority without interrupting an operator.
  {
    id: 'org/listing-d3-majority-clears',
    skill: 'research',
    agents: [
      { name: 'fact-a', ...APPROVE },
      { name: 'fact-b', ...APPROVE },
      { name: 'fact-c', ...REJECT },
    ],
    request: { dataDomain: 'personal', aggregation: { kind: 'majority' }, params: { subject: 'listing-task', predicate: 'd3-majority' } },
    expect: [
      { decision: o => o.status === 'completed' && o.decision.conclusion === 'approve', severity: 'block' },
      { escalation: { expected: false }, severity: 'block' },
    ],
  },

  // 4. after-sales-support (D2): the task dispatches to exactly the registered
  //    role panel; an authorized-but-unselected check is never silently pulled in.
  {
    id: 'org/after-sales-d2-scoped-panel',
    skill: 'research',
    agents: [
      { name: 'intake', ...APPROVE },
      { name: 'policy', ...APPROVE },
      { name: 'refund', ...APPROVE },
    ],
    request: { dataDomain: 'personal', executors: ['intake', 'policy'], aggregation: { kind: 'unanimous' }, params: { subject: 'after-sales-task', predicate: 'd2-scoped' } },
    expect: [
      { decision: o => o.status === 'completed' && o.decision.conclusion === 'approve', severity: 'block' },
      { selection: { mustInclude: ['intake', 'policy'], mustExclude: ['refund'] }, severity: 'block' },
      { evidence: { forbidBareAssertions: true }, severity: 'block' },
    ],
  },

  // 5. after-sales-support (D2): a role whose check settles failed fails the
  //    task rather than silently publishing — a tool failure, not an editor vote.
  {
    id: 'org/after-sales-d2-tool-failure',
    skill: 'research',
    agents: [
      { name: 'intake', fail: true },
      { name: 'policy', ...APPROVE },
    ],
    request: { dataDomain: 'personal', executors: ['intake'], aggregation: { kind: 'unanimous' }, params: { subject: 'after-sales-task', predicate: 'd2-fails' } },
    expect: [
      { decision: o => o.status === 'failed' && o.branches.some(b => b.state === 'failed'), severity: 'block' },
      { escalation: { expected: false }, severity: 'block' },
    ],
  },

  // 6. Any role: an oversized panel is refused by the machine cost gate before
  //    dispatch — the role budget is bounded; no operator interruption.
  {
    id: 'org/delivery-oversized-panel-refused',
    skill: 'research',
    agents: [
      { name: 'intake', ...APPROVE },
    ],
    costLimit: { maxWindowCost: 3, circuitWindowMs: 60_000 },
    request: {
      dataDomain: 'personal',
      executors: ['intake'],
      aggregation: { kind: 'unanimous' },
      costEstimate: { tokens: 5 },
      params: { subject: 'delivery-task', predicate: 'refused' },
    },
    expect: [
      { decision: o => o.status === 'failed' && o.refused?.reason === 'cost-budget-exceeded', severity: 'block' },
      { escalation: { expected: false }, severity: 'block' },
    ],
  },
];
