// design-evals (tech map S7) W4-1: the LLM-as-judge scorer for open-ended
// cases. Deterministic property checks stay the primary judgement (design-evals
// §2: LLM-as-judge is never the only criterion); this scorer covers the answer-
// quality family that a boolean predicate cannot express. The model comes from
// a hub text alias resolved through the existing model-kit wiring (the same
// process-wide resolver the memory embedder reads — one hub wiring per boot),
// called at temperature 0 with a JSON-only contract, and every failure mode —
// disabled, alias unresolved, transport error, timeout, malformed output —
// degrades to an explicit fail-soft verdict: the eval run continues, the check
// lands at observe severity and never blocks the gate.

import { activeHubModelResolve } from '../decision/hub-backend.js';
import type { FanOutResult } from '../orchestrator/types.js';

/** A judge call's outcome. `ok: false` is the fail-soft shape (W4-1): the
 *  reason says why no score exists, and the scorer must not block on it. */
export type JudgeVerdict =
  | { ok: true; score: number; reason: string }
  | { ok: false; reason: string };

/** The hub endpoint one judge call goes out to (model-kit resolved). */
export interface JudgeEndpoint {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Some providers reject temperature 0 and declare their legal value in the
   *  hub adapter; the judge honours it the same way the decision backend does. */
  temperature?: number;
}

export type EvalJudgeOptions = {
  /** Lazy endpoint resolution, consulted on every call: returning null (hub
   *  wiring absent / alias unassigned) degrades the call to fail-soft. */
  resolveEndpoint: () => JudgeEndpoint | null;
  fetchImpl?: typeof fetch;
  /** Per-call timeout, folded into a fail-soft verdict (default 30s). */
  timeoutMs?: number;
};

/** One configured judge: an alias plus the transport to score one rubric
 *  against one settled outcome. Never throws — every failure is a verdict. */
export type EvalJudge = {
  /** Hub alias the model resolves from (audit + run records). */
  alias: string;
  /** Model identifier of the last successful resolution ('' before one). */
  model: string;
  /** Score one open-ended expectation. Temperature 0, JSON-only output. */
  score(rubric: string, outcome: FanOutResult): Promise<JudgeVerdict>;
};

const DEFAULT_TIMEOUT_MS = 30_000;
const ENV_TRUE = new Set(['1', 'true', 'yes', 'on']);

function envFlag(value: string | undefined): boolean {
  return value !== undefined && ENV_TRUE.has(value.trim().toLowerCase());
}

/** The decision transcript one judge call sees: the settled conclusion, every
 *  position's stance + rationale and the surfaced conflicts. Derived purely
 *  from the outcome, so the same run prompts identically. */
export function decisionTranscript(outcome: FanOutResult): string {
  const lines: string[] = [];
  lines.push(`aggregation rule: ${outcome.decision.rule}`);
  lines.push(`status: ${outcome.status}`);
  lines.push(`conclusion: ${outcome.decision.conclusion === null ? '(none)' : outcome.decision.conclusion}`);
  if (outcome.positions.length > 0) {
    lines.push('positions:');
    for (const p of outcome.positions) {
      lines.push(`- ${p.vassal}: stance=${p.stance ?? '(none)'} rationale=${p.rationale ?? '(none)'}`);
    }
  }
  if (outcome.conflicts.length > 0) {
    lines.push('conflicts:');
    for (const c of outcome.conflicts) {
      lines.push(`- ${JSON.stringify(c)}`);
    }
  }
  return lines.join('\n');
}

