import { describe, expect, it, vi } from 'vitest';
import { createJevBackend } from '../src/decision/decision-model.js';
import { createLlmBackend } from '../src/decision/llm.js';
import { arbitrateSplit } from '../src/decision/arbitrate.js';
import { DecisionBackendFailure } from '../src/decision/types.js';
import type { DecisionBackend, DecisionTrace } from '../src/decision/types.js';

const fixedNow = () => new Date('2026-09-22T00:00:00.000Z');

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('Jev decision-model adapter', () => {
  it('maps noul/choice/score to typed primitives, calibrated, with trace and input-only cost', async () => {
    const calls: RequestInit[] = [];
    const traces: DecisionTrace[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push(init!);
      const body = JSON.parse(String(init?.body));
      const name = Object.keys(body.questions)[0];
      const type = body.questions[name].type;
      const answers: Record<string, unknown> = {
        noul: { probability: 0.82, confidence: 0.91 },
        choice: { choice: 'go', probabilities: { go: 0.7, hold: 0.3 }, confidence: 0.88 },
        score: { score: 72, level: 'high', distribution: { low: 0.1, mid: 0.2, high: 0.7 }, confidence: 0.86 },
      };
      return jsonResponse(200, { answers: { [name]: answers[type] } });
    });
    const backend = createJevBackend({
      baseUrl: 'https://jev.example/v1', apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch, now: fixedNow,
      onTrace: trace => traces.push(trace),
    });

    const noul = await backend.noul({ question: 'risky?', instructions: 'i', state: {}, runId: 'r1', realm: 'personal' });
    expect(noul).toMatchObject({ probability: 0.82, confidence: 0.91, calibrated: true });

    const choice = await backend.choice({ question: 'decide', instructions: 'i', state: {}, runId: 'r1', realm: 'personal', options: ['go', 'hold'] });
    expect(choice.choice).toBe('go');
    expect(choice.calibrated).toBe(true);

    const score = await backend.score({ question: 'rate', instructions: 'i', state: {}, runId: 'r1', realm: 'personal', levels: ['low', 'mid', 'high'] });
    expect(score.score).toBe(72);
    expect(score.level).toBe('high');

    expect(calls).toHaveLength(3);
    // output is free for Jev: cost carries input tokens and zero output tokens
    expect(traces).toHaveLength(3);
    expect(traces[0].backend).toBe('decision-model');
    expect(traces[0].model).toBe('jev-latest');
    expect(traces[0].cost?.outputTokens).toBe(0);
    expect(traces[0].cost?.inputTokens).toBeGreaterThan(0);
    expect(traces[0].cost?.cents).toBeGreaterThan(0);
  });

  it('folds auth/unavailable/timeout status and out-of-band choices into DecisionBackendFailure', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(403, { error: 'forbidden' }));
    const backend = createJevBackend({
      baseUrl: 'https://jev.example', apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch, now: fixedNow,
    });
    await expect(backend.noul({ question: 'q', instructions: 'i', state: {}, runId: 'r', realm: 'personal' }))
      .rejects.toMatchObject({ code: 'auth' });

    const fetch500 = vi.fn(async () => jsonResponse(500, {}));
    const backend500 = createJevBackend({ baseUrl: 'u', apiKey: 'k', fetchImpl: fetch500 as unknown as typeof fetch, now: fixedNow });
    await expect(backend500.noul({ question: 'q', instructions: 'i', state: {}, runId: 'r', realm: 'personal' }))
      .rejects.toMatchObject({ code: 'unavailable' });

    const slow = vi.fn(
      (_url: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        })
    );
    const backendSlow = createJevBackend({ baseUrl: 'u', apiKey: 'k', fetchImpl: slow as unknown as typeof fetch, now: fixedNow });
    await expect(backendSlow.noul({ question: 'q', instructions: 'i', state: {}, runId: 'r', realm: 'personal', maxWaitMs: 10 }))
      .rejects.toMatchObject({ code: 'timeout' });

    const oob = vi.fn(async () => jsonResponse(200, { answers: { q_choice: { choice: 'not-an-option', confidence: 0.9 } } }));
    const backendOob = createJevBackend({ baseUrl: 'u', apiKey: 'k', fetchImpl: oob as unknown as typeof fetch, now: fixedNow });
    await expect(backendOob.choice({ question: 'q', instructions: 'i', state: {}, runId: 'r', realm: 'personal', options: ['a', 'b'] }))
      .rejects.toMatchObject({ code: 'invalid' });
  });
});

