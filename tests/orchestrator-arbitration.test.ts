import { describe, expect, it } from 'vitest';
import { Orchestrator } from '../src/orchestrator/orchestrator.js';
import type { DispatchPort, FanOutResult, TargetLookup } from '../src/orchestrator/types.js';
import type { DispatchRequest, DispatchResult } from '../src/dispatch/dispatcher.js';
import type { A2AEvent, Task, TaskState } from '../src/a2a/types.js';
import { DecisionBackendFailure } from '../src/decision/types.js';
import type { ChoiceResult, DecisionBackend, NoulResult, ScoreResult } from '../src/decision/types.js';

function statusEvent(taskId: string, state: TaskState): A2AEvent {
  return { kind: 'status-update', taskId, contextId: 'ctx', status: { state }, final: state === 'completed' };
}

function okResult(vassal: string, stance: string): DispatchResult {
  const task: Task = {
    kind: 'task',
    id: `${vassal}-task`,
    contextId: 'ctx',
    status: { state: 'completed' },
    artifacts: [{ artifactId: 'a1', name: 'verdict', parts: [{ kind: 'data', data: { stance } }] }],
  };
  return { ok: true, task, events: [statusEvent(task.id, 'completed')], injectedHits: [] };
}

type Route = DispatchResult | ((req: DispatchRequest) => Promise<DispatchResult> | DispatchResult);

