import { describe, expect, it } from 'vitest';
import { ConcurrencyMetrics, percentile } from '../src/orchestrator/metrics.js';
import { Orchestrator } from '../src/orchestrator/orchestrator.js';
import type { DispatchPort, TargetLookup } from '../src/orchestrator/types.js';
import type { DispatchRequest, DispatchResult } from '../src/dispatch/dispatcher.js';
import type { A2AEvent, Task, TaskState } from '../src/a2a/types.js';

function statusEvent(taskId: string, state: TaskState): A2AEvent {
  return { kind: 'status-update', taskId, contextId: 'ctx', status: { state }, final: state === 'completed' };
}
function ok(vassal: string, state: TaskState = 'completed'): DispatchResult {
  const task: Task = { kind: 'task', id: `${vassal}-t`, contextId: 'ctx', status: { state }, artifacts: [] };
  return { ok: true, task, events: [statusEvent(task.id, state)], injectedHits: [] };
}
function failed(): DispatchResult {
  return { ok: false, reason: 'boom', audit: { ts: 't', vassal: 'v', decision: 'dispatch-failed' } };
}
function portFor(routes: Record<string, DispatchResult>): DispatchPort {
  return {
    async dispatch(req) {
      return routes[req.vassal!];
    },
    async cancel() {},
  };
}
function lookup(names: string[]): TargetLookup {
  return { findBySkill: () => names.map(name => ({ name })) };
}

describe('percentile', () => {
  it('computes nearest-rank percentiles', () => {
    const sorted = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    expect(percentile(sorted, 50)).toBe(50);
    expect(percentile(sorted, 95)).toBe(100);
    expect(percentile([42], 95)).toBe(42);
    expect(percentile([], 50)).toBe(0);
  });
});

describe('ConcurrencyMetrics collector', () => {
  it('tracks queue depth, in-flight, peak concurrency and per-vassal stats', () => {
    let mono = 0;
    const metrics = new ConcurrencyMetrics({ elapsed: () => (mono += 10) });
    expect(metrics.snapshot().queueDepth).toBe(0);

    metrics.enqueue();
    metrics.enqueue();
    expect(metrics.snapshot().queueDepth).toBe(2);

    metrics.branchStarted({ intentId: 'i', runId: 'r:a', vassal: 'a', skill: 's', startedAt: 't' });
    metrics.branchStarted({ intentId: 'i', runId: 'r:b', vassal: 'b', skill: 's', startedAt: 't' });
    const active = metrics.snapshot();
    expect(active.inFlight).toBe(2);
    expect(active.maxInFlight).toBe(2);
    expect(active.queueDepth).toBe(0);

    metrics.branchEnded('i', 'r:a', 'a', 'completed');
    metrics.branchEnded('i', 'r:b', 'b', 'failed');
    const done = metrics.snapshot();
    expect(done.inFlight).toBe(0);
    expect(done.finished).toBe(2);
    expect(done.completed).toBe(1);
    expect(done.failed).toBe(1);
    expect(done.perVassal.a).toMatchObject({ calls: 1, completed: 1, failureRate: 0 });
    expect(done.perVassal.b).toMatchObject({ calls: 1, failed: 1, failureRate: 1 });
    expect(done.perVassal.a.latency?.count).toBe(1);
  });

  it('classifies timeouts separately from failures', () => {
    const metrics = new ConcurrencyMetrics();
    metrics.branchStarted({ intentId: 'i', runId: 'r:a', vassal: 'a', skill: 's', startedAt: 't' });
    metrics.branchEnded('i', 'r:a', 'a', 'timeout');
    const snap = metrics.snapshot();
    expect(snap.timedOut).toBe(1);
    expect(snap.perVassal.a.failureRate).toBe(1);
  });
});

describe('E1.7 Orchestrator integration', () => {
  it('records per-branch latency and failure rate across a fan-out', async () => {
    const port = portFor({ loom: ok('loom'), atlas: failed() });
    const metrics = new ConcurrencyMetrics();
    const orch = new Orchestrator(lookup(['loom', 'atlas']), port, {
      newIntentId: () => 'i1', newRunId: () => 'r1', metrics,
    });
    const result = await orch.fanOut({ intentId: 'i1', skill: 's', params: {}, realm: 'personal' });
    expect(result.status).toBe('partial');

    const snap = metrics.snapshot();
    expect(snap.inFlight).toBe(0);
    expect(snap.finished).toBe(2);
    expect(snap.completed).toBe(1);
    expect(snap.failed).toBe(1);
    expect(snap.maxInFlight).toBe(2);
    expect(snap.perVassal.loom.calls).toBe(1);
    expect(snap.perVassal.atlas.failed).toBe(1);
    expect(snap.perVassal.atlas.failureRate).toBe(1);
    expect(snap.perVassal.loom.latency?.count).toBe(1);
    // unbounded dispatch: nothing stays queued after the fan-out resolves
    expect(snap.queueDepth).toBe(0);
  });

  it('is a no-op when no metrics collector is provided', async () => {
    const port = portFor({ loom: ok('loom') });
    const orch = new Orchestrator(lookup(['loom']), port, { newIntentId: () => 'i', newRunId: () => 'r' });
    const result = await orch.fanOut({ intentId: 'i', skill: 's', params: {}, realm: 'personal' });
    expect(result.status).toBe('completed');
  });
});
