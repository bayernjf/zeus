import { describe, expect, it, vi } from 'vitest';
import { Orchestrator } from '../src/orchestrator/orchestrator.js';
import type { Conflict, DispatchPort, FanOutResult, TargetLookup } from '../src/orchestrator/types.js';
import type { DispatchRequest, DispatchResult } from '../src/dispatch/dispatcher.js';
import type { A2AEvent, Task, TaskState } from '../src/a2a/types.js';
import { OversightDesk, conflictsToDesk } from '../src/oversight/oversight.js';
import { applyConflictResolution } from '../src/orchestrator/resolution.js';

function statusEvent(taskId: string, state: TaskState): A2AEvent {
  return { kind: 'status-update', taskId, contextId: 'ctx', status: { state }, final: state === 'completed' };
}

function stanceResult(vassal: string, stance: string, state: TaskState = 'completed'): DispatchResult {
  const task: Task = {
    kind: 'task', id: `${vassal}-task`, contextId: 'ctx', status: { state },
    artifacts: [{ artifactId: 'a1', name: 'verdict', parts: [{ kind: 'data', data: { stance } }] }],
  };
  return { ok: true, task, events: [statusEvent(task.id, state)], injectedHits: [] };
}

type Route = DispatchResult | ((req: DispatchRequest, callNo: number) => DispatchResult);
function makePort(routes: Record<string, Route>): DispatchPort & { dispatchCount: Record<string, number> } {
  const dispatchCount: Record<string, number> = {};
  return {
    dispatchCount,
    async dispatch(req) {
      const name = req.vassal!;
      const no = (dispatchCount[name] = (dispatchCount[name] ?? 0) + 1);
      const route = routes[name];
      return typeof route === 'function' ? (route as (r: DispatchRequest, n: number) => DispatchResult)(req, no) : route;
    },
    async cancel() {},
  };
}

function lookupFor(names: string[]): TargetLookup {
  return { findBySkill: () => names.map(name => ({ name })) };
}

function splitOrchestrator(port: DispatchPort, names: string[], onConflict?: (conflicts: Conflict[], result: FanOutResult) => void) {
  return new Orchestrator(lookupFor(names), port, {
    newIntentId: () => 'intent-1',
    newRunId: () => 'run-1',
    ...(onConflict ? { onConflict } : {}),
  });
}

describe('E6.2 OversightDesk intent-conflict intake and decision', () => {
  it('ingests an unresolved split (idempotent per intent), decides a stance, and rejects invalid stances', () => {
    const desk = new OversightDesk({ newId: (() => { let n = 0; return () => `esc-${++n}`; })() });
    const result: FanOutResult = {
      intentId: 'intent-1', runId: 'run-1', skill: 'decide', realm: 'personal',
      branches: [], stream: [], positions: [],
      decision: { rule: 'majority', conclusion: null, positions: [], reason: 'tie 1-1' },
      conflicts: [{ stances: [{ stance: 'go', vassals: ['a'] }, { stance: 'hold', vassals: ['b'] }], reason: 'split' }],
      status: 'needs-driver', createdAt: 't',
    };

    const first = desk.ingestConflict({ intentId: 'intent-1', runId: 'run-1', skill: 'decide', realm: 'personal', conflict: result.conflicts[0] });
    const second = desk.ingestConflict({ intentId: 'intent-1', runId: 'run-1', skill: 'decide', realm: 'personal', conflict: result.conflicts[0] });
    expect(second.id).toBe(first.id);
    expect(first).toMatchObject({ kind: 'intent-conflict', options: ['go', 'hold'], status: 'pending' });
    expect(desk.list('pending')).toHaveLength(1);

    expect(() => desk.decideConflict(first.id, 'nope')).toThrow(/not one of the conflict options/);
    const decided = desk.decideConflict(first.id, 'go', 'accept go');
    expect(decided).toMatchObject({ status: 'approved', decidedStance: 'go' });
    expect(desk.list('pending')).toHaveLength(0);
    // deciding twice is refused
    expect(() => desk.decideConflict(first.id, 'hold')).toThrow(/already approved/);
  });

  it('rejecting an intent-conflict records the decision without a single-task cancel', async () => {
    const cancelTask = vi.fn(async () => ({}));
    const desk = new OversightDesk({ cancelTask });
    const esc = desk.ingestConflict({
      runId: 'r', skill: 's', realm: 'personal',
      conflict: { stances: [{ stance: 'go', vassals: ['a'] }, { stance: 'hold', vassals: ['b'] }], reason: 'split' },
    });
    const rejected = await desk.reject(esc.id, 'no go');
    expect(rejected.status).toBe('rejected');
    expect(cancelTask).not.toHaveBeenCalled();
  });
});

