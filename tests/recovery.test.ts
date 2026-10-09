// design-long-running (tech map S13) V1: classifyRecoverable verdict table +
// computeCheckpoint conservative projection. Acceptance (design-long-running
// §5): positives/negatives for all four verdict classes, the "a non-idempotent
// execute branch never auto-resumes" independent invariant, every input
// reaches a verdict (no unclassified branch), and zero runtime behaviour
// change (V1 is pure functions only).

import { describe, expect, it } from 'vitest';
import {
  classifyRecoverable,
  computeCheckpoint,
  type RecoverableBranch,
} from '../src/orchestrator/recovery.js';
import type { OrchestratorSnapshot } from '../src/orchestrator/orchestrator.js';

function branch(overrides: Partial<RecoverableBranch> = {}): RecoverableBranch {
  return {
    mode: 'plan',
    skillDeclaresIdempotent: false,
    idempotencyKeyReusable: true,
    unconsumedDelegationNonce: false,
    lastOutcome: 'running',
    hasFallbackProvider: false,
    circuitOpen: false,
    budgetExhausted: false,
    ...overrides,
  };
}

describe('classifyRecoverable (S13 V1)', () => {
  it('auto-resumes a clean running plan branch with the next resume number', () => {
    expect(classifyRecoverable(branch({ resumesSoFar: 2 }))).toEqual({ kind: 'auto-resume', resumeNo: 3 });
  });

  it('auto-resumes an idempotent execute branch when replay still covers it', () => {
    const r = classifyRecoverable(branch({ mode: 'execute', skillDeclaresIdempotent: true }));
    expect(r).toEqual({ kind: 'auto-resume', resumeNo: 1 });
  });

  it('never auto-resumes a non-idempotent execute branch', () => {
    const r = classifyRecoverable(branch({ mode: 'execute', skillDeclaresIdempotent: false }));
    expect(r).toEqual({ kind: 'await-operator', level: 1, reason: 'non-idempotent-execute' });
  });

  it('never auto-resumes an execute branch with an unconsumed delegation ticket', () => {
    const r = classifyRecoverable(branch({ mode: 'execute', skillDeclaresIdempotent: true, unconsumedDelegationNonce: true }));
    expect(r.kind).toBe('await-operator');
  });

  it('never auto-resumes when the idempotency key is no longer replayable', () => {
    const r = classifyRecoverable(branch({ idempotencyKeyReusable: false }));
    expect(r.kind).toBe('await-operator');
  });

  it('never auto-resumes when the budget is exhausted', () => {
    const r = classifyRecoverable(branch({ budgetExhausted: true }));
    expect(r).toEqual({ kind: 'await-operator', level: 1, reason: 'budget-exhausted' });
  });

  it('settles a failed branch without fallback as failed', () => {
    const r = classifyRecoverable(branch({ lastOutcome: 'failed', hasFallbackProvider: false }));
    expect(r).toEqual({ kind: 'settle-failed', reason: 'no-fallback-provider' });
  });

  it('settles a failed branch as failed when the circuit is open', () => {
    const r = classifyRecoverable(branch({ lastOutcome: 'failed', circuitOpen: true }));
    expect(r).toEqual({ kind: 'settle-failed', reason: 'circuit-open' });
  });

  it('a failed branch with a fallback awaits the operator re-dispatch decision', () => {
    const r = classifyRecoverable(branch({ lastOutcome: 'failed', hasFallbackProvider: true }));
    expect(r.kind).toBe('await-operator');
    if (r.kind === 'await-operator') expect(r.reason).toContain('re-dispatch');
  });

  it('an unsettled cancel settles as canceled', () => {
    const r = classifyRecoverable(branch({ cancelIssued: true, lastOutcome: 'running' }));
    expect(r).toEqual({ kind: 'settle-canceled' });
  });

  it('an input-required branch awaits the operator', () => {
    const r = classifyRecoverable(branch({ lastOutcome: 'input-required' }));
    expect(r).toEqual({ kind: 'await-operator', level: 1, reason: 'pending-input' });
  });

  it('a crash older than maxAutoResumeMs awaits the operator', () => {
    const r = classifyRecoverable(branch({ crashedForMs: 9000 }), 5000);
    expect(r).toEqual({ kind: 'await-operator', level: 1, reason: 'crashed-too-long' });
  });

  it('a crash within maxAutoResumeMs still auto-resumes', () => {
    const r = classifyRecoverable(branch({ crashedForMs: 1000 }), 5000);
    expect(r).toEqual({ kind: 'auto-resume', resumeNo: 1 });
  });

  it('cancel wins over every other signal, including failure', () => {
    const r = classifyRecoverable(branch({ cancelIssued: true, lastOutcome: 'failed', circuitOpen: true }));
    expect(r).toEqual({ kind: 'settle-canceled' });
  });

  it('every input reaches a verdict — no unclassified branch', () => {
    // Exhaustive sweep over the boolean faces (8 plan variants + 8 execute
    // variants with every failure signal) must never throw or return undefined.
    for (const mode of ['plan', 'execute'] as const) {
      for (const idem of [false, true]) {
        for (const key of [false, true]) {
          for (const nonce of [false, true]) {
            for (const failed of [false, true]) {
              const r = classifyRecoverable(branch({ mode, skillDeclaresIdempotent: idem, idempotencyKeyReusable: key, unconsumedDelegationNonce: nonce, lastOutcome: failed ? 'failed' : 'running' }));
              expect(['auto-resume', 'await-operator', 'settle-failed', 'settle-canceled']).toContain(r.kind);
            }
          }
        }
      }
    }
  });
});

