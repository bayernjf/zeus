import { DecisionBackendFailure } from '../decision/types.js';
import type { ChoiceResult, DecisionBackend, DecisionBackendError } from '../decision/types.js';
import { statusFromBranches } from './resolution.js';
import type { Conflict, FanOutResult, JudgeReview, Position } from './types.js';

/**
 * E1.3 LLM-as-judge / adversarial review. Distinct from arbitration
 * (arbitration.ts), which only fires when the deterministic rule CANNOT
 * conclude and asks the backend to settle the split. Judge review fires AFTER
 * the rule already reached a conclusion over >=2 competing stances and asks an
 * independent backend to review them:
 *  - a gated recommendation agreeing with the rule is recorded as endorsement;
 *  - a calibrated, high-confidence recommendation that DISAGREES flips the
 *    intent back to needs-driver and opens a 'judge-review' conflict so the
 *    driver settles it through the existing E6.2 loop (the judge never silently
 *    overrides the rule, and a weak majority is never silently accepted);
 *  - low confidence / uncalibrated (LLM self-report) without explicit
 *    permission / backend failure only records the attempt — the model is never
 *    a hard dependency and the rule conclusion stands.
 *
 * Pure and async (one backend call), unit-testable with an injected backend.
 */
export type JudgeDecisionInput = {
  result: FanOutResult;
  backend: DecisionBackend;
  /** Confidence gate for a recommendation to count (default 0.8). */
  threshold?: number;
  /** Permit uncalibrated (LLM) confidence to count (default false). */
  allowUncalibrated?: boolean;
  /** A gated disagreement escalates to the driver (default true). */
  escalateOnDisagreement?: boolean;
  stateKeys?: string[];
  maxWaitMs?: number;
  now: () => Date;
};

const DEFAULT_THRESHOLD = 0.8;

function distinctStances(positions: Position[]): string[] {
  return [...new Set(positions.map(position => position.stance))].sort((a, b) => a.localeCompare(b));
}

function supporters(result: FanOutResult, stance: string): string[] {
  return result.positions.filter(position => position.stance === stance).map(position => position.vassal);
}

function withReview(result: FanOutResult, judgeReview: JudgeReview): FanOutResult {
  return { ...result, judgeReview };
}

export async function judgeDecision(input: JudgeDecisionInput): Promise<FanOutResult> {
  const { result, backend, now } = input;
  const decidedAt = now().toISOString();
  const auditBase = { backend: backend.kind, model: backend.model, decidedAt };

  // Only review a rule that already concluded; an inconclusive rule goes
  // through arbitration instead. A backend-arbitrated conclusion is not
  // re-judged by the same backend (it would be reviewing its own verdict).
  if (result.decision.conclusion === null) {
    return withReview(result, { judged: false, reason: 'rule-inconclusive', ...auditBase });
  }
  if (result.backendArbitration?.concluded) {
    return withReview(result, { judged: false, reason: 'rule-inconclusive', ...auditBase });
  }
  const options = distinctStances(result.positions);
  if (options.length < 2) {
    return withReview(result, { judged: false, reason: 'single-stance', ...auditBase });
  }

  const threshold = input.threshold ?? DEFAULT_THRESHOLD;
  const state = {
    rule: result.decision.rule,
    ruleConclusion: result.decision.conclusion,
    ruleReason: result.decision.reason,
    positions: result.positions.map(position => ({
      vassal: position.vassal,
      stance: position.stance,
      ...(position.rationale ? { rationale: position.rationale } : {}),
      ...(position.weight !== undefined ? { weight: position.weight } : {}),
    })),
  };

  let review: ChoiceResult;
  try {
    review = await backend.choice({
      question:
        'The aggregation rule already produced a conclusion. Independently review the competing vassal stances as an adversarial judge, and choose the stance that should be accepted; disagree with the rule when the evidence warrants.',
      instructions:
        'Weigh every vassal rationale against the rule conclusion; pick the best-supported stance; express calibrated uncertainty.',
      state,
      options,
      runId: result.runId,
      realm: result.realm,
      ...(input.maxWaitMs !== undefined ? { maxWaitMs: input.maxWaitMs } : {}),
    });
  } catch (error) {
    const backendError: DecisionBackendError =
      error instanceof DecisionBackendFailure
        ? error.toJSON()
        : { code: 'unavailable', message: error instanceof Error ? error.message : 'judge review failed' };
    return withReview(result, { judged: false, reason: 'backend-failure', error: backendError, ...auditBase });
  }

  const common = {
    confidence: review.confidence,
    calibrated: review.calibrated,
    probabilities: review.probabilities,
    ...auditBase,
  };
  if (review.confidence < threshold) {
    return withReview(result, { judged: false, reason: 'below-threshold', ...common });
  }
  if (!review.calibrated && !input.allowUncalibrated) {
    return withReview(result, { judged: false, reason: 'uncalibrated', ...common });
  }

  const ruleConclusion = result.decision.conclusion;
  if (review.choice === ruleConclusion) {
    return withReview(result, {
      judged: true,
      recommended: review.choice,
      agreesWithRule: true,
      ...common,
    });
  }

  const escalate = input.escalateOnDisagreement !== false;
  const judgeReview: JudgeReview = {
    judged: true,
    recommended: review.choice,
    agreesWithRule: false,
    escalated: escalate,
    ...common,
  };
  if (!escalate) return withReview(result, judgeReview);

  const conflictStances = [
    {
      stance: ruleConclusion,
      vassals: supporters(result, ruleConclusion),
      summary: `rule ${result.decision.rule} conclusion (${result.decision.reason})`,
    },
    {
      stance: review.choice,
      vassals: supporters(result, review.choice),
      summary: `judge ${backend.kind}/${backend.model} recommendation (confidence ${review.confidence})`,
    },
  ].sort((a, b) => a.stance.localeCompare(b.stance));
  const conflict: Conflict = {
    kind: 'judge-review',
    stances: conflictStances,
    reason: `high-confidence judge review (${backend.kind}/${backend.model}, confidence ${review.confidence}) disagrees with rule conclusion "${ruleConclusion}"`,
  };
  return {
    ...result,
    conflicts: [...result.conflicts, conflict],
    status: statusFromBranches(result.branches, true),
    judgeReview,
  };
}
