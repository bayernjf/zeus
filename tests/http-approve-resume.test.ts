import { describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createHttpServer } from '../src/http/server.js';
import { VassalRegistry } from '../src/registry/registry.js';
import { Ed25519MemorySigner } from '../src/registry/signing.js';
import { Orchestrator, IntentBudgetExceededError } from '../src/orchestrator/orchestrator.js';
import { OversightDesk, conflictsToDesk } from '../src/oversight/oversight.js';
import { ConcurrencyMetrics } from '../src/orchestrator/metrics.js';
import { ExecutionDelegationNonceLedger, issueExecutionDelegation } from '../src/delegation/execution-delegation.js';
import type { DispatchPort, TargetLookup } from '../src/orchestrator/types.js';
import type { DispatchRequest, DispatchResult } from '../src/dispatch/dispatcher.js';
import type { A2AEvent, Task, TaskState } from '../src/a2a/types.js';

const TOKEN = 'driver-secret';
const AUTH = { authorization: `Bearer ${TOKEN}` };

function resultFor(vassal: string, state: TaskState, stance?: string): DispatchResult {
  const taskId = `${vassal}-task`;
  const event: A2AEvent = { kind: 'status-update', taskId, contextId: 'ctx', status: { state }, final: state !== 'input-required' };
  const task: Task = {
    kind: 'task', id: taskId, contextId: 'ctx', status: { state },
    artifacts: stance ? [{ artifactId: 'a1', name: 'verdict', parts: [{ kind: 'data', data: { stance } }] }] : [],
  };
  return { ok: true, task, events: [event], injectedHits: [] };
}

type Harness = {
  app: FastifyInstance;
  desk: OversightDesk;
  orchestrator: Orchestrator;
  signer: Ed25519MemorySigner;
};

async function setup(options: { mode?: 'plan' | 'execute' } = {}): Promise<Harness> {
  const registry = new VassalRegistry();
  const signer = new Ed25519MemorySigner('zeus-rsk-test');
  const desk = new OversightDesk({ newId: () => 'esc-1' });
  const metrics = new ConcurrencyMetrics();
  const ledger = new ExecutionDelegationNonceLedger();

  let calls = 0;
  const seen: DispatchResult[] = [];
  const port: DispatchPort = {
    async dispatch(_req: DispatchRequest) {
      calls += 1;
      const result = calls === 1 ? resultFor('v1', 'input-required') : resultFor('v1', 'completed', 'yes');
      seen.push(result);
      return result;
    },
    async cancel() {},
  };
  const lookup: TargetLookup = { findBySkill: () => [{ name: 'v1' }] };
  const orchestrator = new Orchestrator(lookup, port, {
    newIntentId: () => 'intent-1', newRunId: () => 'run-1', metrics, onConflict: conflictsToDesk(desk),
    ...(options.mode === 'execute'
      ? { executionDelegation: { verifier: signer.verifier(), ledger, acceptedKeyIds: [signer.keyId] } }
      : {}),
  });

  const seedDelegation = options.mode === 'execute'
    ? await issueExecutionDelegation(
        { grantedBy: 'op', skill: 'research', capabilities: ['execute'] },
        { signer },
      )
    : undefined;
  await orchestrator.fanOut({
    skill: 'research', realm: 'personal', params: {},
    ...(seedDelegation ? { mode: 'execute' as const, executionDelegation: seedDelegation } : {}),
  });
  // The paused branch surfaces as a task-input escalation at the desk.
  desk.ingest(seen[0]!, { vassal: 'v1', skill: 'research', realm: 'personal', runId: 'run-1:v1', params: {} });

  const app = await createHttpServer({
    registry, signer, internalToken: TOKEN, orchestrator, oversight: desk, metrics,
  });
  return { app, desk, orchestrator, signer };
}

