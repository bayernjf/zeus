import { describe, expect, it } from 'vitest';
import { Orchestrator } from '../src/orchestrator/orchestrator.js';
import { MemoryStore } from '../src/memory/memory-store.js';
import type { DispatchPort, TargetLookup } from '../src/orchestrator/types.js';
import type { DispatchRequest, DispatchResult } from '../src/dispatch/dispatcher.js';
import type { A2AEvent, Task } from '../src/a2a/types.js';

/**
 * deferred #44 (design-memory-self-evolution §2.2 / §九, D2): the runtime
 * write-back wiring. Active selection-weight cards for a realm feed
 * `selectCandidates` (weights), and the auto dispatch list follows the
 * selected face order — so a down-weighted vassal is dispatched later, and a
 * retracted card restores the baseline order (reversibility is structural).
 */

function done(vassal: string): DispatchResult {
  const task: Task = {
    kind: 'task', id: `${vassal}-t`, contextId: 'ctx', status: { state: 'completed' },
    artifacts: [{ artifactId: 'a', name: 'r', parts: [{ kind: 'data', data: { stance: 'go' } }] }],
  };
  const event: A2AEvent = { kind: 'status-update', taskId: task.id, contextId: 'ctx', status: { state: 'completed' }, final: true };
  return { ok: true, task, events: [event], injectedHits: [] };
}

function immediatePort(started: string[] = []) {
  const port: DispatchPort = {
    async dispatch(req: DispatchRequest) {
      started.push(req.vassal!);
      return done(req.vassal!);
    },
    async cancel() {},
  };
  return port;
}

function lookupFor(names: string[]): TargetLookup {
  return { findBySkill: () => names.map(name => ({ name })) };
}

function build(names: string[], options: ConstructorParameters<typeof Orchestrator>[2] = {}) {
  const started: string[] = [];
  const orchestrator = new Orchestrator(lookupFor(names), immediatePort(started), {
    now: () => new Date('2026-10-14T00:00:00.000Z'),
    newIntentId: () => 'intent-1',
    newRunId: () => 'run-1',
    ...options,
  });
  return { orchestrator, started };
}

describe('deferred #44 — runtime write-back wiring at fanOut', () => {
  it('baseline: no provider → auto dispatch follows the lookup order', async () => {
    const { orchestrator, started } = build(['a', 'b']);
    const result = await orchestrator.fanOut({ skill: 'review', realm: 'personal', realmId: 'r1', params: {} });
    expect(started).toEqual(['a', 'b']);
    expect(result.branches.map(b => b.vassal)).toEqual(['a', 'b']);
  });

  it('baseline: provider present but no realmId → no weights applied (realm-scoped cards)', async () => {
    const { orchestrator, started } = build(['a', 'b'], {
      selectionWeightsProvider: () => ({ a: 0.5, b: 1 }),
    });
    const result = await orchestrator.fanOut({ skill: 'review', realm: 'personal', params: {} });
    expect(started).toEqual(['a', 'b']);
    expect(result.branches.map(b => b.vassal)).toEqual(['a', 'b']);
  });

  it('active cards re-order the auto pool by factor (higher weight dispatches first)', async () => {
    const { orchestrator, started } = build(['a', 'b'], {
      selectionWeightsProvider: realmId => (realmId === 'r1' ? { a: 0.5, b: 1 } : {}),
    });
    const result = await orchestrator.fanOut({ skill: 'review', realm: 'personal', realmId: 'r1', params: {} });
    expect(started).toEqual(['b', 'a']);
    expect(result.branches.map(b => b.vassal)).toEqual(['b', 'a']);
  });

  it('named pins stay first regardless of weights (D2: sorting applies to the auto pool only)', async () => {
    const { orchestrator, started } = build(['a', 'b'], {
      selectionWeightsProvider: () => ({ a: 0.5, b: 1 }),
    });
    const result = await orchestrator.fanOut({
      skill: 'review', realm: 'personal', realmId: 'r1', params: {}, vassals: ['a'],
    });
    expect(started).toEqual(['a']);
    expect(result.branches.map(b => b.vassal)).toEqual(['a']);
  });

  it('boot contract: MemoryStore.selectionWeights(realmId) feeds the provider', async () => {
    const memory = new MemoryStore(() => {});
    memory.recordWriteback({
      realmId: 'r1', source: { kind: 'reflection', target: 'a', confidence: 'stable' },
      param: 'selection-weight', target: 'a', factor: 0.5, reason: 'test card',
    });
    const { orchestrator, started } = build(['a', 'b'], {
      selectionWeightsProvider: realmId => memory.selectionWeights(realmId),
    });
    const result = await orchestrator.fanOut({ skill: 'review', realm: 'personal', realmId: 'r1', params: {} });
    expect(started).toEqual(['b', 'a']);
    expect(result.branches.map(b => b.vassal)).toEqual(['b', 'a']);
  });

  it('retracting the card restores the baseline order (reversibility is structural)', async () => {
    const memory = new MemoryStore(() => {});
    const card = memory.recordWriteback({
      realmId: 'r1', source: { kind: 'reflection', target: 'a', confidence: 'stable' },
      param: 'selection-weight', target: 'a', factor: 0.5, reason: 'test card',
    });
    memory.retractWriteback(card.id);
    const { orchestrator, started } = build(['a', 'b'], {
      selectionWeightsProvider: realmId => memory.selectionWeights(realmId),
    });
    const result = await orchestrator.fanOut({ skill: 'review', realm: 'personal', realmId: 'r1', params: {} });
    expect(started).toEqual(['a', 'b']);
    expect(result.branches.map(b => b.vassal)).toEqual(['a', 'b']);
  });
});
