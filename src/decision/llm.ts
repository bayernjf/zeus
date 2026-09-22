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
 * Family B adapter: a traditional LLM behind the same narrow port (System 2,
 * slow layer). Each primitive is translated into a prompt + JSON output contract,
 * then parsed and validated locally. Confidence is self-reported by the LLM and
 * marked calibrated:false — it must never alone gate high-stakes decisions
 * (design-decision-backend §4/§6).
 *
 * Transport targets an OpenAI-compatible /chat/completions endpoint.
 */

export type LlmConfig = BackendOptions & {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Published unit prices in USD per million tokens; cost is omitted when unknown. */
  inputUsdPerMillion?: number;
  outputUsdPerMillion?: number;
  defaultTimeoutMs?: number;
};

const DEFAULT_TIMEOUT_MS = 15000;

export function createLlmBackend(config: LlmConfig): DecisionBackend {
  const fetchImpl = config.fetchImpl ?? fetch;
  const now = config.now ?? (() => new Date());
  const sink = createTraceSink(config, now, 'llm', config.model);

  async function completeJson(
    kind: 'noul' | 'choice' | 'score',
    request: QuestionBase & { question: string },
    systemPrompt: string,
    userPrompt: string,
    requestTokens: number
  ): Promise<{ parsed: Record<string, unknown>; latencyMs: number; inputTokens: number; outputTokens: number; stateKeys: string[] }> {
    const timeoutMs = request.maxWaitMs ?? config.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    const started = Date.now();
    const { state, stateKeys } = prepareState(request, config);
    const stateText = typeof state === 'string' ? state : JSON.stringify(state);
    const body = JSON.stringify({
      model: config.model,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `${userPrompt}\n\nDecision criteria: ${request.instructions}\nState:\n${stateText}\n\nRespond with one JSON object and nothing else.` },
      ],
    });

    let payload: Record<string, unknown>;
    try {
      const response = await timedFetch(
        `${config.baseUrl.replace(/\/+$/, '')}/chat/completions`,
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
          runId: request.runId, backend: 'llm', model: config.model,
          request: { kind, question: request.question, stateKeys },
          error: failure, latencyMs: Date.now() - started,
        });
        throw new DecisionBackendFailure(failure.code, failure.message);
      }
      payload = (await response.json()) as Record<string, unknown>;
    } catch (error) {
      if (error instanceof DecisionBackendFailure) throw error;
      throw new DecisionBackendFailure('unavailable', error instanceof Error ? error.message : 'LLM transport error');
    }

    const latencyMs = Date.now() - started;
    const content = extractContent(payload);
    const parsed = parseJsonObject(content);
    if (!parsed) {
      const failure = { code: 'invalid' as const, message: 'LLM output was not a parseable JSON object' };
      sink.emit({
        runId: request.runId, backend: 'llm', model: config.model,
        request: { kind, question: request.question, stateKeys },
        error: failure, latencyMs,
      });
      throw new DecisionBackendFailure(failure.code, failure.message);
    }
    const usage = (payload.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined) ?? {};
    const inputTokens = usage.prompt_tokens ?? requestTokens + estimateTokens(stateText);
    const outputTokens = usage.completion_tokens ?? estimateTokens(content);
    return { parsed, latencyMs, inputTokens, outputTokens, stateKeys };
  }

  function emitCost(
    kind: 'noul' | 'choice' | 'score',
    request: { question: string; instructions: string; runId: string },
    stateKeys: string[],
    result: unknown,
    latencyMs: number,
    inputTokens: number,
    outputTokens: number
  ): void {
    const cost =
      config.inputUsdPerMillion !== undefined && config.outputUsdPerMillion !== undefined
        ? {
            inputTokens,
            outputTokens,
            cents: (inputTokens / 1_000_000) * config.inputUsdPerMillion! * 100 + (outputTokens / 1_000_000) * config.outputUsdPerMillion! * 100,
          }
        : undefined;
    sink.emit({
      runId: request.runId, backend: 'llm', model: config.model,
      request: { kind, question: request.question, stateKeys },
      result, latencyMs, ...(cost ? { cost } : {}),
    });
  }

  return {
    kind: 'llm',
    model: config.model,
    async noul(request: NoulRequest): Promise<NoulResult> {
      const { parsed, latencyMs, inputTokens, outputTokens, stateKeys } = await completeJson(
        'noul', request,
        'You are a decision engine. Answer only with the requested JSON; no prose.',
        `Proposition: ${request.question}\nReturn {"probability": <0..1 truth probability>, "confidence": <0..1 self-assessed confidence>}.`,
        estimateTokens(request.question)
      );
      const result: NoulResult = {
        probability: assertRanged(parsed.probability, 'probability'),
        confidence: assertRanged(parsed.confidence, 'confidence'),
        calibrated: false,
        decisionAt: now().toISOString(),
      };
      emitCost('noul', request, stateKeys, result, latencyMs, inputTokens, outputTokens);
      return result;
    },
    async choice(request: ChoiceRequest): Promise<ChoiceResult> {
      const { parsed, latencyMs, inputTokens, outputTokens, stateKeys } = await completeJson(
        'choice', request,
        'You are a decision engine. Choose exactly one of the given options. Answer only with the requested JSON.',
        `Question: ${request.question}\nOptions: ${request.options.join(' | ')}\nReturn {"choice": <one option>, "probabilities": {<option>: <0..1>}, "confidence": <0..1>}.`,
        estimateTokens(request.question)
      );
      const choice = String(parsed.choice ?? '');
      if (!request.options.includes(choice)) {
        throw new DecisionBackendFailure('invalid', 'LLM returned a choice outside the provided options');
      }
      const probabilities: Record<string, number> = {};
      if (parsed.probabilities && typeof parsed.probabilities === 'object') {
        for (const option of request.options) {
          const v = Number((parsed.probabilities as Record<string, unknown>)[option]);
          if (Number.isFinite(v)) probabilities[option] = v;
        }
      }
      const result: ChoiceResult = {
        choice,
        probabilities,
        confidence: assertRanged(parsed.confidence, 'confidence'),
        calibrated: false,
        decisionAt: now().toISOString(),
      };
      emitCost('choice', request, stateKeys, result, latencyMs, inputTokens, outputTokens);
      return result;
    },
    async score(request: ScoreRequest): Promise<ScoreResult> {
      const { parsed, latencyMs, inputTokens, outputTokens, stateKeys } = await completeJson(
        'score', request,
        'You are a decision engine. Score against the given level bands. Answer only with the requested JSON.',
        `Question: ${request.question}\nLevels: ${request.levels.join(' | ')}\nReturn {"score": <0..100>, "level": <one level>, "distribution": {<level>: <0..1>}, "confidence": <0..1>}.`,
        estimateTokens(request.question)
      );
      const score = Number(parsed.score);
      if (!Number.isFinite(score) || score < 0 || score > 100) {
        throw new DecisionBackendFailure('invalid', 'LLM score must be a number in [0,100]');
      }
      const distribution: Record<string, number> = {};
      if (parsed.distribution && typeof parsed.distribution === 'object') {
        for (const level of request.levels) {
          const v = Number((parsed.distribution as Record<string, unknown>)[level]);
          if (Number.isFinite(v)) distribution[level] = v;
        }
      }
      const result: ScoreResult = {
        score,
        ...(parsed.level !== undefined ? { level: String(parsed.level) } : {}),
        distribution,
        confidence: assertRanged(parsed.confidence, 'confidence'),
        calibrated: false,
        decisionAt: now().toISOString(),
      };
      emitCost('score', request, stateKeys, result, latencyMs, inputTokens, outputTokens);
      return result;
    },
  };
}

function extractContent(payload: Record<string, unknown>): string {
  const choices = payload.choices as Array<{ message?: { content?: unknown } }> | undefined;
  const content = choices?.[0]?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(part => (typeof part === 'object' && part && 'text' in part ? String((part as { text: unknown }).text) : '')).join('');
  }
  return '';
}

/** Tolerant JSON extraction: models occasionally wrap JSON in fences/prose. */
function parseJsonObject(text: string): Record<string, unknown> | null {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(candidate.slice(start, end + 1));
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** env wiring; returns null when not fully configured → kernel unchanged. */
export function createLlmBackendFromEnv(env: NodeJS.ProcessEnv = process.env, options: BackendOptions = {}): DecisionBackend | null {
  const baseUrl = env.ZEUS_LLM_BASE_URL;
  const apiKey = env.ZEUS_LLM_API_KEY;
  const model = env.ZEUS_LLM_MODEL;
  if (!baseUrl || !apiKey || !model) return null;
  return createLlmBackend({ baseUrl, apiKey, model, ...options });
}
