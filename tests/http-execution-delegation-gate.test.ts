import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createHttpServer } from '../src/http/server.js';
import { VassalRegistry } from '../src/registry/registry.js';
import { Ed25519MemorySigner } from '../src/registry/signing.js';
import { Orchestrator } from '../src/orchestrator/orchestrator.js';
import { OversightDesk, conflictsToDesk } from '../src/oversight/oversight.js';
import { ConcurrencyMetrics } from '../src/orchestrator/metrics.js';
import { ExecutionDelegationNonceLedger, issueExecutionDelegation } from '../src/delegation/execution-delegation.js';
import type { DispatchPort, TargetLookup } from '../src/orchestrator/types.js';
import type { DispatchResult, AuditEntry } from '../src/dispatch/dispatcher.js';
import type { A2AEvent, Task } from '../src/a2a/types.js';

const TOKEN = 'driver-secret';
const AUTH = { authorization: `Bearer ${TOKEN}` };
const NOW = new Date('2026-10-03T00:00:00.000Z');

function okResult(vassal: string): DispatchResult {
  const task: Task = {
    kind: 'task', id: `${vassal}-task`, contextId: 'ctx', status: { state: 'completed' },
    artifacts: [{ artifactId: 'a1', name: 'verdict', parts: [{ kind: 'data', data: { stance: 'go' } }] }],
  };
  return { ok: true, task, events: [{ kind: 'status-update', taskId: task.id, contextId: 'ctx', status: { state: 'completed' }, final: true } as A2AEvent], injectedHits: [] };
}

function makePort() {
  const dispatch = vi.fn(async () => okResult('pr-helper'));
  const cancel = vi.fn(async () => {});
  const port: DispatchPort = { dispatch, cancel };
  return { port, dispatch, cancel };
}

function lookupFor(names: string[]): TargetLookup {
  return { findBySkill: () => names.map(name => ({ name })) };
}

async function gateServer() {
  const signer = new Ed25519MemorySigner('zeus-rsk-test');
  const ledger = new ExecutionDelegationNonceLedger();
  const audit: AuditEntry[] = [];
  const { port, dispatch } = makePort();
  const desk = new OversightDesk({ newId: () => 'esc-1' });
  const metrics = new ConcurrencyMetrics();
  const orchestrator = new Orchestrator(lookupFor(['pr-helper']), port, {
    newIntentId: () => 'intent-1',
    newRunId: () => 'run-1',
    onConflict: conflictsToDesk(desk),
    metrics,
    executionDelegation: {
      verifier: signer.verifier(),
      ledger,
      acceptedKeyIds: [signer.keyId],
      now: () => NOW,
    },
    onExecutionDelegationRefused: entry => {
      audit.push({
        ts: entry.at,
        vassal: entry.vassal,
        skill: entry.skill,
        realm: entry.realm,
        decision: 'execution-delegation-denied',
        detail: entry.reason,
      });
    },
  });
  const app = await createHttpServer({
    registry: new VassalRegistry(),
    signer,
    internalToken: TOKEN,
    orchestrator,
    oversight: desk,
    metrics,
    now: () => NOW,
  });
  return { app, audit, dispatch, signer, ledger };
}

describe('HTTP H2 — execute-mode dispatch gate (deferred #33)', () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('rejects an execute intent without a delegation and never dispatches outbound', async () => {
    const h = await gateServer();
    app = h.app;
    const res = await app.inject({
      method: 'POST',
      url: '/api/intents',
      headers: { ...AUTH, 'content-type': 'application/json' },
      payload: { skill: 'deployment-health', realm: 'personal', params: {}, mode: 'execute' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { branches: Array<{ ok: boolean; reason?: string }> };
    expect(body.branches[0]?.ok).toBe(false);
    expect(body.branches[0]?.reason).toBe('execute refused: missing');
    expect(h.dispatch).not.toHaveBeenCalled();
    expect(h.audit.some(e => e.decision === 'execution-delegation-denied' && e.detail === 'missing')).toBe(true);
  });

  it('admits an execute intent carrying a valid signed delegation (one dispatch)', async () => {
    const h = await gateServer();
    app = h.app;
    const issued = await issueExecutionDelegation(
      { grantedBy: 'operator@zeus', skill: 'deployment-health', capabilities: ['execute'] },
      { signer: h.signer, now: () => NOW },
    );
    const res = await app.inject({
      method: 'POST',
      url: '/api/intents',
      headers: { ...AUTH, 'content-type': 'application/json' },
      payload: { skill: 'deployment-health', realm: 'personal', params: {}, mode: 'execute', executionDelegation: issued },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { branches: Array<{ ok: boolean }> };
    expect(body.branches[0]?.ok).toBe(true);
    expect(h.dispatch).toHaveBeenCalledTimes(1);
    expect(h.audit.some(e => e.decision === 'execution-delegation-denied')).toBe(false);
  });

  it('rejects a replayed delegation on the second execute intent', async () => {
    const h = await gateServer();
    app = h.app;
    const issued = await issueExecutionDelegation(
      { grantedBy: 'operator@zeus', skill: 'deployment-health', capabilities: ['execute'] },
      { signer: h.signer, now: () => NOW },
    );
    const payload = { skill: 'deployment-health', realm: 'personal', params: {}, mode: 'execute', executionDelegation: issued };
    await app.inject({ method: 'POST', url: '/api/intents', headers: { ...AUTH, 'content-type': 'application/json' }, payload });
    const replay = await app.inject({ method: 'POST', url: '/api/intents', headers: { ...AUTH, 'content-type': 'application/json' }, payload });
    expect(replay.statusCode).toBe(200);
    const body = replay.json() as { branches: Array<{ ok: boolean; reason?: string }> };
    expect(body.branches[0]?.ok).toBe(false);
    expect(body.branches[0]?.reason).toBe('execute refused: replayed');
    expect(h.dispatch).toHaveBeenCalledTimes(1);
    expect(h.audit.some(e => e.decision === 'execution-delegation-denied' && e.detail === 'replayed')).toBe(true);
  });

  it('rejects an unknown mode value with 400 before touching the kernel', async () => {
    const h = await gateServer();
    app = h.app;
    const res = await app.inject({
      method: 'POST',
      url: '/api/intents',
      headers: { ...AUTH, 'content-type': 'application/json' },
      payload: { skill: 'deployment-health', realm: 'personal', params: {}, mode: 'execute-now' },
    });
    expect(res.statusCode).toBe(400);
    expect(h.dispatch).not.toHaveBeenCalled();
  });
});
