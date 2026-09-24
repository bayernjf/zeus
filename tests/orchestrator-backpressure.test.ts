import { describe, expect, it } from 'vitest';
import { Orchestrator, type OrchestratorOptions } from '../src/orchestrator/orchestrator.js';
import { ConcurrencyMetrics } from '../src/orchestrator/metrics.js';
import type { DispatchPort, TargetLookup } from '../src/orchestrator/types.js';
import type { DispatchRequest, DispatchResult } from '../src/dispatch/dispatcher.js';
import type { A2AEvent, Task } from '../src/a2a/types.js';

function statusEvent(taskId: string): A2AEvent {
  return { kind: 'status-update', taskId, contextId: 'ctx', status: { state: 'completed' }, final: true };
}

function done(vassal: string): DispatchResult {
  const task: Task = {
    kind: 'task', id: `${vassal}-t`, contextId: 'ctx', status: { state: 'completed' },
    artifacts: [{ artifactId: 'a', name: 'r', parts: [{ kind: 'data', data: { stance: 'go' } }] }],
  };
  return { ok: true, task, events: [statusEvent(task.id)], injectedHits: [] };
}

/** Drain the queue until every pending branch transition has run. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await new Promise(resolve => setImmediate(resolve));
}

/** Dispatches stay open until the test releases them, making concurrency observable. */
function gatedPort() {
  const waiting: Array<{ vassal: string; finish: (result: DispatchResult) => void }> = [];
  const started: string[] = [];
  let active = 0;
  let maxActive = 0;
  const port: DispatchPort = {
    async dispatch(req: DispatchRequest) {
      started.push(req.vassal!);
      active += 1;
      maxActive = Math.max(maxActive, active);
      return new Promise<DispatchResult>(resolve => {
        waiting.push({ vassal: req.vassal!, finish: result => { active -= 1; resolve(result); } });
      });
    },
    async cancel() {},
  };
  return {
    port,
    started,
    get pending() { return waiting.length; },
    get active() { return active; },
    get maxActive() { return maxActive; },
    releaseOne(result?: DispatchResult) {
      const next = waiting.shift();
      if (!next) throw new Error(`nothing in flight to release (started: ${started.join(',')})`);
      next.finish(result ?? done(next.vassal));
    },
    /** Finish whatever is in flight, letting queued branches take the freed slots. */
    async drain() {
      for (let guard = 0; guard < 100 && waiting.length > 0; guard += 1) {
        this.releaseOne();
        await flush();
      }
    },
  };
}

function lookupFor(names: string[]): TargetLookup {
  return { findBySkill: () => names.map(name => ({ name })) };
}

function build(names: string[], options: OrchestratorOptions = {}) {
  const gated = gatedPort();
  const metrics = new ConcurrencyMetrics();
  const orchestrator = new Orchestrator(lookupFor(names), gated.port, {
    metrics,
    newIntentId: () => 'intent-1',
    newRunId: () => 'run-1',
    ...options,
  });
  return { gated, metrics, orchestrator };
}

const request = { skill: 'review', realm: 'personal' as const, params: {} };
const SIX = ['a', 'b', 'c', 'd', 'e', 'f'];

describe('E1.5 bounded fan-out', () => {
  it('holds the cap and reports a real queue depth while branches wait', async () => {
    const { gated, metrics, orchestrator } = build(SIX, { maxConcurrentBranches: 2 });
    const running = orchestrator.fanOut(request);
    await flush();

    expect(gated.maxActive).toBe(2);
    expect(metrics.snapshot()).toMatchObject({ inFlight: 2, queueDepth: 4 });

    await gated.drain();
    const result = await running;
    expect(result.branches).toHaveLength(6);
    expect(result.branches.every(b => b.ok)).toBe(true);
    expect(result.status).toBe('completed');
    expect(gated.started).toHaveLength(6);
    // two at a time was the ceiling for the whole run
    expect(gated.maxActive).toBe(2);
    expect(metrics.snapshot().queueDepth).toBe(0);
  });

  it('dispatches everything at once when no cap is configured', async () => {
    const { gated, metrics, orchestrator } = build(SIX);
    const running = orchestrator.fanOut(request);
    await flush();

    expect(gated.maxActive).toBe(6);
    expect(metrics.snapshot().queueDepth).toBe(0);
    await gated.drain();
    expect((await running).status).toBe('completed');
  });

  it('refuses branches with a reason once the wait line is full, without dispatching them', async () => {
    const { gated, metrics, orchestrator } = build(SIX, { maxConcurrentBranches: 1, branchQueueLimit: 2 });
    const running = orchestrator.fanOut(request);
    await flush();

    // 1 in flight, 2 queued; the other 3 refused before ever reaching a vassal
    expect(gated.started).toEqual(['a']);
    expect(metrics.snapshot()).toMatchObject({ inFlight: 1, queueDepth: 2 });

    await gated.drain();
    const result = await running;
    const refused = result.branches.filter(b => !b.ok && /concurrency limit 1 reached/.test(b.reason ?? ''));
    expect(refused).toHaveLength(3);
    expect(refused.every(b => b.events.length === 0)).toBe(true);
    expect(result.branches.filter(b => b.ok)).toHaveLength(3);
    expect(result.status).toBe('partial');
    // every lease came back: nothing is left counted as waiting
    expect(metrics.snapshot().queueDepth).toBe(0);
  });

  it('refuses immediately rather than queueing when the limit is zero', async () => {
    const { gated, orchestrator } = build(['a', 'b', 'c'], { maxConcurrentBranches: 1, branchQueueLimit: 0 });
    const running = orchestrator.fanOut(request);
    await flush();
    expect(gated.started).toEqual(['a']);

    await gated.drain();
    const result = await running;
    expect(result.branches.filter(b => b.ok)).toHaveLength(1);
    expect(result.branches.filter(b => !b.ok)).toHaveLength(2);
  });

  it('returns the slot when a branch fails, so the kernel cannot wedge', async () => {
    const { gated, orchestrator } = build(['a', 'b', 'c'], { maxConcurrentBranches: 1 });
    const running = orchestrator.fanOut(request);
    await flush();

    // The dispatcher rejected this branch; the lease must still come back.
    gated.releaseOne({
      ok: false,
      reason: 'upstream exploded',
      audit: { ts: 't', vassal: 'a', decision: 'dispatch-failed' },
    });
    await flush();
    expect(gated.started).toEqual(['a', 'b']);

    await gated.drain();
    const result = await running;
    expect(result.branches.map(b => b.vassal)).toEqual(['a', 'b', 'c']);
    expect(result.branches.map(b => b.ok)).toEqual([false, true, true]);
  });

  it('gates resumed branches the same way', async () => {
    const { gated, orchestrator } = build(['a', 'b'], { maxConcurrentBranches: 1 });
    const first = orchestrator.fanOut({ ...request, intentId: 'intent-1' });
    await flush();
    expect(gated.started).toEqual(['a']);
    await gated.drain();
    expect((await first).status).toBe('completed');
    expect(gated.started).toEqual(['a', 'b']);

    const resumed = orchestrator.resumeBranch('intent-1', 'a', { extra: 1 });
    await flush();
    expect(gated.active).toBe(1);
    expect(gated.started.filter(name => name === 'a')).toHaveLength(2);
    await gated.drain();
    expect((await resumed).branches.find(b => b.vassal === 'a')?.ok).toBe(true);
  });
});
