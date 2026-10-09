// design-hil (tech map S10) V1: classifyInterruption maps every intent signal
// onto exactly one interruption level (design-hil §3 fixed chain). Each signal
// gets a positive and a negative example; the L2 stall pair (no fallback AND
// downstream depends on it) is the only path to a blocking interruption.
import { describe, expect, it } from 'vitest';
import { AUDIT_DECISIONS } from '../src/dispatch/dispatcher.js';
import {
  classifyInterruption,
  interruptionReason,
  type InterruptLevel,
  type InterruptSignal,
} from '../src/oversight/interrupt.js';

/** Property: the classifier is total — every signal yields 0 | 1 | 2. */
function expectLevel(sig: InterruptSignal, expected: InterruptLevel) {
  expect(classifyInterruption(sig)).toBe(expected);
  expect(interruptionReason(sig)).toBeTruthy();
}

describe('classifyInterruption (S10 V1)', () => {
  it('branch-failed: high-stakes skips the automatic chain (L1)', () => {
    expectLevel(
      { kind: 'branch-failed', idempotent: true, retriesLeft: 3, highStakes: true },
      1,
    );
  });

  it('branch-failed: idempotent with retries left is auto-resolvable (L0)', () => {
    expectLevel(
      { kind: 'branch-failed', idempotent: true, retriesLeft: 1, highStakes: false },
      0,
    );
  });

  it('branch-failed: non-idempotent or exhausted retries waits async (L1)', () => {
    expectLevel(
      { kind: 'branch-failed', idempotent: false, retriesLeft: 0, highStakes: false },
      1,
    );
    expectLevel(
      { kind: 'branch-failed', idempotent: true, retriesLeft: 0, highStakes: false },
      1,
    );
  });

  it('circuit-open: auto-selected dispatch is refused by the guard (L0)', () => {
    expectLevel({ kind: 'circuit-open', explicitlyNamed: false }, 0);
  });

  it('circuit-open: an explicit target still dispatches but warrants a glance (L1)', () => {
    expectLevel({ kind: 'circuit-open', explicitlyNamed: true }, 1);
  });

  it('intent-conflict: arbitration-resolvable is automatic (L0)', () => {
    expectLevel({ kind: 'intent-conflict', autoResolvable: true }, 0);
  });

  it('intent-conflict: unresolvable queues with stances (L1)', () => {
    expectLevel({ kind: 'intent-conflict', autoResolvable: false }, 1);
  });

  it('task-input-missing waits for the operator to supply the input (L1)', () => {
    expectLevel({ kind: 'task-input-missing' }, 1);
  });

  it('delegation-limit-hit: covering contract derives a child ticket (L0)', () => {
    expectLevel({ kind: 'delegation-limit-hit', coveredByContract: true }, 0);
  });

  it('delegation-limit-hit without a contract requires a new one (L1)', () => {
    expectLevel({ kind: 'delegation-limit-hit', coveredByContract: false }, 1);
  });

  it('explicit-branch-failed: no fallback + downstream depends = the only L2', () => {
    expectLevel(
      { kind: 'explicit-branch-failed', hasFallbackProvider: false, downstreamDependsOnIt: true },
      2,
    );
  });

  it('explicit-branch-failed with a fallback recovers async (L1)', () => {
    expectLevel(
      { kind: 'explicit-branch-failed', hasFallbackProvider: true, downstreamDependsOnIt: true },
      1,
    );
    expectLevel(
      { kind: 'explicit-branch-failed', hasFallbackProvider: false, downstreamDependsOnIt: false },
      1,
    );
  });

  it('every signal reaches a defined level (no undefined path)', () => {
    const signals: InterruptSignal[] = [
      { kind: 'branch-failed', idempotent: true, retriesLeft: 0, highStakes: false },
      { kind: 'circuit-open', explicitlyNamed: false },
      { kind: 'intent-conflict', autoResolvable: false },
      { kind: 'task-input-missing' },
      { kind: 'delegation-limit-hit', coveredByContract: false },
      { kind: 'explicit-branch-failed', hasFallbackProvider: false, downstreamDependsOnIt: true },
    ];
    for (const sig of signals) {
      const level = classifyInterruption(sig);
      expect([0, 1, 2]).toContain(level);
      expect(interruptionReason(sig).length).toBeGreaterThan(0);
    }
  });

  it('the interruption levels are audited on the governance spine', () => {
    for (const d of ['interrupt-level-0', 'interrupt-level-1', 'interrupt-level-2'] as const) {
      expect(AUDIT_DECISIONS).toContain(d);
    }
  });
});
