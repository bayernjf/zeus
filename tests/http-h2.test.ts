import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createHttpServer } from '../src/http/server.js';
import { VassalRegistry } from '../src/registry/registry.js';
import { Ed25519MemorySigner } from '../src/registry/signing.js';
import { Orchestrator } from '../src/orchestrator/orchestrator.js';
import { OversightDesk, conflictsToDesk } from '../src/oversight/oversight.js';
import { ConcurrencyMetrics } from '../src/orchestrator/metrics.js';
import type { DispatchPort, TargetLookup } from '../src/orchestrator/types.js';
import type { DispatchRequest, DispatchResult } from '../src/dispatch/dispatcher.js';
import type { A2AEvent, Task, TaskState } from '../src/a2a/types.js';

const TOKEN = 'driver-secret';
const AUTH = { authorization: `Bearer ${TOKEN}` };

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
  return { ok: false, reason, audit: { ts: 't', vassal: 'v', decision: 'dispatched' as const } };
}

type Route = DispatchResult | ((req: DispatchRequest) => Promise<DispatchResult> | DispatchResult);

function makePort(routes: Record<string, Route>) {
  const cancelCalls: Array<[string, string]> = [];
  const port: DispatchPort & { cancelCalls: typeof cancelCalls } = {
    cancelCalls,
    async dispatch(req) {
      const route = routes[req.vassal!];
      return typeof route === 'function' ? route(req) : route;
    },
    async cancel(vassal, taskId) {
      cancelCalls.push([vassal, taskId]);
    },
  };
  return port;
}

function lookupFor(names: string[]): TargetLookup {
  return { findBySkill: () => names.map(name => ({ name })) };
}

type DriverHarness = {
  app: FastifyInstance;
  port: ReturnType<typeof makePort>;
  desk: OversightDesk;
};

async function driverServer(routes: Record<string, Route>, names: string[]): Promise<DriverHarness> {
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
  });
  const app = await createHttpServer({
    registry,
    signer,
    internalToken: TOKEN,
    orchestrator,
    oversight: desk,
    metrics,
    now: () => new Date('2026-09-22T00:00:00.000Z'),
  });
  return { app, port, desk };
}

describe('HTTP H2 driver API — auth', () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('does not mount H2 routes when no internal token is configured', async () => {
    app = await createHttpServer({
      registry: new VassalRegistry(),
      signer: new Ed25519MemorySigner('k'),
    });
    const reply = await app.inject({ method: 'POST', url: '/api/intents', payload: { skill: 'x', realm: 'personal', params: {} } });
    expect(reply.statusCode).toBe(404);
    expect(await app.inject({ method: 'GET', url: '/api/escalations' })).toMatchObject({ statusCode: 404 });
    expect(await app.inject({ method: 'GET', url: '/api/metrics' })).toMatchObject({ statusCode: 404 });
  });

  it('rejects H2 requests without or with a wrong bearer token', async () => {
    const harness = await driverServer({ loom: okResult('loom') }, ['loom']);
    app = harness.app;
    const noAuth = await app.inject({ method: 'POST', url: '/api/intents', payload: { skill: 'x', realm: 'personal', params: {} } });
    expect(noAuth.statusCode).toBe(401);
    const wrong = await app.inject({
      method: 'GET',
      url: '/api/escalations',
      headers: { authorization: 'Bearer nope' },
    });
    expect(wrong.statusCode).toBe(401);
    const metrics = await app.inject({ method: 'GET', url: '/api/metrics' });
    expect(metrics.statusCode).toBe(401);
  });
});

