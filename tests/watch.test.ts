import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  WatchRegistry,
  evaluatePredicate,
  type Watch,
  type WatchAuditEntry,
  type WatchSubmitResult,
} from '../src/watch/watch.js';
import { FileKernelStateStore, collectKernelState, applyKernelState } from '../src/state/kernel-state.js';
import type { MetricsSnapshot } from '../src/orchestrator/metrics.js';
import { VassalRegistry } from '../src/registry/registry.js';
import { OversightDesk } from '../src/oversight/oversight.js';
import { Orchestrator } from '../src/orchestrator/orchestrator.js';
import type { DagRunner } from '../src/orchestrator/dag-runner.js';

/**
 * design-self-host-loop §7 step 2: the trigger primitive with the metrics and
 * realm sources. The properties that matter are the ones a trigger can violate
 * silently — firing more than once for one condition, spending budget twice
 * across a restart, or reading "unavailable" as "condition false".
 */

const NOW = new Date('2026-10-05T12:00:00.000Z');

function metrics(overrides: Partial<Record<string, number>> = {}): MetricsSnapshot {
  return {
    inFlight: 0,
    maxInFlight: 0,
    queueDepth: 0,
    finished: 0,
    completed: 0,
    failed: 0,
    timedOut: 0,
    canceled: 0,
    perVassal: {},
    inFlightByVassal: {},
    capturedAt: NOW.toISOString(),
    ...overrides,
  } as MetricsSnapshot;
}

function baseInput(overrides: Partial<Parameters<WatchRegistry['register']>[0]> = {}) {
  return {
    owner: 'operator@bayjf',
    realm: 'personal' as const,
    predicate: { source: 'metrics' as const, op: 'above' as const, field: 'queueDepth', value: 2 },
    intent: { skill: 'review', subject: 'queue is deep', mode: 'plan' as const, maxFanOut: 1 },
    intervalSeconds: 60,
    startsAt: '2026-10-05T11:00:00.000Z',
    expiresAt: '2026-10-05T13:00:00.000Z',
    budget: { fires: 2, executes: 0 },
    ...overrides,
  };
}

/** Minimal real components: collect/apply walk every component, so the round
 *  trip has to be driven by the same shape boot persists. */
function kernelComponents(watches: WatchRegistry): Parameters<typeof collectKernelState>[0] {
  const lookup = { findBySkill: () => [] };
  const port = {
    async dispatch() {
      throw new Error('not dispatched by the snapshot round-trip');
    },
    async cancel() {},
  };
  return {
    registry: new VassalRegistry(),
    oversight: new OversightDesk(),
    orchestrator: new Orchestrator(lookup, port),
    dagRunner: {} as DagRunner,
    watches,
  };
}

describe('watch registration (closed predicate surface)', () => {
  it('refuses a field the source cannot read', () => {
    const registry = new WatchRegistry({ newId: () => 'w1' });
    expect(() =>
      registry.register(baseInput({ predicate: { source: 'metrics', op: 'above', field: 'entryCount', value: 1 } }))
    ).toThrow(/not readable from source 'metrics'/);
  });

  it('refuses an op outside the closed enum and a non-numeric threshold', () => {
    const registry = new WatchRegistry({ newId: () => 'w1' });
    expect(() =>
      registry.register(baseInput({ predicate: { source: 'metrics', op: 'matches' as never, field: 'queueDepth' } }))
    ).toThrow(/predicate\.op/);
    expect(() =>
      registry.register(baseInput({ predicate: { source: 'metrics', op: 'above', field: 'queueDepth', value: '3' as never } }))
    ).toThrow(/numeric predicate\.value/);
  });

  it('refuses an execute watch that does not name a contract (invariant 4)', () => {
    const registry = new WatchRegistry({ newId: () => 'w1' });
    expect(() =>
      registry.register(
        baseInput({
          intent: { skill: 'merge', subject: 'x', mode: 'execute', maxFanOut: 1 },
          budget: { fires: 2, executes: 1 },
        }),
      )
    ).toThrow(
      /delegationId/
    );
  });

  it('refuses an execute watch whose execute budget is not positive', () => {
    const registry = new WatchRegistry({ newId: () => 'w1' });
    expect(() =>
      registry.register(
        baseInput({
          intent: { skill: 'merge', subject: 'x', mode: 'execute', maxFanOut: 1 },
          delegationId: 'contract-1',
        }),
      ),
    ).toThrow(/budget\.executes/);
  });

  it('refuses an inverted window', () => {
    const registry = new WatchRegistry({ newId: () => 'w1' });
    expect(() => registry.register(baseInput({ expiresAt: '2026-10-05T10:00:00.000Z' }))).toThrow(/expiresAt/);
  });
});