function makePort(routes: Record<string, Route>): DispatchPort {
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

type MockBackend = DecisionBackend & { choiceCalls: number };

function mockBackend(
  kind: 'decision-model' | 'llm',
  choice: (req: { options: string[] }) => ChoiceResult | Promise<ChoiceResult>
): MockBackend {
  const backend: MockBackend = {
    choiceCalls: 0,
    kind,
    model: kind === 'llm' ? 'mock-llm' : 'mock-jev',
    async noul(): Promise<NoulResult> {
      throw new Error('noul should not be called');
    },
    async choice(req) {
      backend.choiceCalls++;
      return choice(req);
    },
    async score(): Promise<ScoreResult> {
      throw new Error('score should not be called');
    },
  };
  return backend;
}

const calibratedHigh = (): ChoiceResult => ({
  choice: 'approve',
  probabilities: { approve: 0.92, reject: 0.08 },
  confidence: 0.92,
  calibrated: true,
  decisionAt: 't',
});
const calibratedLow = (): ChoiceResult => ({
  choice: 'approve',
  probabilities: { approve: 0.55, reject: 0.45 },
  confidence: 0.55,
  calibrated: true,
  decisionAt: 't',
});
const uncalibratedHigh = (): ChoiceResult => ({
  choice: 'approve',
  probabilities: { approve: 0.9, reject: 0.1 },
  confidence: 0.9,
  calibrated: false,
  decisionAt: 't',
});

function splitPort(): DispatchPort {
  return makePort({ loom: okResult('loom', 'approve'), atlas: okResult('atlas', 'reject') });
}

describe('S2 backend arbitration on unresolved splits', () => {
  it('concludes via a calibrated high-confidence backend and does not escalate to the driver', async () => {
    const backend = mockBackend('decision-model', calibratedHigh);
    const escalated: FanOutResult[] = [];
    const orch = new Orchestrator(lookupFor(['loom', 'atlas']), splitPort(), {
      newIntentId: () => 'intent-1',
      newRunId: () => 'run-1',
      decisionBackend: backend,
      onConflict: (_c, r) => escalated.push(r),
    });

    const result = await orch.fanOut({ intentId: 'X', skill: 'review', params: {}, realm: 'enterprise' });

    expect(result.status).toBe('completed');
    expect(result.decision.conclusion).toBe('approve');
    expect(result.conflicts).toEqual([]);
    expect(result.decision.margin).toEqual({ winner: 'approve', winnerCount: 1, total: 2 });
    expect(backend.choiceCalls).toBe(1);
    expect(escalated).toHaveLength(0);
    expect(result.backendArbitration).toMatchObject({
      concluded: true,
      conclusion: 'approve',
      confidence: 0.92,
      calibrated: true,
      backend: 'decision-model',
      model: 'mock-jev',
    });
  });

  it('keeps needs-driver and escalates when confidence is below the threshold', async () => {
    const backend = mockBackend('decision-model', calibratedLow);
    const escalated: FanOutResult[] = [];
    const orch = new Orchestrator(lookupFor(['loom', 'atlas']), splitPort(), {
      newIntentId: () => 'intent-1',
      newRunId: () => 'run-1',
      decisionBackend: backend,
      onConflict: (_c, r) => escalated.push(r),
    });

    const result = await orch.fanOut({ intentId: 'X', skill: 'review', params: {}, realm: 'enterprise' });

    expect(result.status).toBe('needs-driver');
    expect(result.decision.conclusion).toBeNull();
    expect(result.conflicts).toHaveLength(1);
    expect(escalated).toHaveLength(1);
    expect(result.backendArbitration).toMatchObject({ concluded: false, confidence: 0.55, calibrated: true });
  });

  it('does not let an uncalibrated LLM conclude by default', async () => {
    const backend = mockBackend('llm', uncalibratedHigh);
    const escalated: FanOutResult[] = [];
    const orch = new Orchestrator(lookupFor(['loom', 'atlas']), splitPort(), {
      decisionBackend: backend,
      onConflict: (_c, r) => escalated.push(r),
    });

    const result = await orch.fanOut({ skill: 'review', params: {}, realm: 'personal' });

    expect(result.status).toBe('needs-driver');
    expect(escalated).toHaveLength(1);
    expect(result.backendArbitration).toMatchObject({ concluded: false, calibrated: false, backend: 'llm' });
  });

  it('concludes on uncalibrated confidence only when explicitly allowed', async () => {
    const backend = mockBackend('llm', uncalibratedHigh);
    const orch = new Orchestrator(lookupFor(['loom', 'atlas']), splitPort(), {
      decisionBackend: backend,
      allowUncalibratedArbitration: true,
    });

    const result = await orch.fanOut({ skill: 'review', params: {}, realm: 'personal' });

    expect(result.status).toBe('completed');
    expect(result.decision.conclusion).toBe('approve');
    expect(result.backendArbitration).toMatchObject({ concluded: true, calibrated: false });
  });

  it('survives a backend failure: stays needs-driver and records the error without throwing', async () => {
    const backend = mockBackend('decision-model', () => {
      throw new DecisionBackendFailure('timeout', 'choice timed out');
    });
    const escalated: FanOutResult[] = [];
    const orch = new Orchestrator(lookupFor(['loom', 'atlas']), splitPort(), {
      decisionBackend: backend,
      onConflict: (_c, r) => escalated.push(r),
    });

    const result = await orch.fanOut({ skill: 'review', params: {}, realm: 'enterprise' });

    expect(result.status).toBe('needs-driver');
    expect(escalated).toHaveLength(1);
    expect(result.backendArbitration?.concluded).toBe(false);
    expect(result.backendArbitration?.error).toMatchObject({ code: 'timeout' });
  });

  it('behaves exactly as before when no backend is configured', async () => {
    const escalated: FanOutResult[] = [];
    const orch = new Orchestrator(lookupFor(['loom', 'atlas']), splitPort(), {
      newIntentId: () => 'intent-1',
      onConflict: (_c, r) => escalated.push(r),
    });

    const result = await orch.fanOut({ intentId: 'X', skill: 'review', params: {}, realm: 'enterprise' });

    expect(result.status).toBe('needs-driver');
    expect(escalated).toHaveLength(1);
    expect(result.backendArbitration).toBeUndefined();
  });

  it('persists the arbitration record with the intent (idempotency snapshot)', async () => {
    const backend = mockBackend('decision-model', calibratedHigh);
    const orch = new Orchestrator(lookupFor(['loom', 'atlas']), splitPort(), { decisionBackend: backend });

    const result = await orch.fanOut({ intentId: 'X', skill: 'review', params: {}, realm: 'enterprise' });
    expect(result.backendArbitration?.concluded).toBe(true);
    expect(orch.getIntent('X')?.backendArbitration?.concluded).toBe(true);
    expect(orch.exportState().intents[0].backendArbitration?.model).toBe('mock-jev');
  });

  it('arbitrates again after resumeBranch recomputes a split', async () => {
    const backend = mockBackend('decision-model', calibratedHigh);
    const orch = new Orchestrator(lookupFor(['loom', 'atlas']), splitPort(), {
      newIntentId: () => 'intent-1',
      newRunId: () => 'run-1',
      decisionBackend: backend,
    });

    const first = await orch.fanOut({ intentId: 'X', skill: 'review', params: {}, realm: 'enterprise' });
    expect(first.status).toBe('completed');

    const resumed = await orch.resumeBranch('X', 'atlas', { note: 'redo' });
    expect(resumed.status).toBe('completed');
    expect(resumed.decision.conclusion).toBe('approve');
    expect(resumed.backendArbitration?.concluded).toBe(true);
  });
});
