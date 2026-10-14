import { afterEach, describe, expect, it } from 'vitest';
import { createHttpServer } from '../src/http/server.js';
import { VassalRegistry } from '../src/registry/registry.js';
import { Ed25519MemorySigner } from '../src/registry/signing.js';
import { Orchestrator } from '../src/orchestrator/orchestrator.js';
import type { DispatchPort, TargetLookup } from '../src/orchestrator/types.js';
import type { DispatchRequest, DispatchResult } from '../src/dispatch/dispatcher.js';
import type { A2AEvent, Task } from '../src/a2a/types.js';

/**
 * E4.11 (design-a2a-push): the HTTP callback receiver
 * `POST /api/a2a/push-notifications` — bearer-protected, mounted only when the
 * internal token is set and an orchestrator is present, idempotent per taskId.
 */

const TOKEN = 'driver-secret';
const AUTH = { authorization: `Bearer ${TOKEN}` };
const PUSH_URL = 'http://127.0.0.1:8787/api/a2a/push-notifications';

function ack(vassal: string): DispatchResult {
  const task: Task = {
    kind: 'task', id: `${vassal}-t`, contextId: 'ctx', status: { state: 'working' }, artifacts: [],
  };
  const event: A2AEvent = { kind: 'status-update', taskId: task.id, contextId: 'ctx', status: { state: 'working' }, final: false };
  return { ok: true, task, events: [event], injectedHits: [] };
}

function finalTask(vassal: string, state: Task['status']['state'] = 'completed'): Task {
  return {
    kind: 'task', id: `${vassal}-t`, contextId: 'ctx', status: { state },
    artifacts: [{ artifactId: 'a', name: 'r', parts: [{ kind: 'data', data: { stance: 'go' } }] }],
  };
}

function lookupFor(names: string[]): TargetLookup {
  return { findBySkill: () => names.map(name => ({ name })) };
}

function immediatePort() {
  const port: DispatchPort = {
    async dispatch(req: DispatchRequest) {
      return ack(req.vassal!);
    },
    async cancel() {},
  };
  return port;
}

async function flush(times = 5): Promise<void> {
  for (let i = 0; i < times; i += 1) await new Promise(resolve => setImmediate(resolve));
}

async function server(options: Omit<Parameters<typeof createHttpServer>[0], 'registry' | 'signer'>) {
  return createHttpServer({
    registry: new VassalRegistry(),
    signer: new Ed25519MemorySigner('zeus-rsk-test'),
    ...options,
  });
}

function armedOrchestrator() {
  return new Orchestrator(lookupFor(['a']), immediatePort(), {
    now: () => new Date('2026-10-14T00:00:00.000Z'),
    newIntentId: () => 'intent-1',
    newRunId: () => 'run-1',
    pushReceiver: { url: PUSH_URL, token: TOKEN },
  });
}

describe('POST /api/a2a/push-notifications (E4.11)', () => {
  let app: Awaited<ReturnType<typeof createHttpServer>> | undefined;
  afterEach(async () => app?.close());

  it('is not mounted when the internal token is unset', async () => {
    app = await server({ orchestrator: armedOrchestrator() });
    const res = await app.inject({
      method: 'POST', url: '/api/a2a/push-notifications',
      headers: AUTH, payload: finalTask('a'),
    });
    expect(res.statusCode).toBe(404);
  });

  it('is not mounted when no orchestrator is present', async () => {
    app = await server({ internalToken: TOKEN });
    const res = await app.inject({
      method: 'POST', url: '/api/a2a/push-notifications',
      headers: AUTH, payload: finalTask('a'),
    });
    expect(res.statusCode).toBe(404);
  });

  it('requires bearer auth', async () => {
    app = await server({ internalToken: TOKEN, orchestrator: armedOrchestrator() });
    const res = await app.inject({ method: 'POST', url: '/api/a2a/push-notifications', payload: finalTask('a') });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a malformed body (400)', async () => {
    app = await server({ internalToken: TOKEN, orchestrator: armedOrchestrator() });
    for (const payload of [
      {},
      { id: 42, status: {} },
      { id: 't', status: { state: 'bogus' } },
      { id: '', status: { state: 'completed' } },
    ]) {
      const res = await app.inject({ method: 'POST', url: '/api/a2a/push-notifications', headers: AUTH, payload });
      expect(res.statusCode).toBe(400);
    }
  });

  it('refuses an unknown task id (404) even with a valid bearer', async () => {
    app = await server({ internalToken: TOKEN, orchestrator: armedOrchestrator() });
    const res = await app.inject({
      method: 'POST', url: '/api/a2a/push-notifications',
      headers: AUTH, payload: finalTask('ghost'),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: 'unknown_task' });
  });

  it('accepts a push for an armed branch and settles the intent; a replay is idempotent', async () => {
    const orch = armedOrchestrator();
    app = await server({ internalToken: TOKEN, orchestrator: orch });
    let settled = false;
    const fanOut = orch
      .fanOut({ skill: 'review', realm: 'personal', params: {}, pushNotification: true })
      .then(result => { settled = true; return result; });
    await flush();
    expect(settled).toBe(false);

    const accepted = await app.inject({
      method: 'POST', url: '/api/a2a/push-notifications',
      headers: AUTH, payload: finalTask('a', 'completed'),
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toMatchObject({ ok: true, idempotent: false, state: 'completed' });

    const replay = await app.inject({
      method: 'POST', url: '/api/a2a/push-notifications',
      headers: AUTH, payload: finalTask('a', 'completed'),
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ ok: true, idempotent: true, state: 'completed' });

    const result = await fanOut;
    expect(result.status).toBe('completed');
    expect(result.branches[0]).toMatchObject({ vassal: 'a', ok: true, state: 'completed' });
  });
});
