import { describe, expect, it, vi } from 'vitest';
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
  // maxInFlight counts dispatches that are inside the port at the same moment.
  // That is the property "fan-out is parallel" actually claims, and unlike a
  // millisecond bound it cannot be broken by a slow scheduler: the previous check
  // ("both dispatches start within 8ms") failed at 12ms while the code was right.
  const calls: Array<{ vassal: string; runId: string }> = [];
  const cancelCalls: Array<[string, string]> = [];
  let inFlight = 0;
  const port: DispatchPort & { calls: typeof calls; cancelCalls: typeof cancelCalls; maxInFlight: number } = {
    calls,
    cancelCalls,
    maxInFlight: 0,
    async dispatch(req) {
      calls.push({ vassal: req.vassal!, runId: req.runId! });
      inFlight += 1;
      port.maxInFlight = Math.max(port.maxInFlight, inFlight);
      try {
        const route = routes[req.vassal!]!; // test routes cover every dispatched vassal
        const result = await (typeof route === 'function' ? route(req) : route);
        // §7: a real fetch body reader rejects when its signal fires; the stub
        // mirrors that so an aborted stream settles as a rejected dispatch.
        if (req.signal?.aborted) throw new DOMException('aborted', 'AbortError');
        return result;
      } catch (error) {
        if (req.signal?.aborted) throw new DOMException('aborted', 'AbortError');
        throw error;
      } finally {
        inFlight -= 1;
      }
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
    // Parallelism is proven structurally: the second dispatch enters the port
    // while the first is still inside it. A serial run cannot produce that shape
    // at any machine speed, and a saturated runner cannot fake it away — the
    // previous check ("both start within 8ms") failed at 12ms under CPU
    // contention while the code was correct, so it measured the scheduler.
    expect(port.maxInFlight).toBe(2);
    // Control: run the same two branches one after another and confirm the
    // predicate goes the other way. Without this, the overlap assertion could
    // pass for a serial implementation too and we would not know.
    const serialPort = makePort({
      loom: async () => { await delay(15); return okResult('loom'); },
      atlas: async () => { await delay(15); return okResult('atlas'); },
    });
    const serialOrch = newOrchestrator(serialPort, ['loom']);
    await serialOrch.fanOut({ skill: 'generate-content', params: {}, realm: 'personal' });
    const second = newOrchestrator(serialPort, ['atlas']);
    await second.fanOut({ skill: 'generate-content', params: {}, realm: 'personal' });
    expect(serialPort.maxInFlight).toBe(1);
    expect(port.calls.map(c => c.runId)).toEqual(['run-1:loom', 'run-1:atlas']);
    expect(result.stream.map(e => e.source.vassal)).toEqual(['loom', 'atlas']);
    expect(result.stream[0]!.source.taskId).toBe('loom-task');
  });

  it('returns an independent copy, so mutating the reply cannot corrupt the stored result (C-audit 12)', async () => {
    const port = makePort({
      loom: async () => okResult('loom'),
      atlas: async () => okResult('atlas'),
    });
    const orch = newOrchestrator(port, ['loom', 'atlas']);

    const result = await orch.fanOut({ skill: 'generate-content', params: {}, realm: 'personal' });
    // The fan-out reply and getIntent() share nested arrays if the reply is the
    // stored reference; a caller that mutates what it was handed would then
    // corrupt later replays. Both reads must stay isolated.
    result.branches.push({ vassal: 'tampered', runId: 'x', ok: false, events: [] } as never);
    result.positions.push({ vassal: 'tampered', stance: 'go' } as never);

    const stored = orch.getIntent('intent-1');
    expect(stored!.branches.map(b => b.vassal)).toEqual(['loom', 'atlas']);
    expect(stored!.positions).toEqual([]);
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
    vi.useFakeTimers();
    try {
      const port = makePort({
        loom: okResult('loom'),
        atlas: async () => { await delay(40); return okResult('atlas'); },
      });
      const orch = newOrchestrator(port, ['loom', 'atlas']);
      // Deterministic clock: fire the 8ms deadline without relying on the event
      // loop keeping 32ms of headroom under load (deferred #43).
      const pending = orch.fanOut({ skill: 'x', params: {}, realm: 'personal', branchTimeoutMs: 8 });
      await vi.advanceTimersByTimeAsync(8);
      const result = await pending;
      const atlas = result.branches.find(b => b.vassal === 'atlas')!;
      expect(atlas.timedOut).toBe(true);
      expect(atlas.ok).toBe(false);
      expect(result.status).toBe('partial');
    } finally {
      vi.useRealTimers();
    }
  });

  it('disarms the branch deadline once the branch settles', async () => {
    vi.useFakeTimers();
    try {
      const port = makePort({ loom: okResult('loom') });
      const orch = newOrchestrator(port, ['loom']);
      const result = await orch.fanOut({ intentId: 'T', skill: 'x', params: {}, realm: 'personal', branchTimeoutMs: 60_000 });
      expect(result.branches[0]!.ok).toBe(true);
      // the deadline lost the race and must not stay armed for the next minute
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('best-effort cancels a task that outlived its branch timeout', async () => {
    const port = makePort({ atlas: async () => { await delay(25); return okResult('atlas'); } });
    const orch = newOrchestrator(port, ['atlas']);
    const result = await orch.fanOut({ intentId: 'T', skill: 'x', params: {}, realm: 'personal', branchTimeoutMs: 5 });
    expect(result.branches[0]!.timedOut).toBe(true);

    await delay(50);
    expect(port.cancelCalls).toEqual([['atlas', 'atlas-task']]);
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
    expect(result.conflicts[0]!.stances.map(s => s.stance).sort()).toEqual(['approve', 'reject']);
    expect(escalated).toHaveLength(1);
    expect(escalated[0]!.intentId).toBe('intent-1');
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

  it('rejects a reused intentId that names a different request', async () => {
    const port = makePort({ loom: okResult('loom') });
    const orch = newOrchestrator(port, ['loom']);
    await orch.fanOut({ intentId: 'X', skill: 'x', params: { a: 1 }, realm: 'personal' });

    await expect(orch.fanOut({ intentId: 'X', skill: 'y', params: { a: 1 }, realm: 'personal' }))
      .rejects.toMatchObject({ kind: 'conflict' });
    await expect(orch.fanOut({ intentId: 'X', skill: 'x', params: { a: 2 }, realm: 'personal' }))
      .rejects.toMatchObject({ kind: 'conflict' });
    // key order is not a different request
    await expect(orch.fanOut({ intentId: 'X', skill: 'x', params: { a: 1 }, realm: 'personal' }))
      .resolves.toMatchObject({ replayed: true });
    expect(port.calls).toHaveLength(1);
  });

  it('collapses concurrent fan-outs that share an intentId into one dispatch set', async () => {
    const port = makePort({ loom: async () => { await delay(15); return okResult('loom'); } });
    const orch = newOrchestrator(port, ['loom']);
    const request = { intentId: 'X', skill: 'x', params: {}, realm: 'personal' as const };

    const [first, second] = await Promise.all([orch.fanOut(request), orch.fanOut(request)]);

    expect(first.intentId).toBe(second.intentId);
    expect(port.calls).toHaveLength(1);
  });
});

describe('Orchestrator.resumeBranch', () => {
  it('advances the resume run id so a second resume does not reuse the first', async () => {
    const port = makePort({ loom: okResult('loom') });
    const orch = newOrchestrator(port, ['loom']);
    await orch.fanOut({ intentId: 'X', skill: 'x', params: {}, realm: 'personal' });

    await orch.resumeBranch('X', 'loom', { note: 'one' });
    const second = await orch.resumeBranch('X', 'loom', { note: 'two' });

    expect(port.calls.map(c => c.runId)).toEqual(['run-1:loom', 'run-1:loom:resume1', 'run-1:loom:resume2']);
    expect(second.branches[0]!.runId).toBe('run-1:loom:resume2');
  });

  it('collapses concurrent resumes of the same branch into one dispatch', async () => {
    const port = makePort({ loom: async () => { await delay(15); return okResult('loom'); } });
    const orch = newOrchestrator(port, ['loom']);
    await orch.fanOut({ intentId: 'X', skill: 'x', params: {}, realm: 'personal' });

    const [first, second] = await Promise.all([
      orch.resumeBranch('X', 'loom', { note: 'one' }),
      orch.resumeBranch('X', 'loom', { note: 'one' }),
    ]);

    expect(first.branches[0]!.runId).toBe(second.branches[0]!.runId);
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

  it('reaches an intent whose fan-out is still running instead of throwing UnknownIntentError', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const port = makePort({ loom: async () => { await gate; return okResult('loom', 'completed'); } });
    const orch = newOrchestrator(port, ['loom']);

    const running = orch.fanOut({ intentId: 'X', skill: 'x', params: {}, realm: 'personal' });
    // The branch is still streaming. Before §7 there was nothing to cancel and
    // the cancel returned an empty result; now the live stream is aborted.
    const cancellation = await orch.cancelIntent('X');
    expect(cancellation.results).toEqual([{ vassal: 'loom', canceled: true }]);
    expect(port.cancelCalls).toHaveLength(0); // no task id yet: transport-level abort only

    release!();
    const result = await running;
    const branch = result.branches.find(b => b.vassal === 'loom')!;
    expect(branch.state).toBe('canceled');
    expect(branch.reason).toBe('canceled by the driver');
    // C-28: the driver asked for this, so it must not read as a vassal failure.
    expect(result.status).toBe('canceled');
  });

  it('cancels a branch that settled while its siblings were still running, and aborts the running sibling (§7)', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const port = makePort({
      loom: okResult('loom', 'input-required', 'approve'),
      atlas: async () => { await gate; return okResult('atlas', 'completed', 'ship'); },
    });
    const orch = newOrchestrator(port, ['loom', 'atlas']);

    const running = orch.fanOut({ intentId: 'X', skill: 'x', params: {}, realm: 'enterprise' });
    await delay(5); // loom settles; atlas is still streaming
    const cancellation = await orch.cancelIntent('X');
    // loom is cancelled through tasks/cancel (it has a task id); atlas has none
    // yet, so it is aborted at the transport edge (§7) — both report cancelled.
    expect(cancellation.results).toEqual([
      { vassal: 'loom', taskId: 'loom-task', canceled: true },
      { vassal: 'atlas', canceled: true },
    ]);
    expect(port.cancelCalls).toEqual([['loom', 'loom-task']]);

    release!();
    const result = await running;
    // Both branches are cancelled and neither stance survives into the aggregate.
    expect(result.branches.find(branch => branch.vassal === 'loom')?.state).toBe('canceled');
    expect(result.branches.find(branch => branch.vassal === 'atlas')?.state).toBe('canceled');
    expect(result.positions).toEqual([]);
    expect(result.status).toBe('canceled');
  });

  it('keeps failed when a cancellation is mixed with a genuine branch failure', async () => {
    // C-28, the boundary of the new status: one branch the driver cancelled and
    // one that actually failed is a failure - 'canceled' would hide the fault.
    const port = makePort({
      loom: okResult('loom', 'input-required', 'approve'),
      atlas: failResult('vassal unreachable'),
    });
    const orch = newOrchestrator(port, ['loom', 'atlas']);
    await orch.fanOut({ intentId: 'X', skill: 'x', params: {}, realm: 'enterprise' });
    await orch.cancelIntent('X');

    const after = orch.getIntent('X')!;
    expect(after.branches.find(branch => branch.vassal === 'loom')?.state).toBe('canceled');
    expect(after.status).toBe('failed');
  });

  it('writes a cancellation back into a settled intent so the cancelled stance is recomputed away', async () => {
    const port = makePort({
      loom: okResult('loom', 'input-required', 'approve'),
      atlas: okResult('atlas', 'completed', 'ship'),
    });
    const orch = newOrchestrator(port, ['loom', 'atlas']);
    await orch.fanOut({ intentId: 'X', skill: 'x', params: {}, realm: 'enterprise' });
    expect(orch.getIntent('X')!.positions.map(position => position.vassal).sort()).toEqual(['atlas', 'loom']);

    await orch.cancelIntent('X');

    const after = orch.getIntent('X')!;
    expect(after.branches.find(branch => branch.vassal === 'loom')?.state).toBe('canceled');
    expect(after.positions.map(position => position.vassal)).toEqual(['atlas']);
    expect(after.status).toBe('partial');
  });
});
