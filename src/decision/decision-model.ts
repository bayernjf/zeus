import type {
  BackendOptions,
  ChoiceRequest,
  ChoiceResult,
  DecisionBackend,
  NoulRequest,
  NoulResult,
  QuestionBase,
  ScoreRequest,
  ScoreResult,
} from './types.js';
import { DecisionBackendFailure } from './types.js';
import { assertRanged, createTraceSink, estimateTokens, failureFromStatus, prepareState, timedFetch } from './shared.js';

/**
 * Family A adapter: dedicated decision models (first implementation: TypeSafe Jev).
 * Native typed primitives (noul/choice/score) with calibrated confidence.
 *
 * Wire shape per design-decision-backend §5:
 *   request:  { model, state, questions: { <name>: { type, instructions, options?|levels? } } }
 *   response: a map of typed answers keyed by question name.
 * NOTE: the exact response envelope (answers/results key) has not been verified
 * against the live API (no key in this environment); parsing tolerates the
 * documented shapes and must be confirmed on first real call (mock-fetch tested).
 */

export type JevConfig = BackendOptions & {
  baseUrl: string;
  apiKey: string;
  model?: string;
  /** Input USD per million tokens; Jev published $0.042/M, output free (design §5). */
  inputUsdPerMillion?: number;
  defaultTimeoutMs?: number;
};

// Jev published list price: $0.042 per 1M input tokens, output free. Cents per 1M = 4.2.
const JEV_INPUT_CENTS_PER_MILLION = 4.2;
const DEFAULT_TIMEOUT_MS = 1500;

export function createJevBackend(config: JevConfig): DecisionBackend {
  const model = config.model ?? 'jev-latest';
  const fetchImpl = config.fetchImpl ?? fetch;
  const now = config.now ?? (() => new Date());
  const sink = createTraceSink(config, now, 'decision-model', model);
  const inputCentsPerMillion = (config.inputUsdPerMillion ?? 0.042) * 100;

  async function ask<T>(kind: 'noul' | 'choice' | 'score', request: Questionish, questionBody: Record<string, unknown>): Promise<T> {
    const timeoutMs = request.maxWaitMs ?? config.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    const started = Date.now();
    const { state, stateKeys } = prepareState(request, config);
    const name = `q_${kind}`;
    const body = JSON.stringify({
      model,
      state,
      questions: { [name]: { type: kind, instructions: request.instructions, ...questionBody } },
    });

    let answer: Record<string, unknown>;
    try {
      const response = await timedFetch(
        `${config.baseUrl.replace(/\/+$/, '')}/decide`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${config.apiKey}` },
          body,
        },
        timeoutMs,
        fetchImpl
      );
      if (!response.ok) {
        const failure = failureFromStatus(response.status);
        sink.emit({
          runId: request.runId, backend: 'decision-model', model,
          request: { kind, question: request.question, stateKeys },
          error: failure, latencyMs: Date.now() - started,
        });
        throw new DecisionBackendFailure(failure.code, failure.message);
      }
      const payload = (await response.json()) as Record<string, unknown>;
      answer = extractAnswer(payload, name);
    } catch (error) {
      if (error instanceof DecisionBackendFailure) throw error;
      throw new DecisionBackendFailure('unavailable', error instanceof Error ? error.message : 'decision model error');
    }

    const latencyMs = Date.now() - started;
    const inputTokens = estimateTokens(body);
    const cents = (inputTokens / 1_000_000) * inputCentsPerMillion;
    const result = answer as T;
    sink.emit({
      runId: request.runId, backend: 'decision-model', model,
      request: { kind, question: request.question, stateKeys },
      result, latencyMs,
      cost: { inputTokens, outputTokens: 0, cents },
    });
    return result;
  }

  return {
    kind: 'decision-model',
    model,
    async noul(request: NoulRequest): Promise<NoulResult> {
      const answer = await ask<Record<string, unknown>>('noul', request, {});
      return {
        probability: assertRanged(answer.probability, 'probability'),
        confidence: assertRanged(answer.confidence, 'confidence'),
        calibrated: true,
        decisionAt: now().toISOString(),
      };
    },
    async choice(request: ChoiceRequest): Promise<ChoiceResult> {
      const answer = await ask<Record<string, unknown>>('choice', request, { options: request.options });
      const choice = String(answer.choice ?? '');
      if (!request.options.includes(choice)) {
        throw new DecisionBackendFailure('invalid', 'decision model returned a choice outside the provided options');
      }
      const probabilities = normalizeProbabilities(answer.probabilities, request.options);
      return {
        choice,
        probabilities,
        confidence: assertRanged(answer.confidence, 'confidence'),
        calibrated: true,
        decisionAt: now().toISOString(),
      };
    },
    async score(request: ScoreRequest): Promise<ScoreResult> {
      const answer = await ask<Record<string, unknown>>('score', request, { levels: request.levels });
      const score = Number(answer.score);
      if (!Number.isFinite(score) || score < 0 || score > 100) {
        throw new DecisionBackendFailure('invalid', 'decision model score must be a number in [0,100]');
      }
      return {
        score,
        ...(answer.level !== undefined ? { level: String(answer.level) } : {}),
        distribution: normalizeDistribution(answer.distribution, request.levels),
        confidence: assertRanged(answer.confidence, 'confidence'),
        calibrated: true,
        decisionAt: now().toISOString(),
      };
    },
  };
}

type Questionish = QuestionBase & { question: string };

/** Tolerate documented response envelopes; confirm exact key on first live call. */
function extractAnswer(payload: Record<string, unknown>, name: string): Record<string, unknown> {
  const container =
    (payload.answers as Record<string, unknown> | undefined) ??
    (payload.results as Record<string, unknown> | undefined) ??
    (payload.responses as Record<string, unknown> | undefined) ??
    payload[name];
  const answer = (container as Record<string, unknown> | undefined)?.[name] ?? container;
  if (!answer || typeof answer !== 'object') {
    throw new DecisionBackendFailure('invalid', 'decision model response had no typed answer');
  }
  return answer as Record<string, unknown>;
}

function normalizeProbabilities(raw: unknown, options: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  if (raw && typeof raw === 'object') {
    for (const option of options) {
      const v = Number((raw as Record<string, unknown>)[option]);
      if (Number.isFinite(v)) out[option] = v;
    }
  }
  return out;
}

function normalizeDistribution(raw: unknown, levels: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  if (raw && typeof raw === 'object') {
    for (const level of levels) {
      const v = Number((raw as Record<string, unknown>)[level]);
      if (Number.isFinite(v)) out[level] = v;
    }
  }
  return out;
}

/** env wiring (serve.ts style). Returns null when not configured → kernel unchanged. */
export function createJevBackendFromEnv(env: NodeJS.ProcessEnv = process.env, options: BackendOptions = {}): DecisionBackend | null {
  const apiKey = env.ZEUS_DECISION_API_KEY;
  const baseUrl = env.ZEUS_DECISION_BASE_URL;
  if (!apiKey || !baseUrl) return null;
  return createJevBackend({
    baseUrl,
    apiKey,
    ...(env.ZEUS_DECISION_MODEL ? { model: env.ZEUS_DECISION_MODEL } : {}),
    ...options,
  });
}
