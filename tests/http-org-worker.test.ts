/**
 * T-M7-01/#11 async org task HTTP contract over a REAL listening server with
 * a TaskWorker assembled: dispatch claims synchronously and returns 202 with
 * the running task, the worker executes off the request, and clients poll
 * GET /tasks/:id. Covers a D0 completion and the D2 pause → approve → resume
 * → done loop end to end.
 */
import { describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createHttpServer } from '../src/http/server.js';
import { VassalRegistry } from '../src/registry/registry.js';
import { Ed25519MemorySigner } from '../src/registry/signing.js';
import {
  DecisionAuditChain,
  DecisionService,
  MemoryDecisionStore,
  OrgService,
  TaskWorker,
  type OrgTask,
  type OrgTaskExecutor,
} from '../src/core/index.js';
import { MemoryPolicyStore } from '../src/core/grading/policy-loader.js';
import { DEFAULT_POLICY_V1 } from '../src/core/grading/default-policy.js';

const TOKEN = 'org-worker-secret';
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const FAST = { maxAttempts: 3, baseBackoffMs: 1, maxBackoffMs: 1, factor: 1, jitter: 0 } as const;

interface Stack {
  app: FastifyInstance;
  port: number;
  orgId: string;
  worker: TaskWorker;
}

async function startStack(executor: OrgTaskExecutor, scope: 'D0' | 'D2' = 'D2'): Promise<Stack> {
  const signer = new Ed25519MemorySigner('zeus-rsk-org-worker');
  const policyStore = new MemoryPolicyStore();
  policyStore.put(DEFAULT_POLICY_V1);
  const decisions = new DecisionService({
    policyStore,
    recordStore: new MemoryDecisionStore(),
    audit: new DecisionAuditChain(new Ed25519MemorySigner('audit-seal-org-worker')),
  });
  const org = new OrgService({
    decisions,
    retryPolicy: { ...FAST },
    taskDeadlineMs: 60_000,
  });
  const worker = new TaskWorker({ org, executor });
  worker.start();
  const app = await createHttpServer({
    registry: new VassalRegistry(),
    signer,
    internalToken: TOKEN,
    decisionService: decisions,
    orgService: org,
    orgExecutor: executor,
    orgTaskWorker: worker,
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const port = (app.server.address() as { port: number }).port;

  const headers = { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` };
  const org0 = await fetch(`http://127.0.0.1:${port}/api/v1/org/organizations`, {
    method: 'POST', headers, body: JSON.stringify({ name: '自营', scaleTier: 'small' }),
  }).then((r) => r.json());
  const dept = await fetch(`http://127.0.0.1:${port}/api/v1/org/departments`, {
    method: 'POST', headers, body: JSON.stringify({ organizationId: org0.id, name: '运营', mission: 'm' }),
  }).then((r) => r.json());
  const pos = await fetch(`http://127.0.0.1:${port}/api/v1/org/positions`, {
    method: 'POST', headers,
    body: JSON.stringify({
      organizationId: org0.id, departmentId: dept.id, name: '运营专员',
      requiredSkills: ['ops'], allowedTools: ['refund.issue'], decisionScope: scope,
    }),
  }).then((r) => r.json());
  await fetch(`http://127.0.0.1:${port}/api/v1/org/positions/${pos.id}/assign-agent`, {
    method: 'POST', headers, body: JSON.stringify({ agentId: 'agent-1' }),
  });
  return { app, port, orgId: org0.id as string, worker };
}

async function api(port: number, path: string, init: { method?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` };
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: init.method ?? 'GET',
    headers,
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  return { status: res.status, body: await res.json() };
}

async function pollTask(port: number, id: string, pred: (t: OrgTask) => boolean): Promise<OrgTask> {
  const deadline = Date.now() + 2000;
  for (;;) {
    const { body } = await api(port, `/api/v1/org/tasks/${id}`);
    const t = body as OrgTask;
    if (pred(t)) return t;
    if (Date.now() > deadline) throw new Error(`poll timed out; last status=${(body as OrgTask).status}`);
    await sleep(5);
  }
}

describe('async org task dispatch over HTTP (T-M7-01/#11)', () => {
  it('returns 202 and runs a D0 task to completion on the worker', async () => {
    const executor: OrgTaskExecutor = {
      run: async () => ({ outcome: 'complete', result: { listed: true } }),
    };
    const stack = await startStack(executor, 'D0');
    try {
      const created = await api(stack.port, '/api/v1/org/tasks', {
        method: 'POST', body: { organizationId: stack.orgId, title: '上架', payload: {}, requiredSkill: 'ops' },
      });
      const id = (created.body as OrgTask).id;
      const dispatched = await api(stack.port, `/api/v1/org/tasks/${id}/dispatch`, { method: 'POST' });
      expect(dispatched.status).toBe(202);
      expect((dispatched.body as { task: OrgTask }).task.status).toBe('running');

      const done = await pollTask(stack.port, id, (t) => t.status === 'done');
      expect(done.result).toEqual({ listed: true });
    } finally {
      stack.worker.stop();
      await stack.app.close();
    }
  });

  it('pauses at a D2 checkpoint, then resumes after approval to done', async () => {
    const executor: OrgTaskExecutor = {
      run: async (ctx) => {
        const payload = ctx.task.payload as { amount: number };
        const d = await ctx.requestDecision({
          intent: 'refund-order',
          amount: { value: payload.amount, currency: 'CNY' },
          impact: 'self',
          reversibility: 'reversible',
          idempotencyKey: `refund-${ctx.task.id}`,
        });
        return { outcome: 'complete', result: { refunded: true, grade: d.grade } };
      },
    };
    const stack = await startStack(executor, 'D2');
    try {
      const created = await api(stack.port, '/api/v1/org/tasks', {
        method: 'POST',
        body: { organizationId: stack.orgId, title: '退款 1200', payload: { amount: 1200 }, requiredSkill: 'ops' },
      });
      const id = (created.body as OrgTask).id;
      const dispatched = await api(stack.port, `/api/v1/org/tasks/${id}/dispatch`, { method: 'POST' });
      expect(dispatched.status).toBe(202);

      const paused = await pollTask(stack.port, id, (t) => t.status === 'awaiting_decision');
      expect(paused.decisionId).toBeTruthy();

      const resumed = await api(stack.port, `/api/v1/org/tasks/${id}/resume`, {
        method: 'POST', body: { decision: 'approve', approver: 'owner' },
      });
      expect(resumed.status).toBe(202);

      const done = await pollTask(stack.port, id, (t) => t.status === 'done');
      expect(done.result).toEqual({ refunded: true, grade: 'D2' });
    } finally {
      stack.worker.stop();
      await stack.app.close();
    }
  });
});
