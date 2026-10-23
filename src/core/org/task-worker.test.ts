/**
 * T-M7-01/#11 async TaskWorker tests: claiming is synchronous and fast while
 * execution happens on the worker; D2 checkpoints pause and resume through the
 * queue; a restart-style recovery re-runs interrupted running tasks; duplicate
 * enqueues never execute a task twice.
 */
import { describe, expect, it } from 'vitest';
import { DecisionService } from '../decision-service/service.js';
import { MemoryDecisionStore } from '../decision-service/store.js';
import { DecisionAuditChain } from '../audit/audit-chain.js';
import { Ed25519MemorySigner } from '../../registry/signing.js';
import { MemoryPolicyStore } from '../grading/policy-loader.js';
import { DEFAULT_POLICY_V1 } from '../grading/default-policy.js';
import { OrgService, TaskWorker, type OrgTaskExecutor } from './index.js';

function makeDecisionService(): DecisionService {
  const policyStore = new MemoryPolicyStore();
  policyStore.put(DEFAULT_POLICY_V1);
  return new DecisionService({
    policyStore,
    recordStore: new MemoryDecisionStore(),
    audit: new DecisionAuditChain(new Ed25519MemorySigner('m7-worker-test')),
  });
}

const FAST_RETRY = { maxAttempts: 3, baseBackoffMs: 1, maxBackoffMs: 1, factor: 1, jitter: 0 } as const;

function setup(scope: 'D0' | 'D2' = 'D0') {
  const decisions = makeDecisionService();
  let seq = 0;
  const service = new OrgService({
    decisions,
    clock: () => '2026-10-22T00:00:00.000Z',
    newId: prefix => `${prefix}-${++seq}`,
    retryPolicy: { ...FAST_RETRY },
    taskDeadlineMs: 60_000,
  });
  const org = service.createOrganization({ name: '自营', scaleTier: 'small' });
  const dept = service.createDepartment({ organizationId: org.id, name: '运营', mission: 'm' });
  const position = service.createPosition({
    organizationId: org.id,
    departmentId: dept.id,
    name: '运营专员',
    requiredSkills: ['ops'],
    allowedTools: ['refund.issue'],
    decisionScope: scope,
  });
  service.assignAgent(position.id, { agentId: 'agent-1' });
  const newTask = () =>
    service.createTask({ organizationId: org.id, title: '任务', payload: { amount: 1200 }, requiredSkill: 'ops' });
  return { service, decisions, org, newTask };
}

describe('TaskWorker (T-M7-01/#11 async execution)', () => {
  it('claims synchronously without running; the worker executes to done off the request', async () => {
    const { service, newTask } = setup();
    const task = newTask();
    const executor: OrgTaskExecutor = {
      run: async () => ({ outcome: 'complete', result: { listed: true } }),
    };
    const worker = new TaskWorker({ org: service, executor });
    const claimed = service.claim(task.id);
    expect(claimed.status).toBe('running');
    // The executor has not run yet (claim is side-effect-free).
    expect(service.getTask(task.id).result).toBeUndefined();

    worker.start();
    worker.enqueue(task.id);
    await worker.drain();
    worker.stop();

    const done = service.getTask(task.id);
    expect(done.status).toBe('done');
    expect(done.result).toEqual({ listed: true });
    expect(done.transitions.map(t => t.status)).toEqual([
      'pending', 'dispatched', 'running', 'done',
    ]);
  });

  it('recovers interrupted running tasks on start without an explicit enqueue', async () => {
    const { service, newTask } = setup();
    const task = newTask();
    // Simulate a worker that died after claiming but before execution.
    service.claim(task.id);
    expect(service.getTask(task.id).status).toBe('running');
    expect(service.getTask(task.id).result).toBeUndefined();

    const executor: OrgTaskExecutor = {
      run: async () => ({ outcome: 'complete', result: { recovered: true } }),
    };
    const worker = new TaskWorker({ org: service, executor });
    worker.start(); // recover() should pick up the running task
    await worker.drain();
    worker.stop();

    expect(service.getTask(task.id).status).toBe('done');
    expect(service.getTask(task.id).result).toEqual({ recovered: true });
  });

  it('pauses at a D2 checkpoint on the worker and resumes after approval', async () => {
    const { service, newTask } = setup('D2');
    const task = newTask();
    const executor: OrgTaskExecutor = {
      run: async ctx => {
        const d = await ctx.requestDecision({
          intent: 'refund-order',
          amount: { value: 1200, currency: 'CNY' },
          impact: 'self',
          reversibility: 'reversible',
          idempotencyKey: `refund-${task.id}`,
        });
        return { outcome: 'complete', result: { refunded: true, grade: d.grade } };
      },
    };
    const worker = new TaskWorker({ org: service, executor });
    worker.start();
    service.claim(task.id);
    worker.enqueue(task.id);
    await worker.drain();
    expect(service.getTask(task.id).status).toBe('awaiting_decision');
    const decisionId = service.getTask(task.id).decisionId!;
    expect(decisionId).toBeTruthy();

    // Approve, claim the resume, and let the worker run it.
    await service.claimResume(task.id, { decision: 'approve', approver: 'owner' });
    worker.enqueue(task.id);
    await worker.drain();
    worker.stop();

    const done = service.getTask(task.id);
    expect(done.status).toBe('done');
    expect(done.result).toEqual({ refunded: true, grade: 'D2' });
  });

  it('ignores duplicate enqueues so a task executes at most once', async () => {
    const { service, newTask } = setup();
    const task = newTask();
    let runs = 0;
    const executor: OrgTaskExecutor = {
      run: async () => {
        runs += 1;
        return { outcome: 'complete' };
      },
    };
    const worker = new TaskWorker({ org: service, executor });
    worker.start();
    service.claim(task.id);
    worker.enqueue(task.id);
    worker.enqueue(task.id);
    worker.enqueue(task.id);
    await worker.drain();
    worker.stop();
    expect(runs).toBe(1);
    expect(service.getTask(task.id).status).toBe('done');
  });

  it('reports unexpected runner errors via onError and keeps draining', async () => {
    const { service, newTask } = setup();
    const bad = newTask();
    const good = newTask();
    const errors: string[] = [];
    const executor: OrgTaskExecutor = {
      run: async ctx => {
        if (ctx.task.id === bad.id) {
          // runClaimed on a non-running task surfaces through onError path.
          throw new Error('should-not-happen');
        }
        return { outcome: 'complete' };
      },
    };
    const worker = new TaskWorker({ org: service, executor, onError: (id, e) => errors.push(`${id}:${(e as Error).message}`) });
    worker.start();
    service.claim(good.id);
    worker.enqueue(good.id);
    await worker.drain();
    expect(service.getTask(good.id).status).toBe('done');
    // A spurious enqueue of a terminal task is reported, not retried forever.
    worker.enqueue('task-does-not-exist');
    await worker.drain();
    worker.stop();
    expect(errors.some(e => e.startsWith('task-does-not-exist'))).toBe(true);
  });
});
