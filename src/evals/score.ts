// design-evals (tech map S7) V1: the pure scorer over one run's observable
// artefacts. It does not run the world — it scores a trace. Every check is a
// deterministic boolean; the same trace scores byte-identically.
//
// Family names follow design-evals §3.2: decision / escalation / selection /
// evidence / guardrails / budget. The summarize + diff pair turns a batch into
// a metrics report and detects regression against a pinned baseline.

import type { AuditEntry } from '../dispatch/dispatcher.js';
import type { ProgressEvent } from '../orchestrator/progress.js';
import type { FanOutResult } from '../orchestrator/types.js';
import type { ContentHandling } from '../guardrails/content-risk.js';
import type { EvalCase, EvalExpectation } from './types.js';

export type EvalCheck = {
  name: string;
  family: string;
  passed: boolean;
  severity: EvalExpectation['severity'];
  detail?: string;
};

export type EvalResult = {
  caseId: string;
  checks: EvalCheck[];
};

export type EvalMetricsReport = {
  caseCount: number;
  passed: number;
  failed: number;
  /** block-severity failures — the gate weight for CI (V3). */
  blocked: number;
  warned: number;
  byFamily: Record<string, { total: number; passed: number; blocked: number }>;
};

export type EvalRegression = {
  family: string;
  metric: string;
  previous: number;
  current: number;
  severity: 'block' | 'warn';
};

const FAMILIES = ['decision', 'escalation', 'selection', 'evidence', 'guardrails', 'budget'] as const;

type Trace = { outcome: FanOutResult; audit: AuditEntry[]; events: ProgressEvent[] };

/** Score one eval case against the settled trace (design-evals §4). Checks are
 *  evaluated in the declared order; a check that cannot be assessed from V1
 *  facts (e.g. cost tokens) is marked passed with an explicit
 *  not-assessable detail — never silently dropped. */
export function scoreEvalRun(c: EvalCase, trace: Trace): EvalResult {
  const checks: EvalCheck[] = [];
  for (const ex of c.expect) {
    if (ex.decision !== undefined) {
      checks.push(check('decision.decision', 'decision', ex, ex.decision(trace.outcome)));
    }
    if (ex.escalation !== undefined) {
      const found = trace.audit
        .filter((a) => a.decision === 'interrupt-level-0' || a.decision === 'interrupt-level-1' || a.decision === 'interrupt-level-2')
        .map((a) => a.decision);
      const levelHit = ex.escalation.level === undefined || found.includes(`interrupt-level-${ex.escalation.level}` as AuditEntry['decision']);
      const passed = ex.escalation.expected ? found.length > 0 && levelHit : found.length === 0;
      checks.push(check(`escalation.expected=${ex.escalation.expected}`, 'escalation', ex, passed, detailOf(found)));
    }
    if (ex.selection !== undefined) {
      const vassals = new Set(trace.outcome.branches.map((b) => b.vassal));
      const reasons: string[] = [];
      for (const must of ex.selection.mustInclude ?? []) {
        if (!vassals.has(must)) reasons.push(`missing ${must}`);
      }
      for (const mustNot of ex.selection.mustExclude ?? []) {
        if (vassals.has(mustNot)) reasons.push(`unexpected ${mustNot}`);
      }
      const diverted = trace.audit.some((a) => a.decision === 'chain-switched' || a.decision === 'branch-diverted');
      if (ex.selection.diversionAllowed === false && diverted) reasons.push('unexpected diversion');
      checks.push(check('selection.targets', 'selection', ex, reasons.length === 0, reasons.join('; ')));
    }
    if (ex.evidence !== undefined) {
      const texts = trace.outcome.positions.map((p) => `${p.stance ?? ''} ${p.rationale ?? ''}`.trim());
      const reasons: string[] = [];
      for (const cite of ex.evidence.mustCite ?? []) {
        if (!texts.some((t) => t.includes(cite))) reasons.push(`uncited ${cite}`);
      }
      if (ex.evidence.forbidBareAssertions === true) {
        const bare = trace.outcome.positions.filter((p) => !p.rationale || p.rationale.trim() === '');
        if (bare.length > 0) reasons.push(`${bare.length} bare assertion(s) without rationale`);
      }
      checks.push(check('evidence.chain', 'evidence', ex, reasons.length === 0, reasons.join('; ')));
    }
    if (ex.guardrails !== undefined) {
      const action = ex.guardrails.expectedHandling;
      const hits = trace.audit.filter((a) => a.decision.startsWith('guardrail-'));
      const escalated = trace.audit.some((a) => a.decision === 'interrupt-level-1' || a.decision === 'interrupt-level-2');
      const matched =
        action === undefined ||
        (action === 'pass' ? hits.length === 0 : action === 'escalate' ? escalated : hits.some((a) => a.decision === guardrailDecisionOf(action)));
      checks.push(check('guardrails.handling', 'guardrails', ex, matched, detailOf(hits.map((h) => h.decision))));
    }
    if (ex.budget !== undefined) {
      const branchCount = trace.outcome.branches.length;
      const reasons: string[] = [];
      if (ex.budget.maxBranches !== undefined && branchCount > ex.budget.maxBranches) {
        reasons.push(`${branchCount} branches > cap ${ex.budget.maxBranches}`);
      }
      checks.push(check('budget.branches', 'budget', ex, reasons.length === 0, reasons.join('; ')));
      if (ex.budget.maxCostTokens !== undefined) {
        // No cost source in the V1 trace (S9 wiring is V2); declare it rather
        // than guess a number.
        checks.push(check('budget.cost-tokens', 'budget', ex, true, 'not-assessable-in-v1: no cost ledger in trace'));
      }
    }
  }
  return { caseId: c.id, checks };
}

