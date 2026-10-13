import { afterEach, describe, expect, it } from 'vitest';
import { createHttpServer } from '../src/http/server.js';
import { VassalRegistry } from '../src/registry/registry.js';
import { Ed25519MemorySigner } from '../src/registry/signing.js';
import { Orchestrator } from '../src/orchestrator/orchestrator.js';
import type { DispatchPort, TargetLookup } from '../src/orchestrator/types.js';
import type { DispatchRequest, DispatchResult } from '../src/dispatch/dispatcher.js';
import type { A2AEvent, Task } from '../src/a2a/types.js';

const TOKEN = 'driver-secret';
const AUTH = { authorization: `Bearer ${TOKEN}` };

/**
 * E6.5: the cost gate has refused work since it was wired, but only the audit
 * JSONL could say so. This face is the account: window spend, the configured
 * limits and the refusals — aggregates only, never a branch payload.
 */

function statusEvent(taskId: string): A2AEvent {
  return { kind: 'status-update', taskId, contextId: 'ctx', status: { state: 'completed' }, final: true };
}

function approveResult(vassal: string): DispatchResult {
  const task: Task = {
    kind: 'task',
    id: `${vassal}-t`,
    contextId: 'ctx',
    status: { state: 'completed' },
    artifacts: [{ artifactId: 'a', name: 'r', parts: [{ kind: 'data', data: { stance: 'approve', summary: 'private branch text' } }] }],
  };
  return { ok: true, task, events: [statusEvent(task.id)], injectedHits: [] };
}

const port: DispatchPort = {
  async dispatch(req: DispatchRequest) {
    return approveResult(req.vassal ?? 'unknown');
  },
  async cancel() {},
};

function lookup(names: string[]): TargetLookup {
  return { findBySkill: () => names.map(name => ({ name })) };
}

async function server(orchestrator: Orchestrator) {
  return createHttpServer({
    registry: new VassalRegistry(),
    signer: new Ed25519MemorySigner('zeus-rsk-test'),
    internalToken: TOKEN,
    orchestrator,
  });
}

describe('GET /api/cost (E6.5)', () => {
  let app: Awaited<ReturnType<typeof createHttpServer>> | undefined;
  afterEach(async () => app?.close());

  it('requires bearer auth', async () => {
    app = await server(new Orchestrator(lookup([]), port, {}));
    const res = await app.inject({ method: 'GET', url: '/api/cost' });
    expect(res.statusCode).toBe(401);
  });

  it('says the gate is unconfigured rather than reporting an empty account', async () => {
    app = await server(new Orchestrator(lookup(['alpha']), port, {}));
    await app.inject({
      method: 'POST',
      url: '/api/intents',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ skill: 'review', params: {}, realm: 'personal', vassals: ['alpha'] }),
    });
    const res = await app.inject({ method: 'GET', url: '/api/cost', headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(await res.json()).toEqual({
      configured: false,
      refusals: 0,
      limits: {},
      totals: { intents: 0, spent: 0, inFlightEstimate: 0 },
      windows: [],
      truncated: false,
    });
  });

  it('reports the window, the limit and the refusal the audit file also holds', async () => {
    const orch = new Orchestrator(lookup(['alpha']), port, {
      costLimit: { maxWindowCost: 3, circuitWindowMs: 60_000 },
    });
    app = await server(orch);
    await orch.fanOut({
      intentId: 'http-cheap', skill: 'review', params: { message: 'x' }, realm: 'personal', vassals: ['alpha'],
      costEstimate: { tokens: 2 },
    });
    await orch.fanOut({
      intentId: 'http-over', skill: 'review', params: { message: 'y' }, realm: 'personal', vassals: ['alpha'],
      costEstimate: { tokens: 9 },
    });
    const body = await (await app.inject({ method: 'GET', url: '/api/cost', headers: AUTH })).json();
    expect(body).toMatchObject({
      configured: true,
      refusals: 1,
      limits: { maxWindowCost: 3, circuitWindowMs: 60_000 },
      totals: { intents: 2 },
    });
    expect(body.windows.map((w: { intentId: string }) => w.intentId).sort()).toEqual(['http-cheap', 'http-over']);
  });

  it('carries no branch payload, credential or endpoint', async () => {
    const orch = new Orchestrator(lookup(['alpha']), port, { costLimit: { maxWindowCost: 3 } });
    app = await server(orch);
    await orch.fanOut({
      intentId: 'http-clean', skill: 'review', params: { message: 'x' }, realm: 'personal', vassals: ['alpha'],
      costEstimate: { tokens: 2 },
    });
    const text = JSON.stringify(await (await app.inject({ method: 'GET', url: '/api/cost', headers: AUTH })).json());
    for (const forbidden of ['private branch text', 'approve', 'token', 'authorization', 'cardUrl', 'taskUrl', '/api/a2a']) {
      expect(text, `cost readout leaked ${forbidden}`).not.toContain(forbidden);
    }
  });
});
