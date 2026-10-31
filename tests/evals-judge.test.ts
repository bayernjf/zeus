// design-evals (tech map S7) W4-1: the LLM-as-judge scorer. The model call is
// always fake here (loopback fetch doubles, no real network): the contract
// under test is the transport shape (temperature 0, JSON-only), the fail-soft
// verdict taxonomy (disabled / unresolvable / HTTP error / timeout / malformed
// output never throw and never block) and the scorer integration (verdicts are
// pre-collected data; a below-bar score fails at the case's severity, an
// unavailable judge degrades to observe).

import { describe, expect, it } from 'vitest';
import { createEvalJudge, createEvalJudgeFromEnv, decisionTranscript, parseVerdict } from '../src/evals/judge.js';
import type { JudgeEndpoint } from '../src/evals/judge.js';
import { DEFAULT_JUDGE_MIN_SCORE, scoreEvalRun, summarizeEvalRun } from '../src/evals/score.js';
import type { EvalCase, EvalExpectation } from '../src/evals/types.js';
import type { FanOutRequest, FanOutResult } from '../src/orchestrator/types.js';

function outcome(overrides: Partial<FanOutResult> = {}): FanOutResult {
  return {
    intentId: 'intent-1', runId: 'r1', skill: 'research', realm: 'personal', branches: [], stream: [],
    positions: [
      { vassal: 'alpha', stance: 'approve', rationale: 'verified against brief.md' },
      { vassal: 'beta', stance: 'approve', rationale: 'same finding, independent check' },
    ],
    decision: { rule: 'unanimous', conclusion: 'approve', positions: [], reason: 'unanimous' },
    conflicts: [], status: 'completed', createdAt: 't0',
    ...overrides,
  };
}

function request(): FanOutRequest {
  return { skill: 'research', params: {}, realm: 'personal' };
}

function judgeCase(expect: EvalExpectation[]): EvalCase {
  return { id: 'case-judge', world: {}, agents: {}, input: request(), expect };
}

const endpoint: JudgeEndpoint = { baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'k', model: 'judge-m' };

interface RecordedRequest { url: string; init: RequestInit }

function chatFetch(content: string): { fetch: typeof fetch; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  const impl: typeof fetch = async (input, init) => {
    requests.push({ url: String(input), init: init ?? {} });
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
  };
  return { fetch: impl, requests };
}

function bodyOf(init: RequestInit): Record<string, unknown> {
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}

describe('parseVerdict (W4-1)', () => {
  it('parses a plain JSON verdict', () => {
    expect(parseVerdict('{"score": 0.9, "reason": "cites evidence"}')).toEqual({ ok: true, score: 0.9, reason: 'cites evidence' });
  });

  it('parses a fenced or prose-wrapped JSON verdict', () => {
    expect(parseVerdict('```json\n{"score": 0.8}\n```')).toEqual({ ok: true, score: 0.8, reason: '' });
    expect(parseVerdict('Verdict: {"score": 1, "reason": "exact"} (end)')).toEqual({ ok: true, score: 1, reason: 'exact' });
  });

  it('rejects scores outside [0,1] and non-JSON shapes', () => {
    expect(parseVerdict('{"score": 1.5}')).toBeNull();
    expect(parseVerdict('{"score": "high"}')).toBeNull();
    expect(parseVerdict('{"reason": "no score"}')).toBeNull();
    expect(parseVerdict('not json at all')).toBeNull();
    expect(parseVerdict('')).toBeNull();
  });
});