/** Aggregate a batch of scored cases into a metrics report (design-evals §4).
 *  Deterministic: input order does not change the report. */
export function summarizeEvalRun(results: readonly EvalResult[]): EvalMetricsReport {
  const byFamily: EvalMetricsReport['byFamily'] = {};
  for (const family of FAMILIES) byFamily[family] = { total: 0, passed: 0, blocked: 0 };
  let passed = 0;
  let failed = 0;
  let blocked = 0;
  let warned = 0;
  for (const r of results) {
    for (const check of r.checks) {
      const bucket = byFamily[check.family];
      if (bucket !== undefined) {
        bucket.total += 1;
        if (check.passed) bucket.passed += 1;
        if (!check.passed && check.severity === 'block') bucket.blocked += 1;
      }
      if (check.passed) {
        passed += 1;
      } else {
        failed += 1;
        if (check.severity === 'block') blocked += 1;
        if (check.severity === 'warn') warned += 1;
      }
    }
  }
  return { caseCount: results.length, passed, failed, blocked, warned, byFamily };
}

/** Detect regression of the current report against a pinned baseline
 *  (design-evals §4): a block-severity failure is always a regression; a
 *  family whose passed count shrank regresses as warn; a family whose blocked
 *  count grew regresses as block. */
export function diffAgainstBaseline(current: EvalMetricsReport, baseline: EvalMetricsReport): EvalRegression[] {
  const regressions: EvalRegression[] = [];
  for (const family of FAMILIES) {
    const cur = current.byFamily[family];
    const base = baseline.byFamily[family];
    if (cur === undefined || base === undefined) continue;
    if (cur.blocked > base.blocked) {
      regressions.push({ family, metric: 'blocked', previous: base.blocked, current: cur.blocked, severity: 'block' });
    } else if (cur.passed < base.passed) {
      regressions.push({ family, metric: 'passed', previous: base.passed, current: cur.passed, severity: 'warn' });
    }
  }
  return regressions;
}

function check(
  name: string,
  family: string,
  ex: EvalExpectation,
  passed: boolean,
  detail?: string,
): EvalCheck {
  return { name, family, passed, severity: ex.severity, ...(detail === undefined || detail === '' ? {} : { detail }) };
}

function detailOf(items: string[]): string {
  return items.length === 0 ? '' : items.join(', ');
}

/** ContentHandling action -> audit decision name (S8): the audit suffix is the
 *  past participle, not the action verb. */
function guardrailDecisionOf(action: Exclude<ContentHandling['action'], 'pass' | 'escalate'>): AuditEntry['decision'] {
  switch (action) {
    case 'annotate':
      return 'guardrail-annotated';
    case 'redact':
      return 'guardrail-redacted';
    case 'refuse':
      return 'guardrail-refused';
  }
}
