// design-evals (tech map S7) V1: scoreEvalRun / summarizeEvalRun /
// diffAgainstBaseline pure scorers. Acceptance (design-evals §5): a
// positive/negative pair per metric family; forbidBareAssertions always fails
// an evidence-less decision; severity weights and baseline regression are
// asserted; the same trace scores byte-identically (deterministic); zero
// runtime behaviour change (V1 is pure functions only).

import { describe, expect, it } from 'vitest';
import { diffAgainstBaseline, scoreEvalRun, summarizeEvalRun } from '../src/evals/score.js';
import type { EvalCase, EvalExpectation } from '../src/evals/types.js';
import type { AuditEntry } from '../src/dispatch/dispatcher.js';
import type { FanOutRequest, FanOutResult } from '../src/orchestrator/types.js';

function outcome(overrides: Partial<FanOutResult> = {}): FanOutResult {
  return {
    intentId: 'intent-1', runId: 'r1', skill: 'research', realm: 'personal', branches: [], stream: [], positions: [],
    decision: { rule: 'unanimous', conclusion: null, positions: [], reason: '' }, conflicts: [], status: 'completed', createdAt: 't0',
    ...overrides,
  };
}

function request(): FanOutRequest {
  return { skill: 'research', params: {}, realm: 'personal' };
}

function case_(expect: EvalExpectation[], overrides: Partial<EvalCase> = {}): EvalCase {
  return { id: 'case-1', world: {}, agents: {}, input: request(), expect, ...overrides };
}

function audit(decision: AuditEntry['decision']): AuditEntry {
  return { ts: 't1', vassal: 'a1', decision };
}

