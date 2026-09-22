import { arbitrateSplit } from '../decision/arbitrate.js';
import type { DecisionBackend } from '../decision/types.js';
import { statusFromBranches } from './resolution.js';
import type { BackendArbitration, FanOutResult } from './types.js';

/**
 * S2 critic wiring: after the deterministic aggregation rule ends in
 * needs-driver, optionally consult a model-agnostic decision backend. A
 * calibrated, high-confidence arbitration concludes the intent (the conflict is
 * cleared, original positions stay auditable). Anything else (low confidence,
 * uncalibrated LLM without explicit permission, backend failure) leaves the
 * split unresolved for the human driver and only records the attempt.
 *
 * Pure function — the Orchestrator stores what it returns; unit-testable without
 * the dispatch stack.
 */
export type ArbitrateConflictInput = {
  result: FanOutResult;
  backend: DecisionBackend;
  threshold?: number;
  allowUncalibrated?: boolean;
  maxWaitMs?: number;
  stateKeys?: string[];
  now: () => Date;
};

export async function arbitrateConflict(input: ArbitrateConflictInput): Promise<FanOutResult> {
  const { result, backend, now } = input;
  if (result.status !== 'needs-driver' || result.conflicts.length === 0) return result;

  const conflict = result.conflicts[0];
  const outcome = await arbitrateSplit({
    backend,
    stances: conflict.stances,
    runId: result.runId,
    realm: result.realm,
    ruleReason: conflict.reason,
    ...(input.threshold !== undefined ? { threshold: input.threshold } : {}),
    ...(input.allowUncalibrated !== undefined ? { allowUncalibrated: input.allowUncalibrated } : {}),
    ...(input.maxWaitMs !== undefined ? { maxWaitMs: input.maxWaitMs } : {}),
    ...(input.stateKeys ? { stateKeys: input.stateKeys } : {}),
  });
  const decidedAt = now().toISOString();

  if (!outcome.concluded || outcome.conclusion === null) {
    const record: BackendArbitration = {
      concluded: false,
      ...(outcome.confidence !== undefined ? { confidence: outcome.confidence } : {}),
      ...(outcome.calibrated !== undefined ? { calibrated: outcome.calibrated } : {}),
      ...(outcome.backend ? { backend: outcome.backend } : {}),
      ...(outcome.model ? { model: outcome.model } : {}),
      ...(outcome.error ? { error: outcome.error } : {}),
      decidedAt,
    };
    return { ...result, backendArbitration: record };
  }

  const supporters = conflict.stances.find(stance => stance.stance === outcome.conclusion)?.vassals ?? [];
  const record: BackendArbitration = {
    concluded: true,
    conclusion: outcome.conclusion,
    ...(outcome.confidence !== undefined ? { confidence: outcome.confidence } : {}),
    ...(outcome.calibrated !== undefined ? { calibrated: outcome.calibrated } : {}),
    ...(outcome.backend ? { backend: outcome.backend } : {}),
    ...(outcome.model ? { model: outcome.model } : {}),
    decidedAt,
  };
  return {
    ...result,
    decision: {
      ...result.decision,
      conclusion: outcome.conclusion,
      reason: `backend-arbitrated via ${outcome.backend}/${outcome.model}: "${outcome.conclusion}" (rule could not conclude: ${result.decision.reason})`,
      margin: { winner: outcome.conclusion, winnerCount: supporters.length, total: result.positions.length },
    },
    conflicts: [],
    status: statusFromBranches(result.branches, false),
    backendArbitration: record,
  };
}
