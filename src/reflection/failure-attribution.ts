/**
 * Execution-after reflection, read-only half (deferred #40, first suggested
 * step). Aggregate failures from the audit trail and, optionally, replayed
 * decisions, into a post-mortem summary. This module is deliberately pure:
 * it never writes back to memory/rules/thresholds — the write-back face waits
 * for real execution-agent failure samples (deferred #40 trigger).
 *
 * The unit of analysis is the audit decision (E4.7). "Failure" means a branch
 * that did not complete as a healthy execution: transport failure, driver
 * abort, a refusal (skill/policy/unknown/revoked), an execution-delegation
 * denial, or an ack breach. Governance/state events (revocations, grants,
 * watch lifecycle, escalation outcomes) are neither success nor failure — they
 * describe the environment, not a branch outcome.
 *
 * Patterns are the read-only answer to deferred #40's question "is there a
 * stable law worth writing back": they never write, they only mark.
 */

import type { AuditDecision, AuditEntry } from '../dispatch/dispatcher.js';

export type FailureCategory =
  | 'dispatch'
  | 'abort'
  | 'refused-skill'
  | 'refused-policy'
  | 'refused-unknown'
  | 'refused-revoked'
  | 'delegation'
  | 'ack';

export type CategoryCounts = Partial<Record<FailureCategory, number>>;

export type VassalAttribution = {
  vassal: string;
  /** Failure entries for this vassal. */
  failures: number;
  /** Entries carrying this vassal (success + failure; governance events excluded). */
  total: number;
  /** failures / total; 0 when total is 0. */
  rate: number;
  byCategory: CategoryCounts;
  /** Non-empty failure detail values, deduplicated and capped (samples only). */
  sampleReasons: string[];
};

export type FailurePattern = {
  kind: 'vassal-concentrated' | 'category-concentrated' | 'reason-repeated';
  target: string;
  confidence: 'stable' | 'suggestive';
  evidence: string[];
  /** true only for 'stable' — the only read-only marker worth taking to the
   *  write-back design (never writes anything itself). */
  writebackCandidate: boolean;
};

export type FailureAttribution = {
  /** Inclusive ISO time span of the analysed entries; null when input is empty. */
  window: { from: string; to: string } | null;
  totals: {
    entries: number;
    failures: number;
    failureRate: number;
  };
  byCategory: CategoryCounts;
  byVassal: VassalAttribution[];
  patterns: FailurePattern[];
};

const FAILURE_CATEGORY: Partial<Record<AuditDecision, FailureCategory>> = {
  'dispatch-failed': 'dispatch',
  'branch-aborted': 'abort',
  'refused-skill-uninstalled': 'refused-skill',
  'refused-no-active-provider': 'refused-skill',
  'refused-realm-policy': 'refused-policy',
  'refused-data-policy': 'refused-policy',
  'domain-refused': 'refused-policy',
  'refused-unknown-vassal': 'refused-unknown',
  'refused-revoked': 'refused-revoked',
  'execution-delegation-denied': 'delegation',
  'delegation-limit-exceeded': 'delegation',
  'sla-ack-breached': 'ack',
};

/** Decisions that describe a healthy branch outcome. */
const SUCCESS_DECISIONS: ReadonlySet<AuditDecision> = new Set([
  'dispatched',
  'domain-read',
  'realm-write',
]);

function classify(decision: AuditDecision): { kind: 'ok' | 'fail' | 'skip'; category?: FailureCategory } {
  const category = FAILURE_CATEGORY[decision];
  if (category !== undefined) return { kind: 'fail', category };
  if (SUCCESS_DECISIONS.has(decision)) return { kind: 'ok' };
  return { kind: 'skip' };
}