describe('HTTP H2 driver API — intent lifecycle', () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('fans out an intent and returns the aggregated decision', async () => {
    const harness = await driverServer(
      { loom: okResult('loom', 'completed', 'approve'), atlas: okResult('atlas', 'completed', 'approve') },
      ['loom', 'atlas']
    );
    app = harness.app;
    const reply = await app.inject({
      method: 'POST',
      url: '/api/intents',
      headers: AUTH,
      payload: { skill: 'review', realm: 'enterprise', params: {} },
    });
    expect(reply.statusCode).toBe(200);
    const body = JSON.parse(reply.body);
    expect(body.status).toBe('completed');
    expect(body.intentId).toBe('intent-1');
    expect(body.decision.conclusion).toBe('approve');
    expect(body.branches.map((b: { vassal: string }) => b.vassal)).toEqual(['loom', 'atlas']);
  });

  it('rejects malformed intent requests with 400', async () => {
    const harness = await driverServer({ loom: okResult('loom') }, ['loom']);
    app = harness.app;
    const noSkill = await app.inject({ method: 'POST', url: '/api/intents', headers: AUTH, payload: { realm: 'personal', params: {} } });
    expect(noSkill.statusCode).toBe(400);
    const badRealm = await app.inject({
      method: 'POST',
      url: '/api/intents',
      headers: AUTH,
      payload: { skill: 'x', realm: 'cloud', params: {} },
    });
    expect(badRealm.statusCode).toBe(400);
    const badVassals = await app.inject({
      method: 'POST',
      url: '/api/intents',
      headers: AUTH,
      payload: { skill: 'x', realm: 'personal', params: {}, vassals: ['loom', 7] },
    });
    expect(badVassals.statusCode).toBe(400);
  });

  it('reads a stored intent and 404s on an unknown one', async () => {
    const harness = await driverServer({ loom: okResult('loom') }, ['loom']);
    app = harness.app;
    await app.inject({ method: 'POST', url: '/api/intents', headers: AUTH, payload: { skill: 'x', realm: 'personal', params: {} } });
    const ok = await app.inject({ method: 'GET', url: '/api/intents/intent-1', headers: AUTH });
    expect(ok.statusCode).toBe(200);
    expect(JSON.parse(ok.body).intentId).toBe('intent-1');
    const missing = await app.inject({ method: 'GET', url: '/api/intents/nope', headers: AUTH });
    expect(missing.statusCode).toBe(404);
  });

  it('replays an idempotent intent without re-dispatching', async () => {
    const harness = await driverServer({ loom: okResult('loom') }, ['loom']);
    app = harness.app;
    const payload = { intentId: 'fixed', skill: 'x', realm: 'personal', params: {} };
    const first = await app.inject({ method: 'POST', url: '/api/intents', headers: AUTH, payload });
    expect(first.statusCode).toBe(200);
    const second = await app.inject({ method: 'POST', url: '/api/intents', headers: AUTH, payload });
    expect(second.statusCode).toBe(200);
    expect(JSON.parse(second.body).replayed).toBe(true);
  });

  it('cancels non-terminal branches of an intent', async () => {
    const harness = await driverServer(
      { loom: okResult('loom', 'input-required'), atlas: okResult('atlas', 'completed') },
      ['loom', 'atlas']
    );
    app = harness.app;
    await app.inject({
      method: 'POST',
      url: '/api/intents',
      headers: AUTH,
      payload: { intentId: 'cancel-me', skill: 'x', realm: 'enterprise', params: {} },
    });
    const reply = await app.inject({ method: 'POST', url: '/api/intents/cancel-me/cancel', headers: AUTH });
    expect(reply.statusCode).toBe(200);
    const body = JSON.parse(reply.body);
    expect(body.results).toEqual([{ vassal: 'loom', taskId: 'loom-task', canceled: true }]);
    expect(harness.port.cancelCalls).toEqual([['loom', 'loom-task']]);
    const missing = await app.inject({ method: 'POST', url: '/api/intents/nope/cancel', headers: AUTH });
    expect(missing.statusCode).toBe(404);
  });
});

