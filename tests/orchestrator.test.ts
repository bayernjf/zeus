import { describe, expect, it } from 'vitest';
import { Orchestrator, UnknownIntentError } from '../src/orchestrator/orchestrator.js';
import type { DispatchPort, FanOutResult, TargetLookup } from '../src/orchestrator/types.js';
import type { DispatchRequest, DispatchResult } from '../src/dispatch/dispatcher.js';
import type { A2AEvent, Task, TaskState } from '../src/a2a/types.js';

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

function audit() {
  return { ts: 't', vassal: 'v', decision: 'dispatched' as const };
}

function statusEvent(taskId: string, state: TaskState): A2AEvent {
  return { kind: 'status-update', taskId, contextId: 'ctx', status: { state }, final: state === 'completed' };
}

function okResult(vassal: string, state: TaskState = 'completed', stance?: string): DispatchResult {
  const task: Task = {
    kind: 'task',
    id: `${vassal}-task`,
    contextId: 'ctx',
    status: { state },
    artifacts: stance
      ? [{ artifactId: 'a1', name: 'verdict', parts: [{ kind: 'data', data: { stance } }] }]
      : [],
  };
  return { ok: true, task, events: [statusEvent(task.id, state)], injectedHits: [] };
}

function failResult(reason: string): DispatchResult {
  return { ok: false, reason, audit: audit() };
}

type Route = DispatchResult | ((req: DispatchRequest) => Promise<DispatchResult> | DispatchResult);

function makePort(routes: Record<string, Route>, cancelFor?: Record<string, () => void>) {
  const calls: Array<{ vassal: string; runId: string; at: number }> = [];
  const cancelCalls: Array<[string, string]> = [];
  const port: DispatchPort & { calls: typeof calls; cancelCalls: typeof cancelCalls } = {
    calls,
    cancelCalls,
    async dispatch(req) {
      calls.push({ vassal: req.vassal!, runId: req.runId!, at: Date.now() });
      const route = routes[req.vassal!];
      return typeof route === 'function' ? route(req) : route;
    },
    async cancel(vassal, taskId) {
      cancelCalls.push([vassal, taskId]);
      cancelFor?.[vassal]?.();
    },
  };
  return port;
}

function lookupFor(names: string[]): TargetLookup {
  return { findBySkill: () => names.map(name => ({ name })) };
}

function newOrchestrator(port: DispatchPort, names: string[], options: ConstructorParameters<typeof Orchestrator>[2] = {}) {
  return new Orchestrator(lookupFor(names), port, { newIntentId: () => 'intent-1', newRunId: () => 'run-1', ...options });
}

describe('Orchestrator.fanOut', () => {
  it('fans out by skill to every provider in parallel and merges sourced streams', async () => {
    const port = makePort({
      loom: async () => { await delay(15); return okResult('loom'); },
      atlas: async () => { await delay(15); return okResult('atlas'); },
    });
    const orch = newOrchestrator(port, ['loom', 'atlas']);

    const result = await orch.fanOut({ skill: 'generate-content', params: {}, realm: 'personal' });

    expect(result.status).toBe('completed');
    expect(result.branches.map(b => b.vassal)).toEqual(['loom', 'atlas']);
    // Parallelism is proven deterministically by both dispatches starting in the
    // same tick window (a serial run would start the second ~15ms later). We do
    // not assert total wall-clock: under saturated CI the 15ms timers slip and
    // make any "< 28ms" bound flaky without indicating serialization.
    expect(port.calls[1].at - port.calls[0].at).toBeLessThan(8);
    expect(port.calls.map(c => c.runId)).toEqual(['run-1:loom', 'run-1:atlas']);
    expect(result.stream.map(e => e.source.vassal)).toEqual(['loom', 'atlas']);
    expect(result.stream[0].source.taskId).toBe('loom-task');
  });

  it('honours an explicit vassal list and ignores other skill providers', async () => {
    const port = makePort({ loom: okResult('loom'), atlas: okResult('atlas') });
    const orch = newOrchestrator(port, ['loom', 'atlas']);
    const result = await orch.fanOut({ skill: 'x', vassals: ['atlas'], params: {}, realm: 'personal' });
    expect(result.branches.map(b => b.vassal)).toEqual(['atlas']);
  });

  it('fails when no vassal provides the skill', async () => {
    const port = makePort({});
    const orch = new Orchestrator(lookupFor([]), port, { newIntentId: () => 'i' });
    const result = await orch.fanOut({ skill: 'ghost', params: {}, realm: 'personal' });
    expect(result.status).toBe('failed');
    expect(result.branches).toEqual([]);
    expect(port.calls).toHaveLength(0);
  });

  it('marks partial when one branch fails but keeps the successful branch', async () => {
    const port = makePort({ loom: okResult('loom'), atlas: failResult('connection refused') });
    const orch = newOrchestrator(port, ['loom', 'atlas']);
    const result = await orch.fanOut({ skill: 'x', params: {}, realm: 'personal' });
    expect(result.status).toBe('partial');
    expect(result.branches.find(b => b.vassal === 'atlas')?.reason).toMatch(/connection refused/);
    expect(result.branches.find(b => b.vassal === 'loom')?.ok).toBe(true);
  });

  it('fails when every branch fails', async () => {
    const port = makePort({ loom: failResult('a'), atlas: failResult('b') });
    const orch = newOrchestrator(port, ['loom', 'atlas']);
    const result = await orch.fanOut({ skill: 'x', params: {}, realm: 'personal' });
    expect(result.status).toBe('failed');
  });

  it('records a timed-out branch as failed without losing the others', async () => {
    const port = makePort({
      loom: okResult('loom'),
      atlas: async () => { await delay(40); return okResult('atlas'); },
    });
    const orch = newOrchestrator(port, ['loom', 'atlas']);
    const result = await orch.fanOut({ skill: 'x', params: {}, realm: 'personal', branchTimeoutMs: 8 });
    const atlas = result.branches.find(b => b.vassal === 'atlas')!;
    expect(atlas.timedOut).toBe(true);
    expect(atlas.ok).toBe(false);
    expect(result.status).toBe('partial');
  });

  it('aggregates unanimous stances into a conclusion', async () => {
    const port = makePort({ loom: okResult('loom', 'completed', 'approve'), atlas: okResult('atlas', 'completed', 'approve') });
    const orch = newOrchestrator(port, ['loom', 'atlas']);
    const result = await orch.fanOut({ skill: 'review', params: {}, realm: 'enterprise' });
    expect(result.status).toBe('completed');
    expect(result.decision.conclusion).toBe('approve');
    expect(result.positions).toHaveLength(2);
  });

  it('escalates an unresolved split as needs-driver and fires onConflict, never picking a side', async () => {
    const port = makePort({ loom: okResult('loom', 'completed', 'approve'), atlas: okResult('atlas', 'completed', 'reject') });
    const escalated: FanOutResult[] = [];
    const orch = newOrchestrator(port, ['loom', 'atlas'], { onConflict: (_c, r) => escalated.push(r) });
    const result = await orch.fanOut({ skill: 'review', params: {}, realm: 'enterprise' });
    expect(result.status).toBe('needs-driver');
    expect(result.decision.conclusion).toBeNull();
    expect(result.conflicts[0].stances.map(s => s.stance).sort()).toEqual(['approve', 'reject']);
    expect(escalated).toHaveLength(1);
    expect(escalated[0].intentId).toBe('intent-1');
  });
});

