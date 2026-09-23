import { describe, expect, it } from 'vitest';
import { Orchestrator, type OrchestratorSnapshot } from '../src/orchestrator/orchestrator.js';
import type {
  Conflict,
  DispatchPort,
  FanOutRequest,
  FanOutResult,
  TargetLookup,
} from '../src/orchestrator/types.js';
import type { DispatchRequest, DispatchResult } from '../src/dispatch/dispatcher.js';
import type { A2AEvent, Task, TaskState } from '../src/a2a/types.js';
import {
  ReplayError,
  replayDecision,
  replayDecisions,
  replaySnapshot,
  renderReplay,
  type DecisionReplay,
  type ReplayStep,
} from '../src/orchestrator/replay.js';

function statusEvent(taskId: string, state: TaskState, timestamp?: string): A2AEvent {
  return {
    kind: 'status-update',
    taskId,
    contextId: 'ctx',
    status: { state, ...(timestamp ? { timestamp } : {}) },
    final: state === 'completed' || state === 'failed',
  };
}

function stanceResult(vassal: string, stance: string, state: TaskState = 'completed'): DispatchResult {
  const task: Task = {
    kind: 'task',
    id: `${vassal}-task`,
    contextId: 'ctx',
    status: { state },
    artifacts: [{ artifactId: 'a1', name: 'verdict', parts: [{ kind: 'data', data: { stance } }] }],
  };
  return { ok: true, task, events: [statusEvent(task.id, state)], injectedHits: [] };
}

function makePort(routes: Record<string, DispatchResult | ((req: DispatchRequest) => DispatchResult)>): DispatchPort {
  return {
    async dispatch(req) {
      const route = routes[req.vassal!];
      return typeof route === 'function' ? route(req) : route;
    },
    async cancel() {},
  };
}

function lookupFor(names: string[]): TargetLookup {
  return { findBySkill: () => names.map(name => ({ name })) };
}

function kindsOf(replay: DecisionReplay): Array<ReplayStep['kind']> {
  return replay.timeline.map(step => step.kind);
}

