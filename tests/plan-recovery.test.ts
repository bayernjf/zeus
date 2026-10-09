// design-tool-discovery (tech map S11) V3 slice 2: planRecovery resolves one
// failed step of a chain plan into an executable instruction. Unlike the
// slice-1 verdict (RecoveryAction), the instruction carries the concrete
// candidate to re-run or switch to, so a runtime can act on it. Pure function,
// zero IO — every input is caller-supplied, mirroring recoverChain.

import { describe, expect, it } from 'vitest';
import {
  type ChainFailure,
  type ChainPlan,
  type DispatchCandidate,
  planRecovery,
} from '../src/orchestrator/discovery.js';

function candidate(provider: string, mode: 'execute' | 'plan' = 'execute'): DispatchCandidate {
  return { provider, skillId: 'research', mode };
}

function plan(steps: ChainPlan['steps'], policy: ChainPlan['policy'] = 'sequential'): ChainPlan {
  return { steps, policy };
}

function failure(overrides: Partial<ChainFailure> = {}): ChainFailure {
  return {
    step: 'research',
    idempotent: false,
    retriesLeft: 0,
    highStakes: false,
    circuitOpen: false,
    hasAlternateProvider: false,
    requiredStep: true,
    ...overrides,
  };
}

describe('planRecovery (S11 V3 slice 2)', () => {
  it('retries the failed provider when the step is idempotent, budget remains and the circuit is closed', () => {
    const p = plan([{ skillId: 'research', candidates: [candidate('a1'), candidate('a2')], required: true }]);
    const r = planRecovery(p, 0, 'a1', failure({ idempotent: true, retriesLeft: 1 }));
    expect(r).toEqual({ action: 'retry', stepIndex: 0, candidate: candidate('a1') });
  });

  it('retry picks the first face candidate of the failed provider when the step lists it twice', () => {
    const p = plan([{ skillId: 'research', candidates: [candidate('a1'), candidate('a1'), candidate('a2')], required: true }]);
    const r = planRecovery(p, 0, 'a1', failure({ idempotent: true, retriesLeft: 2 }));
    expect(r).toEqual({ action: 'retry', stepIndex: 0, candidate: candidate('a1') });
  });

  it('switches to the first alternate candidate in face order when the failed provider has no retry path', () => {
    const p = plan([{ skillId: 'research', candidates: [candidate('a1'), candidate('a2'), candidate('a3')], required: true }]);
    const r = planRecovery(p, 0, 'a1', failure());
    expect(r).toEqual({ action: 'switch', stepIndex: 0, candidate: candidate('a2'), from: 'a1' });
  });

  it('switches even when the failed provider is still in the face but retry budget is spent', () => {
    const p = plan([{ skillId: 'research', candidates: [candidate('a1'), candidate('a2')], required: true }]);
    const r = planRecovery(p, 0, 'a1', failure({ idempotent: true, retriesLeft: 0 }));
    expect(r).toEqual({ action: 'switch', stepIndex: 0, candidate: candidate('a2'), from: 'a1' });
  });

  it('degrades a non-required step when no alternate exists', () => {
    const p = plan([{ skillId: 'research', candidates: [candidate('a1')], required: false }]);
    const r = planRecovery(p, 0, 'a1', failure());
    expect(r).toEqual({ action: 'degrade', stepIndex: 0 });
  });

  it('escalates a required step with no alternate', () => {
    const p = plan([{ skillId: 'research', candidates: [candidate('a1')], required: true }]);
    const r = planRecovery(p, 0, 'a1', failure());
    expect(r).toEqual({ action: 'escalate', stepIndex: 0, reason: 'required-step-without-alternate' });
  });

  it('high-stakes steps escalate before any retry is considered', () => {
    const p = plan([{ skillId: 'research', candidates: [candidate('a1'), candidate('a2')], required: true }]);
    const r = planRecovery(p, 0, 'a1', failure({ idempotent: true, retriesLeft: 3, highStakes: true }));
    expect(r).toEqual({ action: 'escalate', stepIndex: 0, reason: 'high-stakes-step' });
  });

  it('an open circuit refuses retry and switch, falling to degrade for optional steps', () => {
    const p = plan([{ skillId: 'research', candidates: [candidate('a1'), candidate('a2')], required: false }]);
    const r = planRecovery(p, 0, 'a1', failure({ idempotent: true, retriesLeft: 3, circuitOpen: true }));
    expect(r).toEqual({ action: 'degrade', stepIndex: 0 });
  });

  it('an open circuit refuses retry and switch, escalating required steps', () => {
    const p = plan([{ skillId: 'research', candidates: [candidate('a1'), candidate('a2')], required: true }]);
    const r = planRecovery(p, 0, 'a1', failure({ idempotent: true, retriesLeft: 3, circuitOpen: true }));
    expect(r).toEqual({ action: 'escalate', stepIndex: 0, reason: 'required-step-without-alternate' });
  });

  it('a dag-policy plan resolves each failed step independently by its own face', () => {
    const p = plan(
      [
        { skillId: 'research', candidates: [candidate('a1'), candidate('a2')], required: true },
        { skillId: 'writeup', candidates: [candidate('b1')], required: false },
      ],
      'dag',
    );
    expect(planRecovery(p, 0, 'a1', failure())).toEqual({ action: 'switch', stepIndex: 0, candidate: candidate('a2'), from: 'a1' });
    expect(planRecovery(p, 1, 'b1', failure())).toEqual({ action: 'degrade', stepIndex: 1 });
  });

  it('fails loudly when the step index is out of range', () => {
    const p = plan([{ skillId: 'research', candidates: [candidate('a1')], required: true }]);
    expect(() => planRecovery(p, 1, 'a1', failure())).toThrow(RangeError);
    expect(() => planRecovery(p, -1, 'a1', failure())).toThrow(RangeError);
  });
});
