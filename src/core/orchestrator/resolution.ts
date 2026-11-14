import { aggregate, extractPositions } from './aggregate.js';
import { DomainError, type DomainErrorKind } from '../../util/domain-error.js';
import { detectConflicts } from './conflict.js';
import { mergeBranches } from './merge.js';
import type {
  BranchOutcome,
  OperatorResolution,
  FanOutResult,
  FanOutStatus,
  FanOutRequest,
} from './types.js';

/**
 * E6.2 write-back: apply the operator's conflict settlement to a stored fan-out
 * result. Pure function — the orchestrator/persistence layer stores what it returns.
 * The accepted stance becomes the decision conclusion; the conflict is cleared
 * and status is recomputed from branches (a fully-successful intent completes,
 * a partially-failed one is 'partial'). The original positions are preserved so
 * the human override stays auditable.
 */
export class IntentResolutionError extends DomainError {
  constructor(message: string, kind: DomainErrorKind = 'invalid') {
    super(message, kind);
  }
}

export function applyConflictResolution(result: FanOutResult, operator: Omit<OperatorResolution, 'decidedAt'> & { decidedAt?: string }): FanOutResult {
  if (result.status !== 'needs-operator') {
    throw new IntentResolutionError(`intent ${result.intentId} is ${result.status}; only needs-operator intents accept a operator decision`, 'conflict');
  }
  const conflict = result.conflicts.find(c => c.stances.some(s => s.stance === operator.stance));
  if (!conflict) {
    const options = result.conflicts.flatMap(c => c.stances.map(s => s.stance));
    throw new IntentResolutionError(`stance "${operator.stance}" is not among the conflict options: ${options.join(', ')}`);
  }
  const supporters = conflict.stances.find(s => s.stance === operator.stance)?.executors ?? [];
  const resolution: OperatorResolution = {
    escalationId: operator.escalationId,
    stance: operator.stance,
    ...(operator.note ? { note: operator.note } : {}),
    decidedAt: operator.decidedAt ?? new Date().toISOString(),
  };
  return {
    ...result,
    decision: {
      ...result.decision,
      conclusion: operator.stance,
      reason: `operator-settled via escalation ${operator.escalationId}: ${operator.stance} (rule could not conclude: ${result.decision.reason})`,
      margin: { winner: operator.stance, winnerCount: supporters.length, total: result.positions.length },
    },
    conflicts: [],
    status: statusFromBranches(result.branches, false),
    operatorResolution: resolution,
  };
}

/** Recompute the derived parts of a result after branches changed (E6.3 re-dispatch). */
export function recomputeResult(
  previous: FanOutResult,
  branches: BranchOutcome[],
  aggregation: FanOutRequest['aggregation'],
  _now: () => Date
): FanOutResult {
  const positions = extractPositions(branches);
  const decision = aggregate(positions, aggregation);
  const conflicts = detectConflicts(positions, decision);
  const recomputed: FanOutResult = {
    ...previous,
    branches,
    stream: mergeBranches(branches),
    positions,
    decision,
    conflicts,
    status: statusFromBranches(branches, conflicts.length > 0),
    createdAt: previous.createdAt,
  };
  // The settlement records describe the superseded branch set. Keeping them
  // would leave a result whose new decision contradicts its recorded
  // arbitration/judge/operator settlement, so drop them; the caller re-derives
  // them (maybeArbitrate/maybeJudge) or the intent returns to the operator.
  delete recomputed.operatorResolution;
  delete recomputed.judgeReview;
  delete recomputed.backendArbitration;
  return recomputed;
}

export function statusFromBranches(branches: BranchOutcome[], hasUnresolvedConflict: boolean): FanOutStatus {
  const succeeded = branches.filter(branch => branch.ok);
  if (succeeded.length === 0) {
    // C-28: an intent whose every branch the operator cancelled is not a failure.
    // Collapsing it into 'failed' left cancellation indistinguishable from a real
    // fault (only recoverable by reading branch.state), so the operator was sent
    // to debug a executor that never ran. A cancellation mixed with a genuine
    // failure is still 'failed' - something did go wrong.
    if (branches.length > 0 && branches.every(branch => branch.state === 'canceled')) return 'canceled';
    return 'failed';
  }
  if (hasUnresolvedConflict) return 'needs-operator';
  if (succeeded.length < branches.length) return 'partial';
  return 'completed';
}
