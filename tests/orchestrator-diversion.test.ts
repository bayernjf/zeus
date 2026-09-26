import { describe, it, expect } from 'vitest';
import { selectTargets, formatExhausted, type DiversionInput } from '../src/orchestrator/diversion.js';
import { ConcurrencyMetrics } from '../src/orchestrator/metrics.js';
import { Orchestrator } from '../src/orchestrator/orchestrator.js';
import type { DispatchPort } from '../src/orchestrator/types.js';
import type { RealmType } from '../src/a2a/types.js';

const REALM: RealmType = 'personal';

/** Build a selectTargets input with a fixed load/metric/health snapshot. */
function input(overrides: Partial<DiversionInput> & Pick<DiversionInput, 'initialNames' | 'candidatePool'>): DiversionInput {
  return {
    skill: 'code',
    load: {
      inFlightByVassal: () => 0,
      capOf: () => 1,
    },
    metrics: {
      failureRate: () => 0,
      p50Ms: () => null,
    },
    health: { statusOf: () => 'active' },
    ...overrides,
  };
}

describe('selectTargets (#9 backpressure diversion)', () => {
  it('diverts a saturated target to an available same-skill provider', () => {
    const result = selectTargets(input({
      initialNames: ['A'],
      candidatePool: ['A', 'B'],
      load: {
        inFlightByVassal: v => (v === 'A' ? 1 : 0),
        capOf: () => 1,
      },
    }));
    expect(result.plan).toEqual([{ target: 'B', divertedFrom: 'A' }]);
    expect(result.exhausted).toBeNull();
  });

  it('reorders candidates by reliability, preferring the lower failure rate', () => {
    const result = selectTargets(input({
      initialNames: ['A'],
      candidatePool: ['A', 'B', 'C'],
      load: {
        inFlightByVassal: v => (v === 'A' ? 1 : 0),
        capOf: () => 1,
      },
      metrics: {
        failureRate: v => (v === 'A' ? 0.5 : v === 'B' ? 0.1 : 0.3),
        p50Ms: () => 100,
      },
    }));
    // B (0.1 failure) outranks C (0.3); A is saturated and skipped.
    expect(result.plan).toEqual([{ target: 'B', divertedFrom: 'A' }]);
  });

  it('does not divert an explicit hard-pinned target even when saturated', () => {
    const result = selectTargets(input({
      explicitVassals: ['A'],
      initialNames: ['A'],
      candidatePool: ['A', 'B'],
      load: {
        inFlightByVassal: v => (v === 'A' ? 1 : 0),
        capOf: () => 1,
      },
    }));
    expect(result.plan).toEqual([{ target: 'A', divertedFrom: null }]);
    expect(result.exhausted).toBeNull();
  });

  it('falls back to the global gate when every candidate is saturated, with an audit trail', () => {
    const result = selectTargets(input({
      initialNames: ['A'],
      candidatePool: ['A', 'B'],
      load: {
        inFlightByVassal: () => 1,
        capOf: () => 1,
      },
    }));
    // No alternate: original target kept so it hits the semaphore queue→reject gate.
    expect(result.plan).toEqual([{ target: 'A', divertedFrom: null }]);
    expect(result.exhausted).not.toBeNull();
    expect(result.exhausted!.skill).toBe('code');
    expect(result.exhausted!.tried).toEqual([
      { vassal: 'A', state: 'saturated' },
      { vassal: 'B', state: 'saturated' },
    ]);
  });

  it('excludes revoked and unhealthy (unknown) providers from candidacy', () => {
    const result = selectTargets(input({
      initialNames: ['A'],
      candidatePool: ['A', 'B', 'C'],
      load: {
        inFlightByVassal: v => (v === 'A' ? 1 : 0),
        capOf: () => 1,
      },
      health: {
        statusOf: v => (v === 'B' ? 'revoked' : v === 'C' ? 'unknown' : 'active'),
      },
    }));
    // A saturated, B revoked, C unhealthy → no eligible alternate.
    expect(result.plan).toEqual([{ target: 'A', divertedFrom: null }]);
    expect(result.exhausted).not.toBeNull();
    const states = Object.fromEntries(result.exhausted!.tried.map(t => [t.vassal, t.state]));
    expect(states).toEqual({ A: 'saturated', B: 'revoked', C: 'unhealthy' });
  });

  it('formatExhausted renders the tried-candidate states for a refusal reason', () => {
    const text = formatExhausted({
      skill: 'code',
      tried: [
        { vassal: 'A', state: 'saturated' },
        { vassal: 'B', state: 'revoked' },
      ],
    });
    expect(text).toContain("no alternate provider for skill 'code'");
    expect(text).toContain('A[saturated]');
    expect(text).toContain('B[revoked]');
  });
});

describe('orchestrator wiring (#9 diversion event + per-vassal load)', () => {
  function makeDispatcher() {
    const aGate = deferred<void>();
    const port: DispatchPort = {
      dispatch: req =>
        req.vassal === 'A'
          ? new Promise(resolve =>
              aGate.promise.then(() =>
                resolve({ ok: true, task: okTask(req.runId ?? 'A'), events: [], injectedHits: [] })
              )
            )
          : Promise.resolve({ ok: true, task: okTask(req.runId ?? req.vassal ?? 'B'), events: [], injectedHits: [] }),
      cancel: async () => undefined,
    };
    return { port, releaseA: () => aGate.resolve() };
  }

  it('emits branch-diverted and keeps the per-vassal in-flight count when a target saturates', async () => {
    const { port, releaseA } = makeDispatcher();
    const metrics = new ConcurrencyMetrics();
    const diverted: Array<{ from: string; to: string }> = [];
    const orchestrator = new Orchestrator(
      { findBySkill: () => [{ name: 'A' }, { name: 'B' }], statusOf: () => 'active' },
      port,
      {
        now: () => new Date('2026-09-27T00:00:00Z'),
        newIntentId: () => `intent-${Math.random()}`,
        newRunId: () => `run-${Math.random()}`,
        metrics,
        maxConcurrentBranches: 4,
        maxConcurrentPerVassal: 1,
        skillGovernor: { activeProviders: () => ['A', 'B'] },
        onDiverted: e => diverted.push({ from: e.from, to: e.to }),
      }
    );

    const req = (id: string) => ({
      intentId: id,
      skill: 'code',
      params: {},
      realm: REALM,
    });

    // First fan-out: A hangs in flight (saturated), B completes.
    const first = orchestrator.fanOut(req('i1'));
    // Give the in-flight bookkeeping a tick to register A before the second call.
    await new Promise(r => setTimeout(r, 0));

    // Second fan-out: A is saturated → diverted to B.
    const second = await orchestrator.fanOut(req('i2'));

    expect(diverted).toContainEqual({ from: 'A', to: 'B' });
    // A stayed in flight (saturated) across the second dispatch.
    expect(metrics.inFlightByVassalNow('A')).toBeGreaterThanOrEqual(1);
    expect(second.branches.some(b => b.vassal === 'B')).toBe(true);

    releaseA();
    await first;
  });
});

function okTask(id: string) {
  return {
    kind: 'task' as const,
    id,
    contextId: id,
    status: { state: 'completed' as const },
    artifacts: [],
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
