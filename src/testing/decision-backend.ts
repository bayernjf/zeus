// design-agent-testing §5 V2: scripted DecisionBackend. A deterministic
// backend on the same port as the Jev and LLM adapters, so S9 cost, S4
// circuit-breaking and S7 eval runs can drive decision paths without a
// network or a model. Results are fixed or scripted per call; latency and
// failure are configurable; every call is recorded. Cost accounting lives on
// the S9 ledger, not on the decision result, so this backend carries no cost
// field (design-decision-backend keeps DecisionTrace as the only cost site).
// The module is framework-free (no vitest imports) so scripts/*.mjs can use
// the shipped build just like the rest of src/testing.

import { DecisionBackendFailure } from '../decision/types.js';
import type {
  ChoiceRequest,
  ChoiceResult,
  DecisionBackend,
  DecisionBackendErrorCode,
  NoulRequest,
  NoulResult,
  ScoreRequest,
  ScoreResult,
} from '../decision/types.js';

export type ScriptedOptions = {
  kind?: DecisionBackend['kind'];
  model?: string;
  /** Delay before each method resolves/rejects (ms). */
  delayMs?: number;
  /** Every call fails with this folded error code after the configured delay. */
  failWith?: DecisionBackendErrorCode;
  noul?: ScriptedMethod<NoulRequest, NoulResult>;
  choice?: ScriptedMethod<ChoiceRequest, ChoiceResult>;
  score?: ScriptedMethod<ScoreRequest, ScoreResult>;
};

/** A fixed result, a queue of results, or a function of (request, call index). */
export type ScriptedMethod<Request, Result> =
  | Result
  | Result[]
  | ((request: Request, callIndex: number) => Result | Promise<Result>);

export type ScriptedCall<Request> = { callIndex: number; request: Request };

export type ScriptedDecisionBackend = DecisionBackend & {
  readonly calls: {
    noul: ScriptedCall<NoulRequest>[];
    choice: ScriptedCall<ChoiceRequest>[];
    score: ScriptedCall<ScoreRequest>[];
  };
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function resolveScripted<Request, Result>(
  scripted: ScriptedMethod<Request, Result> | undefined,
  fallback: Result,
  request: Request,
  callIndex: number,
): Result | Promise<Result> {
  if (scripted === undefined) return fallback;
  if (typeof scripted === 'function') {
    return (scripted as (request: Request, callIndex: number) => Result | Promise<Result>)(request, callIndex);
  }
  if (Array.isArray(scripted)) {
    const picked = scripted[Math.min(callIndex, scripted.length - 1)];
    if (picked === undefined) throw new Error('scripted decision backend: empty result queue');
    return picked;
  }
  return scripted;
}

/** Build a scripted decision backend. Methods with no script answer with a
 *  neutral fixed result, so a test that only drives `choice` does not have to
 *  construct the other two answers. */
export function createScriptedDecisionBackend(options: ScriptedOptions = {}): ScriptedDecisionBackend {
  const kind = options.kind ?? 'decision-model';
  const calibrated = kind === 'decision-model';
  const calls: ScriptedDecisionBackend['calls'] = { noul: [], choice: [], score: [] };

  const run = async <Request, Result>(
    log: ScriptedCall<Request>[],
    scripted: ScriptedMethod<Request, Result> | undefined,
    fallback: Result,
    request: Request,
  ): Promise<Result> => {
    const callIndex = log.length;
    log.push({ callIndex, request });
    if (options.delayMs !== undefined && options.delayMs > 0) await sleep(options.delayMs);
    if (options.failWith !== undefined) {
      throw new DecisionBackendFailure(options.failWith, `scripted failure: ${options.failWith}`);
    }
    return resolveScripted(scripted, fallback, request, callIndex);
  };

  return {
    kind,
    model: options.model ?? (kind === 'llm' ? 'scripted-llm' : 'scripted-jev'),
    noul: (request) =>
      run<NoulRequest, NoulResult>(
        calls.noul,
        options.noul,
        { probability: 0.5, confidence: 0.5, calibrated, decisionAt: 't0' },
        request,
      ),
    choice: (request) =>
      run<ChoiceRequest, ChoiceResult>(
        calls.choice,
        options.choice,
        { choice: '', probabilities: {}, confidence: 0, calibrated, decisionAt: 't0' },
        request,
      ),
    score: (request) =>
      run<ScoreRequest, ScoreResult>(
        calls.score,
        options.score,
        { score: 50, distribution: {}, confidence: 0, calibrated, decisionAt: 't0' },
        request,
      ),
    calls,
  };
}
