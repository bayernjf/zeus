import { describe, expect, it, vi } from 'vitest';
import { Orchestrator, IntentBudgetExceededError, type OrchestratorOptions } from '../src/orchestrator/orchestrator.js';
import {
  advanceBudget,
  budgetExceeded,
  circuitOpen,
  emptyBudget,
  mayDispatch,
  settleBranch,
} from '../src/orchestrator/termination.js';
import type { DispatchPort, TargetLookup } from '../src/orchestrator/types.js';
import type { DispatchRequest, DispatchResult } from '../src/dispatch/dispatcher.js';
import type { A2AEvent } from '../src/a2a/types.js';

function statusEvent(taskId: string): A2AEvent {
  return { kind: 'status-update', taskId, contextId: 'ctx', status: { state: 'completed' }, final: true };
}

function taskResult(vassal: string, ok: boolean): DispatchResult {
  if (!ok) {
    return {
      ok: false,
      reason: `vassal ${vassal} failed`,
      audit: { ts: new Date().toISOString(), vassal, decision: 'branch-aborted', detail: 'test failure' },
    };
  }
  const task = {
    kind: 'task' as const, id: `${vassal}-t`, contextId: 'ctx', status: { state: 'completed' as const },
    artifacts: [{ artifactId: 'a', name: 'r', parts: [{ kind: 'data' as const, data: { stance: 'go' } }] }],
  };
  return { ok: true, task, events: [statusEvent(task.id)], injectedHits: [] };
}

function lookupFor(names: string[]): TargetLookup {
  return { findBySkill: () => names.map(name => ({ name })) };
}

/** Port that settles every dispatch immediately with the given outcome. */
function settlingPort(ok: boolean): DispatchPort & { started: string[] } {
  const started: string[] = [];
  return {
    async dispatch(req: DispatchRequest) {
      started.push(req.vassal!);
      return taskResult(req.vassal!, ok);
    },
    async cancel() {},
    started,
  };
}

function build(names: string[], options: OrchestratorOptions = {}, port: DispatchPort & { started: string[] } = settlingPort(true)) {
  const orchestrator = new Orchestrator(lookupFor(names), port, {
    newIntentId: () => 'intent-1',
    newRunId: () => 'run-1',
    ...options,
  });
  return { orchestrator, port };
}

const request = { skill: 'review', realm: 'personal' as const, params: {} };

