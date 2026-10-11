import { afterEach, describe, expect, it } from 'vitest';
import { createHttpServer } from '../src/http/server.js';
import { VassalRegistry } from '../src/registry/registry.js';
import { Ed25519MemorySigner } from '../src/registry/signing.js';
import { Orchestrator } from '../src/orchestrator/orchestrator.js';
import { ProgressHub } from '../src/orchestrator/progress.js';
import type { DispatchPort, TargetLookup } from '../src/orchestrator/types.js';
import type { DispatchRequest, DispatchResult } from '../src/dispatch/dispatcher.js';
import type { A2AEvent, Task } from '../src/a2a/types.js';

const TOKEN = 'driver-secret';
const AUTH = { authorization: `Bearer ${TOKEN}` };

function statusEvent(taskId: string): A2AEvent {
  return { kind: 'status-update', taskId, contextId: 'ctx', status: { state: 'completed' }, final: true };
}

function done(vassal: string, stance = 'approve'): DispatchResult {
  const task: Task = {
    kind: 'task', id: `${vassal}-t`, contextId: 'ctx', status: { state: 'completed' },
    artifacts: [{ artifactId: 'a', name: 'r', parts: [{ kind: 'data', data: { stance } }] }],
  };
  return { ok: true, task, events: [statusEvent(task.id)], injectedHits: [] };
}

function lookupFor(names: string[]): TargetLookup {
  return { findBySkill: () => names.map(name => ({ name })) };
}

function gatedPort() {
  const waiting: Array<{ finish: (r: DispatchResult) => void; vassal: string }> = [];
  const port: DispatchPort = {
    async dispatch(req: DispatchRequest) {
      return new Promise<DispatchResult>(resolve => waiting.push({ vassal: req.vassal!, finish: resolve }));
    },
    async cancel() {},
  };
  return {
    port,
    async flush(times = 5) {
      for (let i = 0; i < times; i += 1) await new Promise(r => setImmediate(r));
    },
    releaseAll() {
      for (const entry of waiting.splice(0)) entry.finish(done(entry.vassal));
    },
  };
}

async function server(orchestrator: Orchestrator, progressHub: ProgressHub) {
  return createHttpServer({
    registry: new VassalRegistry(),
    signer: new Ed25519MemorySigner('zeus-rsk-test'),
    internalToken: TOKEN,
    orchestrator,
    progressHub,
  });
}

describe('GET /api/active-intents (S15 V3, design-streaming §3.3)', () => {
  let app: Awaited<ReturnType<typeof createHttpServer>> | undefined;
  afterEach(async () => app?.close());

  it('requires bearer auth', async () => {
    const hub = new ProgressHub();
    const orch = new Orchestrator(lookupFor([]), gatedPort().port, {});
    app = await server(orch, hub);
    const res = await app.inject({ method: 'GET', url: '/api/active-intents' });
    expect(res.statusCode).toBe(401);
  });

  it('reports an empty set when nothing is in flight', async () => {
    const hub = new ProgressHub();
    const orch = new Orchestrator(lookupFor([]), gatedPort().port, {});
    app = await server(orch, hub);
    const res = await app.inject({ method: 'GET', url: '/api/active-intents', headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(await res.json()).toEqual({ intents: [] });
  });

  it('projects the stream view for a running intent', async () => {
    const gated = gatedPort();
    const hub = new ProgressHub();
    const orch = new Orchestrator(lookupFor(['loom']), gated.port, {
      newIntentId: () => 'intent-live',
      newRunId: () => 'run-1',
      onProgress: e => hub.publish(e),
    });
    app = await server(orch, hub);
    const flying = orch.fanOut({ intentId: 'intent-live', skill: 'review', params: {}, realm: 'personal' });
    await gated.flush();

    const res = await app.inject({ method: 'GET', url: '/api/active-intents', headers: AUTH });
    expect(res.statusCode).toBe(200);
    const body = await res.json();
    expect(body.intents).toHaveLength(1);
    expect(body.intents[0]).toMatchObject({ intentId: 'intent-live', skill: 'review', status: 'running' });
    // The branch has started and is not settled; its runId is present in the view order.
    expect(body.intents[0].view.order).toHaveLength(1);
    expect(body.intents[0].settledCount).toBe(0);
    expect(body.intents[0].totalCount).toBe(1);

    gated.releaseAll();
    await flying;
  });

  it('lists a needs-driver intent as blocked', async () => {
    const hub = new ProgressHub();
    const split: DispatchPort = {
      async dispatch(req) {
        return done(req.vassal!, req.vassal === 'loom' ? 'approve' : 'reject');
      },
      async cancel() {},
    };
    const orch = new Orchestrator(lookupFor(['loom', 'atlas']), split, {
      newIntentId: () => 'intent-blocked',
      newRunId: () => 'run-1',
      onProgress: e => hub.publish(e),
    });
    app = await server(orch, hub);
    await orch.fanOut({ intentId: 'intent-blocked', skill: 'review', params: {}, realm: 'enterprise' });

    const res = await app.inject({ method: 'GET', url: '/api/active-intents', headers: AUTH });
    const body = await res.json();
    expect(body.intents).toHaveLength(1);
    expect(body.intents[0]).toMatchObject({ intentId: 'intent-blocked', status: 'needs-driver' });
    expect(body.intents[0].settledCount).toBe(2);
  });
});
