import { describe, expect, it } from 'vitest';
import { Orchestrator } from '../src/orchestrator/orchestrator.js';
import type { DispatchPort, FanOutResult, TargetLookup } from '../src/orchestrator/types.js';
import type { DispatchRequest, DispatchResult } from '../src/dispatch/dispatcher.js';
import type { A2AEvent, Task, TaskState } from '../src/a2a/types.js';
import { DecisionBackendFailure } from '../src/decision/types.js';
import type { ChoiceResult, DecisionBackend, NoulResult, ScoreResult } from '../src/decision/types.js';
import { replayDecision } from '../src/orchestrator/replay.js';

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

const choiceResult = (choice: string, confidence: number, calibrated: boolean): ChoiceResult => ({
  choice,
  probabilities: {
    approve: choice === 'approve' ? confidence : 1 - confidence,
    reject: choice === 'reject' ? confidence : 1 - confidence,
  },
  confidence,
  calibrated,
  decisionAt: 't',
});

/** 2 approve + 1 reject -> majority concludes "approve" (the judge review target). */
function majorityPort(): DispatchPort {
  return makePort({
    loom: okResult('loom', 'approve'),
    atlas: okResult('atlas', 'approve'),
    prhelper: okResult('prhelper', 'reject'),
  });
}
const MAJORITY_NAMES = ['loom', 'atlas', 'prhelper'];

