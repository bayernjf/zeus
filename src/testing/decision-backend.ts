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
  DecisionBackendError,
  DecisionBackendErrorCode,
  DecisionTrace,
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
  /** TracePort v1 §2: the token usage every call reports through
   *  DecisionTrace (design-decision-backend keeps DecisionTrace the only cost
   *  site). Absent, calls emit traces without a usage block — exactly what a
   *  provider that returned no usage block would produce. */
  usage?: { inputTokens: number; outputTokens: number; reasoningTokens?: number };
  /** Receives one DecisionTrace per scripted call (E1.6 replayability, same
   *  hook the real adapters expose). */
  onTrace?: (trace: DecisionTrace) => void;
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
 *  construct the other two answers. When `onTrace` is wired, every call emits
 *  one DecisionTrace — success carries the scripted result and usage, a
 *  scripted failure carries the folded error — so eval runs (design-evals
 *  W4-3) and reliability tests can drive the per-call ledger without a
 *  network. */
export function createScriptedDecisionBackend(options: ScriptedOptions = {}): ScriptedDecisionBackend {
  const kind = options.kind ?? 'decision-model';
  const calibrated = kind === 'decision-model';
  const model = options.model ?? (kind === 'llm' ? 'scripted-llm' : 'scripted-jev');
  const calls: ScriptedDecisionBackend['calls'] = { noul: [], choice: [], score: [] };
  const now = () => new Date().toISOString();

  const emit = (
    primitive: 'noul' | 'choice' | 'score',
    request: { runId: string; question: string; stateKeys?: string[] },
    started: number,
    outcome: { result?: unknown; error?: DecisionBackendError },
  ): void => {
    if (options.onTrace === undefined) return;
    const trace: DecisionTrace = {
      runId: request.runId,
      backend: kind,
      model: model,
      request: { kind: primitive, question: request.question, stateKeys: request.stateKeys ?? [] },
      ...(outcome.result !== undefined ? { result: outcome.result } : {}),
      ...(outcome.error !== undefined ? { error: outcome.error } : {}),
      latencyMs: Date.now() - started,
      ...(options.usage !== undefined ? { usage: options.usage } : {}),
      decidedAt: now(),
    };
    options.onTrace(trace);
  };

  const run = async <Request extends { runId: string; question: string; stateKeys?: string[] }, Result>(
    primitive: 'noul' | 'choice' | 'score',
    log: ScriptedCall<Request>[],
    scripted: ScriptedMethod<Request, Result> | undefined,
    fallback: Result,
    request: Request,
  ): Promise<Result> => {
    const callIndex = log.length;
    log.push({ callIndex, request });
    const started = Date.now();
    if (options.delayMs !== undefined && options.delayMs > 0) await sleep(options.delayMs);
    if (options.failWith !== undefined) {
      const failure = new DecisionBackendFailure(options.failWith, `scripted failure: ${options.failWith}`);
      emit(primitive, request, started, { error: failure.toJSON() });
      throw failure;
    }
    const result = resolveScripted(scripted, fallback, request, callIndex);
    emit(primitive, request, started, { result });
    return result;
  };

  return {
    kind,
    model: model,
    noul: (request) =>
      run<NoulRequest, NoulResult>(
        'noul',
        calls.noul,
        options.noul,
        { probability: 0.5, confidence: 0.5, calibrated, decisionAt: 't0' },
        request,
      ),
    choice: (request) =>
      run<ChoiceRequest, ChoiceResult>(
        'choice',
        calls.choice,
        options.choice,
        { choice: '', probabilities: {}, confidence: 0, calibrated, decisionAt: 't0' },
        request,
      ),
    score: (request) =>
      run<ScoreRequest, ScoreResult>(
        'score',
        calls.score,
        options.score,
        { score: 50, distribution: {}, confidence: 0, calibrated, decisionAt: 't0' },
        request,
      ),
    calls,
  };
}