describe('createEvalJudge (W4-1)', () => {
  it('sends temperature 0 with a JSON-only contract and parses the verdict', async () => {
    const { fetch, requests } = chatFetch('{"score": 0.9, "reason": "cites brief.md"}');
    const judge = createEvalJudge({ alias: 'choice', resolveEndpoint: () => endpoint, fetchImpl: fetch });
    expect(judge.alias).toBe('choice');
    const verdict = await judge.score('answer must cite sources', outcome());
    expect(verdict).toEqual({ ok: true, score: 0.9, reason: 'cites brief.md' });
    expect(judge.model).toBe('judge-m');
    expect(requests).toHaveLength(1);
    const { url, init } = requests[0]!;
    expect(url).toBe('http://127.0.0.1:9/v1/chat/completions');
    const body = bodyOf(init);
    expect(body.model).toBe('judge-m');
    expect(body.temperature).toBe(0);
    expect(body.response_format).toEqual({ type: 'json_object' });
    const messages = body.messages as Array<{ role: string; content: string }>;
    expect(messages[0]!.role).toBe('system');
    expect(messages[1]!.content).toContain('Rubric: answer must cite sources');
    expect(messages[1]!.content).toContain('stance=approve');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer k');
  });

  it('honours an adapter-declared temperature (models that reject 0)', async () => {
    const { fetch, requests } = chatFetch('{"score": 1}');
    const judge = createEvalJudge({
      alias: 'choice',
      resolveEndpoint: () => ({ ...endpoint, temperature: 1 }),
      fetchImpl: fetch,
    });
    await judge.score('r', outcome());
    expect(bodyOf(requests[0]!.init).temperature).toBe(1);
  });

  it('degrades an unresolvable endpoint to a fail-soft verdict', async () => {
    const judge = createEvalJudge({ alias: 'choice', resolveEndpoint: () => null });
    const verdict = await judge.score('r', outcome());
    expect(verdict).toEqual({ ok: false, reason: 'no judge endpoint resolved (hub wiring absent or alias unassigned)' });
  });

  it('degrades an HTTP error to a fail-soft verdict', async () => {
    const judge = createEvalJudge({
      alias: 'choice',
      resolveEndpoint: () => endpoint,
      fetchImpl: (async () => new Response('boom', { status: 500 })) as typeof fetch,
    });
    const verdict = await judge.score('r', outcome());
    expect(verdict).toEqual({ ok: false, reason: 'judge http 500' });
  });

  it('degrades malformed model output to a fail-soft verdict', async () => {
    const judge = createEvalJudge({
      alias: 'choice',
      resolveEndpoint: () => endpoint,
      fetchImpl: chatFetch('I think the answer is fine, no JSON though').fetch,
    });
    const verdict = await judge.score('r', outcome());
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toContain('not a parseable');
  });

  it('degrades a timeout to a fail-soft verdict', async () => {
    // A fetch that aborts with the signal instead of resolving late: the abort
    // is what the hard timeout produces, so the judge must fold it into a
    // verdict instead of throwing.
    const slowFetch: typeof fetch = (_input, init) => new Promise((_resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('should not resolve')), 5_000);
      init?.signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new DOMException('The operation was aborted.', 'AbortError'));
      });
    });
    const judge = createEvalJudge({
      alias: 'choice',
      resolveEndpoint: () => endpoint,
      fetchImpl: slowFetch,
      timeoutMs: 10,
    });
    const verdict = await judge.score('r', outcome());
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toContain('judge call failed');
  });
});

describe('createEvalJudgeFromEnv (W4-1)', () => {
  it('returns null when the kill switch is off or the timeout is malformed', () => {
    expect(createEvalJudgeFromEnv({})).toBeNull();
    expect(createEvalJudgeFromEnv({ ZEUS_EVAL_JUDGE_ENABLED: '0' })).toBeNull();
    expect(createEvalJudgeFromEnv({ ZEUS_EVAL_JUDGE_ENABLED: '1', ZEUS_EVAL_JUDGE_TIMEOUT_MS: 'abc' })).toBeNull();
  });

  it('wires the alias from env with the decision-alias default', () => {
    const judge = createEvalJudgeFromEnv({ ZEUS_EVAL_JUDGE_ENABLED: 'yes' });
    expect(judge).not.toBeNull();
    expect(judge!.alias).toBe('choice');
    const named = createEvalJudgeFromEnv({ ZEUS_EVAL_JUDGE_ENABLED: '1', ZEUS_EVAL_JUDGE_ALIAS: 'score' });
    expect(named!.alias).toBe('score');
  });
});