describe('predicate evaluation', () => {
  it('treats an unreadable source as unknown, never as false', () => {
    // "unavailable" and "not met" differ in what the operator should do; folding
    // them together is how a watch dies quietly.
    expect(evaluatePredicate({ source: 'metrics', op: 'above', field: 'queueDepth', value: 2 }, { kind: 'unavailable' })).toBeNull();
  });

  it('does not fire on the first changed reading, only on an actual change', () => {
    const predicate = { source: 'realm' as const, op: 'changed' as const, field: 'lastItemModifiedAt' };
    expect(evaluatePredicate(predicate, { kind: 'value', value: 'a' })).toBe(false);
    expect(evaluatePredicate(predicate, { kind: 'value', value: 'b' }, 'a')).toBe(true);
    expect(evaluatePredicate(predicate, { kind: 'value', value: 'b' }, 'b')).toBe(false);
  });
});

describe('a tick over the metrics source', () => {
  it('fires exactly once for one satisfied condition', async () => {
    const registry = new WatchRegistry({ newId: () => 'w1' });
    registry.register(baseInput());
    const submitted: string[] = [];
    const audits: string[] = [];

    const first = await registry.runTick({
      now: () => NOW,
      sources: { metrics: () => metrics({ queueDepth: 5 }) },
      submit: async request => {
        submitted.push(request.intentId);
        return { ok: true };
      },
      audit: entry => audits.push(entry.decision),
    });
    expect(first.fired).toEqual(['w1']);
    expect(submitted).toEqual(['watch:w1:1']);
    expect(audits).toContain('watch-fired');
    expect(registry.get('w1')!.used.fires).toBe(1);
  });

  it('advances the sequence per fire, so a sustained condition is bounded by the budget', async () => {
    // A watch is an interval trigger, not an edge trigger: while the condition
    // holds it fires again each interval, and `budget.fires` is what stops it.
    const registry = new WatchRegistry({ newId: () => 'w1' });
    registry.register(baseInput());
    const submitted: string[] = [];
    const options = {
      now: () => NOW,
      sources: { metrics: () => metrics({ queueDepth: 5 }) },
      submit: async (request: { intentId: string }) => {
        submitted.push(request.intentId);
        return { ok: true };
      },
    };
    await registry.runTick(options);
    await registry.runTick({ ...options, now: () => new Date(NOW.getTime() + 61_000) });
    expect(submitted).toEqual(['watch:w1:1', 'watch:w1:2']);
    expect(registry.get('w1')!.used.fires).toBe(2);
  });

  it('reuses the intent id when the fire was not recorded, so a retry replays instead of dispatching', async () => {
    // The idempotency guarantee: a fire that never landed (submit refused, or a
    // crash before persistence) leaves `used.fires` alone, so the retry carries
    // the same intent id and the orchestrator replays it rather than dispatching
    // a second time.
    const registry = new WatchRegistry({ newId: () => 'w1' });
    registry.register(baseInput());
    const submitted: string[] = [];
    const options = {
      now: () => NOW,
      sources: { metrics: () => metrics({ queueDepth: 5 }) },
      submit: async (request: { intentId: string }): Promise<WatchSubmitResult> => {
        submitted.push(request.intentId);
        return submitted.length === 1 ? { ok: false, reason: 'gateway refused' } : { ok: true, replayed: true };
      },
    };
    await registry.runTick(options);
    await registry.runTick({ ...options, now: () => new Date(NOW.getTime() + 61_000) });
    expect(submitted).toEqual(['watch:w1:1', 'watch:w1:1']);
    expect(registry.get('w1')!.used.fires).toBe(1);
  });

  it('stops firing once the budget is spent', async () => {
    const registry = new WatchRegistry({ newId: () => 'w1' });
    registry.register(baseInput({ budget: { fires: 1, executes: 0 } }));
    const options = {
      now: () => NOW,
      sources: { metrics: () => metrics({ queueDepth: 5 }) },
      submit: async () => ({ ok: true }),
    };
    await registry.runTick(options);
    const second = await registry.runTick({ ...options, now: () => new Date(NOW.getTime() + 61_000) });
    expect(second.evaluated).toBe(0);
    expect(registry.get('w1')!.used.fires).toBe(1);
  });

  it('reports an unreadable source and disables the watch after the threshold', async () => {
    const registry = new WatchRegistry({ newId: () => 'w1' });
    registry.register(baseInput());
    const audits: string[] = [];
    const options = {
      now: () => NOW,
      sources: {}, // no metrics source: unreadable, not false
      submit: async () => ({ ok: true }),
      audit: (entry: WatchAuditEntry) => audits.push(entry.decision),
      maxEvalFailures: 2,
    };
    const first = await registry.runTick(options);
    expect(first.unavailable).toEqual(['w1']);
    expect(first.fired).toEqual([]);
    expect(registry.get('w1')!.enabled).toBe(true);

    const second = await registry.runTick({ ...options, now: () => new Date(NOW.getTime() + 61_000) });
    expect(second.autoDisabled).toEqual(['w1']);
    expect(registry.get('w1')!.enabled).toBe(false);
    expect(audits).toContain('watch-eval-unavailable');
    expect(audits).toContain('watch-auto-disabled');
  });

  it('fails closed on an execute fire with no trust anchor and escalates instead of dispatching', async () => {
    const registry = new WatchRegistry({ newId: () => 'we' });
    registry.register(
      baseInput({
        intent: { skill: 'merge', subject: 'x', mode: 'execute', maxFanOut: 1 },
        delegationId: 'contract-1',
        budget: { fires: 2, executes: 1 },
      })
    );
    let submissions = 0;
    const escalations: Array<{ reason: string; tickSeq: number }> = [];
    const audits: string[] = [];
    const report = await registry.runTick({
      now: () => NOW,
      sources: { metrics: () => metrics({ queueDepth: 5 }) },
      escalateLimit: input => escalations.push({ reason: input.reason, tickSeq: input.tickSeq }),
      audit: entry => audits.push(entry.decision),
      submit: async () => {
        submissions += 1;
        return { ok: true };
      },
    });
    // No derive hook assembled = no trust anchor: zero outbound, desk escalation.
    expect(report.fired).toEqual([]);
    expect(submissions).toBe(0);
    expect(registry.get('we')!.used.fires).toBe(0);
    expect(escalations).toEqual([{ reason: 'no-trust-anchor', tickSeq: 1 }]);
    expect(audits).toContain('delegation-limit-exceeded');
  });
});