describe('LLM adapter (slow layer)', () => {
  it('parses structured JSON, marks calibrated:false, and costs output tokens', async () => {
    const traces: DecisionTrace[] = [];
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, {
        choices: [{ message: { content: JSON.stringify({ choice: 'go', probabilities: { go: 0.6, hold: 0.4 }, confidence: 0.7 }) } }],
        usage: { prompt_tokens: 100, completion_tokens: 40 },
      })
    );
    const backend = createLlmBackend({
      baseUrl: 'https://llm.example', apiKey: 'k', model: 'gpt-x',
      inputUsdPerMillion: 2, outputUsdPerMillion: 8,
      fetchImpl: fetchImpl as unknown as typeof fetch, now: fixedNow, onTrace: t => traces.push(t),
    });
    const result = await backend.choice({ question: 'q', instructions: 'i', state: {}, runId: 'r', realm: 'personal', options: ['go', 'hold'] });
    expect(result.choice).toBe('go');
    expect(result.calibrated).toBe(false);
    expect(traces[0].backend).toBe('llm');
    expect(traces[0].cost).toMatchObject({ inputTokens: 100, outputTokens: 40 });
    // (100/1M*$2 + 40/1M*$8) * 100 cents
    expect(traces[0].cost?.cents).toBeCloseTo(0.052, 5);
  });

  it('extracts JSON from code fences and folds unparseable output to invalid', async () => {
    const fenced = vi.fn(async () =>
      jsonResponse(200, { choices: [{ message: { content: '```json\n{"probability":0.3,"confidence":0.6}\n```' } }] })
    );
    const backend = createLlmBackend({ baseUrl: 'u', apiKey: 'k', model: 'm', fetchImpl: fenced as unknown as typeof fetch, now: fixedNow });
    const noul = await backend.noul({ question: 'q', instructions: 'i', state: {}, runId: 'r', realm: 'personal' });
    expect(noul.probability).toBe(0.3);

    const garbage = vi.fn(async () => jsonResponse(200, { choices: [{ message: { content: 'I think maybe yes.' } }] }) );
    const backendBad = createLlmBackend({ baseUrl: 'u', apiKey: 'k', model: 'm', fetchImpl: garbage as unknown as typeof fetch, now: fixedNow });
    await expect(backendBad.noul({ question: 'q', instructions: 'i', state: {}, runId: 'r', realm: 'personal' }))
      .rejects.toMatchObject({ code: 'invalid' });
  });
});

describe('data sovereignty (design §8)', () => {
  it('refuses enterprise realm by default and only sends whitelisted state keys', async () => {
    const seenBodies: unknown[] = [];
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      seenBodies.push(JSON.parse(String(init?.body)));
      return jsonResponse(200, { answers: { q_noul: { probability: 0.5, confidence: 0.9 } } });
    });
    const backend = createJevBackend({
      baseUrl: 'u', apiKey: 'k', stateKeys: ['public'],
      fetchImpl: fetchImpl as unknown as typeof fetch, now: fixedNow,
    });
    await expect(backend.noul({ question: 'q', instructions: 'i', state: { secret: 'x' }, runId: 'r', realm: 'enterprise' }))
      .rejects.toMatchObject({ code: 'invalid' });
    expect(fetchImpl).not.toHaveBeenCalled();

    await backend.noul({
      question: 'q', instructions: 'i', runId: 'r', realm: 'personal',
      state: { public: 'ok', secret: 'leak' },
    });
    expect(seenBodies[0]).toMatchObject({ state: { public: 'ok' } });
    expect(JSON.stringify(seenBodies[0])).not.toContain('leak');
  });

  it('applies the redact hook after whitelist filtering', async () => {
    let sent: any;
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      sent = JSON.parse(String(init?.body));
      return jsonResponse(200, { answers: { q_noul: { probability: 0.5, confidence: 0.9 } } });
    });
    const backend = createJevBackend({
      baseUrl: 'u', apiKey: 'k', stateKeys: ['name'],
      redact: state => ({ name: String(state.name ?? '').replace(/./g, '*') }),
      fetchImpl: fetchImpl as unknown as typeof fetch, now: fixedNow,
    });
    await backend.noul({ question: 'q', instructions: 'i', runId: 'r', realm: 'personal', state: { name: 'alice' } });
    expect(sent.state).toEqual({ name: '*****' });
  });
});

