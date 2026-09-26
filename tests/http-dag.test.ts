import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createHttpServer } from '../src/http/server.js';
import { VassalRegistry } from '../src/registry/registry.js';
import { Ed25519MemorySigner } from '../src/registry/signing.js';
import { Orchestrator } from '../src/orchestrator/orchestrator.js';
import { DagRunner } from '../src/orchestrator/dag-runner.js';
import { OversightDesk, conflictsToDesk } from '../src/oversight/oversight.js';
import { ConcurrencyMetrics } from '../src/orchestrator/metrics.js';
import type { DispatchPort, TargetLookup } from '../src/orchestrator/types.js';
import type { DispatchRequest, DispatchResult } from '../src/dispatch/dispatcher.js';
import type { A2AEvent, Task, TaskState } from '../src/a2a/types.js';

const TOKEN = 'driver-secret';
const NOW = () => new Date('2026-09-22T00:00:00.000Z');

function statusEvent(taskId: string, state: TaskState): A2AEvent {
  return { kind: 'status-update', taskId, contextId: 'ctx', status: { state }, final: state === 'completed' };
}

function okResult(vassal: string, state: TaskState = 'completed'): DispatchResult {
  const task: Task = {
    kind: 'task',
    id: `${vassal}-task`,
    contextId: 'ctx',
    status: { state },
    artifacts: [],
  };
  return { ok: true, task, events: [statusEvent(task.id, state)], injectedHits: [] };
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

async function dagServer(routes: Record<string, Route>, names: string[]) {
  const registry = new VassalRegistry();
  const signer = new Ed25519MemorySigner('zeus-rsk-test');
  const port = makePort(routes);
  const desk = new OversightDesk({ newId: () => 'esc-1' });
  const metrics = new ConcurrencyMetrics();
  const orchestrator = new Orchestrator(lookupFor(names), port, {
    newIntentId: () => 'intent-1',
    newRunId: () => 'run-1',
    onConflict: conflictsToDesk(desk),
    metrics,
    now: NOW,
  });
  const dagRunner = new DagRunner(lookupFor(names), port, { now: NOW }, orchestrator);
  const app = await createHttpServer({
    registry,
    signer,
    internalToken: TOKEN,
    orchestrator,
    dagRunner,
    oversight: desk,
    metrics,
    now: NOW,
  });
  return { app, desk, orchestrator };
}

describe('HTTP S3 DAG driver API', () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('runs a two-stage dependency intent and records node intents', async () => {
    const harness = await dagServer({ loom: okResult('loom') }, ['loom']);
    app = harness.app;
    const reply = await app.inject({
      method: 'POST',
      url: '/api/intents',
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: {
        realm: 'personal',
        dag: {
          nodes: [
            { id: 'A', skill: 's' },
            { id: 'B', skill: 't', dependsOn: ['A'] },
          ],
        },
      },
    });
    expect(reply.statusCode).toBe(200);
    const body = reply.json();
    expect(body.nodes.map((n: { nodeId: string }) => n.nodeId)).toEqual(['A', 'B']);
    expect(body.nodes.every((n: { state: string }) => n.state === 'completed')).toBe(true);
    // B depends on A, so A must be on the critical path and layer 0.
    expect(body.criticalPath).toContain('B');
    expect(body.layers[0]).toEqual(['A']);
    expect(body.layers[1]).toEqual(['B']);

    // The node intents are real orchestrator intents, reachable individually.
    const nodeA = await app.inject({
      method: 'GET',
      url: `/api/intents/${body.dagId}::A`,
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(nodeA.statusCode).toBe(200);
    expect(nodeA.json().status).toBe('completed');
  });

  it('returns the layer plan and critical path for a run DAG', async () => {
    const harness = await dagServer({ loom: okResult('loom') }, ['loom']);
    app = harness.app;
    const run = await app.inject({
      method: 'POST',
      url: '/api/intents',
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { realm: 'personal', dag: { nodes: [{ id: 'A', skill: 's' }, { id: 'B', skill: 't', dependsOn: ['A'] }] } },
    });
    const dagId = run.json().dagId;
    const reply = await app.inject({
      method: 'GET',
      url: `/api/intents/${dagId}/dag`,
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(reply.statusCode).toBe(200);
    const body = reply.json();
    expect(body.layers).toEqual([['A'], ['B']]);
    expect(body.criticalPath).toEqual(['A', 'B']);
    expect(body.state).toBe('completed');
    expect(body.nodes.map((n: { nodeId: string }) => n.nodeId)).toEqual(['A', 'B']);
  });

  it('rejects a cyclic DAG with a named 400', async () => {
    const harness = await dagServer({ loom: okResult('loom') }, ['loom']);
    app = harness.app;
    const reply = await app.inject({
      method: 'POST',
      url: '/api/intents',
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: {
        realm: 'personal',
        dag: { nodes: [{ id: 'A', skill: 's', dependsOn: ['B'] }, { id: 'B', skill: 't', dependsOn: ['A'] }] },
      },
    });
    expect(reply.statusCode).toBe(400);
    expect(reply.json().error).toBe('invalid_dag');
    expect(reply.json().detail).toMatch(/cycle/i);
  });

  it('rejects a DAG with a dependency on an unknown node', async () => {
    const harness = await dagServer({ loom: okResult('loom') }, ['loom']);
    app = harness.app;
    const reply = await app.inject({
      method: 'POST',
      url: '/api/intents',
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { realm: 'personal', dag: { nodes: [{ id: 'A', skill: 's', dependsOn: ['ghost'] }] } },
    });
    expect(reply.statusCode).toBe(400);
    expect(reply.json().error).toBe('invalid_dag');
    expect(reply.json().detail).toMatch(/ghost/);
  });

  it('rejects malformed dag input fields', async () => {
    const harness = await dagServer({ loom: okResult('loom') }, ['loom']);
    app = harness.app;
    const reply = await app.inject({
      method: 'POST',
      url: '/api/intents',
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { realm: 'personal', dag: { nodes: [{ id: '', skill: 's' }] } },
    });
    expect(reply.statusCode).toBe(400);
    expect(reply.json().error).toBe('invalid_request');
  });

  it('treats dag and skill as mutually exclusive', async () => {
    const harness = await dagServer({ loom: okResult('loom') }, ['loom']);
    app = harness.app;
    const reply = await app.inject({
      method: 'POST',
      url: '/api/intents',
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { realm: 'personal', skill: 's', dag: { nodes: [{ id: 'A', skill: 's' }] } },
    });
    expect(reply.statusCode).toBe(400);
  });

  it('404s for an unknown DAG id', async () => {
    const harness = await dagServer({ loom: okResult('loom') }, ['loom']);
    app = harness.app;
    const reply = await app.inject({
      method: 'GET',
      url: '/api/intents/does-not-exist/dag',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(reply.statusCode).toBe(404);
  });
});
