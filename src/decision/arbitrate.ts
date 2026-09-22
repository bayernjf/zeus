import type { RealmType } from '../a2a/types.js';
import type { DecisionBackend, DecisionBackendError, DecisionBackendKind } from './types.js';
import { DecisionBackendFailure } from './types.js';

/**
 * Rule-arbitration helper (design §3.1): when the pure aggregation rule cannot
 * conclude (tie / no majority / below threshold), optionally ask a decision
 * backend for a fast arbitration. This is the ONLY model touchpoint in the
 * aggregation path, and it is strictly gated:
 *  - a calibrated decision model may conclude when confidence >= threshold;
 *  - an LLM's self-reported confidence (calibrated:false) does NOT conclude
 *    unless allowUncalibrated is explicitly set (low-stakes contexts only);
 *  - any backend error/timeout/low confidence returns concluded:false so the
 *    caller escalates to the human driver — the model is never a hard dependency.
 */

export type SplitStance = {
  stance: string;
  vassals: string[];
  summary?: string;
};

export type ArbitrateInput = {
  backend: DecisionBackend;
  /** The distinct stances the rule could not resolve (>=2). */
  stances: SplitStance[];
  runId: string;
  realm: RealmType;
  /** Why the rule could not conclude; included in the decision context. */
  ruleReason: string;
  threshold?: number;
  /** Permit uncalibrated (LLM self-reported) confidence to auto-conclude. Default false. */
  allowUncalibrated?: boolean;
  stateKeys?: string[];
  maxWaitMs?: number;
};

export type ArbitrateOutcome = {
  concluded: boolean;
  conclusion: string | null;
  confidence?: number;
  calibrated?: boolean;
  backend?: DecisionBackendKind;
  model?: string;
  error?: DecisionBackendError;
};

const DEFAULT_THRESHOLD = 0.8;

export async function arbitrateSplit(input: ArbitrateInput): Promise<ArbitrateOutcome> {
  const options = input.stances.map(stance => stance.stance);
  if (options.length < 2) {
    return { concluded: false, conclusion: null };
  }
  const threshold = input.threshold ?? DEFAULT_THRESHOLD;
  const state = {
    ruleReason: input.ruleReason,
    stances: input.stances.map(stance => ({
      stance: stance.stance,
      vassals: stance.vassals,
      ...(stance.summary ? { summary: stance.summary } : {}),
    })),
  };
  try {
    const result = await input.backend.choice({
      question: 'The aggregation rule could not conclude. Which stance should be accepted as the decision?',
      instructions:
        input.ruleReason || 'Choose the stance best supported by the vassal positions; express calibrated uncertainty.',
      state,
      options,
      runId: input.runId,
      realm: input.realm,
      ...(input.maxWaitMs !== undefined ? { maxWaitMs: input.maxWaitMs } : {}),
    });
    if (result.confidence < threshold) {
      return { concluded: false, conclusion: null, confidence: result.confidence, calibrated: result.calibrated, backend: input.backend.kind, model: input.backend.model };
    }
    if (!result.calibrated && !input.allowUncalibrated) {
      return { concluded: false, conclusion: null, confidence: result.confidence, calibrated: false, backend: input.backend.kind, model: input.backend.model };
    }
    return {
      concluded: true,
      conclusion: result.choice,
      confidence: result.confidence,
      calibrated: result.calibrated,
      backend: input.backend.kind,
      model: input.backend.model,
    };
  } catch (error) {
    if (error instanceof DecisionBackendFailure) {
      return { concluded: false, conclusion: null, backend: input.backend.kind, model: input.backend.model, error: error.toJSON() };
    }
    return {
      concluded: false,
      conclusion: null,
      backend: input.backend.kind,
      model: input.backend.model,
      error: { code: 'unavailable', message: error instanceof Error ? error.message : 'arbitration failed' },
    };
  }
}