describe('Orchestrator idempotency', () => {
  it('replays a stored intent without re-dispatching', async () => {
    const port = makePort({ loom: okResult('loom'), atlas: okResult('atlas') });
    const orch = newOrchestrator(port, ['loom', 'atlas']);
    const first = await orch.fanOut({ intentId: 'X', skill: 'x', params: {}, realm: 'personal' });
    const second = await orch.fanOut({ intentId: 'X', skill: 'x', params: {}, realm: 'personal' });
    expect(second.replayed).toBe(true);
    expect(second.intentId).toBe(first.intentId);
    expect(port.calls).toHaveLength(2); // two branches once, not twice
  });

  it('dispatches again when no intentId is supplied', async () => {
    const port = makePort({ loom: okResult('loom') });
    const orch = newOrchestrator(port, ['loom']);
    await orch.fanOut({ skill: 'x', params: {}, realm: 'personal' });
    await orch.fanOut({ skill: 'x', params: {}, realm: 'personal' });
    expect(port.calls).toHaveLength(2);
  });
});

describe('Orchestrator.cancelIntent', () => {
  it('cancels non-terminal branches and skips terminal ones', async () => {
    const port = makePort({
      loom: okResult('loom', 'input-required'),
      atlas: okResult('atlas', 'completed'),
    });
    const orch = newOrchestrator(port, ['loom', 'atlas']);
    const result = await orch.fanOut({ intentId: 'X', skill: 'x', params: {}, realm: 'enterprise' });
    expect(result.branches.find(b => b.vassal === 'loom')?.state).toBe('input-required');

    const cancellation = await orch.cancelIntent('X');
    expect(cancellation.results).toEqual([{ vassal: 'loom', taskId: 'loom-task', canceled: true }]);
    expect(port.cancelCalls).toEqual([['loom', 'loom-task']]);
  });

  it('is idempotent for an intent whose branches are all terminal', async () => {
    const port = makePort({ loom: okResult('loom', 'completed') });
    const orch = newOrchestrator(port, ['loom']);
    await orch.fanOut({ intentId: 'X', skill: 'x', params: {}, realm: 'personal' });
    const cancellation = await orch.cancelIntent('X');
    expect(cancellation.results).toEqual([]);
    expect(port.cancelCalls).toHaveLength(0);
  });

  it('throws on an unknown intent and records per-branch cancel failures', async () => {
    const failing: DispatchPort = {
      dispatch: async () => okResult('loom', 'input-required'),
      cancel: async () => { throw new Error('vassal unreachable'); },
    };
    const orch = new Orchestrator(lookupFor(['loom']), failing, { newIntentId: () => 'intent-1', newRunId: () => 'run-1' });
    await orch.fanOut({ intentId: 'X', skill: 'x', params: {}, realm: 'enterprise' });
    const cancellation = await orch.cancelIntent('X');
    expect(cancellation.results[0]).toMatchObject({ vassal: 'loom', canceled: false, reason: 'vassal unreachable' });
    await expect(orch.cancelIntent('nope')).rejects.toBeInstanceOf(UnknownIntentError);
  });
});
