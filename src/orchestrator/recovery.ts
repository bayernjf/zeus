// design-long-running (tech map S13): crash-recovery classification and the
// minimal recoverable checkpoint projection. V1 is the pure classifier only
// (design-long-running §5): no boot sequence is touched, no periodic
// checkpoint is scheduled — every input is caller-supplied, so the verdicts
// are fully unit-testable and reproducible.
//
// Hard invariants (design-long-running §3):
//  1. execute branches default to awaiting the operator — an automatic resume
//     never re-sends an external write without a verifiable idempotency
//     declaration and no unconsumed delegation ticket;
//  2. the recovery itself is re-entrant — reclassifying after another crash
//     must not double-dispatch (auto-resume re-checks the idempotency key and
//     in-flight table at the same gate as F2);
//  3. no running zombie — every unsettled intent falls into exactly one of the
//     four verdict classes.

import type { OrchestratorSnapshot } from './orchestrator.js';
import type { FanOutStatus } from './types.js';
import { DEFAULT_MAX_CONSECUTIVE_FAILURES } from './termination.js';

/** The verdict for one unsettled branch after a restart (design-long-running
 *  §3): auto-resume / await-operator / settle-failed / settle-canceled. */
export type RecoveryVerdict =
  | { kind: 'auto-resume'; resumeNo: number }
  | { kind: 'await-operator'; level: 1 | 2; reason: string }
  | { kind: 'settle-failed'; reason: string }
  | { kind: 'settle-canceled' };

/** Failure facts for the recovery classifier (design-long-running §3 / §4).
 *  `crashedForMs` and `resumesSoFar` are optional — the classifier must reach
 *  a verdict with or without them. */
export type RecoverableBranch = {
  mode: 'plan' | 'execute';
  skillDeclaresIdempotent: boolean;
  /** F2 zero-outbound replay still covers this branch. */
  idempotencyKeyReusable: boolean;
  /** An unconsumed execute delegation ticket exists — automatic resume must
   *  not spend it silently. */
  unconsumedDelegationNonce: boolean;
  lastOutcome?: 'failed' | 'input-required' | 'running';
  /** S11 recovery chain still has a fallback provider. */
  hasFallbackProvider: boolean;
  /** S4 consecutive-failure circuit state. */
  circuitOpen: boolean;
  /** S9 budget exhausted for the intent. */
  budgetExhausted: boolean;
  /** A cancel was issued before the crash and never settled. */
  cancelIssued?: boolean;
  /** Number of resumes already on the runId lineage. */
  resumesSoFar?: number;
  /** Milliseconds since the crash; compared only when `maxAutoResumeMs` is set. */
  crashedForMs?: number;
};

/**
 * Classify one unsettled branch after a restart (design-long-running §3):
 *
 *   1. an unsettled cancel settles as canceled;
 *   2. an open circuit settles failed — the S4 breaker governs the automatic
 *      path, so an auto-run branch must not resume through it;
 *   3. a failed branch with no S11 fallback settles failed; with a fallback it
 *      waits for the operator to decide whether to re-dispatch;
 *   4. an exhausted budget, a pending input-required, an unconsumed delegation
 *      ticket, a non-reusable idempotency key, a non-idempotent execute
 *      branch, or a crash longer than `maxAutoResumeMs` all await the
 *      operator;
 *   5. everything else (a clean running plan/idempotent branch) resumes
 *      automatically — the fallback that guarantees no branch is left
 *      unclassified.
 */
export function classifyRecoverable(branch: RecoverableBranch, maxAutoResumeMs?: number): RecoveryVerdict {
  if (branch.cancelIssued) return { kind: 'settle-canceled' };
  if (branch.circuitOpen) return { kind: 'settle-failed', reason: 'circuit-open' };

  if (branch.lastOutcome === 'failed') {
    if (!branch.hasFallbackProvider) return { kind: 'settle-failed', reason: 'no-fallback-provider' };
    return { kind: 'await-operator', level: 1, reason: 'failed-branch-needs-re-dispatch-decision' };
  }

  if (branch.budgetExhausted) return { kind: 'await-operator', level: 1, reason: 'budget-exhausted' };
  if (branch.lastOutcome === 'input-required') return { kind: 'await-operator', level: 1, reason: 'pending-input' };
  if (branch.unconsumedDelegationNonce) return { kind: 'await-operator', level: 1, reason: 'delegation-ticket-pending' };
  if (!branch.idempotencyKeyReusable) return { kind: 'await-operator', level: 1, reason: 'idempotency-key-not-reusable' };
  if (branch.mode === 'execute' && !branch.skillDeclaresIdempotent) {
    return { kind: 'await-operator', level: 1, reason: 'non-idempotent-execute' };
  }
  if (maxAutoResumeMs !== undefined && branch.crashedForMs !== undefined && branch.crashedForMs > maxAutoResumeMs) {
    return { kind: 'await-operator', level: 1, reason: 'crashed-too-long' };
  }

  return { kind: 'auto-resume', resumeNo: (branch.resumesSoFar ?? 0) + 1 };
}

/** One recoverable intent line of the minimal checkpoint (design-long-running
 *  §3.1): current state plus the recovery-relevant declarations. Branch
 *  intermediate products are excluded by design (branch granularity is the A2A
 *  protocol boundary). */
export type RecoveryCheckpoint = {
  takenAt: string;
  intents: Array<{
    intentId: string;
    status: FanOutStatus;
    branch: RecoverableBranch;
  }>;
};

/**
 * Project the minimal recoverable checkpoint from the persisted orchestrator
 * snapshot (design-long-running §4). Pure projection: nothing is written, the
 * state layer owns persistence.
 *
 * The snapshot carries settled intents and the per-intent termination guards,
 * but not the runtime-only declarations (dispatch mode, idempotency statement,
 * delegation nonces). For those the projection takes the conservative default —
 * execute-like branches project `mode: 'execute'` with no idempotency
 * declaration, so the classifier sends them to the operator instead of
 * auto-resuming an external write. The circuit is projected from the S4
 * streak against the structural default threshold.
 */
export function computeCheckpoint(snapshot: OrchestratorSnapshot): RecoveryCheckpoint {
  return {
    takenAt: new Date().toISOString(),
    intents: snapshot.intents.map((intent) => {
      const budget = snapshot.budgets?.[intent.intentId];
      const last = intent.branches[intent.branches.length - 1];
      const lastOutcome = last
        ? last.state === 'input-required'
          ? ('input-required' as const)
          : last.ok
            ? ('running' as const)
            : ('failed' as const)
        : undefined;
      return {
        intentId: intent.intentId,
        status: intent.status,
        branch: {
          mode: 'execute',
          skillDeclaresIdempotent: false,
          idempotencyKeyReusable: false,
          unconsumedDelegationNonce: false,
          ...(lastOutcome === undefined ? {} : { lastOutcome }),
          hasFallbackProvider: false,
          circuitOpen: (budget?.failureStreak ?? 0) >= DEFAULT_MAX_CONSECUTIVE_FAILURES,
          budgetExhausted: false,
          cancelIssued: intent.status === 'canceled',
        },
      };
    }),
  };
}