describe('scoreEvalRun (S7 V1)', () => {
  it('scores a decision predicate', () => {
    const c = case_([{ decision: (o) => o.status === 'completed', severity: 'block' }]);
    const r = scoreEvalRun(c, { outcome: outcome(), audit: [], events: [] });
    expect(r.checks).toHaveLength(1);
    expect(r.checks[0]).toMatchObject({ family: 'decision', passed: true, severity: 'block' });
  });

  it('fails a decision predicate that does not hold', () => {
    const c = case_([{ decision: (o) => o.status === 'failed', severity: 'block' }]);
    const r = scoreEvalRun(c, { outcome: outcome(), audit: [], events: [] });
    expect(r.checks[0]!.passed).toBe(false);
  });

  it('passes escalation when the expected level was hit', () => {
    const c = case_([{ escalation: { expected: true, level: 1 }, severity: 'block' }]);
    const r = scoreEvalRun(c, { outcome: outcome(), audit: [audit('interrupt-level-1')], events: [] });
    expect(r.checks[0]).toMatchObject({ family: 'escalation', passed: true });
  });

  it('fails escalation when a different level was hit', () => {
    const c = case_([{ escalation: { expected: true, level: 2 }, severity: 'block' }]);
    const r = scoreEvalRun(c, { outcome: outcome(), audit: [audit('interrupt-level-1')], events: [] });
    expect(r.checks[0]!.passed).toBe(false);
  });

  it('fails a no-escalation expectation when an interruption exists (误升级)', () => {
    const c = case_([{ escalation: { expected: false }, severity: 'block' }]);
    const r = scoreEvalRun(c, { outcome: outcome(), audit: [audit('interrupt-level-1')], events: [] });
    expect(r.checks[0]!.passed).toBe(false);
  });

  it('passes selection when all must-include targets are present', () => {
    const c = case_([{ selection: { mustInclude: ['a1', 'a2'] }, severity: 'block' }]);
    const out = outcome({ branches: [{ vassal: 'a1', runId: 'r1', ok: true, events: [] }, { vassal: 'a2', runId: 'r2', ok: true, events: [] }] });
    const r = scoreEvalRun(c, { outcome: out, audit: [], events: [] });
    expect(r.checks[0]).toMatchObject({ family: 'selection', passed: true });
  });

  it('fails selection on an excluded target and an unexpected diversion', () => {
    const c = case_([{ selection: { mustExclude: ['a3'], diversionAllowed: false }, severity: 'block' }]);
    const out = outcome({ branches: [{ vassal: 'a3', runId: 'r1', ok: true, events: [] }] });
    const r = scoreEvalRun(c, { outcome: out, audit: [audit('chain-switched')], events: [] });
    expect(r.checks[0]!.passed).toBe(false);
    expect(r.checks[0]!.detail).toContain('unexpected');
  });

  it('passes evidence when the conclusion cites the required sources', () => {
    const c = case_([{ evidence: { mustCite: ['doc-a'], forbidBareAssertions: true }, severity: 'block' }]);
    const out = outcome({ positions: [{ vassal: 'a1', stance: 'x', rationale: 'per doc-a' }] });
    const r = scoreEvalRun(c, { outcome: out, audit: [], events: [] });
    expect(r.checks[0]!.passed).toBe(true);
  });

  it('block-fails a bare assertion with no rationale (verify-before-asserting)', () => {
    const c = case_([{ evidence: { forbidBareAssertions: true }, severity: 'block' }]);
    const out = outcome({ positions: [{ vassal: 'a1', stance: 'x' }] });
    const r = scoreEvalRun(c, { outcome: out, audit: [], events: [] });
    expect(r.checks[0]).toMatchObject({ passed: false, severity: 'block' });
    expect(r.checks[0]!.detail).toContain('bare assertion');
  });

  it('fails evidence when a required citation is missing', () => {
    const c = case_([{ evidence: { mustCite: ['doc-b'] }, severity: 'block' }]);
    const out = outcome({ positions: [{ vassal: 'a1', stance: 'x', rationale: 'per doc-a' }] });
    const r = scoreEvalRun(c, { outcome: out, audit: [], events: [] });
    expect(r.checks[0]!.passed).toBe(false);
    expect(r.checks[0]!.detail).toContain('doc-b');
  });

  it('passes guardrails when the expected handling row exists', () => {
    const c = case_([{ guardrails: { expectedHandling: 'redact' }, severity: 'block' }]);
    const r = scoreEvalRun(c, { outcome: outcome(), audit: [audit('guardrail-redacted')], events: [] });
    expect(r.checks[0]).toMatchObject({ family: 'guardrails', passed: true });
  });

  it('fails guardrails when the handling row is missing', () => {
    const c = case_([{ guardrails: { expectedHandling: 'refuse' }, severity: 'block' }]);
    const r = scoreEvalRun(c, { outcome: outcome(), audit: [audit('guardrail-annotated')], events: [] });
    expect(r.checks[0]!.passed).toBe(false);
  });

  it('passes a signals requirement only when the audit detail signals segment lists it', () => {
    const c = case_([{ guardrails: { expectedHandling: 'annotate', signals: ['external-url'] }, severity: 'block' }]);
    const hit: AuditEntry = {
      ts: 't1', vassal: '(intent)', decision: 'guardrail-annotated',
      detail: 'intent x: appendix entry f1 annotated (data-boundary:kernel-resolved-realm, signals external-url)',
    };
    const r = scoreEvalRun(c, { outcome: outcome(), audit: [hit], events: [] });
    expect(r.checks[0]!.passed).toBe(true);
  });

  it('fails a signals requirement when the row is the default plan-mode label with no signals', () => {
    const c = case_([{ guardrails: { expectedHandling: 'annotate', signals: ['external-url'] }, severity: 'block' }]);
    const hit: AuditEntry = {
      ts: 't1', vassal: '(intent)', decision: 'guardrail-annotated',
      detail: 'intent x: appendix entry f1 annotated (data-boundary:kernel-resolved-realm)',
    };
    const r = scoreEvalRun(c, { outcome: outcome(), audit: [hit], events: [] });
    expect(r.checks[0]!.passed).toBe(false);
  });

  it('does not match a signal name that appears only in the intent-id prefix', () => {
    // Regression: the detail prefix carries the intent id, which the runner
    // derives from the case id — guardrails/external-url-* therefore contains
    // the token "external-url" even when the annotation carried zero signals.
    // Matching must stay inside the `signals …` segment.
    const c = case_([{ guardrails: { expectedHandling: 'annotate', signals: ['external-url'] }, severity: 'block' }]);
    const hit: AuditEntry = {
      ts: 't1', vassal: '(intent)', decision: 'guardrail-annotated',
      detail: 'intent eval-guardrails-external-url-memory: appendix entry f1 annotated (data-boundary:kernel-resolved-realm)',
    };
    const r = scoreEvalRun(c, { outcome: outcome(), audit: [hit], events: [] });
    expect(r.checks[0]!.passed).toBe(false);
  });

  it('scores the branch budget and declares cost-tokens not-assessable in V1', () => {
    const c = case_([{ budget: { maxBranches: 2, maxCostTokens: 100 }, severity: 'block' }]);
    const out = outcome({ branches: [{ vassal: 'a1', runId: 'r1', ok: true, events: [] }, { vassal: 'a2', runId: 'r2', ok: true, events: [] }, { vassal: 'a3', runId: 'r3', ok: true, events: [] }] });
    const r = scoreEvalRun(c, { outcome: out, audit: [], events: [] });
    const branches = r.checks.find((ch) => ch.name === 'budget.branches');
    expect(branches).toMatchObject({ passed: false, detail: '3 branches > cap 2' });
    const cost = r.checks.find((ch) => ch.name === 'budget.cost-tokens');
    expect(cost).toMatchObject({ passed: true });
    expect(cost!.detail).toContain('not-assessable-in-v1');
  });

  it('is deterministic for the same trace', () => {
    const c = case_([
      { decision: (o) => o.status === 'completed', severity: 'block' },
      { escalation: { expected: false }, severity: 'warn' },
    ]);
    const trace = { outcome: outcome(), audit: [audit('interrupt-level-1')], events: [] };
    const a = scoreEvalRun(c, trace);
    const b = scoreEvalRun(c, trace);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe('summarizeEvalRun + diffAgainstBaseline (S7 V1)', () => {
  it('aggregates a batch into a metrics report with family buckets', () => {
    const c = case_([{ decision: (o) => o.status === 'completed', severity: 'block' }]);
    const failing = case_([{ decision: (o) => o.status === 'failed', severity: 'block' }], { id: 'case-2' });
    const report = summarizeEvalRun([
      scoreEvalRun(c, { outcome: outcome(), audit: [], events: [] }),
      scoreEvalRun(failing, { outcome: outcome(), audit: [], events: [] }),
    ]);
    expect(report.caseCount).toBe(2);
    expect(report.passed).toBe(1);
    expect(report.failed).toBe(1);
    expect(report.blocked).toBe(1);
    expect(report.byFamily['decision']).toEqual({ total: 2, passed: 1, blocked: 1 });
  });

  it('counts warn-severity failures separately from block', () => {
    const c = case_([{ escalation: { expected: false }, severity: 'warn' }]);
    const report = summarizeEvalRun([scoreEvalRun(c, { outcome: outcome(), audit: [audit('interrupt-level-1')], events: [] })]);
    expect(report.blocked).toBe(0);
    expect(report.warned).toBe(1);
  });

  it('flags a grown blocked count as a block regression', () => {
    const cur: ReturnType<typeof summarizeEvalRun> = {
      caseCount: 1, passed: 0, failed: 1, blocked: 1, warned: 0,
      byFamily: { decision: { total: 1, passed: 0, blocked: 1 } },
    };
    const base2: ReturnType<typeof summarizeEvalRun> = {
      caseCount: 1, passed: 1, failed: 0, blocked: 0, warned: 0,
      byFamily: { decision: { total: 1, passed: 1, blocked: 0 } },
    };
    const regressions = diffAgainstBaseline(cur, base2);
    expect(regressions).toContainEqual({ family: 'decision', metric: 'blocked', previous: 0, current: 1, severity: 'block' });
  });

  it('flags a shrunken passed count as a warn regression', () => {
    const cur: ReturnType<typeof summarizeEvalRun> = {
      caseCount: 1, passed: 0, failed: 1, blocked: 0, warned: 1,
      byFamily: { decision: { total: 1, passed: 0, blocked: 0 } },
    };
    const base: ReturnType<typeof summarizeEvalRun> = {
      caseCount: 1, passed: 1, failed: 0, blocked: 0, warned: 0,
      byFamily: { decision: { total: 1, passed: 1, blocked: 0 } },
    };
    const regressions = diffAgainstBaseline(cur, base);
    expect(regressions).toContainEqual({ family: 'decision', metric: 'passed', previous: 1, current: 0, severity: 'warn' });
  });

  it('reports no regression when the report matches the baseline', () => {
    const report: ReturnType<typeof summarizeEvalRun> = {
      caseCount: 0, passed: 0, failed: 0, blocked: 0, warned: 0,
      byFamily: { decision: { total: 0, passed: 0, blocked: 0 } },
    };
    expect(diffAgainstBaseline(report, report)).toEqual([]);
  });
});
