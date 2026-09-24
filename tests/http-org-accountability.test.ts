import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createHttpServer } from '../src/http/server.js';
import { VassalRegistry } from '../src/registry/registry.js';
import { Ed25519MemorySigner } from '../src/registry/signing.js';
import { Orchestrator } from '../src/orchestrator/orchestrator.js';
import { OversightDesk, conflictsToDesk } from '../src/oversight/oversight.js';
import { OrgRegistry } from '../src/org/registry.js';
import type { DispatchPort, TargetLookup } from '../src/orchestrator/types.js';
import type { DispatchResult } from '../src/dispatch/dispatcher.js';
import type { A2AEvent, Task } from '../src/a2a/types.js';

const TOKEN = 'driver-secret';
const AUTH = { authorization: `Bearer ${TOKEN}` };

function statusEvent(taskId: string): A2AEvent {
  return { kind: 'status-update', taskId, contextId: 'ctx', status: { state: 'completed' }, final: true };
}

function verdict(vassal: string, stance: string): DispatchResult {
  const task: Task = {
    kind: 'task',
    id: `${vassal}-task`,
    contextId: 'ctx',
    status: { state: 'completed' },
    artifacts: [{ artifactId: 'a1', name: 'verdict', parts: [{ kind: 'data', data: { stance } }] }],
  };
  return { ok: true, task, events: [statusEvent(task.id)], injectedHits: [] };
}

// loom ships, atlas holds: the split needs a driver, so the accountability chain
// can be checked both before and after the settlement.
const splitPort: DispatchPort = {
  async dispatch(req) {
    return verdict(req.vassal!, req.vassal === 'loom' ? 'ship' : 'hold');
  },
  async cancel() {},
};

function lookupFor(names: string[]): TargetLookup {
  return { findBySkill: () => names.map(name => ({ name })) };
}

function establishment(): OrgRegistry {
  const org = new OrgRegistry(() => new Date('2026-09-24T00:00:00.000Z'));
  org.createDepartment({ name: 'Engineering', mission: 'ship the review pipeline' });
  org.assignMember('dept:engineering', { agentId: 'architect', role: 'lead', title: 'Head of Engineering' });
  org.assignMember('dept:engineering', { agentId: 'loom', role: 'member' });
  return org;
}

async function server(orgRegistry: OrgRegistry, withOrchestrator = true): Promise<FastifyInstance> {
  const desk = new OversightDesk({ newId: () => 'esc-1' });
  const orchestrator = new Orchestrator(lookupFor(['loom', 'atlas']), splitPort, {
    newIntentId: () => 'intent-1',
    newRunId: () => 'run-1',
    onConflict: conflictsToDesk(desk),
  });
  return createHttpServer({
    registry: new VassalRegistry(),
    signer: new Ed25519MemorySigner('zeus-rsk-test'),
    internalToken: TOKEN,
    orgRegistry,
    ...(withOrchestrator ? { orchestrator, oversight: desk } : {}),
    now: () => new Date('2026-09-24T00:00:00.000Z'),
  });
}

describe('E9.3 accountability HTTP', () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('traces an intent to executing agents, their lead and the unassigned', async () => {
    app = await server(establishment());
    await app.inject({
      method: 'POST', url: '/api/intents', headers: AUTH,
      payload: { skill: 'review', realm: 'personal', params: {} },
    });

    const res = await app.inject({
      method: 'GET', url: '/api/org/accountability/intent-1', headers: AUTH,
    });
    expect(res.statusCode).toBe(200);
    const chain = await res.json();
    expect(chain).toMatchObject({ intentId: 'intent-1', skill: 'review', status: 'needs-driver' });
    expect(chain.executing).toEqual([
      expect.objectContaining({ agentId: 'loom', role: 'member', departmentId: 'dept:engineering' }),
      expect.objectContaining({ agentId: 'atlas', departmentId: 'unassigned' }),
    ]);
    expect(chain.leads).toEqual([
      expect.objectContaining({
        agentId: 'architect', role: 'lead', title: 'Head of Engineering',
        departmentId: 'dept:engineering',
      }),
    ]);
    expect(chain.unassigned).toEqual(['atlas']);
    expect(chain.driver).toBeUndefined();
  });

  it('names the driver who settled the intent', async () => {
    app = await server(establishment());
    await app.inject({
      method: 'POST', url: '/api/intents', headers: AUTH,
      payload: { skill: 'review', realm: 'personal', params: {} },
    });
    const settled = await app.inject({
      method: 'POST', url: '/api/escalations/esc-1/resolve', headers: AUTH,
      payload: { stance: 'ship', note: 'driver call' },
    });
    expect(settled.statusCode).toBe(200);

    const chain = await (await app.inject({
      method: 'GET', url: '/api/org/accountability/intent-1', headers: AUTH,
    })).json();
    expect(chain.status).toBe('completed');
    expect(chain.driver).toMatchObject({ escalationId: 'esc-1', stance: 'ship' });
  });

  it('404s an unknown intent', async () => {
    app = await server(establishment());
    const res = await app.inject({
      method: 'GET', url: '/api/org/accountability/nope', headers: AUTH,
    });
    expect(res.statusCode).toBe(404);
  });

  it('requires a bearer token', async () => {
    app = await server(establishment());
    const res = await app.inject({ method: 'GET', url: '/api/org/accountability/intent-1' });
    expect(res.statusCode).toBe(401);
  });

  it('is not mounted without an orchestrator, while the chart still is', async () => {
    app = await server(establishment(), false);
    const chain = await app.inject({
      method: 'GET', url: '/api/org/accountability/intent-1', headers: AUTH,
    });
    expect(chain.statusCode).toBe(404);
    const chart = await app.inject({ method: 'GET', url: '/api/org/chart', headers: AUTH });
    expect(chart.statusCode).toBe(200);
  });
});