export function createEvalJudge(options: EvalJudgeOptions & { alias: string }): EvalJudge {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let lastModel = '';
  return {
    alias: options.alias,
    get model(): string {
      return lastModel;
    },
    async score(rubric: string, outcome: FanOutResult): Promise<JudgeVerdict> {
      const endpoint = options.resolveEndpoint();
      if (endpoint === null) {
        return { ok: false, reason: 'no judge endpoint resolved (hub wiring absent or alias unassigned)' };
      }
      lastModel = endpoint.model;
      try {
        const response = await fetchImpl(`${endpoint.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${endpoint.apiKey}`,
          },
          body: JSON.stringify({
            model: endpoint.model,
            temperature: endpoint.temperature ?? 0,
            response_format: { type: 'json_object' },
            messages: [
              {
                role: 'system',
                content:
                  'You are an evaluation judge for a decision engine. Score the answer quality against the given rubric. Respond with one JSON object and nothing else: {"score": <number 0-1>, "reason": "<short justification>"}',
              },
              {
                role: 'user',
                content: `Rubric: ${rubric}\n\nDecision to judge:\n${decisionTranscript(outcome)}`,
              },
            ],
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!response.ok) {
          return { ok: false, reason: `judge http ${response.status}` };
        }
        const payload = (await response.json()) as {
          choices?: Array<{ message?: { content?: string } }>;
        };
        const content = payload.choices?.[0]?.message?.content ?? '';
        const parsed = parseVerdict(content);
        if (parsed === null) {
          return { ok: false, reason: 'judge output was not a parseable {"score","reason"} JSON object' };
        }
        return parsed;
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return { ok: false, reason: `judge call failed: ${reason}` };
      }
    },
  };
}

/** Parse the model's JSON-only answer into a verdict. Anything outside
 *  {"score": number 0..1, "reason"?: string} is fail-soft, never a guess. */
export function parseVerdict(content: string): JudgeVerdict | null {
  if (!content) return null;
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1]! : content;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  const score = (parsed as Record<string, unknown>).score;
  if (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 1) {
    return null;
  }
  const rawReason = (parsed as Record<string, unknown>).reason;
  const reason = typeof rawReason === 'string' ? rawReason : '';
  return { ok: true, score, reason };
}

/**
 * Env wiring (W4-1): the judge exists only when the operator enables it
 * (ZEUS_EVAL_JUDGE_ENABLED) and the hub wiring can resolve the judge alias
 * (ZEUS_EVAL_JUDGE_ALIAS, default `choice` — a text alias assigned for
 * decision work). Either condition missing returns null: the runner then
 * collects no verdicts and every judge check degrades to observe. The
 * optional ZEUS_EVAL_JUDGE_TIMEOUT_MS bounds each call (default 30s).
 */
export function createEvalJudgeFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  options: Partial<EvalJudgeOptions> = {},
): EvalJudge | null {
  if (!envFlag(env.ZEUS_EVAL_JUDGE_ENABLED)) return null;
  const alias = env.ZEUS_EVAL_JUDGE_ALIAS?.trim() || 'choice';
  const timeoutRaw = env.ZEUS_EVAL_JUDGE_TIMEOUT_MS?.trim();
  const timeoutMs = timeoutRaw !== undefined && timeoutRaw !== '' ? Number(timeoutRaw) : undefined;
  if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) return null;
  return createEvalJudge({
    alias,
    resolveEndpoint: () => {
      const resolved = activeHubModelResolve(alias);
      if (resolved === null) return null;
      const adapter = resolved.adapter;
      const adapterTemperature =
        adapter !== null && typeof adapter === 'object' && 'temperature' in adapter
          ? Number((adapter as Record<string, unknown>).temperature)
          : undefined;
      const endpoint: JudgeEndpoint = {
        baseUrl: resolved.baseUrl,
        apiKey: resolved.apiKey,
        model: resolved.model,
      };
      // Some models only accept a specific sampling temperature (e.g. Ark
      // `ark-code-latest` rejects 0 with 400); the hub adapter declares the
      // legal value and the judge honours it like the decision backend does.
      if (adapterTemperature !== undefined && Number.isFinite(adapterTemperature)) {
        endpoint.temperature = adapterTemperature;
      }
      return endpoint;
    },
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...options,
  });
}