describe('connector source (step 3)', () => {
  const connectorInput = (overrides: Partial<Parameters<WatchRegistry['register']>[0]> = {}) =>
    baseInput({
      predicate: { source: 'connector', op: 'above', field: 'queue.depth', value: 2 },
      connector: { id: 'conn-1', tool: 'realm.search', args: { query: 'x' } },
      ...overrides,
    });

  it('refuses a field that is not a bounded path', () => {
    const registry = new WatchRegistry({ newId: () => 'wc' });
    for (const field of ['queue[0]', 'queue.*', 'a.b.c.d.e', 'queue .depth', '']) {
      expect(() => registry.register(connectorInput({ predicate: { source: 'connector', op: 'present', field } }))).toThrow(
        /bounded dot-path/
      );
    }
  });

  it('refuses a connector watch that does not name the tool it reads', () => {
    const registry = new WatchRegistry({ newId: () => 'wc' });
    expect(() => registry.register(connectorInput({ connector: { id: 'conn-1', tool: '' } }))).toThrow(/tool it reads/);
  });

  it('fires when a healthy upstream really returns a matching value', async () => {
    // Positive control: without a firing healthy case, "jitter does not fire"
    // proves nothing — every implementation passes it by never firing at all.
    const registry = new WatchRegistry({ newId: () => 'wc' });
    registry.register(connectorInput());
    const calls: Array<{ id: string; tool: string }> = [];
    const report = await registry.runTick({
      now: () => NOW,
      sources: {
        connector: async ref => {
          calls.push({ id: ref.id, tool: ref.tool });
          return { queue: { depth: 7 } };
        },
      },
      submit: async (): Promise<WatchSubmitResult> => ({ ok: true }),
    });
    expect(report.fired).toEqual(['wc']);
    expect(calls).toEqual([{ id: 'conn-1', tool: 'realm.search' }]);
  });

  it('reports a jittering connector as unavailable and does not fire', async () => {
    const registry = new WatchRegistry({ newId: () => 'wc' });
    registry.register(connectorInput());
    const audits: string[] = [];
    const report = await registry.runTick({
      now: () => NOW,
      sources: {
        connector: async () => {
          throw new Error('connector unreachable');
        },
      },
      submit: async (): Promise<WatchSubmitResult> => ({ ok: true }),
      audit: (entry: WatchAuditEntry) => audits.push(entry.decision),
    });
    expect(report.unavailable).toEqual(['wc']);
    expect(report.fired).toEqual([]);
    expect(audits).toContain('watch-eval-unavailable');
  });

  it('treats a non-scalar or missing path as unreadable', async () => {
    const registry = new WatchRegistry({ newId: () => 'wc' });
    registry.register(connectorInput({ predicate: { source: 'connector', op: 'present', field: 'queue' } }));
    const report = await registry.runTick({
      now: () => NOW,
      sources: { connector: async () => ({ queue: { depth: 1 } }) },
      submit: async (): Promise<WatchSubmitResult> => ({ ok: true }),
    });
    // An object is not a reading, and an empty object is not "absent".
    expect(report.unavailable).toEqual(['wc']);
    expect(report.fired).toEqual([]);
  });

  it('is unreadable when no connector registry is assembled', async () => {
    const registry = new WatchRegistry({ newId: () => 'wc' });
    registry.register(connectorInput());
    const report = await registry.runTick({
      now: () => NOW,
      sources: {},
      submit: async (): Promise<WatchSubmitResult> => ({ ok: true }),
    });
    expect(report.unavailable).toEqual(['wc']);
  });
});