describe('S4 termination guards (design-supervision §7.1)', () => {
  it('pure budget: cumulative cap trips at used >= limit', () => {
    expect(budgetExceeded({ used: 2, failureStreak: 0 }, 3)).toBe(false);
    expect(budgetExceeded({ used: 3, failureStreak: 0 }, 3)).toBe(true);
    expect(budgetExceeded({ used: 9, failureStreak: 0 }, 3)).toBe(true);
  });

  it('pure breaker: consecutive failures trip at streak >= threshold', () => {
    expect(circuitOpen({ used: 0, failureStreak: 1 }, 2)).toBe(false);
    expect(circuitOpen({ used: 0, failureStreak: 2 }, 2)).toBe(true);
  });

  it('pure bookkeeping: advance charges, settle folds streaks, success resets', () => {
    let b = emptyBudget();
    b = advanceBudget(b, 3);
    expect(b.used).toBe(3);
    expect(b.failureStreak).toBe(0);
    b = settleBranch(b, false);
    expect(b.used).toBe(3);
    expect(b.failureStreak).toBe(1);
    b = settleBranch(b, true);
    expect(b.failureStreak).toBe(0);
  });

  it('pure mayDispatch: budget governs all, breaker only auto-selection', () => {
    const limits = { maxBranchesPerIntent: 2, maxConsecutiveBranchFailures: 2 };
    // budget trips regardless of explicit / auto
    expect(mayDispatch({ used: 2, failureStreak: 0 }, limits, false).allowed).toBe(false);
    expect(mayDispatch({ used: 2, failureStreak: 0 }, limits, true).allowed).toBe(false);
    // breaker trips auto-selection only; explicit driver-named targets stay ungoverned
    expect(mayDispatch({ used: 0, failureStreak: 2 }, limits, false).reason).toBe('circuit-open');
    expect(mayDispatch({ used: 0, failureStreak: 2 }, limits, true).allowed).toBe(true);
    // clean budget passes
    expect(mayDispatch({ used: 0, failureStreak: 0 }, limits, false).allowed).toBe(true);
  });

  it('fan-out with a zero budget refuses immediately, zero outbound, reason attached', async () => {
    const port = settlingPort(true);
    const { orchestrator } = build(['a', 'b'], { maxBranchesPerIntent: 0 }, port);
    const result = await orchestrator.fanOut(request);
    expect(result.status).toBe('failed');
    expect(result.branches).toHaveLength(0);
    expect(result.refused?.reason).toBe('budget-exceeded');
    expect(port.started).toHaveLength(0);
  });

  it('resume exhausts the budget: limit 2 → one resume ok, next throws with audit bridge fired', async () => {
    const onTerminationRefused = vi.fn();
    const { orchestrator } = build(['a'], { maxBranchesPerIntent: 2, onTerminationRefused });
    const first = await orchestrator.fanOut({ ...request, vassals: ['a'] });
    expect(first.status).toBe('completed');

    const resumed = await orchestrator.resumeBranch('intent-1', 'a', { round: 2 });
    expect(resumed.status).toBe('completed');

    await expect(orchestrator.resumeBranch('intent-1', 'a', { round: 3 }))
      .rejects.toBeInstanceOf(IntentBudgetExceededError);
    const refusal = onTerminationRefused.mock.calls[0]?.[0];
    expect(refusal?.reason).toBe('budget-exceeded');
    expect(refusal?.intentId).toBe('intent-1');
  });

  it('auto-selected fan-out refuses when the breaker is already open; explicit bypasses it', async () => {
    // A settled intent left the state table (removed), but its budget record
    // survives: two consecutive failures, threshold 2 → the circuit is open.
    const { orchestrator } = build(['a'], { maxConsecutiveBranchFailures: 2 });
    orchestrator.importState({
      intents: [], requests: [],
      budgets: { 'intent-1': { used: 2, failureStreak: 2 } },
    });
    const refused = await orchestrator.fanOut({ ...request, intentId: 'intent-1' });
    expect(refused.status).toBe('failed');
    expect(refused.refused?.reason).toBe('circuit-open');
    expect(refused.branches).toHaveLength(0);

    // the same intent, but the driver names the target: deliberate override
    const port = settlingPort(true);
    const second = new Orchestrator(lookupFor(['a']), port, {
      newIntentId: () => 'intent-2',
      newRunId: () => 'run-2',
      maxConsecutiveBranchFailures: 2,
    });
    second.importState({
      intents: [], requests: [],
      budgets: { 'intent-1': { used: 2, failureStreak: 2 } },
    });
    const admitted = await second.fanOut({ ...request, intentId: 'intent-1', vassals: ['a'] });
    expect(admitted.status).toBe('completed');
  });

  it('budget state travels with exportState/importState: restart cannot reset the guard', async () => {
    const a = build(['a'], { maxBranchesPerIntent: 1 });
    await a.orchestrator.fanOut({ ...request, vassals: ['a'] });
    const snapshot = a.orchestrator.exportState();
    expect(snapshot.budgets?.['intent-1']?.used).toBe(1);

    const port = settlingPort(true);
    const b = new Orchestrator(lookupFor(['a']), port, {
      newIntentId: () => 'intent-1',
      newRunId: () => 'run-1',
      maxBranchesPerIntent: 1,
    });
    b.importState(snapshot);
    // the restored budget (used=1, limit=1) blocks a resume that the fresh
    // counter would have allowed — the guard survives the restart
    await expect(b.resumeBranch('intent-1', 'a', { round: 2 }))
      .rejects.toBeInstanceOf(IntentBudgetExceededError);
  });

  it('default guards are on: a wide fan-out never brushes the structural defaults', async () => {
    const port = settlingPort(true);
    const names = Array.from({ length: 20 }, (_, i) => `v${i}`);
    const { orchestrator } = build(names, {}, port);
    const result = await orchestrator.fanOut(request);
    expect(result.status).toBe('completed');
    expect(orchestrator.exportState().budgets?.['intent-1']?.used).toBe(20);
  });
});