describe('E6.2 end-to-end: fan-out split -> desk -> write-back', () => {
  it('routes a needs-driver split into the desk and the driver decision closes the intent', async () => {
    const port = makePort({ loom: stanceResult('loom', 'go'), atlas: stanceResult('atlas', 'hold') });
    const desk = new OversightDesk({ newId: () => 'esc-1' });
    const orch = splitOrchestrator(port, ['loom', 'atlas'], conflictsToDesk(desk));

    const split = await orch.fanOut({ intentId: 'intent-1', skill: 'decide', params: {}, realm: 'personal', aggregation: { kind: 'majority' } });
    expect(split.status).toBe('needs-driver');
    expect(desk.list('pending')).toHaveLength(1);

    const esc = desk.list('pending')[0];
    const decided = desk.decideConflict(esc.id, 'go');
    const resolved = orch.resolveIntent('intent-1', { escalationId: decided.id, stance: decided.decidedStance!, note: decided.decisionNote });

    expect(resolved.status).toBe('completed');
    expect(resolved.decision.conclusion).toBe('go');
    expect(resolved.conflicts).toEqual([]);
    expect(resolved.driverResolution).toMatchObject({ escalationId: 'esc-1', stance: 'go' });
    // idempotent replay still returns the resolved result
    const replayed = await orch.fanOut({ intentId: 'intent-1', skill: 'decide', params: {}, realm: 'personal' });
    expect(replayed.status).toBe('completed');
    expect(replayed.replayed).toBe(true);
  });

  it('refuses write-back onto an intent that is not needs-driver', () => {
    const completed: FanOutResult = {
      intentId: 'i', runId: 'r', skill: 's', realm: 'personal', branches: [], stream: [], positions: [],
      decision: { rule: 'majority', conclusion: 'go', positions: [], reason: 'unanimous' },
      conflicts: [], status: 'completed', createdAt: 't',
    };
    expect(() => applyConflictResolution(completed, { escalationId: 'e', stance: 'go', decidedAt: 't' })).toThrow(/only needs-driver/);
  });
});

describe('E6.3 minimal re-dispatch after a branch needs another attempt', () => {
  it('resumeBranch re-runs one branch with supplied params and recomputes the intent', async () => {
    const seenParams: Record<string, unknown>[] = [];
    const port = makePort({
      loom: (req, callNo) => {
        seenParams.push(req.params);
        return callNo === 1
          ? { ok: false, reason: 'missing approval', audit: { ts: 't', vassal: 'loom', decision: 'dispatch-failed' as const } }
          : stanceResult('loom', 'go');
      },
      atlas: stanceResult('atlas', 'go'),
    });
    const orch = splitOrchestrator(port, ['loom', 'atlas']);

    const initial = await orch.fanOut({ intentId: 'intent-1', skill: 'decide', params: { ticket: 'OPS-1' }, realm: 'personal', aggregation: { kind: 'majority' } });
    expect(initial.status).toBe('partial');
    expect(initial.decision.conclusion).toBe('go'); // atlas alone already gives majority 1/1

    const resumed = await orch.resumeBranch('intent-1', 'loom', { approved: true });
    expect(port.dispatchCount.loom).toBe(2);
    // supplied params are merged over the original request params
    expect(seenParams[1]).toMatchObject({ ticket: 'OPS-1', approved: true });
    expect(resumed.status).toBe('completed');
    expect(resumed.decision.conclusion).toBe('go');
    expect(resumed.branches.find(b => b.vassal === 'loom')?.state).toBe('completed');
    expect(resumed.branches).toHaveLength(2);
  });

  it('resumeBranch on an unknown intent or unknown vassal throws', async () => {
    const port = makePort({ loom: stanceResult('loom', 'go') });
    const orch = splitOrchestrator(port, ['loom']);
    await expect(orch.resumeBranch('nope', 'loom', {})).rejects.toThrow(/unknown intent/);
    await orch.fanOut({ intentId: 'i', skill: 's', params: {}, realm: 'personal' });
    await expect(orch.resumeBranch('i', 'ghost', {})).rejects.toThrow(/no branch/);
  });
});