describe('E1.6 offline decision replay', () => {
  it('replays a completed unanimous fan-out with participants, input and ordered timeline', async () => {
    const port = makePort({ loom: stanceResult('loom', 'go'), atlas: stanceResult('atlas', 'go') });
    const orch = new Orchestrator(lookupFor(['loom', 'atlas']), port, {
      newIntentId: () => 'intent-1',
      newRunId: () => 'run-1',
    });
    const request: FanOutRequest = {
      intentId: 'intent-1',
      skill: 'decide',
      params: { ticket: 'OPS-1' },
      realm: 'personal',
      aggregation: { kind: 'unanimous' },
    };
    const result = await orch.fanOut(request);

    const replay = replayDecision(result, request);

    expect(replay).toMatchObject({
      intentId: 'intent-1',
      runId: 'run-1',
      skill: 'decide',
      realm: 'personal',
      status: 'completed',
      input: { ticket: 'OPS-1' },
    });
    expect(replay.participants.map(p => p.vassal)).toEqual(['loom', 'atlas']);
    expect(replay.participants.every(p => p.ok && p.state === 'completed' && p.eventCount === 1)).toBe(true);
    expect(replay.positions).toHaveLength(2);
    expect(replay.decision.conclusion).toBe('go');

    const kinds = kindsOf(replay);
    expect(kinds[0]).toBe('intent-started');
    expect(kinds[kinds.length - 1]).toBe('intent-finished');
    // every branch is dispatched before its events and finished after them
    for (const vassal of ['loom', 'atlas']) {
      const dispatched = kinds.indexOf('branch-dispatched');
      const events = replay.timeline.filter(s => s.kind === 'branch-event' && s.vassal === vassal);
      const finished = replay.timeline.find(s => s.kind === 'branch-finished' && s.vassal === vassal)!;
      expect(events.length).toBe(1);
      expect(events[0].index).toBeGreaterThan(dispatched);
      expect(finished.index).toBeGreaterThan(events[0].index);
    }
    // aggregation is presented after positions, before the terminal step
    const positionsIdx = kinds.indexOf('positions-extracted');
    const aggregatedIdx = kinds.indexOf('aggregated');
    expect(positionsIdx).toBeLessThan(aggregatedIdx);
    expect(aggregatedIdx).toBeLessThan(kinds.length - 1);
    expect(kinds).not.toContain('conflict-detected');
    expect(kinds).not.toContain('driver-resolved');
  });

  it('omits the original input when no request is supplied (result alone carries no params)', async () => {
    const port = makePort({ loom: stanceResult('loom', 'go') });
    const orch = new Orchestrator(lookupFor(['loom']), port, {
      newIntentId: () => 'i',
      newRunId: () => 'r',
    });
    const result = await orch.fanOut({ intentId: 'i', skill: 's', params: { secret: 1 }, realm: 'personal' });
    const replay = replayDecision(result);
    expect(replay.input).toBeUndefined();
    expect(replay.aggregation).toBeUndefined();
    expect(replay.status).toBe('completed');
  });

  it('replays conflict, backend arbitration and driver resolution in lifecycle order', () => {
    const result: FanOutResult = {
      intentId: 'i',
      runId: 'r',
      skill: 'decide',
      realm: 'personal',
      branches: [],
      stream: [],
      positions: [],
      decision: { rule: 'majority', conclusion: 'go', positions: [], reason: 'driver settled' },
      conflicts: [
        { stances: [{ stance: 'go', vassals: ['a'] }, { stance: 'hold', vassals: ['b'] }], reason: 'split' },
      ],
      status: 'completed',
      createdAt: 't0',
      backendArbitration: {
        concluded: false,
        confidence: 0.5,
        calibrated: true,
        backend: 'decision-model',
        model: 'jev',
        decidedAt: 't1',
      },
      driverResolution: { escalationId: 'esc-1', stance: 'go', decidedAt: 't2' },
    };

    const replay = replayDecision(result);
    const kinds = kindsOf(replay);
    const conflictIdx = kinds.indexOf('conflict-detected');
    const backendIdx = kinds.indexOf('backend-arbitrated');
    const driverIdx = kinds.indexOf('driver-resolved');
    expect(conflictIdx).toBeGreaterThanOrEqual(0);
    expect(backendIdx).toBeGreaterThan(conflictIdx);
    expect(driverIdx).toBeGreaterThan(backendIdx);

    const backendStep = replay.timeline[backendIdx];
    expect(backendStep.detail).toMatchObject({ concluded: false, backend: 'decision-model', model: 'jev', confidence: 0.5 });
    const driverStep = replay.timeline[driverIdx];
    expect(driverStep.detail).toMatchObject({ escalationId: 'esc-1', stance: 'go' });
    expect(replay.backendArbitration?.model).toBe('jev');
    expect(replay.driverResolution?.escalationId).toBe('esc-1');
  });

  it('appends dispatched/finished steps for branches with no stream events (failure/timeout)', () => {
    const result: FanOutResult = {
      intentId: 'i',
      runId: 'r',
      skill: 's',
      realm: 'personal',
      branches: [
        { vassal: 'dead', runId: 'run-dead', ok: false, events: [], reason: 'dispatch refused' },
        { vassal: 'slow', runId: 'run-slow', ok: false, events: [], timedOut: true, reason: 'branch timeout' },
      ],
      stream: [],
      positions: [],
      decision: { rule: 'majority', conclusion: null, positions: [], reason: 'no stances' },
      conflicts: [],
      status: 'failed',
      createdAt: 't0',
    };

    const replay = replayDecision(result);
    expect(replay.participants).toMatchObject([
      { vassal: 'dead', ok: false, eventCount: 0, reason: 'dispatch refused' },
      { vassal: 'slow', ok: false, eventCount: 0, timedOut: true },
    ]);
    expect(kindsOf(replay).filter(k => k === 'branch-dispatched')).toHaveLength(2);
    expect(kindsOf(replay).filter(k => k === 'branch-finished')).toHaveLength(2);
    const slowFinish = replay.timeline.find(s => s.kind === 'branch-finished' && s.vassal === 'slow')!;
    expect(slowFinish.detail).toMatchObject({ ok: false, timedOut: true, reason: 'branch timeout' });
  });

  it('fails loud on a stream event referencing an unknown branch, and on intent mismatch', () => {
    const corrupt: FanOutResult = {
      intentId: 'i',
      runId: 'r',
      skill: 's',
      realm: 'personal',
      branches: [],
      stream: [
        {
          source: { vassal: 'ghost', runId: 'run-ghost', taskId: 't' },
          event: statusEvent('t', 'working'),
        },
      ],
      positions: [],
      decision: { rule: 'majority', conclusion: null, positions: [], reason: 'x' },
      conflicts: [],
      status: 'failed',
      createdAt: 't0',
    };
    expect(() => replayDecision(corrupt)).toThrowError(ReplayError);

    const clean: FanOutResult = { ...corrupt, branches: [{ vassal: 'ghost', runId: 'run-ghost', ok: true, events: [] }], stream: [] };
    const mismatchedRequest: FanOutRequest = { intentId: 'other', skill: 's', params: {}, realm: 'personal' };
    expect(() => replayDecision(clean, mismatchedRequest)).toThrowError(ReplayError);
  });

  it('replays every intent from an orchestrator snapshot and restores inputs', () => {
    const snapshot: OrchestratorSnapshot = {
      intents: [
        {
          intentId: 'i-1', runId: 'r-1', skill: 's', realm: 'personal', branches: [], stream: [],
          positions: [], decision: { rule: 'majority', conclusion: 'go', positions: [], reason: 'ok' },
          conflicts: [], status: 'completed', createdAt: 't0',
        },
        {
          intentId: 'i-2', runId: 'r-2', skill: 's', realm: 'personal', branches: [], stream: [],
          positions: [], decision: { rule: 'majority', conclusion: null, positions: [], reason: 'split' },
          conflicts: [], status: 'needs-driver', createdAt: 't1',
        },
      ],
      requests: [
        { intentId: 'i-1', request: { intentId: 'i-1', skill: 's', params: { n: 1 }, realm: 'personal' } },
        { intentId: 'i-2', request: { intentId: 'i-2', skill: 's', params: { n: 2 }, realm: 'personal' } },
      ],
    };

    const replays = replaySnapshot(snapshot);
    expect(replays.map(r => r.intentId)).toEqual(['i-1', 'i-2']);
    expect(replays[0].input).toEqual({ n: 1 });
    expect(replays[1].input).toEqual({ n: 2 });
    expect(replays[1].status).toBe('needs-driver');

    // replayDecisions without requests still works but carries no inputs
    const noInputs = replayDecisions(snapshot.intents);
    expect(noInputs.every(r => r.input === undefined)).toBe(true);
  });

  it('renders a deterministic human-readable transcript containing the key facts', () => {
    const conflict: Conflict = {
      stances: [{ stance: 'go', vassals: ['loom'] }, { stance: 'hold', vassals: ['atlas'] }],
      reason: 'split',
    };
    const result: FanOutResult = {
      intentId: 'i-9',
      runId: 'r-9',
      skill: 'decide',
      realm: 'personal',
      branches: [
        { vassal: 'loom', runId: 'run-loom', taskId: 't-loom', ok: true, state: 'completed', events: [] },
      ],
      stream: [],
      positions: [{ vassal: 'loom', stance: 'go', weight: 1, rationale: 'checks pass' }],
      decision: {
        rule: 'majority',
        conclusion: 'go',
        positions: [],
        margin: { winner: 'go', winnerCount: 1, total: 1 },
        reason: '1/1',
      },
      conflicts: [conflict],
      status: 'needs-driver',
      createdAt: 't0',
    };

    const text = renderReplay(replayDecision(result));
    expect(text).toContain('intent i-9');
    expect(text).toContain('loom');
    expect(text).toContain('checks pass');
    expect(text).toContain('"go"');
    expect(text).toContain('needs-driver');
    expect(text).toContain('conflicts (1)');
    // deterministic across renders
    expect(renderReplay(replayDecision(result))).toBe(text);
  });

  it('replay is purely offline: rebuilding after a driver settlement shows the recorded outcome', async () => {
    const port = makePort({ loom: stanceResult('loom', 'go'), atlas: stanceResult('atlas', 'hold') });
    const orch = new Orchestrator(lookupFor(['loom', 'atlas']), port, {
      newIntentId: () => 'intent-1',
      newRunId: () => 'run-1',
    });
    const split = await orch.fanOut({
      intentId: 'intent-1', skill: 'decide', params: {}, realm: 'personal', aggregation: { kind: 'majority' },
    });
    expect(split.status).toBe('needs-driver');
    const resolved = orch.resolveIntent('intent-1', {
      escalationId: 'esc-1', stance: 'go',
    });

    const replay = replayDecision(resolved);
    expect(kindsOf(replay)).toContain('driver-resolved');
    expect(replay.status).toBe('completed');
    expect(replay.decision.conclusion).toBe('go');
    // replaying the same immutable record twice yields identical timelines
    expect(replayDecision(structuredClone(resolved)).timeline).toEqual(replay.timeline);
  });
});