export function attributeFailures(entries: AuditEntry[]): FailureAttribution {
  const byCategory: CategoryCounts = {};
  const perVassal = new Map<string, { failures: number; total: number; byCategory: CategoryCounts; reasons: string[] }>();
  let failures = 0;
  let from: string | null = null;
  let to: string | null = null;

  const touchWindow = (ts: string): void => {
    if (from === null || ts < from) from = ts;
    if (to === null || ts > to) to = ts;
  };

  for (const entry of entries) {
    touchWindow(entry.ts);
    const { kind, category } = classify(entry.decision);
    if (kind === 'skip') continue;
    const bucket = perVassal.get(entry.vassal) ?? {
      failures: 0,
      total: 0,
      byCategory: {},
      reasons: [],
    };
    bucket.total += 1;
    if (kind === 'fail' && category !== undefined) {
      failures += 1;
      bucket.failures += 1;
      bucket.byCategory[category] = (bucket.byCategory[category] ?? 0) + 1;
      byCategory[category] = (byCategory[category] ?? 0) + 1;
      if (entry.detail && !bucket.reasons.includes(entry.detail)) bucket.reasons.push(entry.detail);
    }
    perVassal.set(entry.vassal, bucket);
  }

  const byVassal: VassalAttribution[] = [...perVassal.entries()]
    .map(([vassal, b]) => ({
      vassal,
      failures: b.failures,
      total: b.total,
      rate: b.total === 0 ? 0 : b.failures / b.total,
      byCategory: b.byCategory,
      sampleReasons: b.reasons.slice(0, 5),
    }))
    .sort((a, b) => b.failures - a.failures || a.vassal.localeCompare(b.vassal));

  const patterns: FailurePattern[] = [];
  for (const v of byVassal) {
    if (v.failures < 2) continue;
    // reason-repeated: two or more failures with at most one distinct detail.
    if (v.sampleReasons.length <= 1 && v.failures >= 2 && v.sampleReasons.length >= 1) {
      patterns.push({
        kind: 'reason-repeated',
        target: v.vassal,
        confidence: 'stable',
        evidence: [`${v.failures} failures share reason "${v.sampleReasons[0]}"`],
        writebackCandidate: true,
      });
    }
    // vassal-concentrated: failures dominate this vassal's own entries.
    // stable needs both mass (>= 3) and share (>= 60%); suggestive also fires
    // on fewer failures when they already form a large share (>= 2 and 40%).
    if (v.failures >= 3 && v.rate >= 0.6) {
      patterns.push({
        kind: 'vassal-concentrated',
        target: v.vassal,
        confidence: 'stable',
        evidence: [`${v.failures}/${v.total} entries failed (${Math.round(v.rate * 100)}%)`],
        writebackCandidate: true,
      });
    } else if (v.failures >= 2 && v.rate >= 0.4) {
      patterns.push({
        kind: 'vassal-concentrated',
        target: v.vassal,
        confidence: 'suggestive',
        evidence: [`${v.failures}/${v.total} entries failed (${Math.round(v.rate * 100)}%)`],
        writebackCandidate: false,
      });
    }
  }
  for (const [category, count] of Object.entries(byCategory) as Array<[FailureCategory, number]>) {
    if (count >= 3 && failures > 0 && count / failures >= 0.5) {
      patterns.push({
        kind: 'category-concentrated',
        target: category,
        confidence: 'suggestive',
        evidence: [`${count}/${failures} failures are ${category}`],
        writebackCandidate: false,
      });
    }
  }
  // Deterministic order so the summary is stable across identical inputs.
  patterns.sort((a, b) => {
    const rank = (p: FailurePattern): number => (p.writebackCandidate ? 0 : 1);
    return rank(a) - rank(b) || a.kind.localeCompare(b.kind) || a.target.localeCompare(b.target);
  });

  return {
    window: from === null || to === null ? null : { from, to },
    totals: {
      entries: entries.length,
      failures,
      failureRate: entries.length === 0 ? 0 : failures / entries.length,
    },
    byCategory,
    byVassal,
    patterns,
  };
}

/** Convenience over a single replayed decision: derive its participants' failure
 *  entries so a caller can feed replayed branches into the same summarizer.
 *  Read-only; does not touch the kernel. */
export function participantsToEntries(
  participants: ReadonlyArray<{ vassal: string; ok: boolean; reason?: string; timedOut?: boolean }>,
  base: { ts: string; runId?: string; skill?: string },
): AuditEntry[] {
  return participants.map((p) => ({
    ts: base.ts,
    vassal: p.vassal,
    ...(base.runId !== undefined ? { runId: base.runId } : {}),
    ...(base.skill !== undefined ? { skill: base.skill } : {}),
    decision: p.ok ? 'dispatched' : p.timedOut ? 'sla-ack-breached' : 'dispatch-failed',
    ...(p.ok ? {} : { detail: p.reason ?? 'branch failed' }),
  }));
}