describe('watches survive a restart', () => {
  it('restores the spent budget and lastFiredAt from the snapshot file', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'zeus-watch-'));
    try {
      const registry = new WatchRegistry({ newId: () => 'w1' });
      registry.register(baseInput());
      await registry.runTick({
        now: () => NOW,
        sources: { metrics: () => metrics({ queueDepth: 5 }) },
        submit: async () => ({ ok: true }),
      });
      expect(registry.get('w1')!.used.fires).toBe(1);

      const file = join(sandbox, 'state.json');
      const store = new FileKernelStateStore(file);
      const components = kernelComponents(registry);
      await store.save(collectKernelState(components));

      // The field must reach the file, not only the in-memory collector.
      const persisted = JSON.parse(await readFile(file, 'utf8')) as { watches?: Watch[] };
      expect(persisted.watches?.[0]?.used).toEqual({ fires: 1, executes: 0 });
      expect(persisted.watches?.[0]?.lastFiredAt).toBe(NOW.toISOString());

      const restored = new WatchRegistry();
      applyKernelState(kernelComponents(restored), (await store.load())!);
      expect(restored.get('w1')!.used.fires).toBe(1);
      expect(restored.get('w1')!.lastFiredAt).toBe(NOW.toISOString());
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });
});

describe('realm source', () => {
  it('reads entry metadata through the store and fires on a change', async () => {
    const registry = new WatchRegistry({ newId: () => 'wr' });
    registry.register({
      ...baseInput(),
      realmId: 'realm-1',
      predicate: { source: 'realm', op: 'above', field: 'entryCount', value: 1 },
    });
    const report = await registry.runTick({
      now: () => NOW,
      sources: { realm: async () => ({ entryCount: 3, lastItemModifiedAt: '2026-10-05T11:00:00.000Z' }) },
      submit: async (): Promise<WatchSubmitResult> => ({ ok: true }),
    });
    expect(report.fired).toEqual(['wr']);
  });

  it('reports unavailable, and never fires, when the realm is not mounted', async () => {
    const registry = new WatchRegistry({ newId: () => 'wr' });
    registry.register({
      ...baseInput(),
      predicate: { source: 'realm', op: 'above', field: 'entryCount', value: 1 },
    });
    const report = await registry.runTick({
      now: () => NOW,
      sources: { realm: async () => ({ entryCount: 3 }) },
      submit: async (): Promise<WatchSubmitResult> => ({ ok: true }),
    });
    // realmId missing: unreadable, so no fire — a watch on an unmounted realm
    // must not look like a satisfied condition.
    expect(report.unavailable).toEqual(['wr']);
    expect(report.fired).toEqual([]);
  });
});

