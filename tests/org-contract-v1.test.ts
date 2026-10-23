/**
 * T-M2-05 org contract tests over a REAL listening HTTP server (not inject):
 * organization/department/position lifecycle with agent binding, hierarchy
 * validation, fail-closed paths, threshold configuration taking effect, task
 * dispatch state machine (no-match → explicit 409; full loop; D2 pause →
 * approve via resume → done), and the GATE-M2 end-to-end closed loop.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createHttpServer } from '../src/http/server.js';
import { VassalRegistry } from '../src/registry/registry.js';
import { Ed25519MemorySigner } from '../src/registry/signing.js';
import {
  DecisionAuditChain,
  DecisionService,
  MemoryDecisionStore,
  OrgService,
  type DispatchResult,
  type OrgTask,
  type OrgTaskExecutor,
} from '../src/core/index.js';
import { MemoryPolicyStore } from '../src/core/grading/policy-loader.js';
import { DEFAULT_POLICY_V1 } from '../src/core/grading/default-policy.js';

const TOKEN = 'org-contract-secret';
const BASE = () => `http://127.0.0.1:${port}`;
let port: number;

interface Stack {
  app: FastifyInstance;
  org: OrgService;
  decisions: DecisionService;
  setExecutor(executor: OrgTaskExecutor | undefined): void;
}

let stack: Stack;

async function startStack(): Promise<Stack> {
  const registry = new VassalRegistry();
  const signer = new Ed25519MemorySigner('zeus-rsk-org-contract');
  const policyStore = new MemoryPolicyStore();
  policyStore.put(DEFAULT_POLICY_V1);
  const decisions = new DecisionService({
    policyStore,
    recordStore: new MemoryDecisionStore(),
    audit: new DecisionAuditChain(new Ed25519MemorySigner('audit-seal-org-contract')),
  });
  const org = new OrgService({ decisions });
  let executor: OrgTaskExecutor | undefined;
  const app = await createHttpServer({
    registry,
    signer,
    internalToken: TOKEN,
    decisionService: decisions,
    orgService: org,
    orgExecutor: {
      run: async ctx => {
        if (!executor) {
          throw new Error('no executor installed for this test');
        }
        return executor.run(ctx);
      },
    },
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  port = (app.server.address() as { port: number }).port;
  return {
    app,
    org,
    decisions,
    setExecutor(ex: OrgTaskExecutor | undefined) {
      executor = ex;
    },
  };
}

async function api(path: string, init: { method?: string; body?: unknown; token?: string | null } = {}): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = {};
  if (init.token !== null) headers.authorization = `Bearer ${init.token ?? TOKEN}`;
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${BASE()}${path}`, {
    method: init.method ?? 'GET',
    headers,
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const orgBody = (name = '自营电商') => ({ name, scaleTier: 'small' });

async function bootstrapOrg(positionName = '运营专员', skill = 'ops', scope = 'D2') {
  const org = (await api('/api/v1/org/organizations', { method: 'POST', body: orgBody() })).body;
  const dept = (await api('/api/v1/org/departments', {
    method: 'POST',
    body: { organizationId: org.id, name: '运营中心', mission: '自营电商运营' },
  })).body;
  const position = (await api('/api/v1/org/positions', {
    method: 'POST',
    body: {
      organizationId: org.id,
      departmentId: dept.id,
      name: positionName,
      responsibilities: ['店铺运营'],
      requiredSkills: [skill],
      allowedTools: ['listing', 'refund'],
      decisionScope: scope,
    },
  })).body;
  return { org, dept, position };
}

beforeEach(async () => {
  stack = await startStack();
});

afterEach(async () => {
  await stack.app.close();
});

describe('org contract: auth and validation', () => {
  it('rejects unauthenticated requests with 401', async () => {
    const res = await api('/api/v1/org/organizations', { token: null });
    expect(res.status).toBe(401);
  });

  it('rejects a bad token with 401', async () => {
    const res = await api('/api/v1/org/organizations', { token: 'wrong' });
    expect(res.status).toBe(401);
  });

  it('rejects invalid scaleTier with 400 and §8.1 error body', async () => {
    const res = await api('/api/v1/org/organizations', {
      method: 'POST',
      body: { name: 'x', scaleTier: 'galaxy' },
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_FAILED');
    expect(res.body.message).toBeTruthy();
  });

  it('returns 404 for unknown organizations and positions', async () => {
    const r1 = await api('/api/v1/org/organizations/org:missing');
    expect(r1.status).toBe(404);
    expect(r1.body.code).toBe('ORGANIZATION_NOT_FOUND');
    const r2 = await api('/api/v1/org/positions/pos:nope/assign-agent', {
      method: 'POST',
      body: { agentId: 'a1' },
    });
    expect(r2.status).toBe(404);
    expect(r2.body.code).toBe('POSITION_NOT_FOUND');
  });
});

describe('org contract: establishment lifecycle', () => {
  it('creates org/department/position, binds an agent and queries the establishment', async () => {
    const { org, dept, position } = await bootstrapOrg();
    expect(org.id).toMatch(/^org:/);
    expect(dept.organizationId).toBe(org.id);
    expect(position.decisionScope).toBe('D2');

    const bound = await api(`/api/v1/org/positions/${position.id}/assign-agent`, {
      method: 'POST',
      body: { agentId: 'agent-ops-1' },
    });
    expect(bound.status).toBe(200);
    expect(bound.body.agentId).toBe('agent-ops-1');

    const positions = await api(`/api/v1/org/positions?organizationId=${encodeURIComponent(org.id)}`);
    expect(positions.body.positions).toHaveLength(1);
    expect(positions.body.positions[0].agentId).toBe('agent-ops-1');

    const orgs = await api('/api/v1/org/organizations');
    expect(orgs.body.organizations.map((o: { id: string }) => o.id)).toContain(org.id);
  });

  it('rejects a department whose parent belongs to another organization (400)', async () => {
    const a = (await api('/api/v1/org/organizations', { method: 'POST', body: orgBody('甲公司') })).body;
    const b = (await api('/api/v1/org/organizations', { method: 'POST', body: orgBody('乙公司') })).body;
    const deptA = (await api('/api/v1/org/departments', {
      method: 'POST',
      body: { organizationId: a.id, name: 'A组', mission: 'm' },
    })).body;
    const cross = await api('/api/v1/org/departments', {
      method: 'POST',
      body: { organizationId: b.id, name: 'B组', mission: 'm', parentId: deptA.id },
    });
    expect(cross.status).toBe(400);
    expect(cross.body.code).toBe('VALIDATION_FAILED');
  });

  it('rejects a position in an unknown department (404)', async () => {
    const { org } = await bootstrapOrg();
    const res = await api('/api/v1/org/positions', {
      method: 'POST',
      body: { organizationId: org.id, departmentId: 'dept:missing', name: 'p' },
    });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('DEPARTMENT_NOT_FOUND');
  });
});

describe('org contract: threshold configuration (T-M2-04)', () => {
  it('rejects inverted thresholds with 400', async () => {
    const res = await api('/api/v1/org/policy/thresholds', {
      method: 'POST',
      body: { d1MaxAmount: 9000, d2MaxAmount: 1000, actor: 'owner' },
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_FAILED');
  });

  it('moves boundaries and takes effect immediately on new decisions', async () => {
    const mk = (amount: number, key: string) =>
      api('/api/v1/decisions', {
        method: 'POST',
        body: {
          intent: 'refund',
          domain: 'org:probe',
          amount: { value: amount, currency: 'CNY' },
          impact: 'self',
          reversibility: 'reversible',
          idempotencyKey: key,
        },
      });
    const before = await mk(300, 'before');
    expect(before.body.grade).toBe('D1');

    const updated = await api('/api/v1/org/policy/thresholds', {
      method: 'POST',
      body: { d1MaxAmount: 100, d2MaxAmount: 5000, actor: 'owner' },
    });
    expect(updated.status).toBe(200);
    expect(updated.body.version).toBe(2);

    const after = await mk(300, 'after');
    expect(after.body.grade).toBe('D2');
    // new policy version served
    const policy = await api('/api/v1/policy');
    expect(policy.body.version).toBe(2);
  });
});

describe('org contract: task dispatch (T-M2-03)', () => {
  it('reports no matching position with 409 and leaves the task pending with a reason', async () => {
    const { org, position } = await bootstrapOrg();
    // position unbound
    const created = await api('/api/v1/org/tasks', {
      method: 'POST',
      body: { organizationId: org.id, title: '任务', payload: { x: 1 }, requiredSkill: 'ops' },
    });
    expect(created.status).toBe(201);
    const task = created.body as OrgTask;
    const res = await api(`/api/v1/org/tasks/${task.id}/dispatch`, { method: 'POST' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('NO_MATCHING_POSITION');
    const get = await api(`/api/v1/org/tasks/${task.id}`);
    expect(get.body.status).toBe('pending');
    expect(get.body.unmatchedReason).toContain('no bound position');
    expect(position.id).toBeTruthy();
  });

  it('runs a bound agent task to done with full transition history', async () => {
    const { org, position } = await bootstrapOrg();
    await api(`/api/v1/org/positions/${position.id}/assign-agent`, {
      method: 'POST',
      body: { agentId: 'agent-ops-1' },
    });
    const created = await api('/api/v1/org/tasks', {
      method: 'POST',
      body: { organizationId: org.id, title: '上架', payload: { sku: 'sku-1' }, requiredSkill: 'ops' },
    });
    stack.setExecutor({
      run: async ctx => {
        expect(ctx.agentId).toBe('agent-ops-1');
        const payload = ctx.task.payload as { sku?: string } | null;
        return { outcome: 'complete', result: { listed: true, sku: payload?.sku ?? null } };
      },
    });
    const res = await api(`/api/v1/org/tasks/${created.body.id}/dispatch`, { method: 'POST' });
    expect(res.status).toBe(200);
    const result = res.body as DispatchResult;
    expect(result.task.status).toBe('done');
    expect(result.task.result).toEqual({ listed: true, sku: 'sku-1' });
    expect(result.task.transitions.map((t: { status: string }) => t.status)).toEqual([
      'pending', 'dispatched', 'running', 'done',
    ]);
  });

  it('returns 503 ORG_EXECUTOR_UNCONFIGURED when no executor is assembled', async () => {
    // A second process assembled with org service but no task executor.
    const policyStore2 = new MemoryPolicyStore();
    policyStore2.put(DEFAULT_POLICY_V1);
    const decisions2 = new DecisionService({
      policyStore: policyStore2,
      recordStore: new MemoryDecisionStore(),
      audit: new DecisionAuditChain(new Ed25519MemorySigner('audit-seal-noexec')),
    });
    const org2 = new OrgService({ decisions: decisions2 });
    const app2 = await createHttpServer({
      registry: new VassalRegistry(),
      signer: new Ed25519MemorySigner('zeus-rsk-noexec'),
      internalToken: TOKEN,
      decisionService: decisions2,
      orgService: org2,
    });
    await app2.listen({ host: '127.0.0.1', port: 0 });
    const port2 = (app2.server.address() as { port: number }).port;
    try {
      const created = await fetch(`http://127.0.0.1:${port2}/api/v1/org/organizations`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ name: '无执行器组织' }),
      });
      const org = await created.json();
      const task = await fetch(`http://127.0.0.1:${port2}/api/v1/org/tasks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ organizationId: org.id, title: 't', payload: {} }),
      }).then(r => r.json());
      const res = await fetch(`http://127.0.0.1:${port2}/api/v1/org/tasks/${task.id}/dispatch`, {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.code).toBe('ORG_EXECUTOR_UNCONFIGURED');
      expect(body.retryable).toBe(true);
    } finally {
      await app2.close();
    }
  });
});

describe('GATE-M2: one organization-level closed loop', () => {
  it('建组织 → 岗位 → 绑定 Agent → 派发 → D2 决策点同步审批 → 完成，全程审计可回放', async () => {
    const { org, position } = await bootstrapOrg('退款专员', 'refund', 'D2');
    await api(`/api/v1/org/positions/${position.id}/assign-agent`, {
      method: 'POST',
      body: { agentId: 'agent-refund-1' },
    });

    const created = await api('/api/v1/org/tasks', {
      method: 'POST',
      body: {
        organizationId: org.id,
        title: '客户退款 1200 元',
        payload: { orderId: 'ord-1', amount: 1200 },
        requiredSkill: 'refund',
      },
    });
    expect(created.status).toBe(201);
    const taskId = created.body.id as string;

    // Scripted agent (callback-style): the first run suspends at the D2
    // refund checkpoint; on resume the approved decision is replayed by
    // idempotencyKey and execution proceeds to completion.
    stack.setExecutor({
      run: async ctx => {
        const payload = ctx.task.payload as { amount: number };
        await ctx.requestDecision({
          intent: 'refund-order',
          amount: { value: payload.amount, currency: 'CNY' },
          impact: 'self',
          reversibility: 'reversible',
          idempotencyKey: `refund-${taskId}`,
        });
        return { outcome: 'complete', result: { refunded: true, orderId: 'ord-1' } };
      },
    });

    // Dispatch pauses at the D2 checkpoint (1200 CNY → D2 sync approval).
    const dispatched = await api(`/api/v1/org/tasks/${taskId}/dispatch`, { method: 'POST' });
    expect(dispatched.status).toBe(200);
    expect(dispatched.body.task.status).toBe('awaiting_decision');
    expect(dispatched.body.decision.grade).toBe('D2');
    expect(dispatched.body.decision.status).toBe('blocked');
    const decisionId = dispatched.body.decision.id as string;

    // The decision is independently queryable.
    const decisionGet = await api(`/api/v1/decisions/${decisionId}`);
    expect(decisionGet.status).toBe(200);
    expect(decisionGet.body.domain).toBe(`org:${org.id}`);

    // Owner approves through the task resume; loop completes.
    const resumed = await api(`/api/v1/org/tasks/${taskId}/resume`, {
      method: 'POST',
      body: { decision: 'approve', approver: 'owner', comment: 'gate-m2 approved' },
    });
    expect(resumed.status).toBe(200);
    expect(resumed.body.task.status).toBe('done');
    expect(resumed.body.task.result).toEqual({ refunded: true, orderId: 'ord-1' });
    expect(resumed.body.task.transitions.map((t: { status: string }) => t.status)).toEqual([
      'pending', 'dispatched', 'running', 'awaiting_decision', 'running', 'done',
    ]);

    // Replay the decision trail (audit is append-only and replayable).
    const replay = await api(`/api/v1/decisions/${decisionId}/replay?format=json`);
    expect(replay.status).toBe(200);
    const eventTypes = replay.body.events.map((e: { type: string }) => e.type);
    expect(eventTypes).toContain('decision.created');
    expect(eventTypes).toContain('decision.approved');

    // The task lists under the organization.
    const list = await api(`/api/v1/org/tasks?organizationId=${encodeURIComponent(org.id)}`);
    expect(list.body.tasks).toHaveLength(1);
    expect(list.body.tasks[0].status).toBe('done');
  });
});
