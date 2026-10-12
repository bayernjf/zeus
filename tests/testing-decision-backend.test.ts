import { describe, expect, it } from 'vitest';
import { DecisionBackendFailure } from '../src/decision/types.js';
import type { ChoiceRequest, ChoiceResult, NoulRequest, ScoreRequest } from '../src/decision/types.js';
import { createScriptedDecisionBackend } from '../src/testing/decision-backend.js';

const baseChoice = {
  state: {},
  instructions: 'criteria',
  runId: 'r1',
  realm: 'personal' as const,
  question: 'q',
  options: ['approve', 'reject'],
};

const choiceResult = (choice: string, confidence = 0.9): ChoiceResult => ({
  choice,
  probabilities: { approve: choice === 'approve' ? confidence : 1 - confidence, reject: choice === 'reject' ? confidence : 1 - confidence },
  confidence,
  calibrated: true,
  decisionAt: 't0',
});

describe('scripted decision backend (S17 V2)', () => {
  it('answers an unscripted method with a neutral fixed result and logs the call', async () => {
    const backend = createScriptedDecisionBackend();
    const result = await backend.noul({ ...baseChoice, question: 'is it true?' } as unknown as NoulRequest);
    expect(result.probability).toBe(0.5);
    expect(result.calibrated).toBe(true);
    expect(backend.calls.noul).toHaveLength(1);
    expect(backend.calls.noul[0]?.callIndex).toBe(0);
  });

  it('returns a fixed choice and reports the configured kind/model', async () => {
    const backend = createScriptedDecisionBackend({ kind: 'llm', model: 'agnes-x', choice: choiceResult('approve') });
    const result = await backend.choice(baseChoice as ChoiceRequest);
    expect(result.choice).toBe('approve');
    expect(backend.kind).toBe('llm');
    expect(backend.model).toBe('agnes-x');
    expect(result.calibrated).toBe(true);
  });

  it('walks a result queue per call index and pins to the last entry once exhausted', async () => {
    const backend = createScriptedDecisionBackend({ choice: [choiceResult('approve', 0.8), choiceResult('reject', 0.7)] });
    const first = await backend.choice(baseChoice as ChoiceRequest);
    const second = await backend.choice(baseChoice as ChoiceRequest);
    const third = await backend.choice(baseChoice as ChoiceRequest);
    expect([first.choice, second.choice, third.choice]).toEqual(['approve', 'reject', 'reject']);
    expect(backend.calls.choice.map((c) => c.callIndex)).toEqual([0, 1, 2]);
  });

  it('supports a function script that sees request and call index', async () => {
    const seenOptions: string[][] = [];
    const backend = createScriptedDecisionBackend({
      choice: (request, index) => {
        seenOptions.push(request.options);
        return choiceResult(index === 0 ? 'approve' : 'reject', 0.95);
      },
    });
    expect((await backend.choice(baseChoice as ChoiceRequest)).choice).toBe('approve');
    expect((await backend.choice(baseChoice as ChoiceRequest)).choice).toBe('reject');
    expect(seenOptions).toEqual([baseChoice.options, baseChoice.options]);
  });

  it('records noul/choice/score calls on separate logs with the original request', async () => {
    const backend = createScriptedDecisionBackend();
    await backend.choice(baseChoice as ChoiceRequest);
    await backend.noul({ ...baseChoice, question: 'n?' } as unknown as NoulRequest);
    await backend.score({ ...baseChoice, question: 's?', levels: ['low', 'high'] } as unknown as ScoreRequest);
    expect(backend.calls.choice).toHaveLength(1);
    expect(backend.calls.noul).toHaveLength(1);
    expect(backend.calls.score).toHaveLength(1);
    expect(backend.calls.choice[0]?.request.question).toBe('q');
  });

  it('fails every method with the folded error code', async () => {
    const backend = createScriptedDecisionBackend({ failWith: 'timeout' });
    let code: string | undefined;
    try {
      await backend.choice(baseChoice as ChoiceRequest);
      throw new Error('expected rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(DecisionBackendFailure);
      code = (error as DecisionBackendFailure).code;
    }
    expect(code).toBe('timeout');
    expect(backend.calls.choice).toHaveLength(1);
  });

  it('rejects an empty result queue loudly instead of returning undefined', async () => {
    const backend = createScriptedDecisionBackend({ choice: [] });
    await expect(backend.choice(baseChoice as ChoiceRequest)).rejects.toThrow(/empty result queue/);
  });

  it('delays resolution deterministically', async () => {
    const backend = createScriptedDecisionBackend({ delayMs: 20, choice: choiceResult('approve') });
    const started = Date.now();
    await backend.choice(baseChoice as ChoiceRequest);
    expect(Date.now() - started).toBeGreaterThanOrEqual(15);
  });
});
