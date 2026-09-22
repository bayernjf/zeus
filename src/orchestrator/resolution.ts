import { aggregate, extractPositions } from './aggregate.js';
import { detectConflicts } from './conflict.js';
import { mergeBranches } from './merge.js';
import type {
  BranchOutcome,
  DriverResolution,
  FanOutResult,
  FanOutStatus,
  FanOutRequest,
} from './types.js';

/**
 * E6.2 write-back: apply the driver's conflict settlement to a stored fan-out
 * result. Pure function — the orchestrator/persistence layer stores what it returns.
 * The accepted stance becomes the decision conclusion; the conflict is cleared
 * and status is recomputed from branches (a fully-successful intent completes,
 * a partially-failed one is 'partial'). The original positions are preserved so
 * the human override stays auditable.
 */
export function applyConflictResolution(result: FanOutResult, driver: Omit<DriverResolution, 'decidedAt'> & { decidedAt?: string }): FanOutResult {
  if (result.status !== 'needs-driver') {
    throw new Error(`intent ${result.intentId} is ${result.status}; only needs-driver intents accept a driver decision`);
  }
  const conflict = result.conflicts.find(c => c.stances.some(s => s.stance === driver.stance));
  if (!conflict) {
    const options = result.conflicts.flatMap(c => c.stances.map(s => s.stance));
    throw new Error(`stance "${driver.stance}" is not among the conflict options: ${options.join(', ')}`);
  }
  const supporters = conflict.stances.find(s => s.stance === driver.stance)?.vassals ?? [];
  const resolution: DriverResolution = {
    escalationId: driver.escalationId,
    stance: driver.stance,
    ...(driver.note ? { note: driver.note } : {}),
    decidedAt: driver.decidedAt ?? new Date().toISOString(),
  };
  return {
    ...result,
    decision: {
      ...result.decision,
      conclusion: driver.stance,
      reason: `driver-settled via escalation ${driver.escalationId}: ${driver.stance} (rule could not conclude: ${result.decision.reason})`,
      margin: { winner: driver.stance, winnerCount: supporters.length, total: result.positions.length },
    },
    conflicts: [],
    status: statusFromBranches(result.branches, false),
    driverResolution: resolution,
  };
}

/** Recompute the derived parts of a result after branches changed (E6.3 re-dispatch). */
export function recomputeResult(
  previous: FanOutResult,
  branches: BranchOutcome[],
  aggregation: FanOutRequest['aggregation'],
  now: () => Date
): FanOutResult {
  const positions = extractPositions(branches);
  const decision = aggregate(positions, aggregation);
  const conflicts = detectConflicts(positions, decision);
  return {
    ...previous,
    branches,
    stream: mergeBranches(branches),
    positions,
    decision,
    conflicts,
    status: statusFromBranches(branches, conflicts.length > 0),
    createdAt: previous.createdAt,
  };
}

export function statusFromBranches(branches: BranchOutcome[], hasUnresolvedConflict: boolean): FanOutStatus {
  const succeeded = branches.filter(branch => branch.ok);
  if (succeeded.length === 0) return 'failed';
  if (hasUnresolvedConflict) return 'needs-driver';
  if (succeeded.length < branches.length) return 'partial';
  return 'completed';
}