describe('HTTP H2 driver API — conflict escalation and resolution', () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('runs the full loop: split → escalate → driver settles → decision written back', async () => {
    const harness = await driverServer(
      { loom: okResult('loom', 'completed', 'approve'), atlas: okResult('atlas', 'completed', 'reject') },
      ['loom', 'atlas']
    );
    app = harness.app;

    // 1. fan-out ends in a split the majority rule cannot conclude
    const fan = await app.inject({
      method: 'POST',
      url: '/api/intents',
      headers: AUTH,
      payload: { skill: 'review', realm: 'enterprise', params: {} },
    });
    expect(fan.statusCode).toBe(200);
    expect(JSON.parse(fan.body).status).toBe('needs-driver');

    // 2. the conflict entered the oversight queue
    const list = await app.inject({ method: 'GET', url: '/api/escalations?status=pending', headers: AUTH });
    expect(list.statusCode).toBe(200);
    const escalations = JSON.parse(list.body).escalations;
    expect(escalations).toHaveLength(1);
    expect(escalations[0]).toMatchObject({
      id: 'esc-1',
      kind: 'intent-conflict',
      intentId: 'intent-1',
      status: 'pending',
      options: ['approve', 'reject'],
    });

    // 3. the driver settles it by accepting "approve"
    const resolve = await app.inject({
      method: 'POST',
      url: '/api/escalations/esc-1/resolve',
      headers: AUTH,
      payload: { stance: 'approve', note: 'human call' },
    });
    expect(resolve.statusCode).toBe(200);
    const resolved = JSON.parse(resolve.body);
    expect(resolved.escalation.status).toBe('approved');
    expect(resolved.escalation.decidedStance).toBe('approve');
    expect(resolved.intent.decision.conclusion).toBe('approve');
    expect(resolved.intent.conflicts).toEqual([]);
    expect(resolved.intent.driverResolution).toMatchObject({ escalationId: 'esc-1', stance: 'approve' });

    // 4. the written-back decision is readable on the intent
    const intent = await app.inject({ method: 'GET', url: '/api/intents/intent-1', headers: AUTH });
    expect(JSON.parse(intent.body).decision.conclusion).toBe('approve');
  });

  it('404s an unknown escalation and 400s a stance that is not an option', async () => {
    const harness = await driverServer(
      { loom: okResult('loom', 'completed', 'approve'), atlas: okResult('atlas', 'completed', 'reject') },
      ['loom', 'atlas']
    );
    app = harness.app;
    await app.inject({ method: 'POST', url: '/api/intents', headers: AUTH, payload: { skill: 'review', realm: 'enterprise', params: {} } });

    const missing = await app.inject({
      method: 'POST',
      url: '/api/escalations/nope/resolve',
      headers: AUTH,
      payload: { stance: 'approve' },
    });
    expect(missing.statusCode).toBe(404);

    const badStance = await app.inject({
      method: 'POST',
      url: '/api/escalations/esc-1/resolve',
      headers: AUTH,
      payload: { stance: 'abstain' },
    });
    expect(badStance.statusCode).toBe(400);
  });

  it('409s when settling an already-decided conflict', async () => {
    const harness = await driverServer(
      { loom: okResult('loom', 'completed', 'approve'), atlas: okResult('atlas', 'completed', 'reject') },
      ['loom', 'atlas']
    );
    app = harness.app;
    await app.inject({ method: 'POST', url: '/api/intents', headers: AUTH, payload: { skill: 'review', realm: 'enterprise', params: {} } });
    const first = await app.inject({ method: 'POST', url: '/api/escalations/esc-1/resolve', headers: AUTH, payload: { stance: 'approve' } });
    expect(first.statusCode).toBe(200);
    const again = await app.inject({ method: 'POST', url: '/api/escalations/esc-1/resolve', headers: AUTH, payload: { stance: 'reject' } });
    expect(again.statusCode).toBe(409);
  });

  it('reads one escalation by id without refetching the queue', async () => {
    const harness = await driverServer({}, []);
    app = harness.app;
    const created = harness.desk.ingest(
      okResult('loom', 'input-required'),
      { vassal: 'loom', skill: 'review', realm: 'enterprise', runId: 'run-1' } as DispatchRequest
    );
    const hit = await app.inject({ method: 'GET', url: `/api/escalations/${created!.id}`, headers: AUTH });
    expect(hit.statusCode).toBe(200);
    expect(JSON.parse(hit.body)).toMatchObject({ id: created!.id, kind: 'task-input', status: 'pending' });

    expect((await app.inject({ method: 'GET', url: '/api/escalations/nope', headers: AUTH })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/escalations/nope' })).statusCode).toBe(401);
  });

  it('approves a task-input escalation through the same driver face', async () => {
    const harness = await driverServer({}, []);
    app = harness.app;
    const created = harness.desk.ingest(
      okResult('loom', 'input-required'),
      { vassal: 'loom', skill: 'review', realm: 'enterprise', runId: 'run-1' } as DispatchRequest
    );
    expect(created).not.toBeNull();
    const reply = await app.inject({
      method: 'POST',
      url: `/api/escalations/${created!.id}/approve`,
      headers: AUTH,
      payload: { note: 'proceed' },
    });
    expect(reply.statusCode).toBe(200);
    expect(JSON.parse(reply.body)).toMatchObject({ status: 'approved', kind: 'task-input' });
  });

  it('narrows the queue by kind, so a missing parameter and a memory dispute are not mixed', async () => {
    const harness = await driverServer({}, []);
    app = harness.app;
    harness.desk.ingest(
      okResult('loom', 'input-required'),
      { vassal: 'loom', skill: 'review', realm: 'enterprise', runId: 'run-1' } as DispatchRequest
    );
    harness.desk.ingestMemoryDispute({
      id: 'mem-1', runId: 'run-2', realm: 'personal', factId: 'fact-a',
      conflictingFacts: ['fact-b'], reason: 'two agents disagree about the release date',
    });

    const all = await app.inject({ method: 'GET', url: '/api/escalations', headers: AUTH });
    expect((await all.json()).escalations).toHaveLength(2);

    for (const [kind, size] of [['task-input', 1], ['memory-dispute', 1]] as const) {
      const filtered = await app.inject({ method: 'GET', url: `/api/escalations?kind=${kind}`, headers: AUTH });
      const escalations = (await filtered.json()).escalations;
      expect(escalations).toHaveLength(size);
      expect(escalations[0].kind).toBe(kind);
    }

    const pending = await app.inject({
      method: 'GET', url: '/api/escalations?status=pending&kind=memory-dispute', headers: AUTH,
    });
    expect((await pending.json()).escalations).toHaveLength(1);

    const settled = await app.inject({
      method: 'GET', url: '/api/escalations?status=approved&kind=memory-dispute', headers: AUTH,
    });
    expect((await settled.json()).escalations).toHaveLength(0);

    const bogus = await app.inject({ method: 'GET', url: '/api/escalations?kind=nope', headers: AUTH });
    expect(bogus.statusCode).toBe(400);
  });
});

describe('HTTP H2 driver API — metrics', () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('exposes a concurrency snapshot after fan-out', async () => {
    const harness = await driverServer(
      { loom: okResult('loom', 'completed', 'approve'), atlas: failResult('down') },
      ['loom', 'atlas']
    );
    app = harness.app;
    await app.inject({ method: 'POST', url: '/api/intents', headers: AUTH, payload: { skill: 'x', realm: 'personal', params: {} } });
    const reply = await app.inject({ method: 'GET', url: '/api/metrics', headers: AUTH });
    expect(reply.statusCode).toBe(200);
    const snap = JSON.parse(reply.body);
    expect(snap.finished).toBe(2);
    expect(snap.completed).toBe(1);
    expect(snap.failed).toBe(1);
    expect(snap.inFlight).toBe(0);
    expect(snap.perVassal.loom.calls).toBe(1);
    expect(snap.perVassal.atlas.failureRate).toBe(1);
  });
});