describe('arbitrateSplit (design §3.1 gating)', () => {
  function spyBackend(result: Awaited<ReturnType<DecisionBackend['choice']>> | Promise<never>, kind: 'decision-model' | 'llm' = 'decision-model'): { backend: DecisionBackend; calls: number } {
    let calls = 0;
    const backend: DecisionBackend = {
      kind,
      model: kind === 'decision-model' ? 'jev-latest' : 'gpt-x',
      noul: async () => { throw new Error('unused'); },
      score: async () => { throw new Error('unused'); },
      choice: async () => { calls++; if (result instanceof Promise) return result; return result; },
    };
    return { backend, get calls() { return calls; } };
  }

  const stances = [
    { stance: 'go', vassals: ['a'], summary: 'green' },
    { stance: 'hold', vassals: ['b'], summary: 'red' },
  ];

  it('adopts a high-confidence calibrated arbitration', async () => {
    const spy = spyBackend({ choice: 'go', probabilities: { go: 0.9, hold: 0.1 }, confidence: 0.9, calibrated: true, decisionAt: 't' });
    const outcome = await arbitrateSplit({ backend: spy.backend, stances, runId: 'r', realm: 'personal', ruleReason: 'tie' });
    expect(spy.calls).toBe(1);
    expect(outcome).toMatchObject({ concluded: true, conclusion: 'go', confidence: 0.9 });
  });

  it('does not conclude on low confidence, uncalibrated LLM confidence, or backend failure', async () => {
    const low = spyBackend({ choice: 'go', probabilities: {}, confidence: 0.5, calibrated: true, decisionAt: 't' });
    expect((await arbitrateSplit({ backend: low.backend, stances, runId: 'r', realm: 'personal', ruleReason: 'tie' })).concluded).toBe(false);

    const llm = spyBackend({ choice: 'go', probabilities: {}, confidence: 0.99, calibrated: false, decisionAt: 't' }, 'llm');
    const llmOutcome = await arbitrateSplit({ backend: llm.backend, stances, runId: 'r', realm: 'personal', ruleReason: 'tie' });
    expect(llmOutcome.concluded).toBe(false);
    // explicit opt-in for low-stakes lets the LLM conclude
    const llmAllowed = spyBackend({ choice: 'go', probabilities: {}, confidence: 0.99, calibrated: false, decisionAt: 't' }, 'llm');
    expect((await arbitrateSplit({ backend: llmAllowed.backend, stances, runId: 'r', realm: 'personal', ruleReason: 'tie', allowUncalibrated: true })).concluded).toBe(true);

    const failing = spyBackend(Promise.reject(new DecisionBackendFailure('timeout', 'slow')));
    const failedOutcome = await arbitrateSplit({ backend: failing.backend, stances, runId: 'r', realm: 'personal', ruleReason: 'tie' });
    expect(failedOutcome).toMatchObject({ concluded: false, error: { code: 'timeout' } });
  });

  it('never calls the backend when fewer than two stances remain', async () => {
    const spy = spyBackend({ choice: 'go', probabilities: {}, confidence: 0.99, calibrated: true, decisionAt: 't' });
    const outcome = await arbitrateSplit({ backend: spy.backend, stances: [{ stance: 'go', vassals: ['a'] }], runId: 'r', realm: 'personal', ruleReason: '' });
    expect(spy.calls).toBe(0);
    expect(outcome.concluded).toBe(false);
  });
});
