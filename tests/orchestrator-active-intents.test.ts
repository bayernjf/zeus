import { describe, expect, it } from 'vitest';
import { Orchestrator } from '../src/orchestrator/orchestrator.js';
import type { DispatchPort, TargetLookup } from '../src/orchestrator/types.js';
import type { DispatchRequest, DispatchResult } from '../src/dispatch/dispatcher.js';
import type { A2AEvent, Task } from '../src/a2a/types.js';

function statusEvent(taskId: string): A2AEvent {
  return { kind: 'status-update', taskId, contextId: 'ctx', status: { state: 'completed' }, final: true };
}

function done(executor: string, stance: string): DispatchResult {
  const task: Task = {
    kind: 'task', id: `${executor}-t`, contextId: 'ctx', status: { state: 'completed' },
    artifacts: [{ artifactId: 'a', name: 'r', parts: [{ kind: 'data', data: { stance } }] }],
  };
  return { ok: true, task, events: [statusEvent(task.id)], injectedHits: [] };
}

function lookupFor(names: string[]): TargetLookup {
  return { findBySkill: () => names.map(name => ({ name })) };
}

/** Dispatches stay open until released, so a fan-out is observable mid-flight. */
function gatedPort() {
  const waiting: Array<{ finish: (r: DispatchResult) => void; executor: string }> = [];
  const port: DispatchPort = {
    async dispatch(req: DispatchRequest) {
      return new Promise<DispatchResult>(resolve => {
        waiting.push({ executor: req.executor!, finish: resolve });
      });
    },
    async cancel() {},
  };
  return {
    port,
    async flush(times = 5) {
      for (let i = 0; i < times; i += 1) await new Promise(r => setImmediate(r));
    },
    releaseAll() {
      for (const entry of waiting.splice(0)) entry.finish(done(entry.executor, 'approve'));
    },
  };
}

describe('Orchestrator.activeIntents (S15 V3, design-streaming §3.3)', () => {
  it('lists a fan-out still running as running with its skill', async () => {
    const gated = gatedPort();
    const orch = new Orchestrator(lookupFor(['loom']), gated.port, {
      newIntentId: () => 'intent-running',
      newRunId: () => 'run-1',
    });
    const flying = orch.fanOut({ intentId: 'intent-running', skill: 'review', params: {}, dataDomain: 'personal' });
    await gated.flush();

    expect(orch.activeIntents()).toEqual([{ intentId: 'intent-running', skill: 'review', status: 'running' }]);

    gated.releaseAll();
    await flying;
  });

  it('excludes terminal completed intents once the fan-out settles', async () => {
    const gated = gatedPort();
    const orch = new Orchestrator(lookupFor(['loom']), gated.port, {
      newIntentId: () => 'intent-done',
      newRunId: () => 'run-1',
    });
    const flying = orch.fanOut({ intentId: 'intent-done', skill: 'review', params: {}, dataDomain: 'personal' });
    await gated.flush();
    gated.releaseAll();
    await flying;

    expect(orch.activeIntents()).toEqual([]);
  });

  it('keeps a needs-operator row listed as blocked until the operator settles it', async () => {
    const split: DispatchPort = {
      async dispatch(req) {
        return done(req.executor!, req.executor === 'loom' ? 'approve' : 'reject');
      },
      async cancel() {},
    };
    const orch = new Orchestrator(lookupFor(['loom', 'atlas']), split, {
      newIntentId: () => 'intent-blocked',
      newRunId: () => 'run-1',
    });
    const result = await orch.fanOut({ intentId: 'intent-blocked', skill: 'review', params: {}, dataDomain: 'enterprise' });

    expect(result.status).toBe('needs-operator');
    expect(orch.activeIntents()).toEqual([{ intentId: 'intent-blocked', skill: 'review', status: 'needs-operator' }]);
  });
});