/**
 * design-self-host-loop §7 step 4: an unattended execute fire derives a
 * one-time child ticket from its named contract. The derive hook is the
 * kernel's job; here it is injected so the watch's own guarantees are tested
 * directly: ticket handed to submit, ceilings escalate with zero outbound,
 * and the watch-local execute budget refuses before a contract slot is spent.
 */
describe('execute fires derive a child ticket (step 4)', () => {
  const executeInput = (overrides: Partial<Parameters<WatchRegistry['register']>[0]> = {}) =>
    baseInput({
      intent: { skill: 'merge', subject: 'x', mode: 'execute', maxFanOut: 1 },
      delegationId: 'contract-1',
      budget: { fires: 3, executes: 2 },
      ...overrides,
    });

  it('hands a derived ticket to submit and spends the execute budget once', async () => {
    const registry = new WatchRegistry({ newId: () => 'w1' });
    registry.register(executeInput());
    const submitted: Array<{ mode: string; executionDelegation?: unknown }> = [];
    let deriveCalls = 0;
    const ticket = { nonce: 'ticket-1' };
    await registry.runTick({
      now: () => NOW,
      sources: { metrics: () => metrics({ queueDepth: 5 }) },
      deriveExecution: async () => {
        deriveCalls += 1;
        return { ok: true, delegation: ticket };
      },
      submit: async request => {
        submitted.push({ mode: request.mode, executionDelegation: request.executionDelegation });
        return { ok: true };
      },
    });
    expect(deriveCalls).toBe(1);
    expect(submitted).toEqual([{ mode: 'execute', executionDelegation: ticket }]);
    expect(registry.get('w1')!.used).toEqual({ fires: 1, executes: 1 });
  });

  it('escalates with zero outbound when derivation is refused by a ceiling', async () => {
    const registry = new WatchRegistry({ newId: () => 'w1' });
    registry.register(executeInput());
    let submissions = 0;
    const escalations: string[] = [];
    const audits: string[] = [];
    const report = await registry.runTick({
      now: () => NOW,
      sources: { metrics: () => metrics({ queueDepth: 5 }) },
      deriveExecution: async () => ({ ok: false, reason: 'child-ticket-limit-reached' }),
      escalateLimit: input => escalations.push(input.reason),
      audit: entry => audits.push(entry.decision),
      submit: async () => {
        submissions += 1;
        return { ok: true };
      },
    });
    expect(report.fired).toEqual([]);
    expect(submissions).toBe(0);
    expect(escalations).toEqual(['child-ticket-limit-reached']);
    expect(audits).toContain('delegation-limit-exceeded');
    expect(registry.get('w1')!.used.executes).toBe(0);
  });

  it('refuses an execute-budget-exhausted fire without asking for a ticket', async () => {
    const registry = new WatchRegistry({ newId: () => 'w1' });
    registry.register(executeInput({ budget: { fires: 3, executes: 1 } }));
    let deriveCalls = 0;
    let submissions = 0;
    const escalations: string[] = [];
    let tickOffsetMs = 0;
    const tick = (): Promise<unknown> =>
      registry.runTick({
        // Each pass advances past intervalSeconds so the watch is re-evaluated;
        // the same wall time would be throttled regardless of budget.
        now: () => new Date(NOW.getTime() + (tickOffsetMs += 60_000)),
        sources: { metrics: () => metrics({ queueDepth: 5 }) },
        deriveExecution: async () => {
          deriveCalls += 1;
          return { ok: true, delegation: { nonce: `ticket-${deriveCalls}` } };
        },
        escalateLimit: input => escalations.push(input.reason),
        submit: async () => {
          submissions += 1;
          return { ok: true };
        },
      });
    await tick();
    expect(deriveCalls).toBe(1);
    // A second interval with the condition still held: the watch fire budget
    // allows it, but the execute ceiling refuses before any contract slot is
    // spent, so the contract's own limits are never touched.
    await tick();
    expect(deriveCalls).toBe(1);
    expect(submissions).toBe(1);
    expect(escalations).toEqual(['execute-budget-exhausted']);
  });

  it('dedupes the same refused tick at the desk across replays', async () => {
    const desk = new OversightDesk();
    const first = desk.ingestDelegationLimit({
      watchId: 'w1',
      delegationId: 'contract-1',
      skill: 'merge',
      realm: 'personal',
      limitReason: 'revoked',
      tickSeq: 1,
    });
    const replay = desk.ingestDelegationLimit({
      watchId: 'w1',
      delegationId: 'contract-1',
      skill: 'merge',
      realm: 'personal',
      limitReason: 'revoked',
      tickSeq: 1,
    });
    expect(replay.id).toBe(first.id);
    expect(desk.list(undefined, 'delegation-limit')).toHaveLength(1);
    // A different tick sequence is a new refusal, not a replay.
    const next = desk.ingestDelegationLimit({
      watchId: 'w1',
      delegationId: 'contract-1',
      skill: 'merge',
      realm: 'personal',
      limitReason: 'revoked',
      tickSeq: 2,
    });
    expect(next.id).not.toBe(first.id);
    expect(desk.list(undefined, 'delegation-limit')).toHaveLength(2);
  });
});