describe('E1.3 LLM-as-judge adversarial review', () => {
  it('endorses a rule conclusion when a calibrated high-confidence judge agrees', async () => {
    const backend = mockBackend('decision-model', () => choiceResult('approve', 0.93, true));
    const escalated: FanOutResult[] = [];
    const orch = new Orchestrator(lookupFor(MAJORITY_NAMES), majorityPort(), {
      decisionBackend: backend,
      judgeEnabled: true,
      onConflict: (_c, r) => escalated.push(r),
    });

    const result = await orch.fanOut({ intentId: 'X', skill: 'review', params: {}, realm: 'enterprise' });

    expect(result.status).toBe('completed');
    expect(result.decision.conclusion).toBe('approve');
    expect(result.conflicts).toEqual([]);
    expect(backend.choiceCalls).toBe(1);
    expect(escalated).toHaveLength(0);
    expect(result.judgeReview).toMatchObject({
      judged: true,
      recommended: 'approve',
      agreesWithRule: true,
      calibrated: true,
      backend: 'decision-model',
    });
  });

  it('escalates to the driver when a calibrated high-confidence judge disagrees with the rule', async () => {
    const backend = mockBackend('decision-model', () => choiceResult('reject', 0.91, true));
    const escalated: FanOutResult[] = [];
    const orch = new Orchestrator(lookupFor(MAJORITY_NAMES), majorityPort(), {
      decisionBackend: backend,
      judgeEnabled: true,
      onConflict: (_c, r) => escalated.push(r),
    });

    const result = await orch.fanOut({ intentId: 'X', skill: 'review', params: {}, realm: 'enterprise' });

    expect(result.status).toBe('needs-driver');
    expect(result.decision.conclusion).toBe('approve'); // rule conclusion preserved, not overwritten
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0].kind).toBe('judge-review');
    expect(result.conflicts[0].stances.map(s => s.stance).sort()).toEqual(['approve', 'reject']);
    expect(escalated).toHaveLength(1);
    expect(result.judgeReview).toMatchObject({
      judged: true,
      recommended: 'reject',
      agreesWithRule: false,
      escalated: true,
      confidence: 0.91,
    });
  });

  it('keeps the rule conclusion when judge confidence is below the gate', async () => {
    const backend = mockBackend('decision-model', () => choiceResult('reject', 0.6, true));
    const orch = new Orchestrator(lookupFor(MAJORITY_NAMES), majorityPort(), {
      decisionBackend: backend,
      judgeEnabled: true,
    });

    const result = await orch.fanOut({ intentId: 'X', skill: 'review', params: {}, realm: 'enterprise' });

    expect(result.status).toBe('completed');
    expect(result.conflicts).toEqual([]);
    expect(result.judgeReview).toMatchObject({ judged: false, reason: 'below-threshold', confidence: 0.6 });
  });

  it('does not count an uncalibrated LLM judge by default', async () => {
    const backend = mockBackend('llm', () => choiceResult('reject', 0.95, false));
    const orch = new Orchestrator(lookupFor(MAJORITY_NAMES), majorityPort(), {
      decisionBackend: backend,
      judgeEnabled: true,
    });

    const result = await orch.fanOut({ skill: 'review', params: {}, realm: 'personal' });

    expect(result.status).toBe('completed');
    expect(result.judgeReview).toMatchObject({ judged: false, reason: 'uncalibrated', calibrated: false });
  });

  it('accepts an uncalibrated judge only when explicitly allowed', async () => {
    const backend = mockBackend('llm', () => choiceResult('reject', 0.95, false));
    const orch = new Orchestrator(lookupFor(MAJORITY_NAMES), majorityPort(), {
      decisionBackend: backend,
      judgeEnabled: true,
      allowUncalibratedJudge: true,
    });

    const result = await orch.fanOut({ skill: 'review', params: {}, realm: 'personal' });

    expect(result.status).toBe('needs-driver');
    expect(result.judgeReview).toMatchObject({ judged: true, agreesWithRule: false, escalated: true, calibrated: false });
  });

  it('survives a judge backend failure without throwing and keeps the rule conclusion', async () => {
    const backend = mockBackend('decision-model', () => {
      throw new DecisionBackendFailure('timeout', 'choice timed out');
    });
    const orch = new Orchestrator(lookupFor(MAJORITY_NAMES), majorityPort(), {
      decisionBackend: backend,
      judgeEnabled: true,
    });

    const result = await orch.fanOut({ skill: 'review', params: {}, realm: 'enterprise' });

    expect(result.status).toBe('completed');
    expect(result.judgeReview?.judged).toBe(false);
    expect(result.judgeReview?.reason).toBe('backend-failure');
    expect(result.judgeReview?.error).toMatchObject({ code: 'timeout' });
  });

  it('skips review for a single-stance unanimous decision without calling the backend', async () => {
    const port = makePort({ loom: okResult('loom', 'approve'), atlas: okResult('atlas', 'approve') });
    const backend = mockBackend('decision-model', () => choiceResult('approve', 0.99, true));
    const orch = new Orchestrator(lookupFor(['loom', 'atlas']), port, {
      decisionBackend: backend,
      judgeEnabled: true,
    });

    const result = await orch.fanOut({
      skill: 'review',
      params: {},
      realm: 'enterprise',
      aggregation: { kind: 'unanimous' },
    });

    expect(result.status).toBe('completed');
    expect(backend.choiceCalls).toBe(0);
    expect(result.judgeReview).toMatchObject({ judged: false, reason: 'single-stance' });
  });

  it('does not judge an inconclusive rule (arbitration owns that path)', async () => {
    const port = makePort({ loom: okResult('loom', 'approve'), atlas: okResult('atlas', 'reject') });
    const backend = mockBackend('decision-model', () => choiceResult('reject', 0.5, true));
    const orch = new Orchestrator(lookupFor(['loom', 'atlas']), port, {
      decisionBackend: backend,
      judgeEnabled: true,
    });

    const result = await orch.fanOut({ skill: 'review', params: {}, realm: 'enterprise' });

    expect(result.status).toBe('needs-driver');
    expect(backend.choiceCalls).toBe(1); // arbitration only
    expect(result.judgeReview).toMatchObject({ judged: false, reason: 'rule-inconclusive' });
  });

  it('does not re-judge a conclusion the backend itself arbitrated', async () => {
    const port = makePort({ loom: okResult('loom', 'approve'), atlas: okResult('atlas', 'reject') });
    const backend = mockBackend('decision-model', () => choiceResult('approve', 0.92, true));
    const orch = new Orchestrator(lookupFor(['loom', 'atlas']), port, {
      decisionBackend: backend,
      judgeEnabled: true,
    });

    const result = await orch.fanOut({ skill: 'review', params: {}, realm: 'enterprise' });

    expect(result.status).toBe('completed');
    expect(result.backendArbitration?.concluded).toBe(true);
    expect(backend.choiceCalls).toBe(1); // arbitration, no second call for judging
    expect(result.judgeReview).toMatchObject({ judged: false, reason: 'rule-inconclusive' });
  });

  it('records a gated disagreement without escalating when escalateOnDisagreement is false', async () => {
    const backend = mockBackend('decision-model', () => choiceResult('reject', 0.91, true));
    const orch = new Orchestrator(lookupFor(MAJORITY_NAMES), majorityPort(), {
      decisionBackend: backend,
      judgeEnabled: true,
      judgeEscalateOnDisagreement: false,
    });

    const result = await orch.fanOut({ intentId: 'X', skill: 'review', params: {}, realm: 'enterprise' });

    expect(result.status).toBe('completed');
    expect(result.conflicts).toEqual([]);
    expect(result.judgeReview).toMatchObject({ judged: true, agreesWithRule: false, escalated: false });
  });

  it('never invokes the judge unless judgeEnabled is set (default off)', async () => {
    const backend = mockBackend('decision-model', () => choiceResult('reject', 0.99, true));
    const orch = new Orchestrator(lookupFor(MAJORITY_NAMES), majorityPort(), { decisionBackend: backend });

    const result = await orch.fanOut({ skill: 'review', params: {}, realm: 'enterprise' });

    expect(result.status).toBe('completed');
    expect(backend.choiceCalls).toBe(0);
    expect(result.judgeReview).toBeUndefined();
  });

  it('judges again after resumeBranch recomputes the decision', async () => {
    const backend = mockBackend('decision-model', () => choiceResult('approve', 0.93, true));
    const orch = new Orchestrator(lookupFor(MAJORITY_NAMES), majorityPort(), {
      decisionBackend: backend,
      judgeEnabled: true,
    });

    const first = await orch.fanOut({ intentId: 'X', skill: 'review', params: {}, realm: 'enterprise' });
    expect(first.judgeReview?.agreesWithRule).toBe(true);

    const resumed = await orch.resumeBranch('X', 'prhelper', { note: 'redo' });
    expect(resumed.status).toBe('completed');
    expect(backend.choiceCalls).toBe(2);
    expect(resumed.judgeReview?.judged).toBe(true);
  });

  it('lets the driver settle a judge-review conflict through the existing E6.2 loop', async () => {
    const backend = mockBackend('decision-model', () => choiceResult('reject', 0.91, true));
    const orch = new Orchestrator(lookupFor(MAJORITY_NAMES), majorityPort(), {
      decisionBackend: backend,
      judgeEnabled: true,
    });

    const result = await orch.fanOut({ intentId: 'X', skill: 'review', params: {}, realm: 'enterprise' });
    expect(result.status).toBe('needs-driver');

    const settled = orch.resolveIntent('X', { escalationId: 'esc-1', stance: 'reject' });
    expect(settled.status).toBe('completed');
    expect(settled.decision.conclusion).toBe('reject');
    expect(settled.conflicts).toEqual([]);
    expect(settled.driverResolution?.stance).toBe('reject');
  });

  it('appears in the offline replay timeline when it escalated', async () => {
    const backend = mockBackend('decision-model', () => choiceResult('reject', 0.91, true));
    const orch = new Orchestrator(lookupFor(MAJORITY_NAMES), majorityPort(), {
      decisionBackend: backend,
      judgeEnabled: true,
    });
    const result = await orch.fanOut({ intentId: 'X', skill: 'review', params: {}, realm: 'enterprise' });

    const replay = replayDecision(result);
    const kinds = replay.timeline.map(step => step.kind);
    expect(kinds).toContain('judge-reviewed');
    expect(kinds.indexOf('judge-reviewed')).toBeGreaterThan(kinds.indexOf('aggregated'));
    expect(replay.judgeReview?.recommended).toBe('reject');
    expect(replay.conflicts[0].kind).toBe('judge-review');
  });
});