describe('scoreEvalRun judge family (W4-1)', () => {
  it('fails a below-bar score at the case severity', () => {
    const c = judgeCase([{ judge: { rubric: 'cites sources' }, severity: 'block' }]);
    const r = scoreEvalRun(c, { outcome: outcome(), audit: [], events: [], judgeVerdicts: [{ ok: true, score: 0.4, reason: 'no citations' }] });
    expect(r.checks[0]).toMatchObject({ family: 'judge', passed: false, severity: 'block' });
    expect(r.checks[0]!.detail).toContain('score 0.40 vs min 0.70');
    expect(r.checks[0]!.detail).toContain('no citations');
  });

  it('passes a score at or above the bar, honouring minScore', () => {
    const c = judgeCase([{ judge: { rubric: 'cites sources', minScore: 0.5 }, severity: 'warn' }]);
    const r = scoreEvalRun(c, { outcome: outcome(), audit: [], events: [], judgeVerdicts: [{ ok: true, score: 0.5, reason: 'ok' }] });
    expect(r.checks[0]).toMatchObject({ family: 'judge', passed: true, severity: 'warn' });
    expect(DEFAULT_JUDGE_MIN_SCORE).toBe(0.7);
  });

  it('degrades a failed judge call to observe (fail-soft, never blocks)', () => {
    const c = judgeCase([{ judge: { rubric: 'cites sources' }, severity: 'block' }]);
    const r = scoreEvalRun(c, { outcome: outcome(), audit: [], events: [], judgeVerdicts: [{ ok: false, reason: 'judge http 503' }] });
    expect(r.checks[0]).toMatchObject({ family: 'judge', passed: true, severity: 'observe' });
    expect(r.checks[0]!.detail).toContain('judge-unavailable: judge http 503');
  });

  it('degrades a missing verdict (judge not configured) to observe', () => {
    const c = judgeCase([{ judge: { rubric: 'cites sources' }, severity: 'block' }]);
    const r = scoreEvalRun(c, { outcome: outcome(), audit: [], events: [] });
    expect(r.checks[0]).toMatchObject({ family: 'judge', passed: true, severity: 'observe' });
    expect(r.checks[0]!.detail).toContain('judge not configured');
  });

  it('consumes verdicts in declaration order across multiple judge expectations', () => {
    const c = judgeCase([
      { judge: { rubric: 'first', minScore: 0.9 }, severity: 'warn' },
      { judge: { rubric: 'second' }, severity: 'observe' },
    ]);
    const r = scoreEvalRun(c, {
      outcome: outcome(), audit: [], events: [],
      judgeVerdicts: [{ ok: true, score: 0.95, reason: 'a' }, { ok: true, score: 0.1, reason: 'b' }],
    });
    expect(r.checks[0]!.passed).toBe(true);
    expect(r.checks[1]!.passed).toBe(false);
    expect(r.checks[1]!.detail).toContain('score 0.10 vs min 0.70');
  });

  it('counts judge checks in the family aggregate and stays deterministic', () => {
    const c = judgeCase([{ judge: { rubric: 'r' }, severity: 'block' }]);
    const trace = { outcome: outcome(), audit: [], events: [], judgeVerdicts: [{ ok: true, score: 0.9, reason: 'ok' }] };
    const r1 = scoreEvalRun(c, trace);
    const r2 = scoreEvalRun(c, trace);
    expect(JSON.stringify(r1)).toBe(JSON.stringify(r2));
    const report = summarizeEvalRun([r1]);
    expect(report.byFamily.judge).toEqual({ total: 1, passed: 1, blocked: 0 });
  });

  it('renders the transcript deterministically from the outcome', () => {
    expect(decisionTranscript(outcome())).toContain('conclusion: approve');
    expect(decisionTranscript(outcome())).toContain('- beta: stance=approve rationale=same finding, independent check');
  });
});