describe('watch contract rebinding (step 5)', () => {
  const executeInput = (overrides: Partial<Parameters<WatchRegistry['register']>[0]> = {}) =>
    baseInput({
      intent: { skill: 'merge', subject: 'x', mode: 'execute', maxFanOut: 1 },
      delegationId: 'contract-1',
      budget: { fires: 3, executes: 2 },
      ...overrides,
    });

  it('rebinds an existing watch to a freshly issued contract without touching the budget', () => {
    const registry = new WatchRegistry({ newId: () => 'w1' });
    registry.register(executeInput());
    const rebound = registry.bindDelegation('w1', 'contract-2');
    expect(rebound?.delegationId).toBe('contract-2');
    expect(registry.get('w1')!.delegationId).toBe('contract-2');
    // Only the delegation reference moves; approval must not reset spent budgets.
    expect(registry.get('w1')!.used).toEqual({ fires: 0, executes: 0 });
    expect(registry.get('w1')!.budget).toEqual({ fires: 3, executes: 2 });
    expect(registry.get('w1')!.enabled).toBe(true);
  });

  it('returns undefined for an unknown watch and rejects a blank contract id', () => {
    const registry = new WatchRegistry({ newId: () => 'w1' });
    registry.register(executeInput());
    expect(registry.bindDelegation('missing', 'contract-2')).toBeUndefined();
    expect(() => registry.bindDelegation('w1', '   ')).toThrow(/non-empty/);
  });
});