describe('computeCheckpoint (S13 V1)', () => {
  it('projects settled intents with conservative execute declarations', () => {
    const snapshot: OrchestratorSnapshot = {
      intents: [
        {
          intentId: 'i1', runId: 'r1', skill: 'research', realm: 'personal', branches: [], stream: [], positions: [],
          decision: { rule: 'unanimous', conclusion: null, positions: [], reason: '' }, conflicts: [], status: 'failed', createdAt: '',
        },
      ],
      requests: [],
    };
    const cp = computeCheckpoint(snapshot);
    expect(cp.intents).toHaveLength(1);
    expect(cp.intents[0]!.intentId).toBe('i1');
    // Conservative defaults: execute-like, no idempotency, no fallback.
    expect(cp.intents[0]!.branch.mode).toBe('execute');
    expect(cp.intents[0]!.branch.skillDeclaresIdempotent).toBe(false);
    expect(classifyRecoverable(cp.intents[0]!.branch).kind).toBe('await-operator');
  });

  it('projects a canceled intent so its branch settles canceled', () => {
    const snapshot: OrchestratorSnapshot = {
      intents: [
        {
          intentId: 'i2', runId: 'r2', skill: 'research', realm: 'personal', branches: [], stream: [], positions: [],
          decision: { rule: 'unanimous', conclusion: null, positions: [], reason: '' }, conflicts: [], status: 'canceled', createdAt: '',
        },
      ],
      requests: [],
    };
    const cp = computeCheckpoint(snapshot);
    expect(classifyRecoverable(cp.intents[0]!.branch)).toEqual({ kind: 'settle-canceled' });
  });

  it('projects the circuit from the persisted failure streak', () => {
    const snapshot: OrchestratorSnapshot = {
      intents: [
        {
          intentId: 'i3', runId: 'r3', skill: 'research', realm: 'personal', branches: [], stream: [], positions: [],
          decision: { rule: 'unanimous', conclusion: null, positions: [], reason: '' }, conflicts: [], status: 'failed', createdAt: '',
        },
      ],
      requests: [],
      budgets: { i3: { used: 10, failureStreak: 8 } },
    };
    const cp = computeCheckpoint(snapshot);
    expect(cp.intents[0]!.branch.circuitOpen).toBe(true);
    expect(classifyRecoverable(cp.intents[0]!.branch).kind).toBe('settle-failed');
  });
});