describe('E6.3 one-click approve-resume', () => {
  it('approves the escalation and re-dispatches the branch with supplied params', async () => {
    const { app, desk } = await setup();
    const res = await app.inject({
      method: 'POST', url: '/api/escalations/esc-1/approve-resume', headers: AUTH,
      payload: { params: { answer: '42' }, note: 'driver answered' },
    });
    expect(res.statusCode).toBe(200);
    const body = await res.json();
    expect(body.escalation.status).toBe('approved');
    expect(body.intent.status).toBe('completed');
    expect(desk.get('esc-1')!.status).toBe('approved');
  });

  it('requires a params object', async () => {
    const { app } = await setup();
    const res = await app.inject({ method: 'POST', url: '/api/escalations/esc-1/approve-resume', headers: AUTH, payload: {} });
    expect(res.statusCode).toBe(400);
  });

  it('404s an unknown escalation', async () => {
    const { app } = await setup();
    const res = await app.inject({ method: 'POST', url: '/api/escalations/nope/approve-resume', headers: AUTH, payload: { params: {} } });
    expect(res.statusCode).toBe(404);
  });

  it('requires bearer auth', async () => {
    const { app } = await setup();
    const res = await app.inject({ method: 'POST', url: '/api/escalations/esc-1/approve-resume', payload: { params: {} } });
    expect(res.statusCode).toBe(401);
  });

  it('leaves the escalation pending when re-dispatch fails, so the approval can be retried (M-02)', async () => {
    const { app, desk, orchestrator } = await setup();
    // Simulated kernel rejection (e.g. branch budget exhausted). The approval
    // record must only be written once resumeBranch settles — otherwise the
    // escalation is pinned to "approved" while the branch never re-ran and no
    // retry is possible.
    const original = orchestrator.resumeBranch.bind(orchestrator);
    let failNext = true;
    orchestrator.resumeBranch = ((intentId: string, vassal: string, params: Record<string, unknown>) => {
      if (failNext) {
        failNext = false;
        return Promise.reject(new IntentBudgetExceededError('simulated budget exhaustion'));
      }
      return original(intentId, vassal, params);
    }) as typeof orchestrator.resumeBranch;

    const failed = await app.inject({
      method: 'POST', url: '/api/escalations/esc-1/approve-resume', headers: AUTH,
      payload: { params: { answer: '42' } },
    });
    expect(failed.statusCode).toBe(409);
    expect(desk.get('esc-1')!.status).toBe('pending');

    const retry = await app.inject({
      method: 'POST', url: '/api/escalations/esc-1/approve-resume', headers: AUTH,
      payload: { params: { answer: '42' } },
    });
    expect(retry.statusCode).toBe(200);
    expect(desk.get('esc-1')!.status).toBe('approved');
  });

  it('refuses to resume an execute intent without a fresh delegation and keeps the escalation pending (M-02)', async () => {
    const { app, desk } = await setup({ mode: 'execute' });
    const res = await app.inject({
      method: 'POST', url: '/api/escalations/esc-1/approve-resume', headers: AUTH,
      payload: { params: { answer: '42' } },
    });
    expect(res.statusCode).toBe(400);
    expect(desk.get('esc-1')!.status).toBe('pending');
  });

  it('resumes an execute intent when the request carries a freshly issued execution delegation (M-02)', async () => {
    const { app, desk, signer } = await setup({ mode: 'execute' });
    const delegation = await issueExecutionDelegation(
      { grantedBy: 'op', skill: 'research', capabilities: ['execute'] },
      { signer },
    );
    const res = await app.inject({
      method: 'POST', url: '/api/escalations/esc-1/approve-resume', headers: AUTH,
      payload: { params: { answer: '42' }, executionDelegation: delegation },
    });
    expect(res.statusCode).toBe(200);
    const body = await res.json();
    expect(body.escalation.status).toBe('approved');
    expect(body.intent.status).toBe('completed');
    expect(desk.get('esc-1')!.status).toBe('approved');
  });
});
