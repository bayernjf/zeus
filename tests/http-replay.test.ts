import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createHttpServer } from '../src/http/server.js';
import { VassalRegistry } from '../src/registry/registry.js';
import { Ed25519MemorySigner } from '../src/registry/signing.js';
import { Orchestrator } from '../src/orchestrator/orchestrator.js';
import { OversightDesk, conflictsToDesk } from '../src/oversight/oversight.js';
import type { DispatchPort, TargetLookup } from '../src/orchestrator/types.js';
import type { DispatchResult } from '../src/dispatch/dispatcher.js';
import type { A2AEvent, Task, TaskState } from '../src/a2a/types.js';
import type { ReplayStep } from '../src/orchestrator/replay.js';

const TOKEN = 'driver-secret';
const AUTH = { authorization: `Bearer ${TOKEN}` };

function statusEvent(taskId: string, state: TaskState): A2AEvent {
  return { kind: 'status-update', taskId, contextId: 'ctx', status: { state }, final: state === 'completed' };
}

function verdict(vassal: string, stance: string): DispatchResult {
  const task: Task = {
    kind: 'task',
    id: `${vassal}-task`,
    contextId: 'ctx',
    status: { state: 'completed' },
    artifacts: [{ artifactId: 'a1', name: 'verdict', parts: [{ kind: 'data', data: { stance } }] }],
  };
  return { ok: true, task, events: [statusEvent(task.id, 'completed')], injectedHits: [] };
}

const defaultPort: DispatchPort = {
  async dispatch(req) {
    return verdict(req.vassal!, (req.params as { stance?: string }).stance ?? 'go');
  },
  async cancel() {},
};

const splitPort: DispatchPort = {
  async dispatch(req) {
    return verdict(req.vassal!, req.vassal === 'loom' ? 'ship' : 'hold');
  },
  async cancel() {},
};

function lookupFor(names: string[]): TargetLookup {
  return { findBySkill: () => names.map(name => ({ name })) };
}

let orchestrator: Orchestrator;

async function server(names: string[], dispatch: DispatchPort = defaultPort): Promise<FastifyInstance> {
  const desk = new OversightDesk({ newId: () => 'esc-1' });
  orchestrator = new Orchestrator(lookupFor(names), dispatch, {
    newIntentId: () => 'intent-1',
    newRunId: () => 'run-1',
    onConflict: conflictsToDesk(desk),
  });
  return createHttpServer({
    registry: new VassalRegistry(),
    signer: new Ed25519MemorySigner('zeus-rsk-test'),
    internalToken: TOKEN,
    orchestrator,
    oversight: desk,
    now: () => new Date('2026-09-24T00:00:00.000Z'),
  });
}

async function fanOut(app: FastifyInstance, body: Record<string, unknown>): Promise<void> {
  const res = await app.inject({ method: 'POST', url: '/api/intents', headers: AUTH, payload: body });
  expect(res.statusCode).toBe(200);
}

describe('E1.6 decision replay HTTP', () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('replays a stored decision with its dispatch input and timeline', async () => {
    app = await server(['loom', 'atlas']);
    await fanOut(app, {
      skill: 'review', realm: 'personal', params: { stance: 'go', pr: 42 },
      aggregation: { kind: 'unanimous' },
    });

    const res = await app.inject({ method: 'GET', url: '/api/intents/intent-1/replay', headers: AUTH });
    expect(res.statusCode).toBe(200);
    const replay = await res.json();
    expect(replay).toMatchObject({ intentId: 'intent-1', skill: 'review', status: 'completed' });
    expect(replay.input).toEqual({ stance: 'go', pr: 42 });
    expect(replay.aggregation).toEqual({ kind: 'unanimous' });
    expect(replay.participants.map((p: { vassal: string }) => p.vassal).sort()).toEqual(['atlas', 'loom']);
    const kinds = replay.timeline.map((s: ReplayStep) => s.kind);
    expect(kinds[0]).toBe('intent-started');
    expect(kinds).toContain('branch-dispatched');
    expect(kinds).toContain('positions-extracted');
    expect(kinds).toContain('aggregated');
    expect(kinds[kinds.length - 1]).toBe('intent-finished');
    expect(replay.timeline.map((s: ReplayStep) => s.index)).toEqual(
      replay.timeline.map((_: unknown, i: number) => i + 1),
    );
  });

  it('renders a human-readable timeline with ?format=text', async () => {
    app = await server(['loom']);
    await fanOut(app, { skill: 'review', realm: 'personal', params: {} });

    const res = await app.inject({
      method: 'GET', url: '/api/intents/intent-1/replay?format=text', headers: AUTH,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.body).toContain('Decision replay: intent intent-1');
    expect(res.body).toContain('timeline:');
    expect(res.body).toContain('intent-finished');
  });

  it('shows the driver settlement in the replay after a conflict is resolved', async () => {
    app = await server(['loom', 'atlas'], splitPort);
    await fanOut(app, { skill: 'review', realm: 'personal', params: {} });

    const settled = await app.inject({
      method: 'POST', url: '/api/escalations/esc-1/resolve', headers: AUTH,
      payload: { stance: 'ship', note: 'driver call' },
    });
    expect(settled.statusCode).toBe(200);

    const replay = await (await app.inject({
      method: 'GET', url: '/api/intents/intent-1/replay', headers: AUTH,
    })).json();
    expect(replay.status).toBe('completed');
    expect(replay.driverResolution).toMatchObject({ stance: 'ship', note: 'driver call' });
    const step = replay.timeline.find((s: ReplayStep) => s.kind === 'driver-resolved');
    expect(step.detail).toMatchObject({ stance: 'ship', escalationId: 'esc-1' });
  });

  it('404s an unknown intent and 400s a bad format', async () => {
    app = await server(['loom']);
    const missing = await app.inject({ method: 'GET', url: '/api/intents/nope/replay', headers: AUTH });
    expect(missing.statusCode).toBe(404);

    await fanOut(app, { skill: 'review', realm: 'personal', params: {} });
    const bad = await app.inject({
      method: 'GET', url: '/api/intents/intent-1/replay?format=html', headers: AUTH,
    });
    expect(bad.statusCode).toBe(400);
  });

  it('fails loud (500) when the stored record cannot be replayed', async () => {
    app = await server(['loom']);
    await fanOut(app, { skill: 'review', realm: 'personal', params: {} });

    const snapshot = orchestrator.exportState();
    snapshot.intents[0].stream[0].source.runId = 'run-bogus';
    orchestrator.importState(snapshot);

    const res = await app.inject({ method: 'GET', url: '/api/intents/intent-1/replay', headers: AUTH });
    expect(res.statusCode).toBe(500);
    expect(await res.json()).toMatchObject({ error: 'replay_failed' });
  });

  it('requires a bearer token', async () => {
    app = await server(['loom']);
    const res = await app.inject({ method: 'GET', url: '/api/intents/intent-1/replay' });
    expect(res.statusCode).toBe(401);
  });
});
